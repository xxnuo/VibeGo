package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
	"github.com/xxnuo/vibego/internal/service/terminal"
)

type blockTermCompletionTestResponse struct {
	Kind         string                         `json:"kind"`
	Prefix       string                         `json:"prefix"`
	CommonPrefix string                         `json:"common_prefix"`
	HasMore      bool                           `json:"has_more"`
	Candidates   []blockTermCompletionCandidate `json:"candidates"`
}

type blockTermProfileCompletionCall struct {
	ProfileID string
	Request   terminal.CompletionRequest
}

type blockTermCompletionSSHRuntime struct {
	closed chan struct{}
	once   sync.Once
}

type blockTermCompletionProvider func(context.Context, terminal.CompletionRequest) (terminal.CompletionResult, error)

func (p blockTermCompletionProvider) Complete(ctx context.Context, request terminal.CompletionRequest) (terminal.CompletionResult, error) {
	return p(ctx, request)
}

type blockTermProfileCompletionProvider func(context.Context, string, terminal.CompletionRequest) (terminal.CompletionResult, error)

func (p blockTermProfileCompletionProvider) CompleteProfile(
	ctx context.Context,
	profileID string,
	request terminal.CompletionRequest,
) (terminal.CompletionResult, error) {
	return p(ctx, profileID, request)
}

type blockTermCompletionProviderRuntime struct {
	*blockTermCompletionSSHRuntime
	provider terminal.CompletionProvider
}

func (r *blockTermCompletionProviderRuntime) Capabilities() terminal.TerminalCapabilities {
	return terminal.TerminalCapabilities{Completion: true}
}

func (r *blockTermCompletionProviderRuntime) Complete(ctx context.Context, request terminal.CompletionRequest) (terminal.CompletionResult, error) {
	return r.provider.Complete(ctx, request)
}

func (r *blockTermCompletionSSHRuntime) Type() string { return terminal.RuntimeTypeSSH }

func (r *blockTermCompletionSSHRuntime) Capabilities() terminal.TerminalCapabilities {
	return terminal.TerminalCapabilities{}
}

func (r *blockTermCompletionSSHRuntime) Read([]byte) (int, error) {
	<-r.closed
	return 0, io.EOF
}

func (r *blockTermCompletionSSHRuntime) Write(p []byte) (int, error) { return len(p), nil }
func (r *blockTermCompletionSSHRuntime) Resize(int, int) error       { return nil }
func (r *blockTermCompletionSSHRuntime) ExitCode() int               { return 0 }

func (r *blockTermCompletionSSHRuntime) Close() error {
	r.once.Do(func() { close(r.closed) })
	return nil
}

func (r *blockTermCompletionSSHRuntime) Wait(ctx context.Context) error {
	select {
	case <-r.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type blockTermCompletionRuntimeFactory struct {
	provider        terminal.CompletionProvider
	profileProvider blockTermProfileCompletionProvider
}

func (f blockTermCompletionRuntimeFactory) CreateRuntime(
	context.Context,
	terminal.RuntimeCreateRequest,
) (terminal.TerminalRuntime, error) {
	base := &blockTermCompletionSSHRuntime{closed: make(chan struct{})}
	if f.provider == nil {
		return base, nil
	}
	return &blockTermCompletionProviderRuntime{
		blockTermCompletionSSHRuntime: base,
		provider:                      f.provider,
	}, nil
}

func (f blockTermCompletionRuntimeFactory) CompleteProfile(
	ctx context.Context,
	profileID string,
	request terminal.CompletionRequest,
) (terminal.CompletionResult, error) {
	if f.profileProvider == nil {
		return terminal.CompletionResult{}, terminal.ErrCompletionUnsupported
	}
	return f.profileProvider.CompleteProfile(ctx, profileID, request)
}

func setupBlockTermCompletionSSHHandler(t *testing.T) (blockTermTestEnv, *terminal.Manager) {
	return setupBlockTermCompletionSSHHandlerWithProvider(t, nil)
}

func setupBlockTermCompletionSSHHandlerWithProvider(t *testing.T, provider terminal.CompletionProvider) (blockTermTestEnv, *terminal.Manager) {
	return setupBlockTermCompletionSSHHandlerWithFactory(t, blockTermCompletionRuntimeFactory{provider: provider})
}

func setupBlockTermCompletionSSHHandlerWithFactory(
	t *testing.T,
	factory blockTermCompletionRuntimeFactory,
) (blockTermTestEnv, *terminal.Manager) {
	t.Helper()
	env := setupBlockTermHandler(t)
	manager := terminal.NewManager(env.db, &terminal.ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: factory,
	})
	router := gin.New()
	NewBlockTermHandler(manager).Register(router.Group("/api"))
	return blockTermTestEnv{db: env.db, manager: manager, router: router}, manager
}

func doBlockTermCompletionJSONContext(t *testing.T, ctx context.Context, router http.Handler, payload any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(payload)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/blockterm/completion", strings.NewReader(string(encoded))).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestParseBlockTermCompletionContext(t *testing.T) {
	tests := []struct {
		name      string
		prefix    string
		wantKind  blockTermCompletionKind
		wantRaw   string
		wantValue string
	}{
		{name: "initial command", prefix: "ec", wantKind: blockTermCompletionCommand, wantRaw: "ec", wantValue: "ec"},
		{name: "argument path", prefix: "echo fi", wantKind: blockTermCompletionPath, wantRaw: "fi", wantValue: "fi"},
		{name: "pipe command", prefix: "printf x | ec", wantKind: blockTermCompletionCommand, wantRaw: "ec", wantValue: "ec"},
		{name: "newline command", prefix: "printf x\nec", wantKind: blockTermCompletionCommand, wantRaw: "ec", wantValue: "ec"},
		{name: "assignment before command", prefix: "LANG=C ec", wantKind: blockTermCompletionCommand, wantRaw: "ec", wantValue: "ec"},
		{name: "assignment value is not completed", prefix: "LANG=fo", wantKind: blockTermCompletionNone, wantRaw: "LANG=fo", wantValue: "LANG=fo"},
		{name: "redirect target", prefix: "echo > fi", wantKind: blockTermCompletionPath, wantRaw: "fi", wantValue: "fi"},
		{name: "fd redirect before command", prefix: "2>log ec", wantKind: blockTermCompletionCommand, wantRaw: "ec", wantValue: "ec"},
		{name: "command path", prefix: "./to", wantKind: blockTermCompletionExecutablePath, wantRaw: "./to", wantValue: "./to"},
		{name: "escaped argument", prefix: `cat space\ n`, wantKind: blockTermCompletionPath, wantRaw: `space\ n`, wantValue: "space n"},
		{name: "single quoted argument", prefix: `cat 'space n`, wantKind: blockTermCompletionPath, wantRaw: `'space n`, wantValue: "space n"},
		{name: "double quoted argument", prefix: `cat "space n`, wantKind: blockTermCompletionPath, wantRaw: `"space n`, wantValue: "space n"},
		{name: "variable expansion", prefix: `echo $HO`, wantKind: blockTermCompletionNone, wantRaw: `$HO`, wantValue: `$HO`},
		{name: "command substitution", prefix: "echo \"$(tou", wantKind: blockTermCompletionNone, wantRaw: `"$(tou`, wantValue: "$(tou"},
		{name: "glob expansion", prefix: `echo *.go`, wantKind: blockTermCompletionNone, wantRaw: `*.go`, wantValue: `*.go`},
		{name: "trailing escape", prefix: `echo file\`, wantKind: blockTermCompletionNone, wantRaw: `file\`, wantValue: "file"},
		{name: "comment", prefix: `echo ok # fi`, wantKind: blockTermCompletionNone},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			completionContext := parseBlockTermCompletionContext(test.prefix)
			require.Equal(t, test.wantKind, completionContext.kind)
			require.Equal(t, test.wantRaw, completionContext.word.raw)
			require.Equal(t, test.wantValue, completionContext.word.value)
		})
	}
}

