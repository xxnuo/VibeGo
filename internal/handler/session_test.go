package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
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
	require.NoError(t, db.AutoMigrate(
		&model.UserSession{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
	))
	manager := terminal.NewManager(db, &terminal.ManagerConfig{Shell: "/bin/sh"})
	h := NewSessionHandler(db, manager)
	t.Cleanup(func() {
		sessions, _ := manager.List("", "")
		for _, session := range sessions {
			_ = manager.Close(session.ID)
		}
	})
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

func TestSessionListUsesStablePaginationForEqualUpdateTimes(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create([]model.UserSession{
		{ID: "session-c", Name: "Third", State: "{}", UpdatedAt: 200},
		{ID: "session-a", Name: "First", State: "{}", UpdatedAt: 200},
		{ID: "session-b", Name: "Second", State: "{}", UpdatedAt: 200},
	}).Error)

	listPage := func(page int) []SessionInfo {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", fmt.Sprintf("/api/session?page=%d&page_size=2", page), nil)
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
		var result struct {
			Sessions []SessionInfo `json:"sessions"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
		return result.Sessions
	}

	pageOne := listPage(1)
	pageTwo := listPage(2)
	require.Len(t, pageOne, 2)
	require.Len(t, pageTwo, 1)
	require.Equal(t, []string{"session-a", "session-b"}, []string{pageOne[0].ID, pageOne[1].ID})
	require.Equal(t, []string{"session-c"}, []string{pageTwo[0].ID})
}

func TestSessionListUsesExplicitPosition(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create([]model.UserSession{
		{ID: "session-later", Name: "Later", State: "{}", Position: 2, UpdatedAt: 300},
		{ID: "session-first", Name: "First", State: "{}", Position: 1, UpdatedAt: 100},
	}).Error)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var result struct {
		Sessions []SessionInfo `json:"sessions"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.Equal(t, []string{"session-first", "session-later"}, []string{
		result.Sessions[0].ID,
		result.Sessions[1].ID,
	})
	require.EqualValues(t, 1, result.Sessions[0].Position)
	require.EqualValues(t, 2, result.Sessions[1].Position)
}

func TestSessionReorderPlacesSpecifiedSessionsFirstAndPreservesOmittedOrder(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create([]model.UserSession{
		{ID: "session-a", Name: "A", State: "{}", Position: 1, UpdatedAt: 101},
		{ID: "session-b", Name: "B", State: "{}", Position: 2, UpdatedAt: 102},
		{ID: "session-c", Name: "C", State: "{}", Position: 3, UpdatedAt: 103},
		{ID: "session-d", Name: "D", State: "{}", Position: 4, UpdatedAt: 104},
	}).Error)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/session/reorder",
		bytes.NewBufferString(`{"ids":["session-c","session-a"]}`),
	)
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var sessions []model.UserSession
	require.NoError(t, h.db.Order("position ASC").Find(&sessions).Error)
	require.Equal(t, []string{"session-c", "session-a", "session-b", "session-d"}, []string{
		sessions[0].ID,
		sessions[1].ID,
		sessions[2].ID,
		sessions[3].ID,
	})
	for i, session := range sessions {
		require.EqualValues(t, i+1, session.Position)
	}
	require.EqualValues(t, 103, sessions[0].UpdatedAt)
	require.EqualValues(t, 101, sessions[1].UpdatedAt)
}

func TestSessionReorderRejectsInvalidInventoryWithoutChangingPositions(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create([]model.UserSession{
		{ID: "session-a", Name: "A", State: "{}", Position: 1},
		{ID: "session-b", Name: "B", State: "{}", Position: 2},
	}).Error)

	for _, body := range []string{
		`{"ids":[]}`,
		`{"ids":["session-a","session-a"]}`,
		`{"ids":["session-missing"]}`,
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/session/reorder", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())

		var sessions []model.UserSession
		require.NoError(t, h.db.Order("position ASC").Find(&sessions).Error)
		require.Equal(t, []int64{1, 2}, []int64{sessions[0].Position, sessions[1].Position})
	}
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

