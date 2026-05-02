package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupRouter() (*gin.Engine, *GitHandler) {
	gin.SetMode(gin.TestMode)
	h := NewGitHandler(nil)
	r := gin.New()
	h.Register(r.Group("/"))
	return r, h
}

func postJSON(r *gin.Engine, path string, body interface{}) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", path, bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func setupRouterWithGitWS() (*gin.Engine, *GitHandler) {
	gin.SetMode(gin.TestMode)
	h := NewGitHandler(nil)
	wsHandler := NewGitWSHandler(h)
	h.SetWSHandler(wsHandler)
	r := gin.New()
	h.Register(r.Group("/"))
	wsHandler.Register(r.Group("/"))
	return r, h
}

func setupGitRepoWithMultipleCommits(t *testing.T) string {
	dir, err := os.MkdirTemp("", "git-ext-test")
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

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte("one"), 0644))
	runGit("add", "file1.txt")
	runGit("commit", "-m", "commit 1")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file2.txt"), []byte("two"), 0644))
	runGit("add", "file2.txt")
	runGit("commit", "-m", "commit 2")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file3.txt"), []byte("three"), 0644))
	runGit("add", "file3.txt")
	runGit("commit", "-m", "commit 3")

	return dir
}

func TestGitShow(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/show", map[string]string{"path": dir, "filePath": "file1.txt"})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "one", resp["content"])
}

func TestGitShowNotFound(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/show", map[string]string{"path": dir, "filePath": "nonexistent.txt"})
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestGitCheckout(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte("dirty"), 0644))

	w := postJSON(r, "/git/checkout", map[string]interface{}{"path": dir, "files": []string{"file1.txt"}})
	assert.Equal(t, http.StatusOK, w.Code)

	content, _ := os.ReadFile(filepath.Join(dir, "file1.txt"))
	assert.Equal(t, "one", string(content))
}

func TestGitBranches(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	cmd := exec.Command("git", "checkout", "-b", "dev")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "checkout", "master")
	cmd.Dir = dir
	if cmd.Run() != nil {
		cmd = exec.Command("git", "checkout", "main")
		cmd.Dir = dir
		cmd.Run()
	}

	w := postJSON(r, "/git/branches", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		Branches      []BranchInfo `json:"branches"`
		CurrentBranch string       `json:"currentBranch"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.GreaterOrEqual(t, len(resp.Branches), 2)
	assert.NotEmpty(t, resp.CurrentBranch)
}

func TestGitCreateAndDeleteBranch(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/create-branch", map[string]string{"path": dir, "branch": "new-feature"})
	assert.Equal(t, http.StatusOK, w.Code)

	w = postJSON(r, "/git/branches", map[string]string{"path": dir})
	var resp struct {
		Branches []BranchInfo `json:"branches"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	found := false
	for _, b := range resp.Branches {
		if b.Name == "new-feature" {
			found = true
		}
	}
	assert.True(t, found, "new-feature branch should exist")

	w = postJSON(r, "/git/delete-branch", map[string]string{"path": dir, "branch": "new-feature"})
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitSwitchBranch(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	postJSON(r, "/git/create-branch", map[string]string{"path": dir, "branch": "switch-test"})

	w := postJSON(r, "/git/switch-branch", map[string]string{"path": dir, "branch": "switch-test"})
	assert.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		Branch string `json:"branch"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "switch-test", resp.Branch)
}

func TestGitCommitFiles(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 1})
	assert.Equal(t, http.StatusOK, w.Code)
	var logResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &logResp)
	require.NotEmpty(t, logResp.Commits)
	hash := logResp.Commits[0].Hash

	w = postJSON(r, "/git/commit-files", map[string]string{"path": dir, "commit": hash})
	assert.Equal(t, http.StatusOK, w.Code)
	var filesResp struct {
		Files []CommitFileInfo `json:"files"`
	}
	json.Unmarshal(w.Body.Bytes(), &filesResp)
	assert.NotEmpty(t, filesResp.Files)
}

func TestGitCommitDiff(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 1})
	var logResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &logResp)
	hash := logResp.Commits[0].Hash

	w = postJSON(r, "/git/commit-diff", map[string]interface{}{
		"path": dir, "commit": hash, "filePath": "file3.txt",
	})
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitCommitRangeFilesAndDiff(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 3})
	require.Equal(t, http.StatusOK, w.Code)
	var logResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &logResp))
	require.Len(t, logResp.Commits, 3)
	newest := logResp.Commits[0].Hash
	oldest := logResp.Commits[2].Hash

	w = postJSON(r, "/git/commit-files", map[string]interface{}{
		"path": dir, "commit": newest, "fromCommit": oldest,
	})
	require.Equal(t, http.StatusOK, w.Code)
	var filesResp struct {
		Files []CommitFileInfo `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &filesResp))
	require.Equal(t, []CommitFileInfo{
		{Path: "file1.txt", Status: "A"},
		{Path: "file2.txt", Status: "A"},
		{Path: "file3.txt", Status: "A"},
	}, filesResp.Files)

	w = postJSON(r, "/git/commit-diff", map[string]interface{}{
		"path": dir, "commit": newest, "fromCommit": oldest, "filePath": "file1.txt",
	})
	require.Equal(t, http.StatusOK, w.Code)
	var diffResp struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	assert.Empty(t, diffResp.Old)
	assert.Equal(t, "one", diffResp.New)

	w = postJSON(r, "/git/commit-files", map[string]interface{}{
		"path": dir, "commit": oldest, "fromCommit": newest,
	})
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitRemotes(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/remotes", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Remotes []interface{} `json:"remotes"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Empty(t, resp.Remotes)
}