func TestCompleteBlockTermPathQuotesAndExecutables(t *testing.T) {
	cwd := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(cwd, "space dir"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(cwd, "space name.txt"), []byte("text"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(cwd, "plain.txt"), []byte("text"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(cwd, ".hidden"), []byte("hidden"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(cwd, "run tool"), []byte("#!/bin/sh\n"), 0o755))

	tests := []struct {
		name            string
		prefix          string
		wantLabel       string
		wantReplacement string
		wantReplaceText string
	}{
		{
			name:            "unquoted file",
			prefix:          "cat spa",
			wantLabel:       "space name.txt",
			wantReplacement: `space\ name.txt `,
			wantReplaceText: "spa",
		},
		{
			name:            "escaped file prefix",
			prefix:          `cat space\ n`,
			wantLabel:       "space name.txt",
			wantReplacement: `space\ name.txt `,
			wantReplaceText: `space\ n`,
		},
		{
			name:            "single quoted file",
			prefix:          `cat 'spa`,
			wantLabel:       "space name.txt",
			wantReplacement: `'space name.txt' `,
			wantReplaceText: `'spa`,
		},
		{
			name:            "double quoted file",
			prefix:          `cat "spa`,
			wantLabel:       "space name.txt",
			wantReplacement: `"space name.txt" `,
			wantReplaceText: `"spa`,
		},
		{
			name:            "directory keeps traversal open",
			prefix:          "cat spa",
			wantLabel:       "space dir/",
			wantReplacement: `space\ dir/`,
			wantReplaceText: "spa",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			suggestions := completeBlockTermPrefix(context.Background(), cwd, test.prefix, "")
			var matched *blockTermCompletionSuggestion
			for index := range suggestions {
				if suggestions[index].Label == test.wantLabel {
					matched = &suggestions[index]
					break
				}
			}
			require.NotNil(t, matched)
			require.Equal(t, test.wantReplacement, matched.Replacement)
			require.Equal(t, test.wantReplaceText, matched.ReplaceText)
		})
	}

	argumentSuggestions := completeBlockTermPrefix(context.Background(), cwd, "cat pl", "")
	require.Equal(t, []string{"plain.txt"}, blockTermCompletionLabels(argumentSuggestions))
	require.Empty(t, completeBlockTermPrefix(context.Background(), cwd, "cat hi", ""))
	require.Equal(t, []string{".hidden"}, blockTermCompletionLabels(completeBlockTermPrefix(context.Background(), cwd, "cat .h", "")))

	commandPathSuggestions := completeBlockTermPrefix(context.Background(), cwd, "./r", "")
	require.Equal(t, []string{"./run tool"}, blockTermCompletionLabels(commandPathSuggestions))
	require.Empty(t, completeBlockTermPrefix(context.Background(), cwd, "./p", ""))
}

func TestCompleteBlockTermCommandsUsesPATHWithoutExecuting(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable permission test uses POSIX mode bits")
	}
	cwd := t.TempDir()
	firstBin := t.TempDir()
	secondBin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(firstBin, "tool-one"), []byte("not a script"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(firstBin, "tool-noexec"), []byte("text"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(secondBin, "tool-one"), []byte("duplicate"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(secondBin, "tool-two"), []byte("not a script"), 0o755))
	pathEnv := strings.Join([]string{firstBin, secondBin}, string(os.PathListSeparator))

	suggestions := completeBlockTermPrefix(context.Background(), cwd, "tool-", pathEnv)
	require.Equal(t, []string{"tool-one", "tool-two"}, blockTermCompletionLabels(suggestions))
	for _, suggestion := range suggestions {
		require.Equal(t, "command", suggestion.Kind)
		require.Equal(t, suggestion.Label+" ", suggestion.Replacement)
	}

	marker := filepath.Join(cwd, "must-not-exist")
	unsafePrefix := `echo "$(touch ` + marker + `)`
	require.Empty(t, completeBlockTermPrefix(context.Background(), cwd, unsafePrefix, pathEnv))
	_, err := os.Stat(marker)
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestCompleteBlockTermCommandsIncludesSafeBuiltins(t *testing.T) {
	for _, builtin := range []string{"cd", "export", "unset", "alias", "source", "type"} {
		t.Run(builtin, func(t *testing.T) {
			suggestions := completeBlockTermPrefix(context.Background(), t.TempDir(), builtin, "")
			require.Contains(t, blockTermCompletionLabels(suggestions), builtin)
			for _, suggestion := range suggestions {
				if suggestion.Label == builtin {
					require.Equal(t, "command", suggestion.Kind)
					require.Equal(t, builtin+" ", suggestion.Replacement)
				}
			}
		})
	}
}

func TestCompleteBlockTermCommandsBoundsPATHDirectories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable permission test uses POSIX mode bits")
	}
	root := t.TempDir()
	pathDirs := make([]string, 0, blockTermCompletionMaxPATHDirs+1)
	for index := 0; index <= blockTermCompletionMaxPATHDirs; index++ {
		directory := filepath.Join(root, fmt.Sprintf("bin-%03d", index))
		require.NoError(t, os.Mkdir(directory, 0o755))
		pathDirs = append(pathDirs, directory)
	}
	require.NoError(t, os.WriteFile(filepath.Join(pathDirs[len(pathDirs)-1], "beyond-path-limit"), []byte("binary"), 0o755))
	pathEnv := strings.Join(pathDirs, string(os.PathListSeparator))
	require.Empty(t, completeBlockTermPrefix(context.Background(), root, "beyond-", pathEnv))
}

