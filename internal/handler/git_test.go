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
	"github.com/glebarez/sqlite"
	"github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/stretchr/testify/assert"
	"github.com/xxnuo/vibego/internal/config"
	"gorm.io/gorm"
)

func setupTestGitHandler(t *testing.T) *GitHandler {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&GitRepository{}); err != nil {
		t.Fatal(err)
	}
	return &GitHandler{db: db}
}

func setupTestConfig(t *testing.T) string {
	tmpDir, err := os.MkdirTemp("", "vibego-test-config")
	if err != nil {
		t.Fatal(err)
	}
	config.GlobalConfig = &config.Config{
		ConfigDir: tmpDir,
		LogLevel:  "error",
	}
	return tmpDir
}

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

func bindRepo(t *testing.T, r *gin.Engine, path string) string {
	reqBody := map[string]string{"path": path}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/bind", bytes.NewBuffer(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	return resp["id"].(string)
}

func TestGitStatus(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("hello world"), 0644)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/status?id="+id, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	files := resp["files"].([]interface{})
	assert.Equal(t, 1, len(files))
}

func TestGitLog(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/log?id="+id, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitUndoCommit(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	wGit, _ := git.PlainOpen(repoDir)
	wt, _ := wGit.Worktree()
	os.WriteFile(filepath.Join(repoDir, "file2.txt"), []byte("content"), 0644)
	wt.Add("file2.txt")
	wt.Commit("second commit", &git.CommitOptions{
		Author: &object.Signature{Name: "Me", Email: "me@me.com", When: time.Now()},
	})
	reqBody := map[string]string{"id": id}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/undo-commit", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitNew(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	tmpDir, _ := os.MkdirTemp("", "git-new-test")
	defer os.RemoveAll(tmpDir)
	repoPath := filepath.Join(tmpDir, "new-repo")
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	reqBody := map[string]string{"path": repoPath}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/init", bytes.NewBuffer(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitClone(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	sourceDir := setupGitRepo(t)
	defer os.RemoveAll(sourceDir)
	tmpDir, _ := os.MkdirTemp("", "git-clone-test")
	defer os.RemoveAll(tmpDir)
	destPath := filepath.Join(tmpDir, "cloned-repo")
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	reqBody := map[string]string{"url": sourceDir, "path": destPath}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/clone", bytes.NewBuffer(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGitLogWithLimit(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	wGit, _ := git.PlainOpen(repoDir)
	wt, _ := wGit.Worktree()
	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(repoDir, "file.txt"), []byte(time.Now().String()), 0644)
		wt.Add("file.txt")
		wt.Commit("commit", &git.CommitOptions{
			Author: &object.Signature{Name: "Me", Email: "me@me.com", When: time.Now()},
		})
	}
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/log?id="+id+"&limit=3", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	var resp map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	commits := resp["commits"].([]interface{})
	assert.Equal(t, 3, len(commits))
}

func TestGitList(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git?page=1&page_size=10", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitUnbind(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("DELETE", "/git/"+id, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitDiff(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("modified"), 0644)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/diff?id="+id+"&path=test.txt", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitDiffMissingPath(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/diff?id="+id, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitShow(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/show?id="+id+"&path=test.txt", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitShowMissingPath(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	req, _ := http.NewRequest("GET", "/git/show?id="+id, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitAdd(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "newfile.txt"), []byte("new"), 0644)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	reqBody := map[string]interface{}{"id": id, "files": []string{"newfile.txt"}}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/add", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitReset(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	reqBody := map[string]interface{}{"id": id}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/reset", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitCheckout(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "test.txt"), []byte("modified"), 0644)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	reqBody := map[string]interface{}{"id": id, "files": []string{"test.txt"}}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/checkout", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestGitCheckoutNoFiles(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	reqBody := map[string]interface{}{"id": id, "files": []string{}}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/checkout", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitCommit(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)
	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)
	os.WriteFile(filepath.Join(repoDir, "newfile.txt"), []byte("new"), 0644)
	wGit, _ := git.PlainOpen(repoDir)
	wt, _ := wGit.Worktree()
	wt.Add("newfile.txt")
	h := setupTestGitHandler(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/"))
	id := bindRepo(t, r, repoDir)
	reqBody := map[string]interface{}{"id": id, "message": "test commit", "author": "Test", "email": "test@example.com"}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/commit", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}
