package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

func setupTestHandler(t *testing.T) (*TerminalHandler, func()) {
	tmpDir := t.TempDir()

	db, err := gorm.Open(sqlite.Open(tmpDir+"/test.db"), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}

	if err := db.AutoMigrate(
		&model.UserSession{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
		&model.BlockTermBlock{},
	); err != nil {
		t.Fatalf("failed to migrate: %v", err)
	}

	mgr := terminal.NewManager(db, &terminal.ManagerConfig{Shell: os.Getenv("SHELL")})
	handler := NewTerminalHandler(mgr)

	cleanup := func() {
		sessions, _ := mgr.List("", "")
		for _, s := range sessions {
			mgr.Close(s.ID)
		}
	}

	return handler, cleanup
}

func createTestWorkspaceSession(t *testing.T, handler *TerminalHandler, id string) {
	t.Helper()
	now := time.Now().Unix()
	if err := handler.manager.DB().Create(&model.UserSession{
		ID:           id,
		Name:         "Session",
		State:        "{}",
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}).Error; err != nil {
		t.Fatalf("failed to create workspace session: %v", err)
	}
}

func TestTerminalHandlerNew(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	reqBody := NewTerminalRequest{
		Name: "test",
		Cols: 80,
		Rows: 24,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/terminal", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["ok"] != true {
		t.Error("expected ok=true")
	}
	if resp["id"] == "" {
		t.Error("expected non-empty id")
	}
}

func TestTerminalHandlerList(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info1, _ := handler.manager.Create(terminal.CreateOptions{Name: "test1", Cols: 80, Rows: 24})
	info2, _ := handler.manager.Create(terminal.CreateOptions{Name: "test2", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	req := httptest.NewRequest("GET", "/api/terminal", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp map[string][]TerminalInfo
	json.Unmarshal(w.Body.Bytes(), &resp)

	terminals := resp["terminals"]
	if len(terminals) < 2 {
		t.Errorf("expected at least 2 terminals, got %d", len(terminals))
	}

	found := false
	for _, term := range terminals {
		if term.ID == info1.ID || term.ID == info2.ID {
			found = true
			if term.Status != model.StatusRunning {
				t.Errorf("expected status %s, got %s", model.StatusRunning, term.Status)
			}
		}
	}

	if !found {
		t.Error("created sessions not found in list")
	}
}

func TestTerminalHandlerCreateWithWorkspaceMetadata(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "session-1")
	parent, err := handler.manager.Create(terminal.CreateOptions{
		Name:               "root",
		WorkspaceSessionID: "session-1",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("failed to create parent terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	reqBody := NewTerminalRequest{
		Name:     "meta",
		Cols:     80,
		Rows:     24,
		ParentID: parent.ID,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/terminal", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/terminal", nil)
	router.ServeHTTP(w, req)

	var resp map[string][]TerminalInfo
	json.Unmarshal(w.Body.Bytes(), &resp)

	found := false
	for _, term := range resp["terminals"] {
		if term.Name != "meta" {
			continue
		}
		found = true
		if term.WorkspaceSessionID != "session-1" {
			t.Fatalf("expected workspace_session_id session-1, got %s", term.WorkspaceSessionID)
		}
		if term.GroupID != "group-1" {
			t.Fatalf("expected group_id group-1, got %s", term.GroupID)
		}
		if term.ParentID != parent.ID {
			t.Fatalf("expected parent_id %s, got %s", parent.ID, term.ParentID)
		}
	}

	if !found {
		t.Fatal("created session with metadata not found")
	}
}

func TestTerminalHandlerCreateRejectsMissingWorkspace(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	body, _ := json.Marshal(NewTerminalRequest{
		Name:               "late-terminal",
		WorkspaceSessionID: "deleted-session",
		GroupID:            "group-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/terminal", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d: %s", w.Code, w.Body.String())
	}
	var count int64
	if err := handler.manager.DB().Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("failed to count terminals: %v", err)
	}
	if count != 0 {
		t.Fatalf("missing workspace created %d terminal rows", count)
	}
}

func TestTerminalHandlerCreateRejectsInvalidParent(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "session-1")
	createTestWorkspaceSession(t, handler, "session-2")
	parent, err := handler.manager.Create(terminal.CreateOptions{
		Name:               "parent",
		WorkspaceSessionID: "session-1",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("failed to create parent terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	tests := []struct {
		name   string
		body   NewTerminalRequest
		status int
	}{
		{
			name: "missing parent",
			body: NewTerminalRequest{
				Name:               "missing-parent",
				WorkspaceSessionID: "session-1",
				GroupID:            "group-1",
				ParentID:           "missing",
			},
			status: http.StatusNotFound,
		},
		{
			name: "parent in another group",
			body: NewTerminalRequest{
				Name:               "cross-group-parent",
				WorkspaceSessionID: "session-1",
				GroupID:            "group-2",
				ParentID:           parent.ID,
			},
			status: http.StatusBadRequest,
		},
		{
			name: "parent in another workspace",
			body: NewTerminalRequest{
				Name:               "cross-workspace-parent",
				WorkspaceSessionID: "session-2",
				GroupID:            "group-1",
				ParentID:           parent.ID,
			},
			status: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(tt.body)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/terminal", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tt.status {
				t.Fatalf("expected status %d, got %d: %s", tt.status, w.Code, w.Body.String())
			}
		})
	}

	var count int64
	if err := handler.manager.DB().Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("failed to count terminals: %v", err)
	}
	if count != 1 {
		t.Fatalf("invalid parent requests created terminal rows: %d", count)
	}
}

func TestTerminalHandlerSyncWorkspace(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "session-1")

	info1, _ := handler.manager.Create(terminal.CreateOptions{Name: "test1", Cols: 80, Rows: 24})
	info2, _ := handler.manager.Create(terminal.CreateOptions{Name: "test2", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	body := map[string]any{
		"workspace_session_id": "session-1",
		"terminals": []map[string]string{
			{"id": info1.ID, "group_id": "group-1"},
			{"id": info2.ID, "group_id": "group-1", "parent_id": info1.ID},
		},
	}
	reqBody, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/terminal/sync-workspace", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/terminal?workspace_session_id=session-1&group_id=group-1", nil)
	router.ServeHTTP(w, req)

	var resp map[string][]TerminalInfo
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp["terminals"]) != 2 {
		t.Fatalf("expected 2 terminals, got %d", len(resp["terminals"]))
	}
}

func TestTerminalHandlerSyncRejectsMissingWorkspaceWithoutChangingTerminal(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, err := handler.manager.Create(terminal.CreateOptions{Name: "standalone", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	body := map[string]any{
		"workspace_session_id": "deleted-session",
		"terminals": []map[string]string{
			{"id": info.ID, "group_id": "late-group"},
		},
	}
	reqBody, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/terminal/sync-workspace", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d: %s", w.Code, w.Body.String())
	}

	var stored model.TerminalSession
	if err := handler.manager.DB().First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("failed to load terminal: %v", err)
	}
	if stored.WorkspaceSessionID != "" || stored.GroupID != "" {
		t.Fatalf("missing workspace changed terminal metadata: workspace=%q group=%q", stored.WorkspaceSessionID, stored.GroupID)
	}
	active, ok := handler.manager.Get(info.ID)
	if !ok {
		t.Fatal("terminal is no longer active")
	}
	if active.WorkspaceSessionID != "" || active.GroupID != "" {
		t.Fatalf("missing workspace changed active metadata: workspace=%q group=%q", active.WorkspaceSessionID, active.GroupID)
	}
}

func TestTerminalHandlerSyncRejectsInvalidAssignments(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "session-1")
	createTestWorkspaceSession(t, handler, "session-2")

	first, err := handler.manager.Create(terminal.CreateOptions{Name: "first", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create first terminal: %v", err)
	}
	second, err := handler.manager.Create(terminal.CreateOptions{Name: "second", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create second terminal: %v", err)
	}
	claimed, err := handler.manager.Create(terminal.CreateOptions{
		Name:               "claimed",
		WorkspaceSessionID: "session-2",
		GroupID:            "claimed-group",
	})
	if err != nil {
		t.Fatalf("failed to create claimed terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	tests := []struct {
		name      string
		terminals []map[string]string
		status    int
	}{
		{
			name:      "missing terminal",
			terminals: []map[string]string{{"id": "missing", "group_id": "group-1"}},
			status:    http.StatusNotFound,
		},
		{
			name: "parent omitted",
			terminals: []map[string]string{
				{"id": first.ID, "group_id": "group-1", "parent_id": second.ID},
			},
			status: http.StatusBadRequest,
		},
		{
			name: "parent cycle",
			terminals: []map[string]string{
				{"id": first.ID, "group_id": "group-1", "parent_id": second.ID},
				{"id": second.ID, "group_id": "group-1", "parent_id": first.ID},
			},
			status: http.StatusBadRequest,
		},
		{
			name:      "claimed by another workspace",
			terminals: []map[string]string{{"id": claimed.ID, "group_id": "group-1"}},
			status:    http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"workspace_session_id": "session-1",
				"terminals":            tt.terminals,
			})
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/terminal/sync-workspace", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tt.status {
				t.Fatalf("expected status %d, got %d: %s", tt.status, w.Code, w.Body.String())
			}
		})
	}

	for _, terminalID := range []string{first.ID, second.ID} {
		assertHandlerTerminalScope(t, handler, terminalID, "", "", "")
	}
	assertHandlerTerminalScope(t, handler, claimed.ID, "session-2", "claimed-group", "")
}