func TestReadBlockTermCompletionDirIsBounded(t *testing.T) {
	directory := t.TempDir()
	for index := 0; index <= blockTermCompletionMaxDirScan; index++ {
		name := filepath.Join(directory, fmt.Sprintf("entry-%05d", index))
		require.NoError(t, os.WriteFile(name, nil, 0o644))
	}
	entries, err := readBlockTermCompletionDir(directory)
	require.NoError(t, err)
	require.Len(t, entries, blockTermCompletionMaxDirScan)
}

func TestBlockTermCompletionCommonPrefixUsesWholeRunes(t *testing.T) {
	suggestions := []blockTermCompletionSuggestion{{Label: "前缀甲"}, {Label: "前缀乙"}}
	require.Equal(t, "前缀", blockTermCompletionCommonPrefix(suggestions))
}

func TestCompleteBlockTermPathExpandsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	require.NoError(t, os.WriteFile(filepath.Join(home, "home-file.txt"), nil, 0o600))
	require.Equal(t, []string{"~/"}, blockTermCompletionLabels(
		completeBlockTermPrefix(context.Background(), t.TempDir(), "cat ~", ""),
	))
	require.Equal(t, []string{"~/home-file.txt"}, blockTermCompletionLabels(
		completeBlockTermPrefix(context.Background(), t.TempDir(), "cat ~/home-", ""),
	))
}

