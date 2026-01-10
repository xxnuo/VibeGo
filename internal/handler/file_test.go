package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
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

	body := `{"path":"subdir","isDir":true}`
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

	body := `{"path":"."}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/tree", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result []FileTree
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.NotEmpty(t, result)
	assert.True(t, result[0].IsDir)
}

func TestFileSearch(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "test.go"), []byte("go"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "test.txt"), []byte("txt"), 0644)

	body := `{"path":".","search":"test.go"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileRemove(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "rm.txt"), []byte("x"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file?path=rm.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	_, err := os.Stat(filepath.Join(tmpDir, "rm.txt"))
	assert.True(t, os.IsNotExist(err))
}

func TestFileRemoveDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "rmdir", "sub"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "rmdir", "sub", "f.txt"), []byte("f"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file?path=rmdir", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	_, err := os.Stat(filepath.Join(tmpDir, "rmdir"))
	assert.True(t, os.IsNotExist(err))
}

func TestFileRemoveNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file?path=notexist", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileRename(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "old.txt"), []byte("old"), 0644)

	body := `{"oldName":"old.txt","newName":"new.txt"}`
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

	body := `{"oldName":"notexist","newName":"new.txt"}`
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

	body := `{"oldName":"src.txt","newName":"dst.txt"}`
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

func TestFileGrep(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "test1.txt"), []byte("hello world\nfoo bar\nhello again"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "test2.txt"), []byte("no match here"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/grep?pattern=hello", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string][]GrepMatch
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, 2, len(resp["matches"]))
}

func TestFileGrepWithLimit(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "test.txt"), []byte("line1\nline2\nline3\nline4"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/grep?pattern=line&limit=2", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string][]GrepMatch
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.Equal(t, 2, len(resp["matches"]))
}

func TestFileGrepMissingPattern(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/grep", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileGrepInvalidPattern(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/grep?pattern=[invalid", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileDelete(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "todel.txt"), []byte("x"), 0644)

	body := `{"path":"todel.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/del", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	_, err := os.Stat(filepath.Join(tmpDir, "todel.txt"))
	assert.True(t, os.IsNotExist(err))
}

func TestFileBatchDelete(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "a.txt"), []byte("a"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "b.txt"), []byte("b"), 0644)

	body := `{"paths":["a.txt","b.txt"]}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/del", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileChangeMode(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "chmod.txt"), []byte("x"), 0644)

	body := `{"path":"chmod.txt","mode":"0755"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mode", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileChangeModeInvalidMode(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "chmod.txt"), []byte("x"), 0644)

	body := `{"path":"chmod.txt","mode":"invalid"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mode", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileChangeModeWithSub(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "subdir"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "subdir", "f.txt"), []byte("x"), 0644)

	body := `{"path":"subdir","mode":"0755","sub":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mode", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileChangeOwner(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "chown.txt"), []byte("x"), 0644)

	body := `{"path":"chown.txt","user":"0","group":"0"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/owner", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, w.Code)
}

func TestFileGetContent(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "content.txt"), []byte("hello content"), 0644)

	body := `{"path":"content.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/content", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "hello content")
}

func TestFileGetContentIsDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "adir"), 0755)

	body := `{"path":"adir"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/content", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileSaveContent(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "save.txt"), []byte("old"), 0644)

	body := `{"path":"save.txt","content":"new content"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/save", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, _ := os.ReadFile(filepath.Join(tmpDir, "save.txt"))
	assert.Equal(t, "new content", string(content))
}

func TestFileCheckExist(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "exists.txt"), []byte("x"), 0644)

	body := `{"path":"exists.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/check", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "true")
}

func TestFileCheckExistNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"notexist.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/check", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "false")
}

func TestFileBatchCheckExist(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "a.txt"), []byte("a"), 0644)

	body := `{"paths":["a.txt","notexist.txt"]}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/check", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileDownload(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "dl.txt"), []byte("download content"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/download?path=dl.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "download content", w.Body.String())
}

func TestFileDownloadMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/download", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileDownloadNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/download?path=notexist.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileGetSize(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "size.txt"), []byte("12345"), 0644)

	body := `{"path":"size.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/size", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "5")
}

func TestFileInfo(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "info.txt"), []byte("info"), 0644)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/info?path=info.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "info.txt")
}

func TestFileInfoMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/info", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileInfoNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/info?path=notexist.txt", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestFileCopy(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "src.txt"), []byte("source"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "dst"), 0755)

	body := `{"srcPaths":["src.txt"],"dstPath":"dst"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/copy", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, _ := os.ReadFile(filepath.Join(tmpDir, "dst", "src.txt"))
	assert.Equal(t, "source", string(content))
}

func TestFileCopyDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "srcdir", "sub"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "srcdir", "sub", "f.txt"), []byte("nested"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "dstdir"), 0755)

	body := `{"srcPaths":["srcdir"],"dstPath":"dstdir"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/copy", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileMove(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "tomove.txt"), []byte("move"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "moveto"), 0755)

	body := `{"type":"move","oldPaths":["tomove.txt"],"newPath":"moveto"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/move", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileMoveCopy(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "tocopy.txt"), []byte("copy"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "copyto"), 0755)

	body := `{"type":"copy","oldPaths":["tocopy.txt"],"newPath":"copyto"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/move", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileRemoveMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/file", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileNewSymlink(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "target.txt"), []byte("target"), 0644)

	body := `{"path":"link.txt","isLink":true,"isSymlink":true,"linkPath":"target.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileNewHardlink(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	targetPath := filepath.Join(tmpDir, "hardtarget.txt")
	os.WriteFile(targetPath, []byte("target"), 0644)

	body := `{"path":"hardlink.txt","isLink":true,"isSymlink":false,"linkPath":"` + targetPath + `"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileNewLinkMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"link.txt","isLink":true,"isSymlink":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileBatchChangeModeAndOwner(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "batch1.txt"), []byte("1"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "batch2.txt"), []byte("2"), 0644)

	body := `{"paths":["batch1.txt","batch2.txt"],"mode":"0755","user":"0","group":"0"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/role", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, w.Code)
}

func TestFileCompress(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "tozip.txt"), []byte("zip content"), 0644)

	body := `{"files":["tozip.txt"],"dst":"` + filepath.Join(tmpDir, "out.zip") + `","type":"zip","name":"out.zip"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileCompressTarGz(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "totar.txt"), []byte("tar content"), 0644)

	body := `{"files":["totar.txt"],"dst":"` + filepath.Join(tmpDir, "out.tar.gz") + `","type":"tar.gz","name":"out.tar.gz"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileCompressUnsupportedType(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "f.txt"), []byte("x"), 0644)

	body := `{"files":["f.txt"],"dst":"out.rar","type":"rar","name":"out.rar"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileDecompress(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "tozip.txt"), []byte("zip content"), 0644)
	body := `{"files":["tozip.txt"],"dst":"` + filepath.Join(tmpDir, "test.zip") + `","type":"zip","name":"test.zip"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	os.MkdirAll(filepath.Join(tmpDir, "extracted"), 0755)
	body = `{"path":"` + filepath.Join(tmpDir, "test.zip") + `","dst":"` + filepath.Join(tmpDir, "extracted") + `","type":"zip"}`
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/file/decompress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileDecompressUnsupportedType(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"test.rar","dst":"out","type":"rar"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/decompress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileSearchNotExist(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"notexist"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchOnFile(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "single.txt"), []byte("x"), 0644)

	body := `{"path":"single.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchWithSort(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "a.txt"), []byte("aaa"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "b.txt"), []byte("b"), 0644)

	body := `{"path":".","sortBy":"size","sortOrder":"descending"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileTreeNotExist(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"notexist"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/tree", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchWithHidden(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, ".hidden"), []byte("h"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "visible.txt"), []byte("v"), 0644)

	body := `{"path":".","showHidden":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), ".hidden")
}

