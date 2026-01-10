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

	// Create a file
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
		Author: &object.Signature{
			Name:  "Test",
			Email: "test@example.com",
			When:  time.Now(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	return dir
}

func bindRepo(t *testing.T, r *gin.Engine, path string) string {
	reqBody := map[string]string{
		"path": path,
	}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/bind", bytes.NewBuffer(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)

	id, ok := resp["id"].(string)
	assert.True(t, ok)
	return id
}

func TestGitStatus(t *testing.T) {
	configDir := setupTestConfig(t)
	defer os.RemoveAll(configDir)

	repoDir := setupGitRepo(t)
	defer os.RemoveAll(repoDir)

	// Modify file
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
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)

	files, ok := resp["files"].([]interface{})
	assert.True(t, ok)
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

	// Make another commit so we can undo it
	// We can use the API or direct filesystem. Let's use direct FS for setup speed.
	wGit, _ := git.PlainOpen(repoDir)
	wt, _ := wGit.Worktree()
	os.WriteFile(filepath.Join(repoDir, "file2.txt"), []byte("content"), 0644)
	wt.Add("file2.txt")
	wt.Commit("second commit", &git.CommitOptions{
		Author: &object.Signature{Name: "Me", Email: "me@me.com", When: time.Now()},
	})

	reqBody := map[string]string{
		"id": id,
	}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/git/undo-commit", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)

	// Verify log has 1 commit again
	iter, _ := wGit.Log(&git.LogOptions{})
	count := 0
	iter.ForEach(func(c *object.Commit) error {
		count++
		return nil
	})
		assert.Equal(t, 1, count)
	}
	
	func TestGitNew(t *testing.T) {
		configDir := setupTestConfig(t)
		defer os.RemoveAll(configDir)
	
		tmpDir, err := os.MkdirTemp("", "git-new-test")
		if err != nil {
			t.Fatal(err)
		}
		defer os.RemoveAll(tmpDir)
	
		repoPath := filepath.Join(tmpDir, "new-repo")
	
		h := setupTestGitHandler(t)
	
		gin.SetMode(gin.TestMode)
		r := gin.New()
		h.Register(r.Group("/"))
	
		reqBody := map[string]string{
			"path": repoPath,
		}
		body, _ := json.Marshal(reqBody)
		req, _ := http.NewRequest("POST", "/git/init", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
	
		assert.Equal(t, http.StatusOK, w.Code)
	
		var resp map[string]interface{}
		err = json.Unmarshal(w.Body.Bytes(), &resp)
		assert.NoError(t, err)
	
		id, ok := resp["id"].(string)
		assert.True(t, ok)
		assert.NotEmpty(t, id)
	
		// Verify repo exists on disk
		_, err = git.PlainOpen(repoPath)
		assert.NoError(t, err)
	}
	
	func TestGitClone(t *testing.T) {
		configDir := setupTestConfig(t)
		defer os.RemoveAll(configDir)
	
		// 1. Setup a source repo to clone from
		sourceDir := setupGitRepo(t)
		defer os.RemoveAll(sourceDir)
	
		// 2. Setup a destination dir
		tmpDir, err := os.MkdirTemp("", "git-clone-test")
		if err != nil {
			t.Fatal(err)
		}
		defer os.RemoveAll(tmpDir)
	
		destPath := filepath.Join(tmpDir, "cloned-repo")
	
		h := setupTestGitHandler(t)
	
		gin.SetMode(gin.TestMode)
		r := gin.New()
		h.Register(r.Group("/"))
	
		reqBody := map[string]string{
			"url":  sourceDir, // Clone from local path
			"path": destPath,
		}
		body, _ := json.Marshal(reqBody)
		req, _ := http.NewRequest("POST", "/git/clone", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
	
		assert.Equal(t, http.StatusOK, w.Code)
	
		var resp map[string]interface{}
		err = json.Unmarshal(w.Body.Bytes(), &resp)
		assert.NoError(t, err)
	
		id, ok := resp["id"].(string)
		assert.True(t, ok)
		assert.NotEmpty(t, id)
	
			// Verify repo exists on disk
			_, err = git.PlainOpen(destPath)
			assert.NoError(t, err)
		}
		
		func TestGitLogWithLimit(t *testing.T) {
			configDir := setupTestConfig(t)
			defer os.RemoveAll(configDir)
		
			repoDir := setupGitRepo(t)
			defer os.RemoveAll(repoDir)
		
			// Create more commits
			w, _ := git.PlainOpen(repoDir)
			wt, _ := w.Worktree()
			for i := 0; i < 5; i++ {
				os.WriteFile(filepath.Join(repoDir, "file.txt"), []byte(time.Now().String()), 0644)
				wt.Add("file.txt")
				wt.Commit("commit "+string(rune(i)), &git.CommitOptions{
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
			err := json.Unmarshal(rec.Body.Bytes(), &resp)
			assert.NoError(t, err)
		
			commits, ok := resp["commits"].([]interface{})
			assert.True(t, ok)
			assert.Equal(t, 3, len(commits))
		}
		