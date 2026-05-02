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

	body := `{"name":"Test Device"}`
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

	h.db.Create(&model.UserSession{ID: "s1", Name: "First", State: "{}", CreatedAt: 100, UpdatedAt: 200})
	h.db.Create(&model.UserSession{ID: "s2", Name: "Second", State: "{}", CreatedAt: 150, UpdatedAt: 300})

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

	h.db.Create(&model.UserSession{ID: "load1", Name: "Load Test", State: `{"foo":"bar"}`, CreatedAt: 100, UpdatedAt: 100})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/load1", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result model.UserSession
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, "load1", result.ID)
	assert.Equal(t, "Load Test", result.Name)
	assert.Equal(t, `{"foo":"bar"}`, result.State)
}

func TestSessionLoadWorkspaceState(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{
		ID:    "load-workspace",
		Name:  "Load Workspace",
		State: `{"openGroups":[],"openTools":[],"terminalsByGroup":{},"activeTerminalByGroup":{},"listManagerOpenByGroup":{},"terminalLayouts":{},"focusedIdByGroup":{},"settingsOpen":false,"activeGroupId":null,"fileManagerByGroup":{}}`,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/session/load-workspace", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	workspaceState, ok := result["workspace_state"].(map[string]any)
	assert.True(t, ok)
	assert.NotNil(t, workspaceState["openGroups"])
	assert.NotNil(t, workspaceState["terminalLayouts"])
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

	h.db.Create(&model.UserSession{ID: "save1", Name: "Original", State: "{}", CreatedAt: 100, UpdatedAt: 100})

	body := `{"name":"Renamed Session"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/save1", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session model.UserSession
	h.db.First(&session, "id = ?", "save1")
	assert.Equal(t, "Renamed Session", session.Name)
	assert.Greater(t, session.UpdatedAt, int64(100))
}

func TestSessionSaveWorkspaceState(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{ID: "save-workspace", Name: "Original", State: "{}", CreatedAt: 100, UpdatedAt: 100})

	body := `{"openGroups":[{"id":"group-1","name":"Project","pages":[{"id":"group-1-files","type":"files","label":"Files","tabs":[],"activeTabId":null}],"activePageId":"group-1-files"}],"openTools":[{"id":"tool-1","pageId":"ai-session-manager","name":"AI","tabs":[{"id":"tab-1","title":"Tab"}],"activeTabId":"tab-1"}],"taskbarOrder":["group:group-1","custom:ai"],"settingsOpen":false,"activeGroupId":"group-1","fileManagerByGroup":{}}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PATCH", "/api/session/save-workspace/workspace", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session model.UserSession
	h.db.First(&session, "id = ?", "save-workspace")
	assert.Contains(t, session.State, `"openGroups"`)
	assert.Contains(t, session.State, `"group-1"`)
	assert.Contains(t, session.State, `"taskbarOrder"`)
	assert.Contains(t, session.State, `"custom:ai"`)
	assert.Contains(t, session.State, `"tabs"`)
	assert.Contains(t, session.State, `"tab-1"`)
}

func TestSessionRejectInvalidWorkspaceState(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{ID: "invalid-workspace", Name: "Original", State: "{}", CreatedAt: 100, UpdatedAt: 100})

	body := `{"terminalLayouts":{"root":{"type":"split","direction":"diagonal","ratio":0.5,"first":{"type":"terminal","terminalId":"t1"},"second":{"type":"terminal","terminalId":"t2"}}}}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PATCH", "/api/session/invalid-workspace/workspace", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestSessionPatchWorkspace(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{
		ID:    "patch-workspace",
		Name:  "Original",
		State: `{"openGroups":[],"openTools":[],"terminalsByGroup":{},"activeTerminalByGroup":{},"listManagerOpenByGroup":{},"terminalLayouts":{},"focusedIdByGroup":{},"settingsOpen":false,"activeGroupId":null,"fileManagerByGroup":{}}`,
	})

	body := `{"fileManagerByGroup":{"group-1":{"currentPath":"/tmp/project","rootPath":"/tmp/project","pathHistory":["/tmp/project"],"historyIndex":0,"searchQuery":"main","searchActive":true,"sortField":"modTime","sortOrder":"desc","showHidden":true,"viewMode":"grid"}}}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PATCH", "/api/session/patch-workspace/workspace", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session model.UserSession
	h.db.First(&session, "id = ?", "patch-workspace")
	assert.Contains(t, session.State, `"group-1"`)
	assert.Contains(t, session.State, `"searchQuery":"main"`)
	assert.Contains(t, session.State, `"viewMode":"grid"`)
}

func TestSessionPatchWorkspacePreservesUntouchedFields(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{
		ID:    "patch-preserve",
		Name:  "Original",
		State: `{"openGroups":[],"openTools":[],"terminalsByGroup":{},"activeTerminalByGroup":{},"listManagerOpenByGroup":{},"terminalLayouts":{},"focusedIdByGroup":{},"settingsOpen":false,"activeGroupId":null,"fileManagerByGroup":{"group-1":{"currentPath":"/tmp/project","rootPath":"/tmp/project","pathHistory":["/tmp/project"],"historyIndex":0,"searchQuery":"main","searchActive":true,"sortField":"modTime","sortOrder":"desc","showHidden":true,"viewMode":"grid"}}}`,
	})

	body := `{"openGroups":[{"id":"group-2","name":"Project","pages":[{"id":"group-2-files","type":"files","label":"Files","tabs":[],"activeTabId":null}],"activePageId":"group-2-files"}],"settingsOpen":true,"activeGroupId":"group-2"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PATCH", "/api/session/patch-preserve/workspace", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var session model.UserSession
	h.db.First(&session, "id = ?", "patch-preserve")
	assert.Contains(t, session.State, `"group-2"`)
	assert.Contains(t, session.State, `"viewMode":"grid"`)
}

func TestSessionSaveStateNotFound(t *testing.T) {
	_, r := setupTestSessionHandler(t)

	body := `{"name":"x"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/api/session/notexist", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSessionRemove(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	h.db.Create(&model.UserSession{ID: "rm1", Name: "To Remove", State: "{}", CreatedAt: 100, UpdatedAt: 100})

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

	saveBody := `{"openGroups":[{"id":"group-1","name":"Integration","pages":[{"id":"group-1-files","type":"files","label":"Files","tabs":[],"activeTabId":null}],"activePageId":"group-1-files"}],"openTools":[],"settingsOpen":false,"activeGroupId":"group-1","fileManagerByGroup":{}}`
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("PATCH", "/api/session/"+sessionID+"/workspace", bytes.NewBufferString(saveBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/session/"+sessionID, nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var session map[string]any
	json.Unmarshal(w.Body.Bytes(), &session)
	assert.Contains(t, session["state"], "group-1")

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
