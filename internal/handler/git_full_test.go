package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func runGitCommand(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %s failed: %s", strings.Join(args, " "), string(out))
	return strings.TrimSpace(string(out))
}

func setupFullRepo(t *testing.T) string {
	dir, err := os.MkdirTemp("", "git-full-test")
	require.NoError(t, err)

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s failed: %s\n%s", args[0], err, string(out))
		}
	}

	runGit("init")
	runGit("config", "user.name", "Test")
	runGit("config", "user.email", "test@test.com")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test\n"), 0644))
	runGit("add", "README.md")
	runGit("commit", "-m", "initial commit")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0644))
	runGit("add", "main.go")
	runGit("commit", "-m", "add main.go")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello world\n"), 0644))
	runGit("add", "hello.txt")
	runGit("commit", "-m", "add hello.txt")

	cmd := exec.Command("git", "checkout", "-b", "feature-a")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	require.NoError(t, os.WriteFile(filepath.Join(dir, "feature-a.txt"), []byte("feature a\n"), 0644))
	cmd = exec.Command("git", "add", "feature-a.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "feature-a work")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	cmd = exec.Command("git", "checkout", "master")
	cmd.Dir = dir
	if cmd.Run() != nil {
		cmd = exec.Command("git", "checkout", "main")
		cmd.Dir = dir
		cmd.Run()
	}

	cmd = exec.Command("git", "checkout", "-b", "feature-b")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	require.NoError(t, os.WriteFile(filepath.Join(dir, "feature-b.txt"), []byte("feature b\n"), 0644))
	cmd = exec.Command("git", "add", "feature-b.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "feature-b work")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	cmd = exec.Command("git", "checkout", "master")
	cmd.Dir = dir
	if cmd.Run() != nil {
		cmd = exec.Command("git", "checkout", "main")
		cmd.Dir = dir
		cmd.Run()
	}

	return dir
}

func TestGitFullCheck(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/check", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]bool
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp["isRepo"])

	w = postJSON(r, "/git/check", map[string]string{"path": "/tmp/nonexistent-xyz"})
	assert.Equal(t, http.StatusOK, w.Code)
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.False(t, resp["isRepo"])
}

func TestGitFullStructuredStatus(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello world\nmodified\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "new-file.txt"), []byte("new\n"), 0644))

	w := postJSON(r, "/git/status", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Files   []StructuredFile `json:"files"`
		Summary StatusSummary    `json:"summary"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.GreaterOrEqual(t, len(resp.Files), 2)
	assert.GreaterOrEqual(t, resp.Summary.Changed, 2)
}

func TestGitFullFileDiff(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello world\nnew line\n"), 0644))

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp InteractiveDiff
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "hello.txt", resp.Path)
	assert.Equal(t, "working", resp.Mode)
	assert.NotEmpty(t, resp.Hunks)
	assert.NotEmpty(t, resp.Patch)
	assert.NotEmpty(t, resp.PatchHash)
	assert.Greater(t, resp.Stats.Added, 0)
}

func TestGitFullFileDiffStaged(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("staged content\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "staged",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp InteractiveDiff
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "staged", resp.Mode)
	assert.NotEmpty(t, resp.Hunks)
}

func TestGitFullApplySelectionInclude(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello world\nselected\n"), 0644))

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code)
	var diffResp InteractiveDiff
	json.Unmarshal(w.Body.Bytes(), &diffResp)
	require.NotEmpty(t, diffResp.Hunks)

	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
		"target": "hunk", "action": "include",
		"patchHash": diffResp.PatchHash,
		"lineIds":   []string{}, "hunkIds": []string{diffResp.Hunks[0].ID},
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		OK     bool `json:"ok"`
		Status struct {
			Files []StructuredFile `json:"files"`
		} `json:"status"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.OK)
}

