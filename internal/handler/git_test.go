package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func containsStatusPath(files []FileStatus, path string) bool {
	for _, file := range files {
		if file.Path == path {
			return true
		}
	}
	return false
}

func setupGitRepo(t *testing.T) string {
	dir, err := os.MkdirTemp("", "git-test")
	if err != nil {
		t.Fatal(err)
	}

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
	runGit("config", "user.email", "test@example.com")

	err = os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello"), 0644)
	if err != nil {
		t.Fatal(err)
	}

	runGit("add", "test.txt")
	runGit("commit", "-m", "initial commit")

	return dir
}

func TestGitStatus(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("hello world"), 0644)

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]string{"path": repoDir}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/status", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	files := resp["files"].([]interface{})
	assert.GreaterOrEqual(t, len(files), 1)
}

func TestGitLog(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)

	err := os.WriteFile(filepath.Join(repoDir, "log2.txt"), []byte("log2"), 0644)
	assert.NoError(t, err)
	cmd := exec.Command("git", "add", "log2.txt")
	cmd.Dir = repoDir
	assert.NoError(t, cmd.Run())
	cmd = exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "second")
	cmd.Dir = repoDir
	assert.NoError(t, cmd.Run())

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]string{"path": repoDir}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/log", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Commits []CommitInfo `json:"commits"`
	}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Len(t, resp.Commits, 2)
	assert.Equal(t, 1, resp.Commits[0].ParentCount)
	assert.Equal(t, 0, resp.Commits[1].ParentCount)
	assert.Equal(t, "test@example.com", resp.Commits[0].AuthorEmail)
	assert.NotNil(t, resp.Commits[0].Tags)
	assert.NotNil(t, resp.Commits[1].Tags)
}

func TestGitInit(t *testing.T) {
	tmpDir, _ := os.MkdirTemp("", "git-new-test")
	defer os.RemoveAll(tmpDir)
	repoPath := filepath.Join(tmpDir, "new-repo")

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]string{"path": repoPath}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/init", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitClone(t *testing.T) {
	sourceDir := setupGitRepo(t)
	defer os.RemoveAll(sourceDir)
	tmpDir, _ := os.MkdirTemp("", "git-clone-test")
	defer os.RemoveAll(tmpDir)
	destPath := filepath.Join(tmpDir, "cloned-repo")

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]string{"url": sourceDir, "path": destPath}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/clone", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitDiff(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("modified"), 0644)

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]string{"path": repoDir, "filePath": "test.txt"}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/diff", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitAdd(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "newfile.txt"), []byte("new"), 0644)

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]interface{}{"path": repoDir, "files": []string{"newfile.txt"}}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/add", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitReset(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]interface{}{"path": repoDir}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/reset", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitCommit(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "newfile.txt"), []byte("new"), 0644)

	cmd := exec.Command("git", "add", "newfile.txt")
	cmd.Dir = repoDir
	cmd.Run()

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]interface{}{"path": repoDir, "message": "test commit", "author": "Test", "email": "test@example.com"}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/commit", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitCommitSelectedOnlyCommitsSelectedFiles(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)

	err := os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("selected change"), 0644)
	assert.NoError(t, err)
	err = os.WriteFile(filepath.Join(repoDir, "keep-staged.txt"), []byte("staged only"), 0644)
	assert.NoError(t, err)

	cmd := exec.Command("git", "add", "keep-staged.txt")
	cmd.Dir = repoDir
	assert.NoError(t, cmd.Run())

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]interface{}{
		"path":    repoDir,
		"files":   []string{"test.txt"},
		"patches": []interface{}{},
		"summary": "selected only",
	}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/commit-selected", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	status := collectFileStatus(repoDir)
	assert.True(t, containsStatusPath(status, "keep-staged.txt"))
	assert.False(t, containsStatusPath(status, "test.txt"))

	logCmd := exec.Command("git", "log", "-1", "--format=%s")
	logCmd.Dir = repoDir
	logOut, err := logCmd.Output()
	assert.NoError(t, err)
	assert.Equal(t, "selected only", strings.TrimSpace(string(logOut)))

	showCmd := exec.Command("git", "show", "HEAD:test.txt")
	showCmd.Dir = repoDir
	assert.NoError(t, showCmd.Run())

	showCmd2 := exec.Command("git", "show", "HEAD:keep-staged.txt")
	showCmd2.Dir = repoDir
	assert.Error(t, showCmd2.Run())
}

func TestGitUndoCommit(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)

	os.WriteFile(filepath.Join(repoDir, "file2.txt"), []byte("content"), 0644)
	cmd := exec.Command("git", "add", "file2.txt")
	cmd.Dir = repoDir
	cmd.Run()
	cmd = exec.Command("git", "-c", "user.name=Me", "-c", "user.email=me@me.com", "commit", "-m", "second commit")
	cmd.Dir = repoDir
	cmd.Run()

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))

	reqBody := map[string]string{"path": repoDir}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/undo", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitUndoInitialCommitMakesBranchUnbornAndPreservesWorktree(t *testing.T) {
	repoDir, err := os.MkdirTemp("", "git-undo-initial")
	assert.NoError(t, err)
	defer os.RemoveAll(repoDir)
	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repoDir
		output, runErr := cmd.CombinedOutput()
		assert.NoError(t, runErr, string(output))
	}
	runGit("init")
	runGit("config", "user.name", "Test")
	runGit("config", "user.email", "test@example.com")

	initialPath := filepath.Join(repoDir, "file.txt")
	assert.NoError(t, os.WriteFile(initialPath, []byte("initial\n"), 0644))
	runGit("add", "file.txt")
	runGit("commit", "-m", "initial")

	// Simulate both a deleted tracked file and an unrelated untracked change.
	assert.NoError(t, os.Remove(initialPath))
	unrelatedPath := filepath.Join(repoDir, "unrelated.txt")
	assert.NoError(t, os.WriteFile(unrelatedPath, []byte("keep\n"), 0644))

	h := NewGitHandler(nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	w := postJSON(r, "/git/undo", map[string]string{"path": repoDir})
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// The deleted file is restored, while the repository has no commit and all
	// content is represented as unstaged/untracked work.
	content, err := os.ReadFile(initialPath)
	assert.NoError(t, err)
	assert.Equal(t, "initial\n", string(content))
	assert.FileExists(t, unrelatedPath)
	head := exec.Command("git", "rev-parse", "--verify", "HEAD^{commit}")
	head.Dir = repoDir
	assert.Error(t, head.Run())
	status := collectFileStatus(repoDir)
	assert.True(t, containsStatusPath(status, "file.txt"))
	assert.True(t, containsStatusPath(status, "unrelated.txt"))
}
