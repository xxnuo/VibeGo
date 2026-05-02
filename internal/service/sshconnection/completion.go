package sshconnection

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
)

const (
	sshCompletionLimit          = 100
	sshCompletionOutputMaxBytes = 256 * 1024
	sshCompletionErrorMaxBytes  = 16 * 1024
	sshCompletionOutputMaxLines = 4096
	sshCompletionErrorMaxLines  = 512
	sshCompletionTimeout        = 5 * time.Second
	// Completion uses independent SSH channels. Keep the number of channels
	// bounded so a burst of keystrokes cannot exhaust the shared transport.
	sshCompletionMaxConcurrent = 4
)

type completionBuffer struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	byteLimit int
	lineLimit int
	lines     int
	lineOpen  bool
	overflow  bool
}

func newCompletionBuffer(byteLimit, lineLimit int) *completionBuffer {
	return &completionBuffer{byteLimit: byteLimit, lineLimit: lineLimit}
}

func (b *completionBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, char := range value {
		if !b.lineOpen {
			b.lines++
			b.lineOpen = true
			if b.lineLimit > 0 && b.lines > b.lineLimit {
				b.overflow = true
			}
		}
		if char == '\n' {
			b.lineOpen = false
		}
	}
	remaining := b.byteLimit - b.buffer.Len()
	if b.byteLimit <= 0 {
		remaining = len(value)
	}
	if remaining > 0 {
		if remaining > len(value) {
			remaining = len(value)
		}
		_, _ = b.buffer.Write(value[:remaining])
	}
	if remaining < len(value) {
		b.overflow = true
	}
	return len(value), nil
}

func (b *completionBuffer) snapshot() ([]byte, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buffer.Bytes()...), b.overflow
}

func (r *Runtime) ensureCompletionSlot() chan struct{} {
	if r == nil {
		return nil
	}
	r.completionSlotOnce.Do(func() {
		if r.completionSlot == nil {
			r.completionSlot = make(chan struct{}, sshCompletionMaxConcurrent)
		}
	})
	return r.completionSlot
}

func (r *Runtime) acquireCompletionSlot(ctx context.Context) (func(), error) {
	if r == nil {
		return nil, terminal.ErrCompletionUnsupported
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	slot := r.ensureCompletionSlot()
	if slot == nil {
		return nil, terminal.ErrCompletionUnsupported
	}
	select {
	case slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-r.closed:
		return nil, errRuntimeClosed
	}
	return func() { <-slot }, nil
}

func (r *Runtime) openCompletionSession(ctx context.Context) (*ssh.Session, error) {
	if r == nil || (r.client == nil && r.newSession == nil) {
		return nil, terminal.ErrCompletionUnsupported
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	newSession := r.newSession
	if newSession == nil {
		newSession = r.client.NewSession
	}
	session, err := newSession()
	if ctxErr := ctx.Err(); ctxErr != nil {
		if session != nil {
			_ = session.Close()
		}
		return nil, ctxErr
	}
	select {
	case <-r.closed:
		if session != nil {
			_ = session.Close()
		}
		return nil, errRuntimeClosed
	default:
	}
	if err != nil {
		if session != nil {
			_ = session.Close()
		}
		return nil, err
	}
	if session == nil {
		return nil, errors.New("ssh completion session was not created")
	}
	return session, nil
}

func normalizeCompletionLimit(value int) int {
	if value <= 0 || value > sshCompletionLimit {
		return sshCompletionLimit
	}
	return value
}

func remoteCompletionScript(request terminal.CompletionRequest, fetchLimit int) (string, error) {
	if strings.IndexByte(request.Cwd, 0) >= 0 || strings.IndexByte(request.Prefix, 0) >= 0 {
		return "", errors.New("completion request contains NUL")
	}
	if fetchLimit <= 0 {
		fetchLimit = sshCompletionLimit + 1
	}
	valueType := ""
	executableOnly := "0"
	switch request.Kind {
	case terminal.CompletionKindCommand:
		valueType = "command"
	case terminal.CompletionKindFile:
		valueType = "file"
		if request.ExecutableOnly {
			executableOnly = "1"
		}
	default:
		return "", terminal.ErrCompletionUnsupported
	}
	cwd := request.Cwd
	if strings.TrimSpace(cwd) == "" {
		cwd = "."
	}
	return strings.Join([]string{
		"if ! type compgen >/dev/null 2>&1; then printf '%s\\n' 'remote bash compgen is unavailable' >&2; exit 127; fi",
		"cd -- " + quotePOSIX(cwd) + " || { printf '%s\\n' 'remote completion cwd is unavailable' >&2; exit 72; }",
		"prefix=" + quotePOSIX(request.Prefix),
		"fetch_limit=" + strconv.Itoa(fetchLimit),
		"executable_only=" + executableOnly,
		"emit_compgen() {",
		"  local tag=$1 comp_type=$2 value",
		"  if [ \"$tag\" = V ] && [ \"$executable_only\" = 1 ]; then",
		"    compgen -A \"$comp_type\" -- \"$prefix\" | while IFS= read -r value; do",
		"      if [ -d \"$value\" ] || [ -x \"$value\" ]; then printf '%s\\n' \"$value\"; fi",
		"    done | LC_ALL=C sort -u | head -n \"$fetch_limit\" | while IFS= read -r value; do",
		"      printf '%s\\t%s\\n' \"$tag\" \"$value\"",
		"    done",
		"  else",
		"    compgen -A \"$comp_type\" -- \"$prefix\" | LC_ALL=C sort -u | head -n \"$fetch_limit\" | while IFS= read -r value; do",
		"      printf '%s\\t%s\\n' \"$tag\" \"$value\"",
		"    done",
		"  fi",
		"}",
		// Both queries are intentional. WaveTerm merges directory candidates
		// into command/file completion and marks them with a trailing slash.
		"emit_compgen D directory",
		"emit_compgen V " + valueType,
	}, "\n"), nil
}

func remoteCompletionCommand(script string) string {
	// A login shell establishes the remote user's PATH. The actual completion
	// script then runs in a clean Bash process so profile output or aliases do
	// not corrupt the tagged result stream. BASH_ENV/ENV are explicitly removed
	// because they are read by non-interactive shells even with --norc.
	inner := "command env -u BASH_ENV -u ENV -u CDPATH bash --noprofile --norc -c " + quotePOSIX(script)
	return "bash -lc " + quotePOSIX(inner)
}

func newCompletionProtocolMarker() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("create completion protocol marker: %w", err)
	}
	return "__VIBEGO_COMPLETION_" + hex.EncodeToString(random[:]) + "__", nil
}