func TestGitFullApplySelectionExclude(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("excluded\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "staged",
		"target": "file", "action": "exclude",
		"patchHash": "", "lineIds": []string{}, "hunkIds": []string{},
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		OK bool `json:"ok"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.OK)
}

func TestGitFullApplySelectionExcludeStagedLine(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\nthree\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "seed staged partial")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("ONE\ntwo\nTHREE\n"), 0644))
	cmd = exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "staged",
	})
	require.Equal(t, http.StatusOK, w.Code)

	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	require.NotEmpty(t, diffResp.Hunks)

	lineIDs := make([]string, 0)
	for _, hunk := range diffResp.Hunks {
		for _, line := range hunk.Lines {
			if (line.Content == "three" || line.Content == "THREE") && line.Selectable {
				lineIDs = append(lineIDs, line.ID)
			}
		}
	}
	require.Len(t, lineIDs, 2)

	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "staged",
		"target": "line", "action": "exclude",
		"patchHash": diffResp.PatchHash,
		"lineIds":   lineIDs, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	cmd = exec.Command("git", "diff", "--cached", "--", "hello.txt")
	cmd.Dir = dir
	stagedDiff, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(stagedDiff), "-one")
	assert.Contains(t, string(stagedDiff), "+ONE")
	assert.NotContains(t, string(stagedDiff), "-three")
	assert.NotContains(t, string(stagedDiff), "+THREE")

	cmd = exec.Command("git", "diff", "--", "hello.txt")
	cmd.Dir = dir
	workingDiff, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(workingDiff), "-three")
	assert.Contains(t, string(workingDiff), "+THREE")
	assert.NotContains(t, string(workingDiff), "-one")
}

func TestGitFullApplySelectionIncludeStagedFile(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("ONE\ntwo\nTHREE\n"), 0644))

	w := postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "staged",
		"target": "file", "action": "include",
		"patchHash": "", "lineIds": []string{}, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	cmd := exec.Command("git", "diff", "--cached", "--", "hello.txt")
	cmd.Dir = dir
	stagedDiff, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(stagedDiff), "-hello world")
	assert.Contains(t, string(stagedDiff), "+ONE")
	assert.Contains(t, string(stagedDiff), "+THREE")

	cmd = exec.Command("git", "diff", "--", "hello.txt")
	cmd.Dir = dir
	workingDiff, err := cmd.Output()
	require.NoError(t, err)
	assert.Empty(t, string(workingDiff))
}

func TestGitFullApplySelectionIncludeStagedLine(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\nthree\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "seed staged include")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("ONE\ntwo\nTHREE\n"), 0644))

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code)

	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	require.NotEmpty(t, diffResp.Hunks)

	lineIDs := make([]string, 0)
	for _, hunk := range diffResp.Hunks {
		for _, line := range hunk.Lines {
			if (line.Content == "one" || line.Content == "ONE") && line.Selectable {
				lineIDs = append(lineIDs, line.ID)
			}
		}
	}
	require.Len(t, lineIDs, 2)

	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "staged",
		"target": "line", "action": "include",
		"patchHash": diffResp.PatchHash,
		"lineIds":   lineIDs, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	cmd = exec.Command("git", "diff", "--cached", "--", "hello.txt")
	cmd.Dir = dir
	stagedDiff, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(stagedDiff), "-one")
	assert.Contains(t, string(stagedDiff), "+ONE")
	assert.NotContains(t, string(stagedDiff), "-three")
	assert.NotContains(t, string(stagedDiff), "+THREE")

	cmd = exec.Command("git", "diff", "--", "hello.txt")
	cmd.Dir = dir
	workingDiff, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(workingDiff), "-three")
	assert.Contains(t, string(workingDiff), "+THREE")
	assert.NotContains(t, string(workingDiff), "-one")
}

func TestGitFullApplySelectionDiscard(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("will be discarded\n"), 0644))

	w := postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
		"target": "file", "action": "discard",
		"patchHash": "", "lineIds": []string{}, "hunkIds": []string{},
	})
	assert.Equal(t, http.StatusOK, w.Code)

	content, _ := os.ReadFile(filepath.Join(dir, "hello.txt"))
	assert.Equal(t, "hello world\n", string(content))
}

func TestGitFullServerSidePartialSelectionCommit(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, h := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\nthree\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "seed selection state")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("ONE\ntwo\nTHREE\n"), 0644))

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code)

	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	require.NotEmpty(t, diffResp.Hunks)

	lineIDs := make([]string, 0)
	for _, hunk := range diffResp.Hunks {
		for _, line := range hunk.Lines {
			if (line.Content == "three" || line.Content == "THREE") && line.Selectable {
				lineIDs = append(lineIDs, line.ID)
			}
		}
	}
	require.Len(t, lineIDs, 2)

	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "mode": "working",
		"target": "line", "action": "exclude",
		"patchHash": diffResp.PatchHash,
		"lineIds":   lineIDs, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code)

	var applyResp struct {
		OK     bool `json:"ok"`
		Status struct {
			Files []StructuredFile `json:"files"`
		} `json:"status"`
		Diff InteractiveDiff `json:"diff"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &applyResp))
	require.True(t, applyResp.OK)
	require.Equal(t, "partial", applyResp.Diff.IncludedState)

	found := false
	for _, file := range applyResp.Status.Files {
		if file.Path == "hello.txt" {
			found = true
			assert.Equal(t, "partial", file.IncludedState)
		}
	}
	require.True(t, found)

	debugDiff, err := getGitDiff(dir, "hello.txt", "working")
	require.NoError(t, err)
	selectionState := resolveSelectionState(h.selectionStore, dir, "hello.txt", debugDiff)
	require.Equal(t, "partial", selectionState.IncludedState)

	debugPatch := buildSelectionPatch(debugDiff, getSelectedLineIDsForState(selectionState, debugDiff))
	assert.Equal(t, strings.Join([]string{
		"--- a/hello.txt",
		"+++ b/hello.txt",
		"@@ -1,3 +1,3 @@",
		"-one",
		"+ONE",
		" two",
		" three",
		"",
	}, "\n"), debugPatch)

	w = postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path":        dir,
		"files":       []string{},
		"patches":     []interface{}{},
		"summary":     "feat: backend selection",
		"description": "server side partial",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	logCmd := exec.Command("git", "log", "-1", "--format=%B")
	logCmd.Dir = dir
	logOut, err := logCmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(logOut), "feat: backend selection")
	assert.Contains(t, string(logOut), "server side partial")

	showCmd := exec.Command("git", "show", "HEAD:hello.txt")
	showCmd.Dir = dir
	committedContent, err := showCmd.Output()
	require.NoError(t, err)
	assert.Equal(t, "ONE\ntwo\nthree\n", string(committedContent))

	workingTreeContent, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
	require.NoError(t, err)
	assert.Equal(t, "ONE\ntwo\nTHREE\n", string(workingTreeContent))
}

