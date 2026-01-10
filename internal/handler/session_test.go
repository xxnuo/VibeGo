package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
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
	require.NoError(t, db.AutoMigrate(&model.UserSession{}))
	h := &SessionHandler{db: db}
	r := gin.New()
	g := r.Group("/api")
	h.Register(g)
	return h, r
}

func TestSessionNew(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	body := `{"device_name":"Test Device"}`
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

	body := `{"device_name":"First"}`
	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest("POST", "/api/session", bytes.NewBufferString(body))
	req1.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w1, req1)

	body = `{"device_name":"Second"}`
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

	h.db.Create(&model.UserSession{ID: "s1", DeviceName: "First", State: "{}", CreatedAt: 100, UpdatedAt: 200, ExpiresAt: 999999})
	h.db.Create(&model.UserSession{ID: "s2", DeviceName: "Second", State: "{}", CreatedAt: 150, UpdatedAt: 300, ExpiresAt: 999999})

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

	h.db.Create(&model.UserSession{ID: "load1", DeviceName: "Load Test", State: `{"foo":"bar"}`, CreatedAt: 100, UpdatedAt: 100, ExpiresAt: 999999})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/load1", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result model.UserSession
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, "load1", result.ID)
	assert.Equal(t, "Load Test", result.DeviceName)
	assert.Equal(t, `{"foo":"bar"}`, result.State)
}

func TestSessionLoadNotFound(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/notexist", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionSaveState(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{ID: "save1", DeviceName: "Original", State: "{}", CreatedAt: 100, UpdatedAt: 100, ExpiresAt: 999999})

	body := `{"state":"{\"key\":\"value\"}"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/save1/state", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session model.UserSession
	h.db.First(&session, "id = ?", "save1")
	assert.Contains(t, session.State, "value")
	assert.Greater(t, session.UpdatedAt, int64(100))
}

func TestSessionSaveStateNotFound(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	body := `{"state":"{}"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/notexist/state", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionRemove(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{ID: "rm1", DeviceName: "To Remove", State: "{}", CreatedAt: 100, UpdatedAt: 100, ExpiresAt: 999999})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("DELETE", "/api/session/rm1", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session model.UserSession
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

func TestSessionIntegration(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	newBody := `{"device_name":"Integration Test"}`
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

	saveBody := `{"state":"{\"test\":true}"}`
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("PUT", "/api/session/"+sessionID+"/state", bytes.NewBufferString(saveBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/session/"+sessionID, nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var session model.UserSession
	json.Unmarshal(w.Body.Bytes(), &session)
	assert.Contains(t, session.State, "test")

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