func TestBlockTermCompletionHandler(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("handler executable test uses POSIX mode bits")
	}
	env := setupBlockTermHandler(t)
	cwd := t.TempDir()
	binDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(binDir, "vibego-tool"), []byte("binary"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(binDir, "vibego-test"), []byte("binary"), 0o755))
	t.Setenv("PATH", binDir)
	seedBlockTermTerminal(t, env.db, "term-local")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-local").Updates(map[string]any{
		"runtime_type": "local",
		"current_cwd":  cwd,
	}).Error)

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completions", map[string]any{
		"terminal_id": "term-local",
		"prefix":      "vibego-",
	})
	require.Equal(t, http.StatusOK, response.Code)
	var body struct {
		Kind         string                          `json:"kind"`
		Prefix       string                          `json:"prefix"`
		CommonPrefix string                          `json:"common_prefix"`
		HasMore      bool                            `json:"has_more"`
		Candidates   []blockTermCompletionCandidate  `json:"candidates"`
		Suggestions  []blockTermCompletionSuggestion `json:"suggestions"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, "command", body.Kind)
	require.Equal(t, "vibego-", body.Prefix)
	require.Equal(t, "vibego-t", body.CommonPrefix)
	require.False(t, body.HasMore)
	require.Equal(t, []blockTermCompletionCandidate{
		{Value: "vibego-test", Display: "vibego-test"},
		{Value: "vibego-tool", Display: "vibego-tool"},
	}, body.Candidates)
	require.Equal(t, []string{"vibego-test", "vibego-tool"}, blockTermCompletionLabels(body.Suggestions))

	seedBlockTermTerminal(t, env.db, "term-remote")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-remote").Update("runtime_type", "ssh").Error)
	remote := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completions", map[string]any{
		"terminal_id": "term-remote",
		"prefix":      "vibego-",
	})
	require.Equal(t, http.StatusBadRequest, remote.Code)
	require.Contains(t, remote.Body.String(), "only available for local terminals")

	missing := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completions", map[string]any{
		"terminal_id": "missing",
		"prefix":      "vibego-",
	})
	require.Equal(t, http.StatusNotFound, missing.Code)

	overlong := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completions", map[string]any{
		"terminal_id": "term-local",
		"prefix":      strings.Repeat("x", blockTermCompletionMaxPrefixLen+1),
	})
	require.Equal(t, http.StatusBadRequest, overlong.Code)

	oversizedBody := `{"terminal_id":"term-local","prefix":"`
	oversizedBody += strings.Repeat("x", blockTermCompletionMaxBody) + `"}`
	oversizedRequest := httptest.NewRequest(http.MethodPost, "/api/blockterm/completions", strings.NewReader(oversizedBody))
	oversizedRequest.Header.Set("Content-Type", "application/json")
	oversized := httptest.NewRecorder()
	env.router.ServeHTTP(oversized, oversizedRequest)
	require.Equal(t, http.StatusRequestEntityTooLarge, oversized.Code)
}

func TestBlockTermCompletionHandlerSupportsEndpointAliases(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("handler executable test uses POSIX mode bits")
	}
	env := setupBlockTermHandler(t)
	cwd := t.TempDir()
	binDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(binDir, "vibego-alias"), []byte("binary"), 0o755))
	t.Setenv("PATH", binDir)
	seedBlockTermTerminal(t, env.db, "term-alias")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-alias").Updates(map[string]any{
		"runtime_type": "local",
		"current_cwd":  cwd,
	}).Error)

	payload := map[string]any{"terminal_id": "term-alias", "prefix": "vibego-"}
	paths := []string{
		"/api/blockterm/complete",
		"/api/blockterm/completion",
		"/api/blockterm/completions",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodPost, path, payload)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var body struct {
				Kind       string                         `json:"kind"`
				Prefix     string                         `json:"prefix"`
				Candidates []blockTermCompletionCandidate `json:"candidates"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, "command", body.Kind)
			require.Equal(t, "vibego-", body.Prefix)
			require.Equal(t, []blockTermCompletionCandidate{{
				Value: "vibego-alias", Display: "vibego-alias",
			}}, body.Candidates)
		})
	}
}

func blockTermCompletionLabels(suggestions []blockTermCompletionSuggestion) []string {
	labels := make([]string, 0, len(suggestions))
	for _, suggestion := range suggestions {
		labels = append(labels, suggestion.Label)
	}
	return labels
}

func TestBlockTermCompletionHandlerBoundsCandidates(t *testing.T) {
	env := setupBlockTermHandler(t)
	cwd := t.TempDir()
	for index := 0; index <= blockTermCompletionLimit; index++ {
		name := filepath.Join(cwd, fmt.Sprintf("bounded-%03d", index))
		require.NoError(t, os.WriteFile(name, nil, 0o600))
	}
	seedBlockTermTerminal(t, env.db, "term-bounded")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-bounded").Updates(map[string]any{
		"runtime_type": "local",
		"current_cwd":  cwd,
	}).Error)

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completions", map[string]any{
		"terminal_id": "term-bounded",
		"prefix":      "cat bounded-",
	})
	require.Equal(t, http.StatusOK, response.Code)
	var body struct {
		CommonPrefix string                         `json:"common_prefix"`
		HasMore      bool                           `json:"has_more"`
		Candidates   []blockTermCompletionCandidate `json:"candidates"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.HasMore)
	require.Equal(t, "bounded-", body.CommonPrefix)
	require.Len(t, body.Candidates, blockTermCompletionLimit)
}

func createActiveBlockTermCompletionTerminal(t *testing.T, env blockTermTestEnv, cwd string) string {
	t.Helper()
	info, err := env.manager.Create(terminal.CreateOptions{Name: "completion active", Cwd: cwd})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, env.manager.Close(info.ID)) })
	return info.ID
}

func TestBlockTermCompletionNewProtocolUsesActiveCurrentCwd(t *testing.T) {
	env := setupBlockTermHandler(t)
	initialDir := t.TempDir()
	currentDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(initialDir, "initial.txt"), nil, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(currentDir, "current file.txt"), nil, 0o600))
	require.NoError(t, os.Mkdir(filepath.Join(currentDir, "current-dir"), 0o700))
	terminalID := createActiveBlockTermCompletionTerminal(t, env, initialDir)
	require.NoError(t, env.manager.UpdateShellMetadata(terminalID, terminal.ShellMetadataUpdate{CurrentCwd: &currentDir}))

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id":     terminalID,
		"cwd":             12345,
		"draft":           "cat curr",
		"cursor":          8,
		"prefix":          "curr",
		"kind":            "file",
		"executable_only": false,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body blockTermCompletionTestResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, "file", body.Kind)
	require.Equal(t, "curr", body.Prefix)
	require.Equal(t, "current", body.CommonPrefix)
	require.Equal(t, []blockTermCompletionCandidate{
		{Value: "current file.txt", Display: "current file.txt"},
		{Value: "current-dir/", Display: "current-dir/", IsDirectory: true},
	}, body.Candidates)
}