func TestGitFullDraftScopeIsolation(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/draft", map[string]interface{}{
		"path":                 dir,
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
		"summary":              "feat: scoped draft",
		"description":          "scope a",
		"isAmend":              true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	req, _ := http.NewRequest(
		"GET",
		"/git/draft?path="+url.QueryEscape(dir)+"&workspace_session_id=session-a&group_id=group-a",
		nil,
	)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var draftResp GitDraftResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &draftResp))
	assert.Equal(t, "feat: scoped draft", draftResp.Summary)
	assert.Equal(t, "scope a", draftResp.Description)
	assert.True(t, draftResp.IsAmend)

	req, _ = http.NewRequest(
		"GET",
		"/git/draft?path="+url.QueryEscape(dir)+"&workspace_session_id=session-b&group_id=group-b",
		nil,
	)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &draftResp))
	assert.Empty(t, draftResp.Summary)
	assert.Empty(t, draftResp.Description)
	assert.False(t, draftResp.IsAmend)
}

func TestGitFullSelectionScopeIsolation(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\nthree\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "seed scope isolation")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("ONE\ntwo\nTHREE\n"), 0644))

	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path":                 dir,
		"filePath":             "hello.txt",
		"mode":                 "working",
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))

	lineIDs := make([]string, 0)
	for _, hunk := range diffResp.Hunks {
		for _, line := range hunk.Lines {
			if (line.Content == "three" || line.Content == "THREE") && line.Selectable {
				lineIDs = append(lineIDs, line.ID)
			}
		}
	}
	require.Len(t, lineIDs, 2)

	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path":                 dir,
		"filePath":             "hello.txt",
		"mode":                 "working",
		"target":               "line",
		"action":               "exclude",
		"patchHash":            diffResp.PatchHash,
		"lineIds":              lineIDs,
		"hunkIds":              []string{},
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = postJSON(r, "/git/status", map[string]interface{}{
		"path":                 dir,
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
	})
	require.Equal(t, http.StatusOK, w.Code)

	var statusResp struct {
		Files []StructuredFile `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &statusResp))
	require.NotEmpty(t, statusResp.Files)

	foundPartial := false
	for _, file := range statusResp.Files {
		if file.Path == "hello.txt" {
			foundPartial = file.IncludedState == "partial"
		}
	}
	assert.True(t, foundPartial)

	w = postJSON(r, "/git/status", map[string]interface{}{
		"path":                 dir,
		"workspace_session_id": "session-b",
		"group_id":             "group-b",
	})
	require.Equal(t, http.StatusOK, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &statusResp))

	foundAll := false
	for _, file := range statusResp.Files {
		if file.Path == "hello.txt" {
			foundAll = file.IncludedState == "all"
		}
	}
	assert.True(t, foundAll)
}

func TestGitFullApplySelectionBatch(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("batch one\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() { println(\"batch\") }\n"), 0644))

	w := postJSON(r, "/git/apply-selection-batch", map[string]interface{}{
		"path":                 dir,
		"mode":                 "working",
		"action":               "exclude",
		"filePaths":            []string{"hello.txt", "main.go"},
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var resp struct {
		Status struct {
			Files []StructuredFile `json:"files"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))

	excluded := 0
	for _, file := range resp.Status.Files {
		if (file.Path == "hello.txt" || file.Path == "main.go") && file.IncludedState == "none" {
			excluded++
		}
	}
	assert.Equal(t, 2, excluded)
}

func TestGitFullCommitClearsDraft(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("draft clear\n"), 0644))

	w := postJSON(r, "/git/draft", map[string]interface{}{
		"path":                 dir,
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
		"summary":              "feat: clear draft",
		"description":          "before commit",
		"isAmend":              true,
		"noVerify":             true,
		"signOff":              true,
		"allowEmpty":           true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path":                 dir,
		"summary":              "feat: clear draft",
		"description":          "before commit",
		"workspace_session_id": "session-a",
		"group_id":             "group-a",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	req, _ := http.NewRequest(
		"GET",
		"/git/draft?path="+url.QueryEscape(dir)+"&workspace_session_id=session-a&group_id=group-a",
		nil,
	)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var draftResp GitDraftResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &draftResp))
	assert.Empty(t, draftResp.Summary)
	assert.Empty(t, draftResp.Description)
	assert.False(t, draftResp.IsAmend)
	assert.True(t, draftResp.NoVerify)
	assert.True(t, draftResp.SignOff)
	assert.False(t, draftResp.AllowEmpty)
	assert.True(t, draftResp.SkipCommitHooks)
	assert.True(t, draftResp.SignOffCommits)
	assert.False(t, draftResp.AllowEmptyCommit)
}