func wrapRemoteCompletionProtocol(script, marker string) string {
	begin := marker + "BEGIN"
	end := marker + "END"
	return strings.Join([]string{
		// Start on a fresh line even when a login profile wrote an unterminated
		// diagnostic before the clean inner shell was exec'd.
		"printf '\\n%s\\n' " + quotePOSIX(begin),
		script,
		"printf '%s\\n' " + quotePOSIX(end),
	}, "\n")
}

func extractRemoteCompletionProtocol(output []byte, marker string) ([]byte, error) {
	begin := []byte(marker + "BEGIN")
	end := []byte(marker + "END")
	lines := bytes.Split(output, []byte{'\n'})
	start := -1
	for index, line := range lines {
		if start < 0 {
			if bytes.Equal(line, begin) {
				start = index + 1
			}
			continue
		}
		if bytes.Equal(line, end) {
			return bytes.Join(lines[start:index], []byte{'\n'}), nil
		}
	}
	return nil, errors.New("remote completion returned an invalid protocol frame")
}

func validRemoteCompletionValue(value []byte) bool {
	return len(value) > 0 && utf8.Valid(value) && strings.IndexFunc(string(value), unicode.IsControl) < 0
}

func parseRemoteCompletionOutput(output []byte, limit int) (terminal.CompletionResult, error) {
	if limit <= 0 {
		limit = sshCompletionLimit
	}
	candidates := make(map[string]terminal.CompletionCandidate)
	counts := map[byte]int{'D': 0, 'V': 0}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		tag, value, ok := bytes.Cut(line, []byte{'\t'})
		if !ok || len(tag) != 1 || (tag[0] != 'D' && tag[0] != 'V') || !validRemoteCompletionValue(value) {
			continue
		}
		counts[tag[0]]++
		key := string(value)
		if tag[0] == 'D' {
			key = strings.TrimSuffix(key, "/")
			if key == "" {
				continue
			}
		}
		candidate := terminal.CompletionCandidate{Value: key, IsDirectory: tag[0] == 'D'}
		if current, exists := candidates[key]; exists && current.IsDirectory {
			continue
		}
		candidates[key] = candidate
	}
	ordered := make([]terminal.CompletionCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.IsDirectory {
			candidate.Value = strings.TrimSuffix(candidate.Value, "/") + "/"
		}
		ordered = append(ordered, candidate)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Value == ordered[j].Value {
			return !ordered[i].IsDirectory && ordered[j].IsDirectory
		}
		return ordered[i].Value < ordered[j].Value
	})
	// Each source query is independently bounded to limit+1. Preserve the
	// source-level truncation signal even when directory/file results overlap
	// and deduplication reduces the merged list back to <= limit entries.
	hasMore := counts['D'] > limit || counts['V'] > limit || len(ordered) > limit
	if len(ordered) > limit {
		ordered = ordered[:limit]
	}
	return terminal.CompletionResult{Candidates: ordered, HasMore: hasMore}, nil
}