func TestBlockTermCompletionNewProtocolUsesUTF16Cursor(t *testing.T) {
	env := setupBlockTermHandler(t)
	cwd := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(cwd, "😀-target"), nil, 0o600))
	terminalID := createActiveBlockTermCompletionTerminal(t, env, cwd)

	valid := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": terminalID,
		"draft":       "cat 😀",
		"cursor":      6, // "cat " is four units and 😀 is two UTF-16 units.
		"prefix":      "😀",
		"kind":        "file",
	})
	require.Equal(t, http.StatusOK, valid.Code, valid.Body.String())
	var body blockTermCompletionTestResponse
	require.NoError(t, json.Unmarshal(valid.Body.Bytes(), &body))
	require.Equal(t, []blockTermCompletionCandidate{{Value: "😀-target", Display: "😀-target"}}, body.Candidates)

	split := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": terminalID,
		"draft":       "cat 😀",
		"cursor":      5,
		"prefix":      "😀",
		"kind":        "file",
	})
	require.Equal(t, http.StatusBadRequest, split.Code, split.Body.String())
	require.Contains(t, split.Body.String(), "cursor is outside draft")
}

func TestBlockTermCompletionNewProtocolAliasesAndLegacyRequest(t *testing.T) {
	env := setupBlockTermHandler(t)
	cwd := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(cwd, "alias-target"), nil, 0o600))
	terminalID := createActiveBlockTermCompletionTerminal(t, env, cwd)

	payload := map[string]any{
		"terminal_id": terminalID,
		"draft":       "cat alias-",
		"cursor":      10,
		"prefix":      "alias-",
		"kind":        "file",
	}
	var first blockTermCompletionTestResponse
	for index, path := range []string{
		"/api/blockterm/complete",
		"/api/blockterm/completion",
		"/api/blockterm/completions",
	} {
		response := doBlockTermJSON(t, env.router, http.MethodPost, path, payload)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var body blockTermCompletionTestResponse
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
		if index == 0 {
			first = body
		} else {
			require.Equal(t, first, body)
		}
	}

	legacy := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": terminalID,
		"cwd":         cwd,
		"prefix":      "cat alias-",
	})
	require.Equal(t, http.StatusOK, legacy.Code, legacy.Body.String())
	var legacyBody struct {
		Suggestions []blockTermCompletionSuggestion `json:"suggestions"`
	}
	require.NoError(t, json.Unmarshal(legacy.Body.Bytes(), &legacyBody))
	require.Equal(t, []string{"alias-target"}, blockTermCompletionLabels(legacyBody.Suggestions))
}

func TestBlockTermCompletionNewProtocolUsesDurableBlockContext(t *testing.T) {
	env := setupBlockTermHandler(t)
	parentCwd := t.TempDir()
	blockCwd := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(parentCwd, "parent-target"), nil, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(blockCwd, "durable-target"), nil, 0o600))
	terminalID := createActiveBlockTermCompletionTerminal(t, env, parentCwd)
	createdAt := int64(1_700_000_123)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "durable-completion", TerminalID: terminalID, LineNum: 1,
		Kind: "command", RuntimeType: terminal.RuntimeTypeLocal, Cwd: blockCwd,
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}).Error)

	payload := func(timestamp int64) map[string]any {
		return map[string]any{
			"terminal_id": terminalID, "block_id": "durable-completion", "block_created_at": timestamp,
			"draft": "cat durable-", "cursor": 12, "prefix": "durable-", "kind": "file",
			"runtime_type": terminal.RuntimeTypeLocal, "ssh_profile_id": "", "cwd": blockCwd,
		}
	}
	for _, timestamp := range []int64{createdAt, createdAt * 1000} {
		response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", payload(timestamp))
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var body blockTermCompletionTestResponse
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
		require.Equal(t, []blockTermCompletionCandidate{{Value: "durable-target", Display: "durable-target"}}, body.Candidates)
	}

	conflicts := []struct {
		name  string
		field string
		value any
	}{
		{name: "runtime", field: "runtime_type", value: terminal.RuntimeTypeSSH},
		{name: "profile", field: "ssh_profile_id", value: "forged-profile"},
		{name: "cwd", field: "cwd", value: parentCwd},
	}
	for _, test := range conflicts {
		t.Run(test.name, func(t *testing.T) {
			forged := payload(createdAt)
			forged[test.field] = test.value
			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", forged)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), "completion_context_conflict")
		})
	}
}