func TestGitFullStashViaAPI(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("stash me\n"), 0644))

	w := postJSON(r, "/git/stash", map[string]interface{}{
		"path": dir, "message": "api stash test",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var stashResp struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
		Status  struct {
			Files   []StructuredFile `json:"files"`
			Summary StatusSummary    `json:"summary"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &stashResp))
	assert.True(t, stashResp.OK)
	assert.Empty(t, stashResp.Status.Files)
	assert.Zero(t, stashResp.Status.Summary.Changed)

	content, _ := os.ReadFile(filepath.Join(dir, "hello.txt"))
	assert.Equal(t, "hello world\n", string(content))

	w = postJSON(r, "/git/stash-list", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var listResp struct {
		Stashes []StashEntry `json:"stashes"`
	}
	json.Unmarshal(w.Body.Bytes(), &listResp)
	assert.NotEmpty(t, listResp.Stashes)

	w = postJSON(r, "/git/stash-pop", map[string]interface{}{"path": dir, "index": 0})
	assert.Equal(t, http.StatusOK, w.Code)
	var popResp struct {
		Status struct {
			Files   []StructuredFile `json:"files"`
			Summary StatusSummary    `json:"summary"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &popResp))
	require.Len(t, popResp.Status.Files, 1)
	assert.Equal(t, "modified", popResp.Status.Files[0].ChangeType)
	assert.Equal(t, 1, popResp.Status.Summary.Changed)

	content, _ = os.ReadFile(filepath.Join(dir, "hello.txt"))
	assert.Equal(t, "stash me\n", string(content))
}

func TestGitFullStashFiles(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("stash files test\n"), 0644))
	cmd := exec.Command("git", "stash", "push", "-m", "for stash-files test")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/stash-files", map[string]interface{}{"path": dir, "index": 0})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Files []StashFileInfo `json:"files"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NotEmpty(t, resp.Files)

	found := false
	for _, f := range resp.Files {
		if f.Path == "hello.txt" {
			found = true
			assert.Equal(t, "modified", f.Status)
		}
	}
	assert.True(t, found)

	cmd = exec.Command("git", "stash", "drop")
	cmd.Dir = dir
	cmd.Run()
}

func TestGitFullStashFilesRename(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	cmd := exec.Command("git", "mv", "hello.txt", "renamed.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "stash", "push", "-m", "for stash rename test")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/stash-files", map[string]interface{}{"path": dir, "index": 0})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Files []StashFileInfo `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Files, 1)
	assert.Equal(t, "renamed.txt", resp.Files[0].Path)
	assert.Equal(t, "renamed", resp.Files[0].Status)
}

func TestGitFullStashUntrackedFileDetails(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("new from stash\n"), 0644))
	cmd := exec.Command("git", "stash", "push", "--include-untracked", "-m", "for untracked stash test")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/stash-files", map[string]interface{}{"path": dir, "index": 0})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var filesResp struct {
		Files []StashFileInfo `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &filesResp))
	require.Len(t, filesResp.Files, 1)
	assert.Equal(t, "untracked.txt", filesResp.Files[0].Path)
	assert.Equal(t, "added", filesResp.Files[0].Status)

	w = postJSON(r, "/git/stash-diff", map[string]interface{}{
		"path": dir, "index": 0, "filePath": "untracked.txt",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	assert.Empty(t, diffResp.Old)
	assert.Equal(t, "new from stash\n", diffResp.New)
	assert.NotEmpty(t, diffResp.Hunks)
	assert.Contains(t, diffResp.Patch, "+new from stash")

	cmd = exec.Command("git", "stash", "drop")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
}

func TestGitFullStashDetailsUseStableOIDAfterIndexShift(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("older stash\n"), 0644))
	runGitCommand(t, dir, "stash", "push", "-m", "older")
	olderOID := runGitCommand(t, dir, "rev-parse", "refs/stash")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "main.go"), []byte("package shifted\n"), 0644))
	runGitCommand(t, dir, "stash", "push", "-m", "newer")

	w := postJSON(r, "/git/stash-files", map[string]interface{}{
		"path": dir, "index": 0, "oid": olderOID,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var filesResp struct {
		Files []StashFileInfo `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &filesResp))
	require.Len(t, filesResp.Files, 1)
	assert.Equal(t, "hello.txt", filesResp.Files[0].Path)

	w = postJSON(r, "/git/stash-diff", map[string]interface{}{
		"path": dir, "index": 0, "oid": olderOID, "filePath": "hello.txt",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	assert.Equal(t, "older stash\n", diffResp.New)
	assert.NotContains(t, diffResp.New, "package shifted")

	w = postJSON(r, "/git/stash-drop", map[string]interface{}{
		"path": dir, "index": 0, "oid": olderOID,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.NotContains(t, runGitCommand(t, dir, "stash", "list"), "older")
	assert.Contains(t, runGitCommand(t, dir, "stash", "list"), "newer")
}

func TestGitFullStashDetailsSupportLiteralControlCharacterPaths(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	filePath := "tab\tand-newline\nfile.txt"
	require.NoError(t, os.WriteFile(filepath.Join(dir, filePath), []byte("literal path\n"), 0644))
	runGitCommand(t, dir, "stash", "push", "--include-untracked", "-m", "literal path")
	stashOID := runGitCommand(t, dir, "rev-parse", "refs/stash")

	w := postJSON(r, "/git/stash-files", map[string]interface{}{
		"path": dir, "index": 0, "oid": stashOID,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var filesResp struct {
		Files []StashFileInfo `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &filesResp))
	require.Len(t, filesResp.Files, 1)
	assert.Equal(t, filePath, filesResp.Files[0].Path)
	assert.Equal(t, "added", filesResp.Files[0].Status)

	w = postJSON(r, "/git/stash-diff", map[string]interface{}{
		"path": dir, "index": 0, "oid": stashOID, "filePath": filePath,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	assert.Empty(t, diffResp.Old)
	assert.Equal(t, "literal path\n", diffResp.New)
	assert.Contains(t, diffResp.Patch, "+literal path")
}

func TestGitFullStashDiff(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("stash diff test\n"), 0644))
	cmd := exec.Command("git", "stash", "push", "-m", "for stash-diff")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/stash-diff", map[string]interface{}{
		"path": dir, "index": 0, "filePath": "hello.txt",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp InteractiveDiff
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "stash", resp.Mode)
	assert.NotEmpty(t, resp.Hunks)
	assert.NotEmpty(t, resp.Old)
	assert.NotEmpty(t, resp.New)

	cmd = exec.Command("git", "stash", "drop")
	cmd.Dir = dir
	cmd.Run()
}

