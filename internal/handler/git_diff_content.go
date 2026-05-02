package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Git diff endpoints are consumed by a browser. Keep both the process output
// and blob previews bounded so a generated diff or a checked-in artifact
// cannot turn one request into an unbounded allocation.
const (
	gitDiffPreviewLimit = 256 * 1024
	gitDiffPatchLimit   = 512 * 1024
	// Image previews are transported in an authenticated JSON response. Keep
	// the cap high enough for ordinary screenshots while bounding base64 and
	// browser allocations for repository artifacts.
	gitDiffImageLimit  = 4 * 1024 * 1024
	gitDiffBinaryProbe = 8 * 1024
	gitDiffErrorLimit  = 64 * 1024
	// Conflict resolution and partial-commit index reconciliation need the
	// complete file contents. Keep those operations useful for ordinary source
	// files while still preventing an accidentally selected artifact from
	// allocating without a bound.
	gitConflictContentLimit = 10 * 1024 * 1024
	// An index stores metadata for every tracked path, so it can legitimately
	// be larger than one source file. Keep a separate, higher cap while still
	// refusing an unbounded snapshot.
	gitIndexSnapshotLimit = 64 * 1024 * 1024
)

type gitBoundedCapture struct {
	buf       bytes.Buffer
	hash      hash.Hash
	limit     int64
	total     int64
	truncated bool
}

func newGitBoundedCapture(limit int64) *gitBoundedCapture {
	return &gitBoundedCapture{hash: sha256.New(), limit: limit}
}

func (capture *gitBoundedCapture) Write(p []byte) (int, error) {
	capture.total += int64(len(p))
	_, _ = capture.hash.Write(p)
	if capture.limit <= int64(capture.buf.Len()) {
		capture.truncated = true
		return len(p), nil
	}
	remaining := capture.limit - int64(capture.buf.Len())
	if int64(len(p)) > remaining {
		_, _ = capture.buf.Write(p[:remaining])
		capture.truncated = true
		return len(p), nil
	}
	_, _ = capture.buf.Write(p)
	return len(p), nil
}

func (capture *gitBoundedCapture) Bytes() []byte {
	return capture.buf.Bytes()
}

func (capture *gitBoundedCapture) Size() int64 {
	return capture.total
}

func (capture *gitBoundedCapture) Digest() string {
	return fmt.Sprintf("%x", capture.hash.Sum(nil)[:8])
}

// readGitFileBounded reads at most limit bytes plus one probe byte. The probe
// distinguishes an exactly-limit file from a file whose content was cut off.
// Callers that need a complete file must reject truncated=true instead of
// treating the returned prefix as the original content.
func readGitFileBounded(path string, limit int64) ([]byte, bool, error) {
	if limit < 0 {
		return nil, false, fmt.Errorf("invalid content limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()

	capture := newGitBoundedCapture(limit)
	if _, err := io.Copy(capture, io.LimitReader(file, limit+1)); err != nil {
		return nil, false, err
	}
	return append([]byte(nil), capture.Bytes()...), capture.truncated, nil
}

type gitContentPreview struct {
	content   []byte
	size      int64
	binary    bool
	truncated bool
	exists    bool
}

func isGitBinaryBytes(data []byte) bool {
	probe := data
	if len(probe) > gitDiffBinaryProbe {
		probe = probe[:gitDiffBinaryProbe]
	}
	if bytes.IndexByte(probe, 0) >= 0 {
		return true
	}
	// Git's binary diff heuristic treats bytes that are not valid text as
	// binary in practice. Keep invalid UTF-8 out of JSON string previews too.
	return !utf8.Valid(probe)
}

func previewGitReader(reader io.Reader, size int64) (gitContentPreview, error) {
	return previewGitReaderWithLimit(reader, size, gitDiffPreviewLimit)
}

func previewGitReaderWithLimit(reader io.Reader, size, limit int64) (gitContentPreview, error) {
	if limit < 0 {
		return gitContentPreview{}, fmt.Errorf("invalid preview limit")
	}
	capture := newGitBoundedCapture(limit + 1)
	if _, err := io.Copy(capture, io.LimitReader(reader, limit+1)); err != nil {
		return gitContentPreview{}, err
	}
	content := append([]byte(nil), capture.Bytes()...)
	truncated := capture.truncated
	if int64(len(content)) > limit {
		content = content[:int(limit)]
		truncated = true
	}
	if size < 0 {
		size = int64(len(content))
	}
	if size > int64(len(content)) {
		truncated = true
	}
	return gitContentPreview{
		content:   content,
		size:      size,
		binary:    isGitBinaryBytes(content),
		truncated: truncated,
		exists:    true,
	}, nil
}

func readWorkingGitPreview(path string) (gitContentPreview, error) {
	return readWorkingGitPreviewWithLimit(path, gitDiffPreviewLimit)
}

func readWorkingGitPreviewWithLimit(path string, limit int64) (gitContentPreview, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return gitContentPreview{}, nil
		}
		return gitContentPreview{}, err
	}
	if info.IsDir() {
		return gitContentPreview{}, nil
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, readErr := os.Readlink(path)
		if readErr != nil {
			return gitContentPreview{}, readErr
		}
		return previewGitReaderWithLimit(strings.NewReader(target), int64(len(target)), limit)
	}
	file, err := os.Open(path)
	if err != nil {
		return gitContentPreview{}, err
	}
	defer file.Close()
	return previewGitReaderWithLimit(file, info.Size(), limit)
}