func TestBlockTermCompletionNewProtocolFencesDurableBlockIdentity(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminalID := createActiveBlockTermCompletionTerminal(t, env, t.TempDir())
	seedBlockTermTerminal(t, env.db, "completion-other-terminal")
	createdAt := int64(123)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "other-terminal-block", TerminalID: "completion-other-terminal", LineNum: 1,
		Kind: "command", RuntimeType: terminal.RuntimeTypeLocal, Cwd: ".",
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}).Error)
	request := func(blockID string, timestamp int64) map[string]any {
		return map[string]any{
			"terminal_id": terminalID, "block_id": blockID, "block_created_at": timestamp,
			"draft": "cat x", "cursor": 5, "prefix": "x", "kind": "file",
		}
	}

	scope := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", request("other-terminal-block", createdAt))
	require.Equal(t, http.StatusBadRequest, scope.Code, scope.Body.String())
	require.Contains(t, scope.Body.String(), "completion_block_scope")

	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "timestamp-block", TerminalID: terminalID, LineNum: 1,
		Kind: "command", RuntimeType: terminal.RuntimeTypeLocal, Cwd: ".",
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}).Error)
	mismatch := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", request("timestamp-block", createdAt+1))
	require.Equal(t, http.StatusConflict, mismatch.Code, mismatch.Body.String())
	require.Contains(t, mismatch.Body.String(), "completion_block_timestamp_mismatch")

	missing := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", request("missing-block", createdAt))
	require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())
	require.Contains(t, missing.Body.String(), "completion_block_not_found")
}

func TestBlockTermCompletionNewProtocolFallsBackToUnpurgedHistory(t *testing.T) {
	env := setupBlockTermHandler(t)
	parentCwd := t.TempDir()
	historyCwd := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(historyCwd, "history-target"), nil, 0o600))
	terminalID := createActiveBlockTermCompletionTerminal(t, env, parentCwd)
	createdAt := int64(1_700_000_456)
	deletedAt := int64(789)
	require.NoError(t, env.db.Create(&model.BlockTermCommandHistory{
		ID: "deleted-history-block", TerminalID: terminalID, LineNum: 1,
		Command: "cat history-", Kind: "command", RuntimeType: terminal.RuntimeTypeLocal, Cwd: historyCwd,
		CreatedAt: createdAt, BlockDeletedAt: &deletedAt,
	}).Error)

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": terminalID, "block_id": "deleted-history-block", "block_created_at": createdAt * 1000,
		"draft": "cat history-", "cursor": 12, "prefix": "history-", "kind": "file",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body blockTermCompletionTestResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, []blockTermCompletionCandidate{{Value: "history-target", Display: "history-target"}}, body.Candidates)

	purgedAt := int64(999)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).
		Where("id = ?", "deleted-history-block").
		Update("history_purged_at", purgedAt).Error)
	purged := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": terminalID, "block_id": "deleted-history-block", "block_created_at": createdAt,
		"draft": "cat history-", "cursor": 12, "prefix": "history-", "kind": "file",
	})
	require.Equal(t, http.StatusNotFound, purged.Code, purged.Body.String())
	require.Contains(t, purged.Body.String(), "completion_block_not_found")
}

func TestBlockTermCompletionNextConnectionUsesIdentityScopedCwdAndProfileProvider(t *testing.T) {
	activeRequests := make(chan terminal.CompletionRequest, 1)
	profileRequests := make(chan blockTermProfileCompletionCall, 1)
	factory := blockTermCompletionRuntimeFactory{
		provider: blockTermCompletionProvider(func(_ context.Context, request terminal.CompletionRequest) (terminal.CompletionResult, error) {
			activeRequests <- request
			return terminal.CompletionResult{Candidates: []terminal.CompletionCandidate{{Value: "remote-active"}}}, nil
		}),
		profileProvider: blockTermProfileCompletionProvider(func(
			_ context.Context,
			profileID string,
			request terminal.CompletionRequest,
		) (terminal.CompletionResult, error) {
			profileRequests <- blockTermProfileCompletionCall{ProfileID: profileID, Request: request}
			return terminal.CompletionResult{Candidates: []terminal.CompletionCandidate{{Value: "remote-profile"}}}, nil
		}),
	}
	env, manager := setupBlockTermCompletionSSHHandlerWithFactory(t, factory)
	initialCwd := t.TempDir()
	currentCwd := t.TempDir()
	info, err := manager.Create(terminal.CreateOptions{
		Name: "completion identity", Cwd: initialCwd, RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: "profile-a",
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })
	require.NoError(t, manager.UpdateShellMetadata(info.ID, terminal.ShellMetadataUpdate{CurrentCwd: &currentCwd}))

	setNextConnection := func(profileID, cwd string) {
		viewJSON, marshalErr := json.Marshal(map[string]any{
			"next_connection": map[string]any{
				"runtime_type": terminal.RuntimeTypeSSH, "ssh_profile_id": profileID, "cwd": cwd,
			},
		})
		require.NoError(t, marshalErr)
		require.NoError(t, env.db.Model(&model.TerminalSession{}).
			Where("id = ?", info.ID).
			Update("blockterm_view_json", string(viewJSON)).Error)
	}
	request := func(profileID, cwd string) map[string]any {
		return map[string]any{
			"terminal_id": info.ID, "draft": "cat rem", "cursor": 7, "prefix": "rem", "kind": "file",
			"runtime_type": terminal.RuntimeTypeSSH, "ssh_profile_id": profileID, "cwd": cwd,
		}
	}

	setNextConnection("profile-a", "/durable-active-cwd")
	sameIdentity := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", request("profile-a", "/durable-active-cwd"))
	require.Equal(t, http.StatusOK, sameIdentity.Code, sameIdentity.Body.String())
	select {
	case activeRequest := <-activeRequests:
		require.Equal(t, "/durable-active-cwd", activeRequest.Cwd)
	case <-time.After(time.Second):
		t.Fatal("active SSH completion provider was not called")
	}
	select {
	case unexpected := <-profileRequests:
		t.Fatalf("profile provider was called for matching active identity: %#v", unexpected)
	default:
	}

	setNextConnection("profile-b", "/durable-profile-cwd")
	differentIdentity := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", request("profile-b", "/durable-profile-cwd"))
	require.Equal(t, http.StatusOK, differentIdentity.Code, differentIdentity.Body.String())
	select {
	case profileRequest := <-profileRequests:
		require.Equal(t, "profile-b", profileRequest.ProfileID)
		require.Equal(t, "/durable-profile-cwd", profileRequest.Request.Cwd)
	case <-time.After(time.Second):
		t.Fatal("profile-specific SSH completion provider was not called")
	}
	select {
	case unexpected := <-activeRequests:
		t.Fatalf("active provider was called for a different durable identity: %#v", unexpected)
	default:
	}
}