func TestFileSearchDirOnly(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "subdir"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "file.txt"), []byte("f"), 0644)

	body := `{"path":".","dir":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchSortByModTime(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "old.txt"), []byte("o"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "new.txt"), []byte("n"), 0644)

	body := `{"path":".","sortBy":"modTime"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileTreeWithOptions(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "dir1", "sub"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "dir1", "f.txt"), []byte("f"), 0644)
	os.WriteFile(filepath.Join(tmpDir, ".hidden"), []byte("h"), 0644)

	body := `{"path":".","showHidden":true,"dir":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/tree", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileNewWithMode(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"modefile.txt","content":"test","mode":420}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/new", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	info, _ := os.Stat(filepath.Join(tmpDir, "modefile.txt"))
	assert.Equal(t, os.FileMode(0644), info.Mode().Perm())
}

func TestFileCompressDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "compressdir", "sub"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "compressdir", "f.txt"), []byte("f"), 0644)
	os.WriteFile(filepath.Join(tmpDir, "compressdir", "sub", "g.txt"), []byte("g"), 0644)

	body := `{"files":["compressdir"],"dst":"` + filepath.Join(tmpDir, "dir.zip") + `","type":"zip","name":"dir.zip"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileCompressTarGzDir(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "tardir", "sub"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "tardir", "f.txt"), []byte("f"), 0644)

	body := `{"files":["tardir"],"dst":"` + filepath.Join(tmpDir, "dir.tar.gz") + `","type":"tar.gz","name":"dir.tar.gz"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileDecompressTarGz(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "totar.txt"), []byte("tar content"), 0644)
	body := `{"files":["totar.txt"],"dst":"` + filepath.Join(tmpDir, "test.tar.gz") + `","type":"tar.gz","name":"test.tar.gz"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	os.MkdirAll(filepath.Join(tmpDir, "tarextracted"), 0755)
	body = `{"path":"` + filepath.Join(tmpDir, "test.tar.gz") + `","dst":"` + filepath.Join(tmpDir, "tarextracted") + `","type":"tar.gz"}`
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/file/decompress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileWriteInvalidJSON(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/write", bytes.NewBufferString("invalid"))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileAbsEmpty(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/abs", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileMoveWithName(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "rename.txt"), []byte("r"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "renameto"), 0755)

	body := `{"type":"move","oldPaths":["rename.txt"],"newPath":"renameto","name":"newname.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/move", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileCopyConflict(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "src.txt"), []byte("s"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "dst"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "dst", "src.txt"), []byte("existing"), 0644)

	body := `{"srcPaths":["src.txt"],"dstPath":"dst","cover":false}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/copy", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestFileMoveConflict(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "mv.txt"), []byte("m"), 0644)
	os.MkdirAll(filepath.Join(tmpDir, "mvto"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "mvto", "mv.txt"), []byte("existing"), 0644)

	body := `{"type":"move","oldPaths":["mv.txt"],"newPath":"mvto","cover":false}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/move", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestFileChangeOwnerWithSub(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "owndir"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "owndir", "f.txt"), []byte("f"), 0644)

	body := `{"path":"owndir","user":"0","group":"0","sub":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/owner", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, w.Code)
}

func TestFileBatchChangeModeAndOwnerWithSub(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.MkdirAll(filepath.Join(tmpDir, "batchdir"), 0755)
	os.WriteFile(filepath.Join(tmpDir, "batchdir", "f.txt"), []byte("f"), 0644)

	body := `{"paths":["batchdir"],"mode":"0755","user":"0","group":"0","sub":true}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/role", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, w.Code)
}

func TestFileBatchChangeModeAndOwnerInvalidMode(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "f.txt"), []byte("f"), 0644)

	body := `{"paths":["f.txt"],"mode":"invalid","user":"0","group":"0"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/role", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileCompressNoValidFiles(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"files":["notexist"],"dst":"out.zip","type":"zip","name":"out.zip"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/compress", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusBadRequest, http.StatusInternalServerError}, w.Code)
}

func TestFileUpload(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "upload.txt")
	part.Write([]byte("uploaded content"))
	writer.WriteField("path", tmpDir)
	writer.Close()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileUploadMissingPath(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "upload.txt")
	part.Write([]byte("content"))
	writer.Close()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileUploadOverwrite(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "existing.txt"), []byte("old"), 0644)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "existing.txt")
	part.Write([]byte("new content"))
	writer.WriteField("path", tmpDir)
	writer.WriteField("overwrite", "true")
	writer.Close()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileUploadNoOverwrite(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "existing.txt"), []byte("old"), 0644)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "existing.txt")
	part.Write([]byte("new content"))
	writer.WriteField("path", tmpDir)
	writer.Close()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, w.Code)
}

func TestFileGetContentNotFound(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	body := `{"path":"notexist.txt"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/content", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestFileSaveContentNew(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	body := `{"path":"newfile.txt","content":"new content"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/save", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	content, _ := os.ReadFile(filepath.Join(tmpDir, "newfile.txt"))
	assert.Equal(t, "new content", string(content))
}

func TestFileDeleteInvalidJSON(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/del", bytes.NewBufferString("invalid"))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileBatchDeleteInvalidJSON(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/del", bytes.NewBufferString("invalid"))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileBatchDeleteWithErrors(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "exists.txt"), []byte("x"), 0644)

	body := `{"paths":["exists.txt","../../../etc/passwd"]}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/batch/del", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, w.Code)
}

func TestFileMkdirInvalidJSON(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/mkdir", bytes.NewBufferString("invalid"))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestFileReadStatError(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/read?path=../../../etc/shadow", nil)
	r.ServeHTTP(w, req)

	assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound, http.StatusInternalServerError}, w.Code)
}

func TestFileListDefault(t *testing.T) {
	_, r, _ := setupTestFileHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/file/list", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchPagination(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(tmpDir, "file"+string(rune('a'+i))+".txt"), []byte("x"), 0644)
	}

	body := `{"path":".","page":1,"pageSize":2}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestFileSearchPageOutOfRange(t *testing.T) {
	_, r, tmpDir := setupTestFileHandler(t)

	os.WriteFile(filepath.Join(tmpDir, "file.txt"), []byte("x"), 0644)

	body := `{"path":".","page":100,"pageSize":10}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/file/search", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}