func TestTerminalHandlerSyncInvalidWorkspaceStateRollsBack(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	const originalState = `{"openGroups":[],"openTools":[],"terminalsByGroup":{},"activeTerminalByGroup":{},"listManagerOpenByGroup":{},"terminalLayouts":{},"focusedIdByGroup":{},"settingsOpen":false,"activeGroupId":null,"fileManagerByGroup":{}}`
	now := time.Now().Unix()
	if err := handler.manager.DB().Create(&model.UserSession{
		ID:           "session-1",
		Name:         "Session",
		State:        originalState,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}).Error; err != nil {
		t.Fatalf("failed to create workspace session: %v", err)
	}

	existing, err := handler.manager.Create(terminal.CreateOptions{
		Name:               "existing",
		WorkspaceSessionID: "session-1",
		GroupID:            "old-group",
	})
	if err != nil {
		t.Fatalf("failed to create existing terminal: %v", err)
	}
	standalone, err := handler.manager.Create(terminal.CreateOptions{Name: "standalone"})
	if err != nil {
		t.Fatalf("failed to create standalone terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))
	body, err := json.Marshal(map[string]any{
		"workspace_session_id": "session-1",
		"terminals": []map[string]string{
			{"id": standalone.ID, "group_id": "new-group"},
		},
		"workspace_state": map[string]any{
			"terminalLayouts": map[string]any{
				"root": map[string]any{
					"type":      "split",
					"direction": "diagonal",
					"ratio":     0.5,
					"first":     map[string]any{"type": "terminal", "terminalId": existing.ID},
					"second":    map[string]any{"type": "terminal", "terminalId": standalone.ID},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/terminal/sync-workspace", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d: %s", w.Code, w.Body.String())
	}

	var session model.UserSession
	if err := handler.manager.DB().First(&session, "id = ?", "session-1").Error; err != nil {
		t.Fatalf("load workspace session: %v", err)
	}
	if session.State != originalState {
		t.Fatalf("workspace state changed after rollback: %s", session.State)
	}
	assertHandlerTerminalScope(t, handler, existing.ID, "session-1", "old-group", "")
	assertHandlerTerminalScope(t, handler, standalone.ID, "", "", "")
}

func TestTerminalHandlerSyncRejectsWorkspaceStateMismatchAtomically(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	const originalState = `{"openGroups":[],"openTools":[],"terminalsByGroup":{},"activeTerminalByGroup":{},"listManagerOpenByGroup":{},"terminalLayouts":{},"focusedIdByGroup":{},"settingsOpen":false,"activeGroupId":null,"fileManagerByGroup":{}}`
	if err := handler.manager.DB().Create(&model.UserSession{
		ID:    "session-1",
		Name:  "Session",
		State: originalState,
	}).Error; err != nil {
		t.Fatalf("create workspace session: %v", err)
	}

	root, err := handler.manager.Create(terminal.CreateOptions{Name: "root"})
	if err != nil {
		t.Fatalf("create root terminal: %v", err)
	}
	child, err := handler.manager.Create(terminal.CreateOptions{Name: "child"})
	if err != nil {
		t.Fatalf("create child terminal: %v", err)
	}
	assignments := []SyncWorkspaceTerminalRequest{
		{ID: root.ID, GroupID: "group-1"},
		{ID: child.ID, GroupID: "group-1", ParentID: root.ID},
	}

	stringPtr := func(value string) *string { return &value }
	validState := func() SyncWorkspaceStateRequest {
		return SyncWorkspaceStateRequest{
			TerminalsByGroup: map[string][]WorkspaceTerminalSession{
				"group-1": {
					{ID: root.ID, Name: "root"},
					{ID: child.ID, Name: "child", ParentID: stringPtr(root.ID)},
				},
			},
			ActiveTerminalByGroup:  map[string]*string{"group-1": stringPtr(root.ID)},
			ListManagerOpenByGroup: map[string]bool{"group-1": false},
			TerminalLayouts: map[string]WorkspaceLayoutNode{
				root.ID: {Type: "terminal", TerminalID: stringPtr(root.ID)},
			},
			FocusedIDByGroup: map[string]*string{"group-1": stringPtr(child.ID)},
		}
	}

	tests := []struct {
		name   string
		mutate func(*SyncWorkspaceStateRequest)
	}{
		{
			name: "duplicate terminal",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"] = append(
					state.TerminalsByGroup["group-1"],
					WorkspaceTerminalSession{ID: root.ID, Name: "duplicate"},
				)
			},
		},
		{
			name: "missing terminal",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"] = state.TerminalsByGroup["group-1"][:1]
			},
		},
		{
			name: "extra terminal",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"] = append(
					state.TerminalsByGroup["group-1"],
					WorkspaceTerminalSession{ID: "extra", Name: "extra"},
				)
			},
		},
		{
			name: "group mismatch",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"] = state.TerminalsByGroup["group-1"][:1]
				state.TerminalsByGroup["group-2"] = []WorkspaceTerminalSession{
					{ID: child.ID, Name: "child", ParentID: stringPtr(root.ID)},
				}
			},
		},
		{
			name: "parent mismatch",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"][1].ParentID = nil
			},
		},
		{
			name: "invalid tab color",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"][0].TabColor = "purple"
			},
		},
		{
			name: "invalid tab icon",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalsByGroup["group-1"][0].TabIcon = "star"
			},
		},
		{
			name: "unknown active terminal",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.ActiveTerminalByGroup["group-1"] = stringPtr("missing")
			},
		},
		{
			name: "active terminal from another group",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.ActiveTerminalByGroup["group-2"] = stringPtr(root.ID)
			},
		},
		{
			name: "active child terminal",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.ActiveTerminalByGroup["group-1"] = stringPtr(child.ID)
			},
		},
		{
			name: "focused terminal from another group",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.FocusedIDByGroup["group-2"] = stringPtr(child.ID)
			},
		},
		{
			name: "unknown layout root",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalLayouts = map[string]WorkspaceLayoutNode{
					"missing": {Type: "terminal", TerminalID: stringPtr(root.ID)},
				}
			},
		},
		{
			name: "unknown layout terminal",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalLayouts[root.ID] = WorkspaceLayoutNode{Type: "terminal", TerminalID: stringPtr("missing")}
			},
		},
		{
			name: "child layout root",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalLayouts = map[string]WorkspaceLayoutNode{
					child.ID: {Type: "terminal", TerminalID: stringPtr(child.ID)},
				}
			},
		},
		{
			name: "layout omits root",
			mutate: func(state *SyncWorkspaceStateRequest) {
				state.TerminalLayouts[root.ID] = WorkspaceLayoutNode{Type: "terminal", TerminalID: stringPtr(child.ID)}
			},
		},
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state := validState()
			tt.mutate(&state)
			body, err := json.Marshal(SyncWorkspaceRequest{
				WorkspaceSessionID: "session-1",
				Terminals:          assignments,
				WorkspaceState:     &state,
			})
			if err != nil {
				t.Fatalf("marshal sync request: %v", err)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/terminal/sync-workspace", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected status 400, got %d: %s", w.Code, w.Body.String())
			}

			var session model.UserSession
			if err := handler.manager.DB().First(&session, "id = ?", "session-1").Error; err != nil {
				t.Fatalf("load workspace session: %v", err)
			}
			if session.State != originalState {
				t.Fatalf("workspace state changed after rejection: %s", session.State)
			}
			assertHandlerTerminalScope(t, handler, root.ID, "", "", "")
			assertHandlerTerminalScope(t, handler, child.ID, "", "", "")
		})
	}
}