func TestGitStashCycle(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte("stash me"), 0644))

	cmd := exec.Command("git", "stash", "push", "-m", "test stash")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/stash-list", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var listResp struct {
		Stashes []StashEntry `json:"stashes"`
	}
	json.Unmarshal(w.Body.Bytes(), &listResp)
	assert.NotEmpty(t, listResp.Stashes)

	w = postJSON(r, "/git/stash-pop", map[string]interface{}{"path": dir, "index": 0})
	assert.Equal(t, http.StatusOK, w.Code)

	content, _ := os.ReadFile(filepath.Join(dir, "file1.txt"))
	assert.Equal(t, "stash me", string(content))
}

func TestGitStashDrop(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte("drop me"), 0644))
	cmd := exec.Command("git", "stash", "push", "-m", "drop stash")
	cmd.Dir = dir
	require.NoError(t, cmd.Run())

	w := postJSON(r, "/git/stash-drop", map[string]interface{}{"path": dir, "index": 0})
	assert.Equal(t, http.StatusOK, w.Code)

	w = postJSON(r, "/git/stash-list", map[string]string{"path": dir})
	var listResp struct {
		Stashes []StashEntry `json:"stashes"`
	}
	json.Unmarshal(w.Body.Bytes(), &listResp)
	assert.Empty(t, listResp.Stashes)
}

func TestGitWSBroadcastsSelectionChangesImmediately(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte("ONE\nTWO\nthree"), 0644))

	router, _ := setupRouterWithGitWS()
	server := httptest.NewServer(router)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/git/ws?path=" + url.QueryEscape(dir)

	connA, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer connA.Close()

	connB, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer connB.Close()

	w := postJSON(router, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "file1.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code)

	var diffResp InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))

	lineIDs := make([]string, 0)
	for _, hunk := range diffResp.Hunks {
		for _, line := range hunk.Lines {
			if (line.Content == "two" || line.Content == "TWO") && line.Selectable {
				lineIDs = append(lineIDs, line.ID)
			}
		}
	}
	require.Len(t, lineIDs, 1)

	w = postJSON(router, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "file1.txt", "mode": "working",
		"target": "line", "action": "exclude",
		"patchHash": diffResp.PatchHash,
		"lineIds":   lineIDs, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code)

	require.NoError(t, connB.SetReadDeadline(time.Now().Add(1*time.Second)))

	for {
		var event GitWSEvent
		require.NoError(t, connB.ReadJSON(&event))
		if event.Type != "status_changed" {
			continue
		}

		rawData, err := json.Marshal(event.Data)
		require.NoError(t, err)

		var payload struct {
			Files []StructuredFile `json:"files"`
		}
		require.NoError(t, json.Unmarshal(rawData, &payload))

		found := false
		for _, file := range payload.Files {
			if file.Path == "file1.txt" {
				found = true
				assert.Equal(t, "partial", file.IncludedState)
			}
		}
		require.True(t, found)
		return
	}
}

func TestGitAmend(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "amend.txt"), []byte("amend content"), 0644))

	w := postJSON(r, "/git/amend", map[string]interface{}{
		"path":    dir,
		"files":   []string{"amend.txt"},
		"patches": []interface{}{},
		"summary": "amended commit",
	})
	assert.Equal(t, http.StatusOK, w.Code)

	cmd := exec.Command("git", "log", "-1", "--format=%s")
	cmd.Dir = dir
	out, _ := cmd.Output()
	assert.Equal(t, "amended commit", strings.TrimSpace(string(out)))
}

