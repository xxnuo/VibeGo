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
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/config"
	"github.com/xxnuo/vibego/internal/middleware"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	workspacesvc "github.com/xxnuo/vibego/internal/service/workspace"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func workspaceFixture(t *testing.T) (*gorm.DB, *workspacesvc.Service, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "test.sqlite")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.UserSession{}, &model.TerminalSession{}, &model.TerminalHistory{}); err != nil {
		t.Fatal(err)
	}
	if err := config.MigrateLegacySessionsToWorkspaces(db); err != nil {
		t.Fatal(err)
	}
	service := workspacesvc.New(db)
	router := gin.New()
	api := router.Group("/api")
	api.Use(middleware.Auth("test-key"))
	NewWorkspaceHandler(service).Register(api)
	NewSessionHandler(db).WithWorkspaceSync(service).Register(api)
	return db, service, router
}
func mutation(t *testing.T, id, kind string, p any) workspacesvc.ClientMutation {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return workspacesvc.ClientMutation{ID: id, WorkspaceID: "ws", ClientID: "client-a", Type: kind, Payload: raw, CreatedAt: time.Now().UnixMilli(), BaseRevision: 1}
}
func workspaceRequest(router http.Handler, path string, m workspacesvc.ClientMutation) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(m)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestApplyMutation_ConcurrentTransactions(t *testing.T) {
	db, service, router := workspaceFixture(t)
	if err := db.Create(&model.Workspace{ID: "ws", Name: "Test", Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	const workers = 24
	events, _, unsubscribe := service.Subscribe("ws")
	defer unsubscribe()
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			m := mutation(t, fmt.Sprint(i), "folder/add", map[string]any{"id": fmt.Sprint(i), "path": "/test", "name": fmt.Sprint(i)})
			w := workspaceRequest(router, "/api/workspace/mutations", m)
			if w.Code != 200 {
				t.Errorf("%d %s", w.Code, w.Body)
			}
		}(i)
	}
	wg.Wait()
	snapshot, err := service.Snapshot("ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Folders) != workers || snapshot.Workspace.Revision != workers+1 {
		t.Fatalf("lost concurrent assets: %+v", snapshot)
	}
	for i := int64(2); i <= workers+1; i++ {
		select {
		case event := <-events:
			if event.Revision != i {
				t.Fatalf("out of order: %d != %d", event.Revision, i)
			}
		case <-time.After(time.Second):
			t.Fatal("missing broadcast")
		}
	}
	m := mutation(t, "0", "folder/add", map[string]any{"id": "0", "path": "/test", "name": "0"})
	if w := workspaceRequest(router, "/api/workspace/mutations", m); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	snapshot, _ = service.Snapshot("ws")
	if snapshot.Workspace.Revision != workers+1 {
		t.Fatal("duplicate increments revision")
	}
	select {
	case <-events:
		t.Fatal("duplicate broadcast")
	default:
	}
	m.Payload = json.RawMessage(`{"id":"other","path":"/test","name":"Other"}`)
	if w := workspaceRequest(router, "/api/workspace/mutations", m); w.Code != 409 {
		t.Fatalf("reused id: %d", w.Code)
	}
}