func assertHandlerTerminalScope(
	t *testing.T,
	handler *TerminalHandler,
	terminalID string,
	workspaceSessionID string,
	groupID string,
	parentID string,
) {
	t.Helper()
	var stored model.TerminalSession
	if err := handler.manager.DB().First(&stored, "id = ?", terminalID).Error; err != nil {
		t.Fatalf("failed to load terminal %s: %v", terminalID, err)
	}
	if stored.WorkspaceSessionID != workspaceSessionID || stored.GroupID != groupID || stored.ParentID != parentID {
		t.Fatalf(
			"terminal %s stored scope = (%q, %q, %q), want (%q, %q, %q)",
			terminalID,
			stored.WorkspaceSessionID,
			stored.GroupID,
			stored.ParentID,
			workspaceSessionID,
			groupID,
			parentID,
		)
	}
	active, ok := handler.manager.Get(terminalID)
	if !ok {
		t.Fatalf("terminal %s is not active", terminalID)
	}
	if active.WorkspaceSessionID != workspaceSessionID || active.GroupID != groupID || active.ParentID != parentID {
		t.Fatalf(
			"terminal %s active scope = (%q, %q, %q), want (%q, %q, %q)",
			terminalID,
			active.WorkspaceSessionID,
			active.GroupID,
			active.ParentID,
			workspaceSessionID,
			groupID,
			parentID,
		)
	}
}