func TestGitFullStashPartialFiles(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "stash-a.txt"), []byte("a\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "stash-b.txt"), []byte("b\n"), 0644))

	w := postJSON(r, "/git/stash", map[string]interface{}{
		"path": dir, "message": "partial stash", "files": []string{"stash-a.txt"},
	})
	assert.Equal(t, http.StatusOK, w.Code)

	_, err := os.Stat(filepath.Join(dir, "stash-b.txt"))
	assert.NoError(t, err)

	cmd := exec.Command("git", "stash", "drop")
	cmd.Dir = dir
	cmd.Run()
}

func TestGitFullAddPatch(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello world\npatch line\n"), 0644))

	cmd := exec.Command("git", "diff", "--", "hello.txt")
	cmd.Dir = dir
	patchBytes, err := cmd.Output()
	require.NoError(t, err)
	require.NotEmpty(t, patchBytes)

	w := postJSON(r, "/git/add-patch", map[string]interface{}{
		"path": dir, "filePath": "hello.txt", "patch": string(patchBytes),
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		OK bool `json:"ok"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.OK)

	cmd = exec.Command("git", "diff", "--cached", "--name-only")
	cmd.Dir = dir
	out, _ := cmd.Output()
	assert.Contains(t, string(out), "hello.txt")
}

func TestGitFullCommitSelectedWithDescription(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "selected.txt"), []byte("selected\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "excluded.txt"), []byte("excluded\n"), 0644))

	w := postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path":        dir,
		"files":       []string{"selected.txt"},
		"patches":     []interface{}{},
		"summary":     "feat: selected only",
		"description": "detailed description",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		OK   bool   `json:"ok"`
		Hash string `json:"hash"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.OK)
	assert.NotEmpty(t, resp.Hash)

	cmd := exec.Command("git", "log", "-1", "--format=%B")
	cmd.Dir = dir
	logOut, _ := cmd.Output()
	assert.Contains(t, string(logOut), "feat: selected only")
	assert.Contains(t, string(logOut), "detailed description")

	showCmd := exec.Command("git", "show", "HEAD:selected.txt")
	showCmd.Dir = dir
	assert.NoError(t, showCmd.Run())

	_, statErr := os.Stat(filepath.Join(dir, "excluded.txt"))
	assert.NoError(t, statErr)
}

func TestGitFullCommitSelectedWithPartialPatch(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\nthree\n"), 0644))
	cmd := exec.Command("git", "add", "hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "seed hello.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("ONE\ntwo\nTHREE\n"), 0644))

	patch := strings.Join([]string{
		"--- a/hello.txt",
		"+++ b/hello.txt",
		"@@ -1,3 +1,3 @@",
		"-one",
		"+ONE",
		" two",
		" three",
		"",
	}, "\n")

	w := postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path":  dir,
		"files": []string{},
		"patches": []map[string]string{
			{"filePath": "hello.txt", "patch": patch},
		},
		"summary": "feat: partial patch",
	})
	assert.Equal(t, http.StatusOK, w.Code)

	cmd = exec.Command("git", "log", "-1", "--format=%s")
	cmd.Dir = dir
	logOut, err := cmd.Output()
	require.NoError(t, err)
	assert.Equal(t, "feat: partial patch", strings.TrimSpace(string(logOut)))

	showCmd := exec.Command("git", "show", "HEAD:hello.txt")
	showCmd.Dir = dir
	committedContent, err := showCmd.Output()
	require.NoError(t, err)
	assert.Equal(t, "ONE\ntwo\nthree\n", string(committedContent))

	workingTreeContent, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
	require.NoError(t, err)
	assert.Equal(t, "ONE\ntwo\nTHREE\n", string(workingTreeContent))

	cmd = exec.Command("git", "diff", "--", "hello.txt")
	cmd.Dir = dir
	diffOutput, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(diffOutput), "-three")
	assert.Contains(t, string(diffOutput), "+THREE")
	assert.NotContains(t, string(diffOutput), "-one")
}