func TestWorkspaceMigrationPreservesEntitiesAndIsIdempotent(t *testing.T) {
	db, service, _ := workspaceFixture(t)
	raw := `{"activeGroupId":"folder","openGroups":[{"id":"folder","name":"Repo","activePageId":"files","data":{"encoding":"utf8"},"pages":[{"id":"files","type":"files","label":"Files","path":"/repo","tabs":[{"id":"same","title":"Diff","pinned":true,"data":{"type":"diff","originalPath":"a","modifiedPath":"b"}},{"id":"custom","title":"Custom","data":{"editorId":"fixture","query":"select 1"}}]},{"id":"extra","type":"plugin-page","label":"Extra","tabs":[{"id":"same","title":"Preview","data":{"type":"preview","port":3000}}]}]}],"openTools":[{"id":"tool-port-manager","pageId":"port-manager","name":"Ports","data":{"filter":"tcp"},"tabs":[{"id":"tool-tab","title":"Ports","data":{"port":80}}]}]}`
	for _, id := range []string{"ws", "second"} {
		if err := db.Create(&model.UserSession{ID: id, Name: id, State: raw}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := config.MigrateLegacySessionsToWorkspaces(db); err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.Snapshot("ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Tabs) != 4 || len(snapshot.Tools) != 1 || len(snapshot.Folders) != 1 {
		t.Fatalf("lost inventory: %+v", snapshot)
	}
	if !strings.Contains(snapshot.Tools[0].Data, `"filter":"tcp"`) || !strings.Contains(snapshot.Folders[0].Data, `"encoding":"utf8"`) {
		t.Fatal("lost generic data")
	}
	for _, tab := range snapshot.Tabs {
		if tab.ID == "custom" && tab.TabType != "custom_editor" {
			t.Fatal("lost editor kind")
		}
		if strings.Contains(tab.Data, "activeTabId") {
			t.Fatal("viewport migrated")
		}
	}
	m := mutation(t, "remove", "folder/remove", map[string]any{"id": "folder"})
	if _, err := service.Commit(m); err != nil {
		t.Fatal(err)
	}
	if err := config.MigrateLegacySessionsToWorkspaces(db); err != nil {
		t.Fatal(err)
	}
	snapshot, _ = service.Snapshot("ws")
	if len(snapshot.Folders) != 0 || len(snapshot.Tabs) != 1 {
		t.Fatal("migration resurrected removed assets")
	}
	var stored model.UserSession
	if err := db.First(&stored, "id = ?", "ws").Error; err != nil {
		t.Fatal(err)
	}
	if stored.State != raw {
		t.Fatal("recovery copy was changed")
	}
}

func TestWorkspaceMutationValidationStorageAndCascade(t *testing.T) {
	db, service, router := workspaceFixture(t)
	if err := db.Create(&model.Workspace{ID: "ws", Revision: 1, Name: "Test"}).Error; err != nil {
		t.Fatal(err)
	}
	commit := func(id, kind string, p any) {
		t.Helper()
		w := workspaceRequest(router, "/api/workspace/mutations", mutation(t, id, kind, p))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", kind, w.Code, w.Body)
		}
	}
	commit("folder", "folder/add", map[string]any{"id": "folder", "name": "Repo", "path": "/repo"})
	commit("tab", "tab/open", map[string]any{"id": "tab", "folder_id": "folder", "tab_type": "custom_editor", "title": "Editor", "data": map[string]any{"editorId": "fixture", "query": "select 1"}})
	commit("pin", "tab/pin", map[string]any{"id": "tab", "pinned": true})
	commit("tool", "tool/open", map[string]any{"id": "tool", "page_id": "remote-desktop", "name": "Desktop", "data": map[string]any{"quality": "sharp"}})
	commit("update", "tool/update-data", map[string]any{"id": "tool", "data": map[string]any{"quality": "smooth"}})
	commit("storage", "plugin/storage-update", map[string]any{"plugin_id": "fixture", "scope": "folder", "key": "setting", "value": map[string]any{"model": "test"}})
	commit("plugin", "plugin/mutate", map[string]any{"plugin_id": "fixture", "action": "refresh", "data": []any{1, "two"}})
	snapshot, _ := service.Snapshot("ws")
	if !snapshot.Tabs[0].Pinned || len(snapshot.Storage) != 1 || snapshot.Tools[0].Data != `{"quality":"smooth"}` {
		t.Fatalf("bad snapshot: %+v", snapshot)
	}
	commit("second-folder", "folder/add", map[string]any{"id": "second", "name": "Second", "path": "/second"})
	commit("reorder", "folder/reorder", map[string]any{"folder_ids": []string{"second", "folder"}})
	commit("preview", "tab/open", map[string]any{"id": "preview", "folder_id": "second", "tab_type": "preview", "title": "Preview", "data": map[string]any{"port": 3000}})
	commit("close-preview", "tab/close", map[string]any{"id": "preview", "folder_id": "second"})
	commit("unpin", "tab/pin", map[string]any{"id": "tab", "pinned": false})
	commit("close-tool", "tool/close", map[string]any{"id": "tool"})
	commit("delete-storage", "plugin/storage-update", map[string]any{"plugin_id": "fixture", "scope": "folder", "key": "setting", "deleted": true})
	snapshot, _ = service.Snapshot("ws")
	if snapshot.Folders[0].ID != "second" || snapshot.Tabs[0].Pinned || len(snapshot.Tabs) != 1 || len(snapshot.Tools) != 0 || len(snapshot.Storage) != 0 {
		t.Fatal("reorder, close, unpin or storage deletion was not applied")
	}
	before := snapshot.Workspace.Revision
	for i, invalid := range []struct {
		kind  string
		value any
	}{{"unknown", map[string]any{}}, {"tab/open", map[string]any{"id": "orphan", "folder_id": "missing", "title": "bad"}}, {"folder/reorder", map[string]any{"folder_ids": []string{"folder", "missing"}}}, {"tool/open", map[string]any{"id": "bad", "page_id": "test", "name": "Test", "data": []any{1}}}} {
		w := workspaceRequest(router, "/api/workspace/mutations", mutation(t, fmt.Sprint("invalid", i), invalid.kind, invalid.value))
		if w.Code < 400 {
			t.Fatal("accepted invalid mutation")
		}
	}
	snapshot, _ = service.Snapshot("ws")
	if snapshot.Workspace.Revision != before || snapshot.Folders[0].Position != 0 {
		t.Fatal("invalid mutation partially committed")
	}
	request := httptest.NewRequest(http.MethodPatch, "/api/session/ws/workspace", strings.NewReader(`{"openGroups":[]}`))
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	if w.Code != 409 {
		t.Fatal("legacy blind write accepted")
	}
	commit("remove", "folder/remove", map[string]any{"id": "folder"})
	snapshot, _ = service.Snapshot("ws")
	if len(snapshot.Tabs) != 0 {
		t.Fatal("tabs did not cascade")
	}
}

func TestWorkspaceWebSocketAuthenticationReplayAndScope(t *testing.T) {
	db, service, router := workspaceFixture(t)
	if err := db.Create(&model.Workspace{ID: "ws", Revision: 1, Name: "Test"}).Error; err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(router)
	defer server.Close()
	endpoint := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/workspace/events?workspace_id=ws"
	if conn, response, err := websocket.DefaultDialer.Dial(endpoint, nil); err == nil {
		conn.Close()
		t.Fatal("unauthenticated websocket accepted")
	} else if response.StatusCode != 401 {
		t.Fatal(response.StatusCode)
	}
	for i := 0; i < 2; i++ {
		m := mutation(t, fmt.Sprint(i), "plugin/mutate", map[string]any{"plugin_id": "test", "action": "event", "data": i})
		if _, err := service.Commit(m); err != nil {
			t.Fatal(err)
		}
	}
	conn, _, err := websocket.DefaultDialer.Dial(endpoint+"&key=test-key&after=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for _, want := range []int64{2, 3} {
		var event workspacesvc.MutationEvent
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event.Revision != want {
			t.Fatal(event)
		}
	}
	var initial map[string]any
	if err := conn.ReadJSON(&initial); err != nil {
		t.Fatal(err)
	}
	if initial["type"] != "workspace:snapshot" {
		t.Fatal(initial)
	}
	if _, err := service.Commit(mutation(t, "live", "folder/add", map[string]any{"id": "live", "name": "Live", "path": "/live"})); err != nil {
		t.Fatal(err)
	}
	var live workspacesvc.MutationEvent
	if err := conn.ReadJSON(&live); err != nil {
		t.Fatal(err)
	}
	if live.Revision != 4 || live.Mutation.Type != "folder/add" {
		t.Fatal(live)
	}
}

func TestWorkspaceTerminalLifecycleAndCatalog(t *testing.T) {
	db, service, router := workspaceFixture(t)
	if err := db.Create(&model.UserSession{ID: "ws", Name: "Workspace", State: "{}"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := config.MigrateLegacySessionsToWorkspaces(db); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Commit(mutation(t, "folder", "folder/add", map[string]any{"id": "folder", "name": "Repo", "path": "/repo"})); err != nil {
		t.Fatal(err)
	}
	manager := terminal.NewManager(db, &terminal.ManagerConfig{Shell: "/bin/sh", WorkspaceChanged: service.TerminalsChanged})
	events, _, off := service.Subscribe("ws")
	defer off()
	info, err := manager.CreateInWorkspace(terminal.CreateOptions{Name: "Fixture", Cwd: t.TempDir(), WorkspaceSessionID: "ws", GroupID: "folder"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Delete(info.ID) })
	check := func(name string, count int) {
		t.Helper()
		snapshot, err := service.Snapshot("ws")
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Terminals) != count {
			t.Fatalf("%s: wrong terminal count %d", name, len(snapshot.Terminals))
		}
		if count > 0 && snapshot.Terminals[0].Name != name {
			t.Fatal("terminal name was not synchronized")
		}
	}
	check("Fixture", 1)
	select {
	case event := <-events:
		if event.Mutation.Type != "terminal/open" || !strings.Contains(string(event.Mutation.Payload), info.ID) {
			t.Fatal("missing terminal event")
		}
	case <-time.After(time.Second):
		t.Fatal("missing terminal broadcast")
	}
	if err := manager.Rename(info.ID, "Renamed"); err != nil {
		t.Fatal(err)
	}
	check("Renamed", 1)
	var session model.UserSession
	db.First(&session, "id = ?", "ws")
	if session.State != "{}" {
		t.Fatal("legacy recovery state was overwritten")
	}
	if err := manager.SyncWorkspaceMetadata("ws", nil); err == nil {
		t.Fatal("legacy empty terminal inventory accepted")
	}
	check("Renamed", 1)
	lifecycleRouter := gin.New()
	NewWorkspaceHandler(service, manager).Register(lifecycleRouter.Group("/api"))
	badClose := mutation(t, "invalid-close", "terminal/close", map[string]any{"id": info.ID, "data": []int{1}})
	if response := workspaceRequest(lifecycleRouter, "/api/workspace/mutations", badClose); response.Code != 400 {
		t.Fatalf("invalid close: %d", response.Code)
	}
	check("Renamed", 1)
	closeMutation := mutation(t, "close", "terminal/close", map[string]any{"id": info.ID})
	for i := 0; i < 2; i++ {
		if response := workspaceRequest(lifecycleRouter, "/api/workspace/mutations", closeMutation); response.Code != 200 {
			t.Fatalf("close: %d %s", response.Code, response.Body)
		}
	}
	check("", 0)
	server := httptest.NewServer(router)
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/workspace/events?workspace_id=*&key=test-key", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var initial map[string]any
	if err := conn.ReadJSON(&initial); err != nil {
		t.Fatal(err)
	}
	if initial["type"] != "workspace:catalog" {
		t.Fatal(initial)
	}
	if _, err := service.Commit(mutation(t, "rename", "workspace/rename", map[string]any{"name": "New Name"})); err != nil {
		t.Fatal(err)
	}
	var event workspacesvc.MutationEvent
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event.Mutation.Type != "workspace/rename" {
		t.Fatal(event)
	}
	if _, err := service.Commit(mutation(t, "create-second", "workspace/create", map[string]any{"id": "other", "name": "Other"})); err == nil {
		t.Fatal("mismatched workspace id accepted")
	}
	other := mutation(t, "other", "workspace/create", map[string]any{"id": "other", "name": "Other"})
	other.WorkspaceID = "other"
	other.BaseRevision = 0
	if _, err := service.Commit(other); err != nil {
		t.Fatal(err)
	}
	if err := service.ReorderWorkspaces([]string{"other", "ws"}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.Snapshot("ws")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Workspace.Position != 2 {
		t.Fatal("workspace position not synchronized")
	}
	deleted := mutation(t, "delete-other", "workspace/delete", map[string]any{"id": "other"})
	deleted.WorkspaceID = "other"
	deleted.BaseRevision = 0
	for i := 0; i < 2; i++ {
		if response := workspaceRequest(lifecycleRouter, "/api/workspace/mutations", deleted); response.Code != 200 {
			t.Fatalf("delete workspace: %d %s", response.Code, response.Body)
		}
	}
	if _, err := service.Snapshot("other"); err == nil {
		t.Fatal("workspace remains after deletion")
	}
}
