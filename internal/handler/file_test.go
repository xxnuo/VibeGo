package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestFileHandler(t *testing.T) (*FileHandler, *gin.Engine, string) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := NewFileHandler()
	h.SetBaseDir(tmpDir)
	r := gin.New()
	g := r.Group("/api")
	h.Register(g)
	return h, r, tmpDir
}

func TestFileNew(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"test.txt","content":"hello"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, err := os.ReadFile(filepath.Join(tmpDir, "test.txt"))
	require.NoError(t, err)
	assert.Equal(t, "hello", string(content))
}

func TestFileNewDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"subdir","is_dir":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	info, err := os.Stat(filepath.Join(tmpDir, "subdir"))
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestFileNewConflict(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "exists.txt"), []byte("data"), 0644)

	body := `{"path":"exists.txt","content":"new"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestFileRead(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "read.txt"), []byte("content"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read?path=read.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, "content", result["content"])
}

func TestFileReadNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read?path=notexist.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileReadMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileReadIsDirectory(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.Mkdir(filepath.Join(tmpDir, "adir"), 0755)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read?path=adir", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileWrite(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"write.txt","content":"written"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/write", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, err := os.ReadFile(filepath.Join(tmpDir, "write.txt"))
	require.NoError(t, err)
	assert.Equal(t, "written", string(content))
}

func TestFileWriteOverwrite(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "over.txt"), []byte("old"), 0644)

	body := `{"path":"over.txt","content":"new"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/write", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, _ := os.ReadFile(filepath.Join(tmpDir, "over.txt"))
	assert.Equal(t, "new", string(content))
}

func TestFileList(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "a.txt"), []byte("a"), 0644)
	os.Mkdir(filepath.Join(tmpDir, "b"), 0755)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/list?path=.", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &result)
	files := result["files"].([]interface{})
	assert.Len(t, files, 2)
}

func TestFileListNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/list?path=notexist", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileListNotDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "file.txt"), []byte("x"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/list?path=file.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileTree(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.Mkdir(filepath.Join(tmpDir, "dir1"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "dir1", "f.txt"), []byte("f"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/tree?path=.", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result TreeNode
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.True(t, result.IsDir)
	assert.NotEmpty(t, result.Children)
}

func TestFileSearch(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "test.go"), []byte("go"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "test.txt"), []byte("txt"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/search?path=.&pattern=*.go", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &result)
	matches := result["matches"].([]interface{})
	assert.Len(t, matches, 1)
}

func TestFileSearchMissingPattern(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/search?path=.", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileRemove(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "rm.txt"), []byte("x"), 0644)

	body := `{"path":"rm.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file/rm", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	_, err := os.Stat(filepath.Join(tmpDir, "rm.txt"))
	assert.True(t, os.IsNotExist(err))
}

func TestFileRemoveDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "rmdir", "sub"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "rmdir", "sub", "f.txt"), []byte("f"), 0644)

	body := `{"path":"rmdir"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file/rm", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	_, err := os.Stat(filepath.Join(tmpDir, "rmdir"))
	assert.True(t, os.IsNotExist(err))
}

func TestFileRemoveNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"notexist"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file/rm", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileRename(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "old.txt"), []byte("old"), 0644)

	body := `{"old_path":"old.txt","new_path":"new.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/rename", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	_, err := os.Stat(filepath.Join(tmpDir, "old.txt"))
	assert.True(t, os.IsNotExist(err))
	content, _ := os.ReadFile(filepath.Join(tmpDir, "new.txt"))
	assert.Equal(t, "old", string(content))
}

func TestFileRenameNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"old_path":"notexist","new_path":"new.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/rename", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileRenameConflict(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "src.txt"), []byte("s"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "dst.txt"), []byte("d"), 0644)

	body := `{"old_path":"src.txt","new_path":"dst.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/rename", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestFileMkdir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"newdir"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mkdir", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	info, err := os.Stat(filepath.Join(tmpDir, "newdir"))
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestFileMkdirNested(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"a/b/c"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mkdir", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	info, err := os.Stat(filepath.Join(tmpDir, "a", "b", "c"))
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestFileMkdirConflict(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.Mkdir(filepath.Join(tmpDir, "exists"), 0755)

	body := `{"path":"exists"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mkdir", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestPathTraversalBlocked(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read?path=../../../etc/passwd", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileWriteCreatesDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"deep/nested/file.txt","content":"nested"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/write", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, err := os.ReadFile(filepath.Join(tmpDir, "deep", "nested", "file.txt"))
	require.NoError(t, err)
	assert.Equal(t, "nested", string(content))
}

func TestAbs(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/abs?path=.", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &result)

	abs, _ := filepath.Abs(".")
	assert.Equal(t, abs, result["path"])
}

func TestSystemPathBlacklist(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	var blockedPath string
	if runtime.GOOS == "windows" {
		blockedPath = `C:\Windows\System32\drivers`
	} else {
		blockedPath = "/etc/passwd"
	}

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read?path="+blockedPath, nil)
	r.ServeHTTP(w, req)

	// Expecting 400 Bad Request (from checkBlacklist -> resolvePath -> error -> 400)
	// or 403 Forbidden? The current implementation returns err which leads to 400 BadRequest
	// in Read handler if resolvePath fails.
	assert.Equal(t, http.StatusBadRequest, w.Code)
}