func TestBlockTermCompletionRejectsInvalidDurableNextConnection(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminalID := createActiveBlockTermCompletionTerminal(t, env, t.TempDir())
	require.NoError(t, env.db.Model(&model.TerminalSession{}).
		Where("id = ?", terminalID).
		Update("blockterm_view_json", `{"next_connection":{"runtime_type":"ssh"}}`).Error)
	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": terminalID, "draft": "cat x", "cursor": 5, "prefix": "x", "kind": "file",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "completion_context_invalid")
}

func TestWriteBlockTermCompletionRuntimeErrorMapsSSHBoundaries(t *testing.T) {
	tests := []struct {
		err        error
		wantStatus int
		wantCode   string
	}{
		{err: sshconnection.ErrProfileNotFound, wantStatus: http.StatusNotFound, wantCode: "ssh_profile_not_found"},
		{err: sshconnection.ErrReconnectRequired, wantStatus: http.StatusServiceUnavailable, wantCode: "ssh_reconnect_required"},
		{err: sshconnection.ErrServiceClosed, wantStatus: http.StatusServiceUnavailable, wantCode: "ssh_service_closed"},
		{err: sshconnection.ErrAuthenticationFailed, wantStatus: http.StatusUnauthorized, wantCode: "ssh_authentication_required"},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(response)
		writeBlockTermCompletionRuntimeError(context, test.err)
		require.Equal(t, test.wantStatus, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), test.wantCode)
	}
}

func TestBlockTermCompletionNewProtocolUsesActiveSSHProvider(t *testing.T) {
	currentCwd := t.TempDir()
	requestReceived := make(chan terminal.CompletionRequest, 1)
	provider := blockTermCompletionProvider(func(ctx context.Context, request terminal.CompletionRequest) (terminal.CompletionResult, error) {
		requestReceived <- request
		return terminal.CompletionResult{
			Candidates: []terminal.CompletionCandidate{
				{Value: "remote-z", IsDirectory: false},
				{Value: "remote-dir/", IsDirectory: true},
				{Value: "remote-a", IsDirectory: false},
			},
			HasMore: true,
		}, nil
	})
	env, manager := setupBlockTermCompletionSSHHandlerWithProvider(t, provider)
	info, err := manager.Create(terminal.CreateOptions{
		Name:         "completion ssh",
		Cwd:          t.TempDir(),
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: "completion-profile",
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })
	require.NoError(t, manager.UpdateShellMetadata(info.ID, terminal.ShellMetadataUpdate{CurrentCwd: &currentCwd}))

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id":     info.ID,
		"draft":           "cat rem",
		"cursor":          7,
		"prefix":          "rem",
		"kind":            "file",
		"executable_only": true,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var request terminal.CompletionRequest
	select {
	case request = <-requestReceived:
	case <-time.After(time.Second):
		t.Fatal("SSH completion provider was not called")
	}
	require.Equal(t, terminal.CompletionRequest{
		Cwd:            currentCwd,
		Prefix:         "rem",
		Kind:           terminal.CompletionKindFile,
		ExecutableOnly: true,
		Limit:          100,
	}, request)

	var body blockTermCompletionTestResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, "file", body.Kind)
	require.Equal(t, "rem", body.Prefix)
	require.Equal(t, "rem", body.CommonPrefix)
	require.True(t, body.HasMore)
	require.Equal(t, []blockTermCompletionCandidate{
		{Value: "remote-a", Display: "remote-a"},
		{Value: "remote-dir/", Display: "remote-dir/", IsDirectory: true},
		{Value: "remote-z", Display: "remote-z"},
	}, body.Candidates)
}