func TestTerminalHandlerSyncWorkspaceUpdatesSessionState(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	now := time.Now().Unix()
	err := handler.manager.DB().Create(&model.UserSession{
		ID:           "session-1",
		Name:         "Session",
		State:        `{"openGroups":[],"openTools":[],"terminalsByGroup":{},"activeTerminalByGroup":{},"listManagerOpenByGroup":{},"terminalLayouts":{},"focusedIdByGroup":{},"settingsOpen":false,"activeGroupId":null,"fileManagerByGroup":{}}`,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}).Error
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	info1, _ := handler.manager.Create(terminal.CreateOptions{Name: "test1", Cols: 80, Rows: 24})
	info2, _ := handler.manager.Create(terminal.CreateOptions{Name: "test2", Cols: 80, Rows: 24})
	canonicalName := "canonical-test1"
	canonicalColor := "green"
	canonicalIcon := "compass"
	if err := handler.manager.UpdateSettings(info1.ID, terminal.SettingsUpdate{
		Name:     &canonicalName,
		TabColor: &canonicalColor,
		TabIcon:  &canonicalIcon,
	}); err != nil {
		t.Fatalf("seed canonical terminal settings: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	body := map[string]any{
		"workspace_session_id": "session-1",
		"terminals": []map[string]string{
			{"id": info1.ID, "group_id": "group-1"},
			{"id": info2.ID, "group_id": "group-1", "parent_id": info1.ID},
		},
		"workspace_state": map[string]any{
			"terminalsByGroup": map[string]any{
				"group-1": []map[string]any{
					{"id": info1.ID, "name": "stale", "tabColor": "red", "tabIcon": "fire"},
					{"id": info2.ID, "name": "test2", "parentId": info1.ID},
				},
			},
			"activeTerminalByGroup":  map[string]any{"group-1": info1.ID},
			"listManagerOpenByGroup": map[string]any{"group-1": false},
			"terminalLayouts": map[string]any{
				info1.ID: map[string]any{"type": "terminal", "terminalId": info1.ID},
			},
			"focusedIdByGroup": map[string]any{"group-1": info2.ID},
		},
	}
	reqBody, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/terminal/sync-workspace", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var session model.UserSession
	if err := handler.manager.DB().First(&session, "id = ?", "session-1").Error; err != nil {
		t.Fatalf("failed to load session: %v", err)
	}

	if !strings.Contains(session.State, `"group-1"`) {
		t.Fatalf("expected session state to contain group-1, got %s", session.State)
	}
	if !strings.Contains(session.State, info2.ID) {
		t.Fatalf("expected session state to contain focused terminal id, got %s", session.State)
	}
	state, err := parseWorkspaceState(session.State)
	if err != nil {
		t.Fatalf("parse synchronized workspace state: %v", err)
	}
	canonical := state.TerminalsByGroup["group-1"][0]
	if canonical.Name != canonicalName || canonical.TabColor != canonicalColor || canonical.TabIcon != canonicalIcon {
		t.Fatalf("workspace state did not use canonical terminal settings: %+v", canonical)
	}
}

func TestTerminalHandlerSyncWorkspaceCanonicalizationFailureRollsBackOwnership(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "canonical-rollback-workspace")

	info, err := handler.manager.Create(terminal.CreateOptions{
		Name: "standalone",
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	// Corrupt only the persisted appearance. The request below is otherwise
	// valid, so canonicalization runs after ownership updates inside the same
	// transaction and must force the whole transaction to roll back.
	if err := handler.manager.DB().Model(&model.TerminalSession{}).
		Where("id = ?", info.ID).Update("tab_color", "not-a-valid-color").Error; err != nil {
		t.Fatalf("seed invalid persisted appearance: %v", err)
	}

	state := SyncWorkspaceStateRequest{
		TerminalsByGroup: map[string][]WorkspaceTerminalSession{
			"group-1": {{ID: info.ID, Name: "client value"}},
		},
		ActiveTerminalByGroup:  map[string]*string{},
		ListManagerOpenByGroup: map[string]bool{},
		TerminalLayouts:        map[string]WorkspaceLayoutNode{},
		FocusedIDByGroup:       map[string]*string{},
	}
	body, err := json.Marshal(SyncWorkspaceRequest{
		WorkspaceSessionID: "canonical-rollback-workspace",
		Terminals:          []SyncWorkspaceTerminalRequest{{ID: info.ID, GroupID: "group-1"}},
		WorkspaceState:     &state,
	})
	if err != nil {
		t.Fatalf("encode sync request: %v", err)
	}

	router := gin.New()
	handler.Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodPost, "/api/terminal/sync-workspace", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("expected status 500, got %d: %s", response.Code, response.Body.String())
	}

	var stored model.TerminalSession
	if err := handler.manager.DB().First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("load terminal: %v", err)
	}
	if stored.WorkspaceSessionID != "" || stored.GroupID != "" || stored.ParentID != "" {
		t.Fatalf("ownership changed despite canonicalization failure: %+v", stored)
	}
	var workspace model.UserSession
	if err := handler.manager.DB().First(&workspace, "id = ?", "canonical-rollback-workspace").Error; err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if workspace.State != "{}" {
		t.Fatalf("workspace state changed despite canonicalization failure: %s", workspace.State)
	}
	active, ok := handler.manager.Get(info.ID)
	if !ok {
		t.Fatal("terminal is no longer active")
	}
	if active.WorkspaceSessionID != "" || active.GroupID != "" || active.ParentID != "" {
		t.Fatalf("active ownership changed despite canonicalization failure: %+v", active)
	}
}

