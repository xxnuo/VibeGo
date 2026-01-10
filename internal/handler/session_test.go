package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupTestSessionHandler(t *testing.T) (*SessionHandler, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test_sessions.sqlite")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Session{}))
	h := &SessionHandler{db: db}
	r := gin.New()
	g := r.Group("/api")
	h.Register(g)
	return h, r
}

func TestSessionNew(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	body := `{"name":"Test Session"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/session", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusCreated, w.Code)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, true, result["ok"])
	assert.NotEmpty(t, result["id"])
}

func TestSessionNewGeneratesUUID(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	body := `{"name":"First"}`
	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest("POST", "/api/session", bytes.NewBufferString(body))
	req1.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w1, req1)

	body = `{"name":"Second"}`
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest("POST", "/api/session", bytes.NewBufferString(body))
	req2.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w2, req2)

	var r1, r2 map[string]any
	json.Unmarshal(w1.Body.Bytes(), &r1)
	json.Unmarshal(w2.Body.Bytes(), &r2)
	assert.NotEqual(t, r1["id"], r2["id"])
}

func TestSessionNewEmptyBody(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/session", bytes.NewBufferString("{}"))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusCreated, w.Code)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.NotEmpty(t, result["id"])
}

func TestSessionList(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&Session{ID: "s1", Name: "First", Messages: "[]", CreatedAt: 100, UpdatedAt: 200})
	h.db.Create(&Session{ID: "s2", Name: "Second", Messages: "[]", CreatedAt: 150, UpdatedAt: 300})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	sessions := result["sessions"].([]any)
	assert.Len(t, sessions, 2)
	first := sessions[0].(map[string]any)
	assert.Equal(t, "s2", first["id"])
}

func TestSessionListEmpty(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	sessions := result["sessions"].([]any)
	assert.Len(t, sessions, 0)
}

func TestSessionLoad(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&Session{ID: "load1", Name: "Load Test", Messages: `[{"role":"user","content":"hi"}]`, CreatedAt: 100, UpdatedAt: 100})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/load1", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result Session
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, "load1", result.ID)
	assert.Equal(t, "Load Test", result.Name)
	assert.Equal(t, `[{"role":"user","content":"hi"}]`, result.Messages)
}

func TestSessionLoadNotFound(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/notexist", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionLoadMissingID(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusMovedPermanently, w.Code)
}

func TestSessionSave(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&Session{ID: "save1", Name: "Original", Messages: "[]", CreatedAt: 100, UpdatedAt: 100})

	body := `{"name":"Updated","messages":"[{\"role\":\"user\",\"content\":\"hello\"}]"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/save1", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session Session
	h.db.First(&session, "id = ?", "save1")
	assert.Equal(t, "Updated", session.Name)
	assert.Contains(t, session.Messages, "hello")
	assert.Greater(t, session.UpdatedAt, int64(100))
}

func TestSessionSavePartial(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&Session{ID: "partial1", Name: "Original", Messages: "[]", CreatedAt: 100, UpdatedAt: 100})

	body := `{"messages":"[{\"msg\":\"new\"}]"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/partial1", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session Session
	h.db.First(&session, "id = ?", "partial1")
	assert.Equal(t, "Original", session.Name)
	assert.Contains(t, session.Messages, "new")
}

func TestSessionSaveNotFound(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	body := `{"name":"New Name"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/notexist", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionRemove(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&Session{ID: "rm1", Name: "To Remove", Messages: "[]", CreatedAt: 100, UpdatedAt: 100})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/session/rm1", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session Session
	err := h.db.First(&session, "id = ?", "rm1").Error
	assert.Error(t, err)
}

func TestSessionRemoveNotFound(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/session/notexist", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionRemoveMissingID(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/session/", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionIntegration(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	newBody := `{"name":"Integration Test"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/session", bytes.NewBufferString(newBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusCreated, w.Code)
	var newResult map[string]any
	json.Unmarshal(w.Body.Bytes(), &newResult)
	sessionID := newResult["id"].(string)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/session", nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var listResult map[string]any
	json.Unmarshal(w.Body.Bytes(), &listResult)
	sessions := listResult["sessions"].([]any)
	assert.Len(t, sessions, 1)

	saveBody := `{"messages":"[{\"role\":\"assistant\",\"content\":\"Hello!\"}]"}`
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("PUT", "/api/session/"+sessionID, bytes.NewBufferString(saveBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/session/"+sessionID, nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var session Session
	json.Unmarshal(w.Body.Bytes(), &session)
	assert.Contains(t, session.Messages, "Hello!")

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("DELETE", "/api/session/"+sessionID, nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/session", nil)
	r.ServeHTTP(w, req)
	json.Unmarshal(w.Body.Bytes(), &listResult)
	sessions = listResult["sessions"].([]any)
	assert.Len(t, sessions, 0)
}

var _ = os.Remove