func TestSessionLoadWithoutTouchPreservesLastActiveTime(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create(&model.UserSession{
		ID:           "peek-workspace",
		Name:         "Peek Workspace",
		State:        "{}",
		LastActiveAt: 123,
	}).Error)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/session/peek-workspace?touch=false", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var session model.UserSession
	require.NoError(t, h.db.First(&session, "id = ?", "peek-workspace").Error)
	require.Equal(t, int64(123), session.LastActiveAt)
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

func TestSessionManualRenamePersistsOverrideAndAutomaticRenamePreservesIt(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create(&model.UserSession{
		ID:    "rename-workspace",
		Name:  "Original",
		State: "{}",
	}).Error)

	update := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/session/rename-workspace", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w
	}

	w := update(`{"name":"  Manual Name  ","workspaceNameOverride":"  Manual Name  "}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var session model.UserSession
	require.NoError(t, h.db.First(&session, "id = ?", "rename-workspace").Error)
	require.Equal(t, "Manual Name", session.Name)
	state, err := parseWorkspaceState(session.State)
	require.NoError(t, err)
	require.NotNil(t, state.WorkspaceNameOverride)
	require.Equal(t, "Manual Name", *state.WorkspaceNameOverride)

	w = update(`{"name":"Automatic Folder Name"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, h.db.First(&session, "id = ?", "rename-workspace").Error)
	require.Equal(t, "Automatic Folder Name", session.Name)
	state, err = parseWorkspaceState(session.State)
	require.NoError(t, err)
	require.NotNil(t, state.WorkspaceNameOverride)
	require.Equal(t, "Manual Name", *state.WorkspaceNameOverride)

	w = update(`{"workspaceNameOverride":null}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, h.db.First(&session, "id = ?", "rename-workspace").Error)
	require.Equal(t, "Automatic Folder Name", session.Name)
	state, err = parseWorkspaceState(session.State)
	require.NoError(t, err)
	require.Nil(t, state.WorkspaceNameOverride)
}

func TestSessionRenameValidationIsAtomic(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create(&model.UserSession{
		ID:    "invalid-rename",
		Name:  "Original",
		State: `{"workspaceNameOverride":"Original"}`,
	}).Error)

	for _, body := range []string{
		`{"name":"   "}`,
		fmt.Sprintf(`{"name":%q}`, strings.Repeat("x", 51)),
		`{"name":"One","workspaceNameOverride":"Two"}`,
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/session/invalid-rename", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())

		var session model.UserSession
		require.NoError(t, h.db.First(&session, "id = ?", "invalid-rename").Error)
		require.Equal(t, "Original", session.Name)
		state, err := parseWorkspaceState(session.State)
		require.NoError(t, err)
		require.NotNil(t, state.WorkspaceNameOverride)
		require.Equal(t, "Original", *state.WorkspaceNameOverride)
	}
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

func TestSessionPatchWorkspaceRejectsInvalidPersistedStateAsServerError(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create(&model.UserSession{
		ID:    "invalid-persisted-workspace",
		Name:  "Invalid",
		State: `{"openGroups":`,
	}).Error)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/session/invalid-persisted-workspace/workspace",
		bytes.NewBufferString(`{"settingsOpen":true}`),
	)
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	var session model.UserSession
	require.NoError(t, h.db.First(&session, "id = ?", "invalid-persisted-workspace").Error)
	assert.Equal(t, `{"openGroups":`, session.State)
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

func TestSessionPatchWorkspaceCanonicalizesTerminalSettings(t *testing.T) {
	h, r := setupTestSessionHandler(t)
	now := time.Now().Unix()
	require.NoError(t, h.db.Create(&model.UserSession{
		ID:           "canonical-workspace",
		Name:         "Workspace",
		State:        "{}",
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}).Error)

	info, err := h.manager.Create(terminal.CreateOptions{
		Name:               "Database Name",
		WorkspaceSessionID: "canonical-workspace",
		GroupID:            "group-1",
	})
	require.NoError(t, err)
	canonicalName := "Canonical Name"
	canonicalColor := "cyan"
	canonicalIcon := "compass"
	require.NoError(t, h.manager.UpdateSettings(info.ID, terminal.SettingsUpdate{
		Name:     &canonicalName,
		TabColor: &canonicalColor,
		TabIcon:  &canonicalIcon,
	}))

	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/session/canonical-workspace/workspace",
		bytes.NewBufferString(fmt.Sprintf(
			`{"terminalsByGroup":{"group-1":[{"id":%q,"name":"client value","tabColor":"red","tabIcon":"fire"}]},"settingsOpen":true}`,
			info.ID,
		)),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	var workspace model.UserSession
	require.NoError(t, h.db.First(&workspace, "id = ?", "canonical-workspace").Error)
	state, err := parseWorkspaceState(workspace.State)
	require.NoError(t, err)
	require.True(t, state.SettingsOpen)
	require.Len(t, state.TerminalsByGroup["group-1"], 1)
	terminalState := state.TerminalsByGroup["group-1"][0]
	require.Equal(t, info.ID, terminalState.ID)
	require.Equal(t, canonicalName, terminalState.Name)
	require.Equal(t, canonicalColor, terminalState.TabColor)
	require.Equal(t, canonicalIcon, terminalState.TabIcon)
}

func TestSessionPatchWorkspaceCanonicalizationFailureIsAtomic(t *testing.T) {
	h, r := setupTestSessionHandler(t)
	now := time.Now().Unix()
	require.NoError(t, h.db.Create(&model.UserSession{
		ID:           "canonical-atomic-workspace",
		Name:         "Workspace",
		State:        `{"settingsOpen":false}`,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}).Error)
	info, err := h.manager.Create(terminal.CreateOptions{
		Name:               "Owned Terminal",
		WorkspaceSessionID: "canonical-atomic-workspace",
		GroupID:            "group-1",
	})
	require.NoError(t, err)

	var before model.UserSession
	require.NoError(t, h.db.First(&before, "id = ?", "canonical-atomic-workspace").Error)
	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/session/canonical-atomic-workspace/workspace",
		bytes.NewBufferString(fmt.Sprintf(
			`{"terminalsByGroup":{"group-1":[{"id":%q,"name":"stale"},{"id":"missing","name":"missing"}]},"settingsOpen":true}`,
			info.ID,
		)),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())

	var after model.UserSession
	require.NoError(t, h.db.First(&after, "id = ?", "canonical-atomic-workspace").Error)
	require.Equal(t, before.State, after.State)
	require.Equal(t, before.Name, after.Name)
	require.Equal(t, before.UpdatedAt, after.UpdatedAt)
}

func TestSessionPatchWorkspaceRejectsEmptyTerminalID(t *testing.T) {
	h, r := setupTestSessionHandler(t)
	require.NoError(t, h.db.Create(&model.UserSession{
		ID:    "empty-terminal-id-workspace",
		Name:  "Workspace",
		State: `{"settingsOpen":false}`,
	}).Error)

	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/session/empty-terminal-id-workspace/workspace",
		bytes.NewBufferString(`{"terminalsByGroup":{"group-1":[{"id":"   "}]},"settingsOpen":true}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())

	var workspace model.UserSession
	require.NoError(t, h.db.First(&workspace, "id = ?", "empty-terminal-id-workspace").Error)
	require.Equal(t, `{"settingsOpen":false}`, workspace.State)
}

func TestSessionPatchWorkspaceChecksMissingWorkspaceBeforeTerminalScope(t *testing.T) {
	h, _ := setupTestSessionHandler(t)
	info, err := h.manager.Create(terminal.CreateOptions{
		Name:    "unscoped",
		Cols:    80,
		Rows:    24,
		GroupID: "other-group",
	})
	require.NoError(t, err)

	// Use the legacy session-only handler shape to exercise the transaction path
	// without Manager.MutateWorkspace's preflight check.
	r := gin.New()
	NewSessionHandler(h.db).Register(r.Group("/api"))
	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/session/missing-workspace/workspace",
		bytes.NewBufferString(fmt.Sprintf(
			`{"terminalsByGroup":{"expected-group":[{"id":%q}]}}`, info.ID,
		)),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
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

func TestSessionPatchWorkspaceSerializesWithDeleteWorkspace(t *testing.T) {
	t.Run("patch commits before waiting delete", func(t *testing.T) {
		h, router := setupTestSessionHandler(t)
		require.NoError(t, h.db.Create(&model.UserSession{ID: "patch-first", Name: "Patch First", State: "{}"}).Error)

		entered := make(chan struct{})
		release := make(chan struct{})
		var enterOnce sync.Once
		var releaseOnce sync.Once
		const callbackName = "test:patch_workspace_query_gate"
		require.NoError(t, h.db.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
			if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.UserSession{}).TableName() {
				return
			}
			enterOnce.Do(func() {
				close(entered)
				<-release
			})
		}))
		t.Cleanup(func() {
			releaseOnce.Do(func() { close(release) })
			_ = h.db.Callback().Query().Remove(callbackName)
		})

		patchDone := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(
				http.MethodPatch,
				"/api/session/patch-first/workspace",
				bytes.NewBufferString(`{"settingsOpen":true}`),
			)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			patchDone <- w
		}()

		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("workspace patch did not reach query callback")
		}

		deleteDone := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(http.MethodDelete, "/api/session/patch-first", nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			deleteDone <- w
		}()

		select {
		case w := <-deleteDone:
			t.Fatalf("workspace delete bypassed in-flight patch: %d %s", w.Code, w.Body.String())
		case <-time.After(25 * time.Millisecond):
		}

		releaseOnce.Do(func() { close(release) })
		patch := <-patchDone
		require.Equal(t, http.StatusOK, patch.Code, patch.Body.String())
		deleted := <-deleteDone
		require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

		var count int64
		require.NoError(t, h.db.Model(&model.UserSession{}).Where("id = ?", "patch-first").Count(&count).Error)
		assert.Zero(t, count)
	})

	t.Run("patch observes completed delete", func(t *testing.T) {
		h, router := setupTestSessionHandler(t)
		require.NoError(t, h.db.Create(&model.UserSession{ID: "delete-first", Name: "Delete First", State: "{}"}).Error)

		entered := make(chan struct{})
		release := make(chan struct{})
		var enterOnce sync.Once
		var releaseOnce sync.Once
		const callbackName = "test:delete_workspace_gate"
		require.NoError(t, h.db.Callback().Delete().Before("gorm:delete").Register(callbackName, func(tx *gorm.DB) {
			if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.UserSession{}).TableName() {
				return
			}
			enterOnce.Do(func() {
				close(entered)
				<-release
			})
		}))
		t.Cleanup(func() {
			releaseOnce.Do(func() { close(release) })
			_ = h.db.Callback().Delete().Remove(callbackName)
		})

		deleteDone := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(http.MethodDelete, "/api/session/delete-first", nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			deleteDone <- w
		}()

		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("workspace delete did not reach delete callback")
		}

		patchDone := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(
				http.MethodPatch,
				"/api/session/delete-first/workspace",
				bytes.NewBufferString(`{"settingsOpen":true}`),
			)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			patchDone <- w
		}()

		select {
		case w := <-patchDone:
			t.Fatalf("workspace patch bypassed in-flight delete: %d %s", w.Code, w.Body.String())
		case <-time.After(25 * time.Millisecond):
		}

		releaseOnce.Do(func() { close(release) })
		deleted := <-deleteDone
		require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
		patch := <-patchDone
		require.Equal(t, http.StatusNotFound, patch.Code, patch.Body.String())
	})
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