func TestGitLogWithSkip(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 10})
	var fullResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &fullResp)
	totalCount := len(fullResp.Commits)
	require.GreaterOrEqual(t, totalCount, 3)

	w = postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 1, "skip": 0})
	var firstResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &firstResp)
	assert.Len(t, firstResp.Commits, 1)
	assert.Equal(t, fullResp.Commits[0].Hash, firstResp.Commits[0].Hash)

	w = postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 1, "skip": 1})
	var secondResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &secondResp)
	assert.Len(t, secondResp.Commits, 1)
	assert.Equal(t, fullResp.Commits[1].Hash, secondResp.Commits[0].Hash)

	w = postJSON(r, "/git/log", map[string]interface{}{"path": dir, "limit": 10, "skip": totalCount})
	var emptyResp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &emptyResp)
	assert.Empty(t, emptyResp.Commits)
}

func TestGitBranchStatus(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	w := postJSON(r, "/git/branch-status", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Branch string `json:"branch"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NotEmpty(t, resp.Branch)
}

func TestGitConflicts(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
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

func TestGitConflictDetailsAndResolveUseStdlibFileIO(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	gitPath, err := exec.LookPath("git")
	require.NoError(t, err)
	gitOnlyDir := t.TempDir()
	require.NoError(t, os.Symlink(gitPath, filepath.Join(gitOnlyDir, "git")))
	originalPath := os.Getenv("PATH")
	t.Setenv("PATH", gitOnlyDir)
	t.Setenv("VG_GIT_SHELL_ENV", "0")
	t.Cleanup(func() {
		require.NoError(t, os.Setenv("PATH", originalPath))
	})

	conflictContent := strings.Join([]string{
		"prefix",
		"<<<<<<< HEAD",
		"ours",
		"=======",
		"theirs",
		">>>>>>> branch",
		"suffix",
	}, "\n")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte(conflictContent), 0644))

	w := postJSON(r, "/git/conflict-details", map[string]string{"path": dir, "filePath": "file1.txt"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var details ConflictDetailsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &details))
	assert.Equal(t, "file1.txt", details.Path)
	assert.Equal(t, 1, details.BlocksTotal)
	require.Len(t, details.Segments, 3)
	assert.Equal(t, []string{"ours"}, details.Segments[1].Ours)
	assert.Equal(t, []string{"theirs"}, details.Segments[1].Theirs)

	resolvedContent := "prefix\nresolved\nsuffix\n"
	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path":          dir,
		"filePath":      "file1.txt",
		"mode":          "manual",
		"manualContent": resolvedContent,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	content, err := os.ReadFile(filepath.Join(dir, "file1.txt"))
	require.NoError(t, err)
	assert.Equal(t, resolvedContent, string(content))

	cmd := exec.Command("git", "diff", "--cached", "--name-only")
	cmd.Dir = dir
	out, err := cmd.Output()
	require.NoError(t, err)
	assert.Equal(t, "file1.txt\n", string(out))
}

func TestGitSmartSwitchBranch(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	postJSON(r, "/git/create-branch", map[string]string{"path": dir, "branch": "smart-test"})

	require.NoError(t, os.WriteFile(filepath.Join(dir, "file1.txt"), []byte("dirty"), 0644))

	w := postJSON(r, "/git/smart-switch-branch", map[string]string{"path": dir, "branch": "smart-test"})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Branch  string `json:"branch"`
		Stashed bool   `json:"stashed"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, "smart-test", resp.Branch)
}

func TestGitStatusEmptyRepo(t *testing.T) {
	dir, _ := os.MkdirTemp("", "git-empty-test")
	defer os.RemoveAll(dir)
	cmd := exec.Command("git", "init", dir)
	cmd.Run()

	r, _ := setupRouter()
	w := postJSON(r, "/git/status", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitLogEmptyRepo(t *testing.T) {
	dir, _ := os.MkdirTemp("", "git-empty-log-test")
	defer os.RemoveAll(dir)
	cmd := exec.Command("git", "init", dir)
	cmd.Run()

	r, _ := setupRouter()
	w := postJSON(r, "/git/log", map[string]string{"path": dir})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Commits []CommitInfo `json:"commits"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Empty(t, resp.Commits)
}

func TestGitInvalidPath(t *testing.T) {
	r, _ := setupRouter()
	w := postJSON(r, "/git/status", map[string]string{"path": "/nonexistent/path"})
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitDiffNewFile(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	require.NoError(t, os.WriteFile(filepath.Join(dir, "brand-new.txt"), []byte("new content"), 0644))

	w := postJSON(r, "/git/diff", map[string]string{"path": dir, "filePath": "brand-new.txt"})
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Path string `json:"path"`
		Old  string `json:"old"`
		New  string `json:"new"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Empty(t, resp.Old)
	assert.Equal(t, "new content", resp.New)
}