func TestTerminalHandlerListByWorkspaceSession(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "session-1")
	createTestWorkspaceSession(t, handler, "session-2")

	_, _ = handler.manager.Create(terminal.CreateOptions{
		Name:               "session-1-terminal",
		Cols:               80,
		Rows:               24,
		WorkspaceSessionID: "session-1",
		GroupID:            "group-1",
	})
	_, _ = handler.manager.Create(terminal.CreateOptions{
		Name:               "session-2-terminal",
		Cols:               80,
		Rows:               24,
		WorkspaceSessionID: "session-2",
		GroupID:            "group-2",
	})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	req := httptest.NewRequest("GET", "/api/terminal?workspace_session_id=session-1", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var resp map[string][]TerminalInfo
	json.Unmarshal(w.Body.Bytes(), &resp)
	terminals := resp["terminals"]
	if len(terminals) != 1 {
		t.Fatalf("expected 1 terminal, got %d", len(terminals))
	}
	if terminals[0].WorkspaceSessionID != "session-1" {
		t.Fatalf("expected workspace_session_id session-1, got %s", terminals[0].WorkspaceSessionID)
	}
}

func TestTerminalHandlerClose(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	reqBody := CloseTerminalRequest{ID: info.ID}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/terminal/close", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	_, ok := handler.manager.Get(info.ID)
	if ok {
		t.Error("expected session to be closed")
	}
}