func TestBlockTermCompletionNewProtocolFiltersAndNormalizesSSHProviderCandidates(t *testing.T) {
	provider := blockTermCompletionProvider(func(context.Context, terminal.CompletionRequest) (terminal.CompletionResult, error) {
		return terminal.CompletionResult{Candidates: []terminal.CompletionCandidate{
			{Value: "safe-file"},
			{Value: "remote-dir", IsDirectory: true},
			{Value: "remote-dir/", IsDirectory: true},
			{Value: "remote-dir////", IsDirectory: true},
			{Value: "remote-dir"},
			{Value: "bad\nvalue"},
			{Value: "bad\x1bvalue"},
			{Value: string([]byte{0xff})},
			{Value: "/", IsDirectory: true},
			{},
		}}, nil
	})
	env, manager := setupBlockTermCompletionSSHHandlerWithProvider(t, provider)
	info, err := manager.Create(terminal.CreateOptions{
		Name:         "completion ssh filtered",
		Cwd:          t.TempDir(),
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: "completion-profile",
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": info.ID,
		"draft":       "cat remote",
		"cursor":      10,
		"prefix":      "remote",
		"kind":        "file",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body blockTermCompletionTestResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.False(t, body.HasMore)
	require.Equal(t, []blockTermCompletionCandidate{
		{Value: "remote-dir/", Display: "remote-dir/", IsDirectory: true},
		{Value: "safe-file", Display: "safe-file"},
	}, body.Candidates)
}

func TestBlockTermCompletionNewProtocolBoundsUntrustedSSHProviderCandidates(t *testing.T) {
	provider := blockTermCompletionProvider(func(context.Context, terminal.CompletionRequest) (terminal.CompletionResult, error) {
		candidates := make([]terminal.CompletionCandidate, 0, blockTermCompletionLimit+17)
		for index := 0; index < blockTermCompletionLimit+17; index++ {
			candidates = append(candidates, terminal.CompletionCandidate{Value: fmt.Sprintf("remote-%03d", index)})
		}
		return terminal.CompletionResult{Candidates: candidates}, nil
	})
	env, manager := setupBlockTermCompletionSSHHandlerWithProvider(t, provider)
	info, err := manager.Create(terminal.CreateOptions{
		Name:         "completion ssh bounded",
		Cwd:          t.TempDir(),
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: "completion-profile",
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": info.ID,
		"draft":       "remote-",
		"cursor":      7,
		"prefix":      "remote-",
		"kind":        "command",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body blockTermCompletionTestResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.HasMore)
	require.Equal(t, "remote-", body.CommonPrefix)
	require.Len(t, body.Candidates, blockTermCompletionLimit)
	require.Equal(t, "remote-000", body.Candidates[0].Value)
	require.Equal(t, "remote-099", body.Candidates[len(body.Candidates)-1].Value)
}

func TestBlockTermCompletionNewProtocolRejectsUnsupportedSSH(t *testing.T) {
	env, manager := setupBlockTermCompletionSSHHandler(t)
	info, err := manager.Create(terminal.CreateOptions{
		Name:         "completion ssh unsupported",
		Cwd:          t.TempDir(),
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: "completion-profile",
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", map[string]any{
		"terminal_id": info.ID,
		"draft":       "cat ",
		"cursor":      4,
		"prefix":      "",
		"kind":        "file",
	})
	require.Equal(t, http.StatusNotImplemented, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "terminal_completion_unsupported")
}

func TestBlockTermCompletionNewProtocolMapsRemoteErrors(t *testing.T) {
	tests := []struct {
		name       string
		provider   func(chan struct{}) terminal.CompletionProvider
		wantStatus int
		wantCode   string
		forbidden  string
	}{
		{
			name: "deadline",
			provider: func(_ chan struct{}) terminal.CompletionProvider {
				return blockTermCompletionProvider(func(ctx context.Context, _ terminal.CompletionRequest) (terminal.CompletionResult, error) {
					<-ctx.Done()
					return terminal.CompletionResult{}, ctx.Err()
				})
			},
			wantStatus: http.StatusGatewayTimeout,
			wantCode:   "terminal_completion_timeout",
		},
		{
			name: "cancel",
			provider: func(started chan struct{}) terminal.CompletionProvider {
				return blockTermCompletionProvider(func(ctx context.Context, _ terminal.CompletionRequest) (terminal.CompletionResult, error) {
					close(started)
					<-ctx.Done()
					return terminal.CompletionResult{}, ctx.Err()
				})
			},
			wantStatus: http.StatusRequestTimeout,
			wantCode:   "request_canceled",
		},
		{
			name: "remote error",
			provider: func(_ chan struct{}) terminal.CompletionProvider {
				return blockTermCompletionProvider(func(context.Context, terminal.CompletionRequest) (terminal.CompletionResult, error) {
					return terminal.CompletionResult{}, errors.New("remote completion test failure")
				})
			},
			wantStatus: http.StatusBadGateway,
			wantCode:   "remote_completion_failed",
			forbidden:  "remote completion test failure",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			started := make(chan struct{})
			env, manager := setupBlockTermCompletionSSHHandlerWithProvider(t, test.provider(started))
			info, err := manager.Create(terminal.CreateOptions{
				Name:         "completion ssh error",
				Cwd:          t.TempDir(),
				RuntimeType:  terminal.RuntimeTypeSSH,
				SSHProfileID: "completion-profile",
			})
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })

			payload := map[string]any{
				"terminal_id": info.ID,
				"draft":       "cat ",
				"cursor":      4,
				"prefix":      "",
				"kind":        "file",
			}
			var response *httptest.ResponseRecorder
			if test.name == "deadline" {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
				defer cancel()
				response = doBlockTermCompletionJSONContext(t, ctx, env.router, payload)
			} else if test.name == "cancel" {
				ctx, cancel := context.WithCancel(context.Background())
				responseDone := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					responseDone <- doBlockTermCompletionJSONContext(t, ctx, env.router, payload)
				}()
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("completion provider was not reached")
				}
				cancel()
				select {
				case response = <-responseDone:
				case <-time.After(time.Second):
					t.Fatal("canceled completion request did not finish")
				}
			} else {
				response = doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/completion", payload)
			}
			require.Equal(t, test.wantStatus, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), test.wantCode)
			if test.forbidden != "" {
				require.NotContains(t, response.Body.String(), test.forbidden)
			}
		})
	}
}