func TestSessionRemoveCleansWorkspaceTerminalTree(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	now := time.Now().Unix()
	require.NoError(t, h.db.Create(&model.UserSession{ID: "remove-workspace", Name: "Remove", State: "{}"}).Error)
	require.NoError(t, h.db.Create(&model.UserSession{ID: "keep-workspace", Name: "Keep", State: "{}"}).Error)

	root, err := h.manager.Create(terminal.CreateOptions{
		Name:               "root",
		WorkspaceSessionID: "remove-workspace",
		GroupID:            "group-1",
	})
	require.NoError(t, err)
	child, err := h.manager.Create(terminal.CreateOptions{
		Name:               "child",
		WorkspaceSessionID: "remove-workspace",
		GroupID:            "group-1",
		ParentID:           root.ID,
	})
	require.NoError(t, err)
	grandchild, err := h.manager.Create(terminal.CreateOptions{
		Name:               "grandchild",
		WorkspaceSessionID: "remove-workspace",
		GroupID:            "group-1",
		ParentID:           child.ID,
	})
	require.NoError(t, err)
	unrelated, err := h.manager.Create(terminal.CreateOptions{
		Name:               "unrelated",
		WorkspaceSessionID: "keep-workspace",
		GroupID:            "group-2",
	})
	require.NoError(t, err)

	removedIDs := []string{root.ID, child.ID, grandchild.ID}
	for i, terminalID := range append(append([]string{}, removedIDs...), unrelated.ID) {
		workspaceSessionID := "remove-workspace"
		if terminalID == unrelated.ID {
			workspaceSessionID = "keep-workspace"
		}
		require.NoError(t, h.db.Create(&model.TerminalHistory{
			SessionID: terminalID,
			Data:      []byte("history"),
			CreatedAt: now,
		}).Error)
		require.NoError(t, h.db.Create(&model.BlockTermBlock{
			ID:         fmt.Sprintf("block-%d", i),
			TerminalID: terminalID,
			LineNum:    0,
			CreatedAt:  now,
			UpdatedAt:  now,
		}).Error)
		require.NoError(t, h.db.Create(&model.BlockTermCommandHistory{
			ID:                 fmt.Sprintf("block-%d", i),
			TerminalID:         terminalID,
			WorkspaceSessionID: workspaceSessionID,
			LineNum:            0,
			Command:            fmt.Sprintf("command-%d", i),
			CreatedAt:          now,
		}).Error)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/session/remove-workspace", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	for _, terminalID := range removedIDs {
		_, active := h.manager.Get(terminalID)
		assert.False(t, active, "terminal %s is still active", terminalID)
	}

	var count int64
	require.NoError(t, h.db.Model(&model.UserSession{}).Where("id = ?", "remove-workspace").Count(&count).Error)
	assert.Zero(t, count)
	require.NoError(t, h.db.Model(&model.TerminalSession{}).Where("id IN ?", removedIDs).Count(&count).Error)
	assert.Zero(t, count)
	require.NoError(t, h.db.Model(&model.TerminalHistory{}).Where("session_id IN ?", removedIDs).Count(&count).Error)
	assert.Zero(t, count)
	require.NoError(t, h.db.Model(&model.BlockTermBlock{}).Where("terminal_id IN ?", removedIDs).Count(&count).Error)
	assert.Zero(t, count)
	require.NoError(t, h.db.Model(&model.BlockTermCommandHistory{}).Where("terminal_id IN ?", removedIDs).Count(&count).Error)
	assert.EqualValues(t, len(removedIDs), count)

	require.NoError(t, h.db.Model(&model.UserSession{}).Where("id = ?", "keep-workspace").Count(&count).Error)
	assert.EqualValues(t, 1, count)
	require.NoError(t, h.db.Model(&model.TerminalSession{}).Where("id = ?", unrelated.ID).Count(&count).Error)
	assert.EqualValues(t, 1, count)
	require.NoError(t, h.db.Model(&model.BlockTermCommandHistory{}).Where("terminal_id = ?", unrelated.ID).Count(&count).Error)
	assert.EqualValues(t, 1, count)
	_, active := h.manager.Get(unrelated.ID)
	assert.True(t, active)
}

func TestSessionRemoveKeepsSessionWhenTerminalCleanupFails(t *testing.T) {
	h, r := setupTestSessionHandler(t)

	require.NoError(t, h.db.Create(&model.UserSession{ID: "cleanup-fails", Name: "Keep", State: "{}"}).Error)
	info, err := h.manager.Create(terminal.CreateOptions{
		Name:               "terminal",
		WorkspaceSessionID: "cleanup-fails",
	})
	require.NoError(t, err)
	require.NoError(t, h.db.Migrator().DropTable(&model.TerminalHistory{}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/session/cleanup-fails", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())

	var count int64
	require.NoError(t, h.db.Model(&model.UserSession{}).Where("id = ?", "cleanup-fails").Count(&count).Error)
	assert.EqualValues(t, 1, count)
	require.NoError(t, h.db.Model(&model.TerminalSession{}).Where("id = ?", info.ID).Count(&count).Error)
	assert.EqualValues(t, 1, count)
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