func TestTerminalHandlerReset(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, err := handler.manager.Create(terminal.CreateOptions{Name: "reset", Cwd: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	req := httptest.NewRequest(http.MethodPost, "/api/terminal/"+info.ID+"/reset", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}
	active, ok := handler.manager.Get(info.ID)
	if !ok || active.Status != model.StatusRunning || active.Readonly {
		t.Fatalf("terminal was not reset in place: %+v", active)
	}

	if err := handler.manager.DB().Create(&model.BlockTermBlock{
		ID:         "handler-reset-running-" + info.ID,
		TerminalID: info.ID,
		LineNum:    1,
		Kind:       "command",
		Command:    "sleep 30",
		Status:     "running",
	}).Error; err != nil {
		t.Fatalf("seed running block: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/terminal/"+info.ID+"/reset", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected status 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTerminalHandlerRename(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	reqBody := RenameTerminalRequest{ID: info.ID, Name: "renamed"}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/terminal/rename", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	sessions, _ := handler.manager.List("", "")
	found := false
	for _, session := range sessions {
		if session.ID == info.ID {
			found = true
			if session.Name != "renamed" {
				t.Errorf("expected renamed terminal, got %s", session.Name)
			}
		}
	}

	if !found {
		t.Fatal("renamed session not found")
	}
}

func TestTerminalHandlerSettingsUpdatesNameColorAndIcon(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "settings-workspace")

	info, err := handler.manager.Create(terminal.CreateOptions{
		Name:               "test",
		Cols:               80,
		Rows:               24,
		WorkspaceSessionID: "settings-workspace",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	state := emptyWorkspaceState()
	state.TerminalsByGroup["group-1"] = []WorkspaceTerminalSession{{ID: info.ID, Name: info.Name}}
	rawState, err := marshalWorkspaceState(state)
	if err != nil {
		t.Fatalf("marshal workspace state: %v", err)
	}
	if err := handler.manager.DB().Model(&model.UserSession{}).
		Where("id = ?", "settings-workspace").
		Update("state", rawState).Error; err != nil {
		t.Fatalf("seed workspace state: %v", err)
	}

	router := gin.New()
	handler.Register(router.Group("/api"))

	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/terminal/"+info.ID+"/settings",
		bytes.NewBufferString(`{"name":"  renamed  ","tab_color":"cyan","tab_icon":"sparkle"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	active, ok := handler.manager.Get(info.ID)
	if !ok {
		t.Fatal("terminal is no longer active")
	}
	if active.Name != "renamed" || active.TabColor != "cyan" || active.TabIcon != "sparkle" {
		t.Fatalf("unexpected active settings: %+v", active)
	}
	var stored model.TerminalSession
	if err := handler.manager.DB().First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("load terminal: %v", err)
	}
	if stored.Name != "renamed" || stored.TabColor != "cyan" || stored.TabIcon != "sparkle" {
		t.Fatalf("unexpected stored settings: %+v", stored)
	}
	listReq := httptest.NewRequest(http.MethodGet, "/api/terminal", nil)
	listResponse := httptest.NewRecorder()
	router.ServeHTTP(listResponse, listReq)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list terminal settings: %d %s", listResponse.Code, listResponse.Body.String())
	}
	var listed map[string][]TerminalInfo
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode terminal list: %v", err)
	}
	var listedTerminal *TerminalInfo
	for i := range listed["terminals"] {
		if listed["terminals"][i].ID == info.ID {
			candidate := listed["terminals"][i]
			listedTerminal = &candidate
			break
		}
	}
	if listedTerminal == nil || listedTerminal.TabColor != "cyan" || listedTerminal.TabIcon != "sparkle" {
		t.Fatalf("terminal list omitted appearance: %+v", listedTerminal)
	}
	var workspace model.UserSession
	if err := handler.manager.DB().First(&workspace, "id = ?", "settings-workspace").Error; err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	workspaceState, err := parseWorkspaceState(workspace.State)
	if err != nil {
		t.Fatalf("parse workspace state: %v", err)
	}
	workspaceTerminal := workspaceState.TerminalsByGroup["group-1"][0]
	if workspaceTerminal.Name != "renamed" || workspaceTerminal.TabColor != "cyan" || workspaceTerminal.TabIcon != "sparkle" {
		t.Fatalf("unexpected workspace terminal settings: %+v", workspaceTerminal)
	}

	req = httptest.NewRequest(
		http.MethodPatch,
		"/api/terminal/"+info.ID+"/settings",
		bytes.NewBufferString(`{"tab_color":"default","tab_icon":""}`),
	)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected default reset status 200, got %d: %s", w.Code, w.Body.String())
	}
	active, ok = handler.manager.Get(info.ID)
	if !ok || active.TabColor != "" || active.TabIcon != "" {
		t.Fatalf("expected default appearance reset, got %+v", active)
	}
	if err := handler.manager.DB().First(&workspace, "id = ?", "settings-workspace").Error; err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	workspaceState, err = parseWorkspaceState(workspace.State)
	if err != nil {
		t.Fatalf("parse reset workspace state: %v", err)
	}
	workspaceTerminal = workspaceState.TerminalsByGroup["group-1"][0]
	if workspaceTerminal.TabColor != "" || workspaceTerminal.TabIcon != "" {
		t.Fatalf("workspace appearance was not reset: %+v", workspaceTerminal)
	}
}

func TestTerminalHandlerSettingsValidationDoesNotPartiallyUpdate(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, err := handler.manager.Create(terminal.CreateOptions{Name: "original", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	router := gin.New()
	handler.Register(router.Group("/api"))

	for _, body := range []string{
		`{}`,
		`{"tab_color":"not-a-color"}`,
		`{"tab_icon":"not-an-icon"}`,
		`{"name":"   "}`,
		`{"name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}`,
	} {
		req := httptest.NewRequest(http.MethodPatch, "/api/terminal/"+info.ID+"/settings", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: expected status 400, got %d: %s", body, w.Code, w.Body.String())
		}
	}

	active, ok := handler.manager.Get(info.ID)
	if !ok || active.Name != "original" || active.TabColor != "" || active.TabIcon != "" {
		t.Fatalf("invalid updates changed terminal: %+v", active)
	}
}

func TestTerminalHandlerSettingsRollsBackWhenWorkspaceStateIsInvalid(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()
	createTestWorkspaceSession(t, handler, "invalid-settings-workspace")
	info, err := handler.manager.Create(terminal.CreateOptions{
		Name:               "original",
		WorkspaceSessionID: "invalid-settings-workspace",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	if err := handler.manager.DB().Model(&model.UserSession{}).
		Where("id = ?", "invalid-settings-workspace").
		Update("state", `{"terminalsByGroup":`).Error; err != nil {
		t.Fatalf("seed invalid state: %v", err)
	}

	router := gin.New()
	handler.Register(router.Group("/api"))
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/terminal/"+info.ID+"/settings",
		bytes.NewBufferString(`{"name":"changed","tab_color":"red"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected status 409, got %d: %s", w.Code, w.Body.String())
	}

	var stored model.TerminalSession
	if err := handler.manager.DB().First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("load stored terminal: %v", err)
	}
	if stored.Name != "original" || stored.TabColor != "" {
		t.Fatalf("terminal row changed despite workspace failure: %+v", stored)
	}
	active, ok := handler.manager.Get(info.ID)
	if !ok || active.Name != "original" || active.TabColor != "" {
		t.Fatalf("active terminal changed despite workspace failure: %+v", active)
	}
}

func TestTerminalHandlerRuntimeInfoClearsLastCommandExitCode(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, err := handler.manager.Create(terminal.CreateOptions{Name: "runtime-info", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	exitCode := 17
	if err := handler.manager.UpdateShellMetadata(info.ID, terminal.ShellMetadataUpdate{
		LastCommandExitCode: &exitCode,
	}); err != nil {
		t.Fatalf("failed to seed exit code: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	postRuntimeInfo := func(payload map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		body, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			t.Fatalf("failed to encode runtime info: %v", marshalErr)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/terminal/runtime-info", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}

	w := postRuntimeInfo(map[string]any{"id": info.ID, "shell_state": "running-command"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected omitted exit code update to succeed, got %d: %s", w.Code, w.Body.String())
	}
	current, ok := handler.manager.Get(info.ID)
	if !ok || current.LastCommandExitCode == nil || *current.LastCommandExitCode != exitCode {
		t.Fatalf("omitted exit code should preserve %d, got %+v", exitCode, current)
	}

	w = postRuntimeInfo(map[string]any{"id": info.ID, "last_command_exit_code": nil})
	if w.Code != http.StatusOK {
		t.Fatalf("expected null exit code update to succeed, got %d: %s", w.Code, w.Body.String())
	}
	current, ok = handler.manager.Get(info.ID)
	if !ok {
		t.Fatal("terminal disappeared after runtime info update")
	}
	if current.LastCommandExitCode != nil {
		t.Fatalf("expected active exit code to be cleared, got %d", *current.LastCommandExitCode)
	}
	var stored model.TerminalSession
	if err := handler.manager.DB().First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("failed to load terminal: %v", err)
	}
	if stored.LastCommandExitCode != nil {
		t.Fatalf("expected persisted exit code to be cleared, got %d", *stored.LastCommandExitCode)
	}
}

func TestTerminalHandlerProcessIdentity(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, err := handler.manager.Create(terminal.CreateOptions{
		Name: "process-identity",
		Cwd:  os.TempDir(),
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	req := httptest.NewRequest(http.MethodGet, "/api/terminal/"+info.ID+"/process-identity", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	var identity terminal.ProcessIdentity
	if err := json.Unmarshal(w.Body.Bytes(), &identity); err != nil {
		t.Fatalf("decode process identity: %v", err)
	}
	if identity.ShellPID <= 0 {
		t.Fatalf("shell pid = %d, want positive", identity.ShellPID)
	}
	if identity.ForegroundChildPID != nil {
		t.Fatalf("idle terminal unexpectedly has foreground child %d", *identity.ForegroundChildPID)
	}
}

func TestTerminalHandlerProcessIdentityNotFound(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))
	req := httptest.NewRequest(http.MethodGet, "/api/terminal/missing/process-identity", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTerminalHandlerWebSocket(t *testing.T) {
	handler, cleanup := setupTestHandler(t)

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	server := httptest.NewServer(router)

	wsURL := "ws" + server.URL[4:] + "/api/terminal/ws/" + info.ID

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect websocket: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	_, ok := handler.manager.Get(info.ID)
	if !ok {
		t.Fatal("session not found")
	}

	conn.Close()
	cleanup()
	server.Close()
	time.Sleep(200 * time.Millisecond)
}

func TestTerminalHistoryPersistence(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	sessions, _ := handler.manager.List("", "")
	var found *terminal.TerminalInfo
	for i, s := range sessions {
		if s.ID == info.ID {
			found = &sessions[i]
			break
		}
	}

	if found == nil {
		t.Fatal("session not found")
	}

	if found.Status != model.StatusRunning {
		t.Errorf("expected status %s, got %s", model.StatusRunning, found.Status)
	}
}