func TestGitFullAmendChangesMessage(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "amend.txt"), []byte("amend\n"), 0644))

	w := postJSON(r, "/git/amend", map[string]interface{}{
		"path":    dir,
		"files":   []string{"amend.txt"},
		"patches": []interface{}{},
		"summary": "amended: new message",
	})
	assert.Equal(t, http.StatusOK, w.Code)

	cmd := exec.Command("git", "log", "-1", "--format=%s")
	cmd.Dir = dir
	logOut, _ := cmd.Output()
	assert.Equal(t, "amended: new message", strings.TrimSpace(string(logOut)))
}

func TestGitFullUndoAndRedo(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	hash1Cmd := exec.Command("git", "rev-parse", "HEAD")
	hash1Cmd.Dir = dir
	hash1Out, _ := hash1Cmd.Output()
	hash1 := strings.TrimSpace(string(hash1Out))

	w := postJSON(r, "/git/undo", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)

	hash2Cmd := exec.Command("git", "rev-parse", "HEAD")
	hash2Cmd.Dir = dir
	hash2Out, _ := hash2Cmd.Output()
	assert.NotEqual(t, hash1, strings.TrimSpace(string(hash2Out)))
}

func TestGitFullDeleteCurrentBranchFails(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/branches", map[string]string{"path": dir})
	var brResp struct {
		CurrentBranch string `json:"currentBranch"`
	}
	json.Unmarshal(w.Body.Bytes(), &brResp)

	w = postJSON(r, "/git/delete-branch", map[string]string{"path": dir, "branch": brResp.CurrentBranch})
	assert.Equal(t, http.StatusBadRequest, w.Code)
	var errResp struct {
		Error string `json:"error"`
	}
	json.Unmarshal(w.Body.Bytes(), &errResp)
	assert.Contains(t, errResp.Error, "current branch")
}

func TestGitFullSwitchNonexistentBranch(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/switch-branch", map[string]string{"path": dir, "branch": "nonexistent-xyz"})
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitFullCreateBranchFromRef(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/create-branch", map[string]interface{}{
		"path": dir, "branch": "from-feature", "from": "feature-a",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		OK     bool   `json:"ok"`
		Branch string `json:"branch"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.OK)
	assert.Equal(t, "from-feature", resp.Branch)
}

func TestGitFullSmartSwitchWithDirtyWorktree(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "dirty.txt"), []byte("dirty\n"), 0644))

	w := postJSON(r, "/git/smart-switch-branch", map[string]string{"path": dir, "branch": "feature-a"})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		OK      bool   `json:"ok"`
		Branch  string `json:"branch"`
		Stashed bool   `json:"stashed"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.OK)
	assert.Equal(t, "feature-a", resp.Branch)
	assert.True(t, resp.Stashed)
}

func TestGitFullBranchStatusNoUpstream(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/branch-status", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp BranchStatusInfo
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NotEmpty(t, resp.Branch)
	assert.Empty(t, resp.Upstream)
	assert.Equal(t, 0, resp.Ahead)
	assert.Equal(t, 0, resp.Behind)
}

func TestGitFullConflictsEmpty(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/conflicts", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Conflicts []string `json:"conflicts"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Empty(t, resp.Conflicts)
}