type completionWorkerResult struct {
	result terminal.CompletionResult
	err    error
}

func (r *Runtime) completeRemote(ctx context.Context, script, marker string, limit int) (terminal.CompletionResult, error) {
	session, err := r.openCompletionSession(ctx)
	if err != nil {
		return terminal.CompletionResult{}, err
	}
	var closeOnce sync.Once
	closeSession := func() {
		closeOnce.Do(func() { _ = session.Close() })
	}
	stopCancellation := make(chan struct{})
	cancellationStopped := make(chan struct{})
	go func() {
		defer close(cancellationStopped)
		select {
		case <-ctx.Done():
			closeSession()
		case <-r.closed:
			closeSession()
		case <-stopCancellation:
		}
	}()
	defer func() {
		close(stopCancellation)
		closeSession()
		<-cancellationStopped
	}()

	stdout := newCompletionBuffer(sshCompletionOutputMaxBytes, sshCompletionOutputMaxLines)
	stderr := newCompletionBuffer(sshCompletionErrorMaxBytes, sshCompletionErrorMaxLines)
	session.Stdout = stdout
	session.Stderr = stderr
	if err := session.Start(remoteCompletionCommand(script)); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return terminal.CompletionResult{}, ctxErr
		}
		select {
		case <-r.closed:
			return terminal.CompletionResult{}, errRuntimeClosed
		default:
		}
		return terminal.CompletionResult{}, fmt.Errorf("start remote completion: %w", err)
	}
	err = session.Wait()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return terminal.CompletionResult{}, ctxErr
	}
	select {
	case <-r.closed:
		return terminal.CompletionResult{}, errRuntimeClosed
	default:
	}
	output, outputOverflow := stdout.snapshot()
	errorOutput, errorOverflow := stderr.snapshot()
	if outputOverflow || errorOverflow {
		return terminal.CompletionResult{}, errors.New("remote completion output exceeded the safety limit")
	}
	if err != nil {
		// Keep remote stderr bounded for transport safety, but do not include it
		// in the public error. Login profiles and shell startup may print secrets.
		message := "remote command exited unsuccessfully"
		if bytes.Contains(errorOutput, []byte("remote bash compgen is unavailable")) {
			message = "remote bash compgen is unavailable"
		} else if bytes.Contains(errorOutput, []byte("remote completion cwd is unavailable")) {
			message = "remote completion cwd is unavailable"
		}
		return terminal.CompletionResult{}, fmt.Errorf("remote completion failed: %s", message)
	}
	payload, err := extractRemoteCompletionProtocol(output, marker)
	if err != nil {
		return terminal.CompletionResult{}, err
	}
	return parseRemoteCompletionOutput(payload, limit)
}

// Complete runs bounded bash compgen queries on a fresh SSH session. The
// interactive terminal channel and its stdin are never used by completion.
// A timed-out request returns immediately, while its worker retains one of the
// four slots until any blocked SSH operation and session cleanup have ended.
func (r *Runtime) Complete(ctx context.Context, request terminal.CompletionRequest) (terminal.CompletionResult, error) {
	if r == nil || (r.client == nil && r.newSession == nil) {
		return terminal.CompletionResult{}, terminal.ErrCompletionUnsupported
	}
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := r.completionTimeout
	if timeout <= 0 {
		timeout = sshCompletionTimeout
	}
	completionCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	limit := normalizeCompletionLimit(request.Limit)
	script, err := remoteCompletionScript(request, limit+1)
	if err != nil {
		return terminal.CompletionResult{}, err
	}
	marker, err := newCompletionProtocolMarker()
	if err != nil {
		return terminal.CompletionResult{}, err
	}
	script = wrapRemoteCompletionProtocol(script, marker)
	release, err := r.acquireCompletionSlot(completionCtx)
	if err != nil {
		return terminal.CompletionResult{}, err
	}

	completed := make(chan completionWorkerResult, 1)
	go func() {
		defer release()
		result, workerErr := r.completeRemote(completionCtx, script, marker, limit)
		completed <- completionWorkerResult{result: result, err: workerErr}
	}()

	select {
	case result := <-completed:
		if ctxErr := completionCtx.Err(); ctxErr != nil {
			return terminal.CompletionResult{}, ctxErr
		}
		select {
		case <-r.closed:
			return terminal.CompletionResult{}, errRuntimeClosed
		default:
		}
		return result.result, result.err
	case <-completionCtx.Done():
		return terminal.CompletionResult{}, completionCtx.Err()
	case <-r.closed:
		return terminal.CompletionResult{}, errRuntimeClosed
	}
}