func readGitObjectSize(repoRoot, spec string) (int64, error) {
	cmd := newGitCommand("cat-file", "-s", spec)
	cmd.Dir = repoRoot
	capture, stderr, err := runGitBoundedOutput(cmd, 128)
	if err != nil {
		return 0, gitCommandError(err, stderr.Bytes())
	}
	if capture.truncated {
		return 0, fmt.Errorf("invalid git object size")
	}
	size, err := strconv.ParseInt(strings.TrimSpace(string(capture.Bytes())), 10, 64)
	if err != nil || size < 0 {
		return 0, fmt.Errorf("invalid git object size")
	}
	return size, nil
}

func readGitObjectPreview(repoRoot, spec string) (gitContentPreview, error) {
	return readGitObjectPreviewWithLimit(repoRoot, spec, gitDiffPreviewLimit)
}

func readGitObjectPreviewWithLimit(repoRoot, spec string, limit int64) (gitContentPreview, error) {
	size, err := readGitObjectSize(repoRoot, spec)
	if err != nil {
		return gitContentPreview{}, err
	}
	cmd := newGitCommand("cat-file", "blob", spec)
	cmd.Dir = repoRoot
	capture, stderr, err := runGitBoundedOutput(cmd, limit)
	if err != nil {
		return gitContentPreview{}, gitCommandError(err, stderr.Bytes())
	}
	content := append([]byte(nil), capture.Bytes()...)
	truncated := capture.truncated || size > int64(len(content))
	return gitContentPreview{
		content:   content,
		size:      size,
		binary:    isGitBinaryBytes(content),
		truncated: truncated,
		exists:    true,
	}, nil
}

// gitImageMimeType intentionally excludes SVG and other active/document
// formats. The returned MIME is used only for data URLs rendered in an img.
// Content sniffing wins over the extension when possible; the extension
// fallback keeps one-sided (deleted/added) previews useful when Git returned
// only a short or unusual binary header.
func gitImageMimeType(path string, previews ...gitContentPreview) string {
	detectedImageMime := ""
	for _, preview := range previews {
		if len(preview.content) == 0 {
			continue
		}
		detected := strings.TrimSpace(strings.SplitN(http.DetectContentType(preview.content), ";", 2)[0])
		if isSafeGitImageMime(detected) {
			if detectedImageMime == "" {
				detectedImageMime = detected
			}
			continue
		}
		if !preview.binary {
			return ""
		}
	}
	if detectedImageMime != "" {
		return detectedImageMime
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".bmp":
		return "image/bmp"
	case ".avif":
		return "image/avif"
	default:
		return ""
	}
}

func isSafeGitImageMime(mimeType string) bool {
	switch mimeType {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/bmp", "image/avif":
		return true
	default:
		return false
	}
}

type gitImagePreview struct {
	image    bool
	mimeType string
	old      string
	new      string
}

func gitDiffPreviewLimitForPath(path string) int64 {
	if gitImageMimeType(path) != "" {
		return gitDiffImageLimit
	}
	return gitDiffPreviewLimit
}

// GitImageDiff is the bounded, browser-safe representation of an image diff.
// Empty sides represent an added or deleted image. Contents are base64 encoded
// only after the MIME has been restricted to inert raster formats.
type GitImageDiff struct {
	MimeType string `json:"mimeType"`
	Old      string `json:"old,omitempty"`
	New      string `json:"new,omitempty"`
}

func buildGitImagePreview(path string, oldPreview, newPreview gitContentPreview) gitImagePreview {
	mimeType := gitImageMimeType(path, oldPreview, newPreview)
	if mimeType == "" || (!oldPreview.exists && !newPreview.exists) {
		return gitImagePreview{}
	}
	result := gitImagePreview{image: true, mimeType: mimeType}
	if oldPreview.exists && !oldPreview.truncated && len(oldPreview.content) > 0 {
		result.old = base64.StdEncoding.EncodeToString(oldPreview.content)
	}
	if newPreview.exists && !newPreview.truncated && len(newPreview.content) > 0 {
		result.new = base64.StdEncoding.EncodeToString(newPreview.content)
	}
	return result
}

func (preview gitImagePreview) response() *GitImageDiff {
	if !preview.image {
		return nil
	}
	return &GitImageDiff{MimeType: preview.mimeType, Old: preview.old, New: preview.new}
}

func runGitBoundedOutput(cmd *exec.Cmd, limit int64) (*gitBoundedCapture, *gitBoundedCapture, error) {
	stdout := newGitBoundedCapture(limit)
	stderr := newGitBoundedCapture(gitDiffErrorLimit)
	if cmd == nil {
		return stdout, stderr, fmt.Errorf("git command is required")
	}
	if limit < 0 {
		return stdout, stderr, fmt.Errorf("invalid output limit")
	}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return stdout, stderr, err
	}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return stdout, stderr, err
	}
	_, readErr := io.Copy(stdout, io.LimitReader(pipe, limit+1))
	if stdout.truncated {
		// Stop a large diff producer as soon as the bounded preview has been
		// captured. This protects both memory and request latency.
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return stdout, stderr, readErr
	}
	if waitErr != nil && !stdout.truncated {
		return stdout, stderr, waitErr
	}
	return stdout, stderr, nil
}

func gitPreviewText(preview gitContentPreview) string {
	if !preview.exists || preview.binary || preview.truncated {
		return ""
	}
	return string(preview.content)
}