func TestGitFullRemotesEmpty(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/remotes", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitFullCloneHasRemote(t *testing.T) {
	src := setupFullRepo(t)
	defer os.RemoveAll(src)

	dst, _ := os.MkdirTemp("", "git-clone-test")
	defer os.RemoveAll(dst)
	clonePath := filepath.Join(dst, "cloned")

	r, _ := setupRouter()
	w := postJSON(r, "/git/clone", map[string]string{"url": src, "path": clonePath})
	assert.Equal(t, http.StatusOK, w.Code)

	w = postJSON(r, "/git/remotes", map[string]string{"path": clonePath})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Remotes []struct {
			Name string   `json:"name"`
			URLs []string `json:"urls"`
		} `json:"remotes"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NotEmpty(t, resp.Remotes)
	assert.Equal(t, "origin", resp.Remotes[0].Name)
}

func TestGitFullPushSetsUpstreamForNewBranch(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)

	remoteDir, err := os.MkdirTemp("", "git-push-remote")
	require.NoError(t, err)
	defer os.RemoveAll(remoteDir)

	remotePath := filepath.Join(remoteDir, "origin.git")
	runGitCommand(t, remoteDir, "init", "--bare", remotePath)
	runGitCommand(t, dir, "remote", "add", "origin", remotePath)

	baseBranch := runGitCommand(t, dir, "branch", "--show-current")
	runGitCommand(t, dir, "push", "-u", "origin", baseBranch)
	runGitCommand(t, dir, "checkout", "-b", "feature-sync")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "feature-sync.txt"), []byte("feature sync\n"), 0644))
	runGitCommand(t, dir, "add", "feature-sync.txt")
	runGitCommand(t, dir, "commit", "-m", "feature sync")

	r, _ := setupRouter()
	w := postJSON(r, "/git/push", map[string]string{"path": dir, "remote": "origin"})
	assert.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		OK           bool             `json:"ok"`
		BranchStatus BranchStatusInfo `json:"branchStatus"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.True(t, resp.OK)
	assert.Equal(t, "feature-sync", resp.BranchStatus.Branch)
	assert.Equal(t, "origin/feature-sync", resp.BranchStatus.Upstream)
	assert.Equal(t, 0, resp.BranchStatus.Ahead)
	assert.Equal(t, 0, resp.BranchStatus.Behind)
	assert.Equal(t, "origin/feature-sync", runGitCommand(t, dir, "rev-parse", "--abbrev-ref", "HEAD@{upstream}"))

	head := runGitCommand(t, dir, "rev-parse", "HEAD")
	remoteRefs := strings.Fields(runGitCommand(t, dir, "ls-remote", "--heads", remotePath, "feature-sync"))
	require.Len(t, remoteRefs, 2)
	assert.Equal(t, head, remoteRefs[0])
}

