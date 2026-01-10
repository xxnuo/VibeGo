package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/stretchr/testify/assert"
)

func setupGitRepo(t *testing.T) string {
	dir, err := os.MkdirTemp("", "git-test")
	if err != nil {
		t.Fatal(err)
	}
	repo, err := git.PlainInit(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	w, err := repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(dir, "test.txt")
	err = os.WriteFile(filename, []byte("hello"), 0644)
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.Add("test.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.Commit("initial commit", &git.CommitOptions{
		Author: &object.Signature{Name: "Test", Email: "test@example.com", When: time.Now()},
	})
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestGitStatus(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("hello world"), 0644)

	h := NewGitHandler()
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

	h := NewGitHandler()
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
}

func TestGitInit(t *testing.T) {
	tmpDir, _ := os.MkdirTemp("", "git-new-test")
	defer os.RemoveAll(tmpDir)
	repoPath := filepath.Join(tmpDir, "new-repo")

	h := NewGitHandler()
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

	h := NewGitHandler()
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

	h := NewGitHandler()
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

	h := NewGitHandler()
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

	h := NewGitHandler()
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
	wGit, _ := git.PlainOpen(repoDir)
	wt, _ := wGit.Worktree()
	wt.Add("newfile.txt")

	h := NewGitHandler()
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

func TestGitUndoCommit(t *testing.T) {
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	wGit, _ := git.PlainOpen(repoDir)
	wt, _ := wGit.Worktree()
	os.WriteFile(filepath.Join(repoDir, "file2.txt"), []byte("content"), 0644)
	wt.Add("file2.txt")
	wt.Commit("second commit", &git.CommitOptions{
		Author: &object.Signature{Name: "Me", Email: "me@me.com", When: time.Now()},
	})

	h := NewGitHandler()
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