func TestGitFullTagsLifecycle(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)

	remoteDir, err := os.MkdirTemp("", "git-tags-remote")
	require.NoError(t, err)
	defer os.RemoveAll(remoteDir)

	remotePath := filepath.Join(remoteDir, "origin.git")
	runGitCommand(t, remoteDir, "init", "--bare", remotePath)
	runGitCommand(t, dir, "remote", "add", "origin", remotePath)
	baseBranch := runGitCommand(t, dir, "branch", "--show-current")
	runGitCommand(t, dir, "push", "-u", "origin", baseBranch)

	head := runGitCommand(t, dir, "rev-parse", "HEAD")
	r, _ := setupRouter()

	w := postJSON(r, "/git/create-tag", map[string]string{"path": dir, "name": "v1.0.0", "commit": head})
	assert.Equal(t, http.StatusOK, w.Code)
	var created GitTagsSnapshot
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	assert.Contains(t, created.TagsToPush, "v1.0.0")

	w = postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 1})
	assert.Equal(t, http.StatusOK, w.Code)
	var logResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &logResp))
	require.NotEmpty(t, logResp.Commits)
	assert.Contains(t, logResp.Commits[0].Tags, "v1.0.0")

	w = postJSON(r, "/git/delete-tag", map[string]string{"path": dir, "name": "v1.0.0"})
	assert.Equal(t, http.StatusOK, w.Code)

	w = postJSON(r, "/git/create-tag", map[string]string{"path": dir, "name": "v1.0.0", "commit": head})
	assert.Equal(t, http.StatusOK, w.Code)
	w = postJSON(r, "/git/push", map[string]interface{}{"path": dir, "remote": "origin", "tags": []string{"v1.0.0"}})
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, head, runGitCommand(t, remotePath, "rev-list", "-n", "1", "refs/tags/v1.0.0"))

	w = postJSON(r, "/git/tags", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var pushed GitTagsSnapshot
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &pushed))
	assert.Empty(t, pushed.TagsToPush)

	w = postJSON(r, "/git/delete-tag", map[string]string{"path": dir, "name": "v1.0.0"})
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitFullPushRestoresGoneUpstream(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)

	remoteDir, err := os.MkdirTemp("", "git-push-remote")
	require.NoError(t, err)
	defer os.RemoveAll(remoteDir)

	remotePath := filepath.Join(remoteDir, "origin.git")
	runGitCommand(t, remoteDir, "init", "--bare", remotePath)
	runGitCommand(t, dir, "remote", "add", "origin", remotePath)

	baseBranch := runGitCommand(t, dir, "branch", "--show-current")
	runGitCommand(t, dir, "push", "-u", "origin", baseBranch)
	runGitCommand(t, dir, "checkout", "-b", "recover-upstream")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "recover.txt"), []byte("recover\n"), 0644))
	runGitCommand(t, dir, "add", "recover.txt")
	runGitCommand(t, dir, "commit", "-m", "recover upstream")
	runGitCommand(t, dir, "push", "-u", "origin", "recover-upstream")
	runGitCommand(t, dir, "push", "origin", "--delete", "recover-upstream")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "recover.txt"), []byte("recover again\n"), 0644))
	runGitCommand(t, dir, "add", "recover.txt")
	runGitCommand(t, dir, "commit", "-m", "recover upstream again")

	r, _ := setupRouter()

	statusResp := postJSON(r, "/git/branch-status", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, statusResp.Code)
	var before BranchStatusInfo
	require.NoError(t, json.Unmarshal(statusResp.Body.Bytes(), &before))
	assert.Equal(t, "", before.Upstream)

	w := postJSON(r, "/git/push", map[string]string{"path": dir, "remote": "origin"})
	assert.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		OK           bool             `json:"ok"`
		BranchStatus BranchStatusInfo `json:"branchStatus"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.True(t, resp.OK)
	assert.Equal(t, "recover-upstream", resp.BranchStatus.Branch)
	assert.Equal(t, "origin/recover-upstream", resp.BranchStatus.Upstream)
	assert.Equal(t, 0, resp.BranchStatus.Ahead)
	assert.Equal(t, 0, resp.BranchStatus.Behind)
	assert.Equal(t, "origin/recover-upstream", runGitCommand(t, dir, "rev-parse", "--abbrev-ref", "HEAD@{upstream}"))

	head := runGitCommand(t, dir, "rev-parse", "HEAD")
	remoteRefs := strings.Fields(runGitCommand(t, dir, "ls-remote", "--heads", remotePath, "recover-upstream"))
	require.Len(t, remoteRefs, 2)
	assert.Equal(t, head, remoteRefs[0])
}

func TestGitFullMissingPath(t *testing.T) {
	r, _ := setupRouter()

	w := postJSON(r, "/git/status", map[string]string{})
	assert.Equal(t, http.StatusBadRequest, w.Code)

	w = postJSON(r, "/git/log", map[string]string{})
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitFullDiffNonexistentFile(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/diff", map[string]string{"path": dir, "filePath": "nonexistent.xyz"})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Empty(t, resp.Old)
	assert.Empty(t, resp.New)
}

func TestGitFullCheckoutNewFile(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("untracked\n"), 0644))

	w := postJSON(r, "/git/checkout", map[string]interface{}{"path": dir, "files": []string{"untracked.txt"}})
	assert.Equal(t, http.StatusOK, w.Code)

	_, err := os.Stat(filepath.Join(dir, "untracked.txt"))
	assert.True(t, os.IsNotExist(err))
}

func TestGitFullCommitFilesInitialCommit(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 100})
	var logResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &logResp)

	var initialHash string
	for _, c := range logResp.Commits {
		if c.ParentCount == 0 {
			initialHash = c.Hash
			break
		}
	}
	require.NotEmpty(t, initialHash)

	w = postJSON(r, "/git/commit-files", map[string]string{"path": dir, "commit": initialHash})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Files []CommitFileInfo `json:"files"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NotEmpty(t, resp.Files)
	for _, f := range resp.Files {
		assert.Equal(t, "A", f.Status)
	}
}

func TestGitFullResetSpecificFiles(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b\n"), 0644))
	cmd := exec.Command("git", "add", "a.txt", "b.txt")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/reset", map[string]interface{}{"path": dir, "files": []string{"a.txt"}})
	assert.Equal(t, http.StatusOK, w.Code)

	cmd = exec.Command("git", "diff", "--cached", "--name-only")
	cmd.Dir = dir
	out, _ := cmd.Output()
	assert.NotContains(t, string(out), "a.txt")
	assert.Contains(t, string(out), "b.txt")
}

func TestGitFullShowWithRef(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/show", map[string]string{
		"path": dir, "filePath": "feature-a.txt", "ref": "feature-a",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Content string `json:"content"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "feature a\n", resp.Content)
}

func TestGitFullShowInvalidRef(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/show", map[string]string{
		"path": dir, "filePath": "README.md", "ref": "invalid-ref-xyz",
	})
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitFullCommitDiffContent(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 1})
	var logResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &logResp)
	require.NotEmpty(t, logResp.Commits)

	w = postJSON(r, "/git/commit-diff", map[string]interface{}{
		"path": dir, "commit": logResp.Commits[0].Hash, "filePath": "hello.txt",
	})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Path string `json:"path"`
		Old  string `json:"old"`
		New  string `json:"new"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "hello.txt", resp.Path)
	assert.NotEmpty(t, resp.New)
}

func TestGitFullBranchesListsAll(t *testing.T) {
	dir := setupFullRepo(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/branches", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Branches      []BranchInfo `json:"branches"`
		CurrentBranch string       `json:"currentBranch"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.GreaterOrEqual(t, len(resp.Branches), 3)
	assert.NotEmpty(t, resp.CurrentBranch)

	names := make(map[string]bool)
	for _, b := range resp.Branches {
		names[b.Name] = true
	}
	assert.True(t, names["feature-a"])
	assert.True(t, names["feature-b"])
}
