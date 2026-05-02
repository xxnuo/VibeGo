package terminal

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func setupTestDB(t *testing.T) *gorm.DB {
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}

	if err := db.AutoMigrate(
		&model.UserSession{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
	); err != nil {
		t.Fatalf("failed to migrate: %v", err)
	}

	return db
}

func TestManager_CreateAndClose(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "test", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}

	if info.Status != model.StatusRunning {
		t.Errorf("expected status %s, got %s", model.StatusRunning, info.Status)
	}

	gotInfo, ok := manager.Get(info.ID)
	if !ok {
		t.Fatal("failed to get terminal info")
	}

	if gotInfo.ID != info.ID {
		t.Errorf("expected ID %s, got %s", info.ID, gotInfo.ID)
	}

	err = manager.Close(info.ID)
	if err != nil {
		t.Errorf("failed to close terminal: %v", err)
	}

	_, ok = manager.Get(info.ID)
	if ok {
		t.Error("expected terminal to be removed")
	}
}

func TestManager_UpdateShellMetadataClearsLastCommandExitCode(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "runtime-metadata", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	exitCode := 23
	if err := manager.UpdateShellMetadata(info.ID, ShellMetadataUpdate{LastCommandExitCode: &exitCode}); err != nil {
		t.Fatalf("failed to set exit code: %v", err)
	}
	state := "running-command"
	if err := manager.UpdateShellMetadata(info.ID, ShellMetadataUpdate{ShellState: &state}); err != nil {
		t.Fatalf("failed to update unrelated metadata: %v", err)
	}
	current, ok := manager.Get(info.ID)
	if !ok || current.LastCommandExitCode == nil || *current.LastCommandExitCode != exitCode {
		t.Fatalf("omitted exit code should preserve %d, got %+v", exitCode, current)
	}

	if err := manager.UpdateShellMetadata(info.ID, ShellMetadataUpdate{LastCommandExitCodeSet: true}); err != nil {
		t.Fatalf("failed to clear exit code: %v", err)
	}
	current, ok = manager.Get(info.ID)
	if !ok {
		t.Fatal("terminal disappeared after metadata update")
	}
	if current.LastCommandExitCode != nil {
		t.Fatalf("expected active exit code to be cleared, got %d", *current.LastCommandExitCode)
	}
	var stored model.TerminalSession
	if err := db.First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("failed to load terminal: %v", err)
	}
	if stored.LastCommandExitCode != nil {
		t.Fatalf("expected persisted exit code to be cleared, got %d", *stored.LastCommandExitCode)
	}
}

func TestManager_MultiClient_Sharing(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "test", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		if _, err := manager.Attach(info.ID, conn); err != nil {
			t.Errorf("failed to attach: %v", err)
			conn.Close()
			return
		}

		time.Sleep(500 * time.Millisecond)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	conn1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("client 1 failed to dial: %v", err)
	}
	defer conn1.Close()

	time.Sleep(100 * time.Millisecond)

	conn2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("client 2 failed to dial: %v", err)
	}
	defer conn2.Close()

	time.Sleep(100 * time.Millisecond)

	if manager.activeConns.Load() != 2 {
		t.Errorf("expected 2 active connections, got %d", manager.activeConns.Load())
	}
}

func TestManager_MaxConnections(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh", MaxConnections: 2})

	info, err := manager.Create(CreateOptions{Name: "test", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		if _, err := manager.Attach(info.ID, conn); err != nil {
			conn.Close()
			return
		}

		time.Sleep(500 * time.Millisecond)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	conn1, _, _ := websocket.DefaultDialer.Dial(wsURL, nil)
	defer conn1.Close()
	time.Sleep(50 * time.Millisecond)

	conn2, _, _ := websocket.DefaultDialer.Dial(wsURL, nil)
	defer conn2.Close()
	time.Sleep(50 * time.Millisecond)

	conn3, resp3, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		conn3.Close()
	}

	if resp3 != nil && resp3.StatusCode == http.StatusSwitchingProtocols {
		time.Sleep(50 * time.Millisecond)
		if manager.activeConns.Load() > 2 {
			t.Error("expected max 2 connections to be enforced")
		}
	}
}

func TestManager_WebTTY_Integration(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "test", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	done := make(chan bool)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		if _, err := manager.Attach(info.ID, conn); err != nil {
			conn.Close()
			return
		}

		<-done
		conn.Close()
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	msgCount := 0
	conn.SetReadDeadline(time.Now().Add(1 * time.Second))
	for i := 0; i < 10; i++ {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if len(msg) > 0 {
			msgCount++
			t.Logf("Received message: %s", string(msg))
		}
	}

	close(done)
	conn.Close()

	if msgCount < 1 {
		t.Errorf("expected at least 1 message, got %d", msgCount)
	}
}

func TestManager_Resize(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "test", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	err = manager.Resize(info.ID, 120, 40)
	if err != nil {
		t.Errorf("failed to resize: %v", err)
	}

	err = manager.Resize("nonexistent", 120, 40)
	if err != ErrTerminalNotFound {
		t.Errorf("expected ErrTerminalNotFound, got %v", err)
	}
}

func TestManager_List(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info1, _ := manager.Create(CreateOptions{Name: "test1", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	info2, _ := manager.Create(CreateOptions{Name: "test2", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	defer manager.Close(info1.ID)
	defer manager.Close(info2.ID)

	list, err := manager.List("", "")
	if err != nil {
		t.Fatalf("failed to list: %v", err)
	}
	if len(list) < 2 {
		t.Errorf("expected at least 2 terminals, got %d", len(list))
	}
}

func TestManager_SyncWorkspaceMetadata(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	if err := db.Create(&model.UserSession{ID: "session-1", Name: "Session", State: "{}"}).Error; err != nil {
		t.Fatalf("failed to create workspace session: %v", err)
	}

	info1, err := manager.Create(CreateOptions{Name: "test1", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	info2, err := manager.Create(CreateOptions{Name: "test2", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info1.ID)
	defer manager.Close(info2.ID)

	err = manager.SyncWorkspaceMetadata("session-1", []WorkspaceTerminalAssignment{
		{ID: info1.ID, GroupID: "group-1", ParentID: ""},
		{ID: info2.ID, GroupID: "group-1", ParentID: info1.ID},
	})
	if err != nil {
		t.Fatalf("failed to sync workspace metadata: %v", err)
	}

	list, err := manager.List("session-1", "group-1")
	if err != nil {
		t.Fatalf("failed to list synced terminals: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 terminals, got %d", len(list))
	}

	var childFound bool
	for _, item := range list {
		if item.ID == info2.ID {
			childFound = true
			if item.ParentID != info1.ID {
				t.Fatalf("expected parent %s, got %s", info1.ID, item.ParentID)
			}
		}
	}
	if !childFound {
		t.Fatal("expected child terminal in synced list")
	}

	err = manager.SyncWorkspaceMetadata("session-1", []WorkspaceTerminalAssignment{
		{ID: info1.ID, GroupID: "group-2", ParentID: ""},
	})
	if err != nil {
		t.Fatalf("failed to resync workspace metadata: %v", err)
	}

	group1List, err := manager.List("session-1", "group-1")
	if err != nil {
		t.Fatalf("failed to list group-1 terminals: %v", err)
	}
	if len(group1List) != 0 {
		t.Fatalf("expected 0 terminals in old group, got %d", len(group1List))
	}

	var child model.TerminalSession
	if err := db.Where("id = ?", info2.ID).First(&child).Error; err != nil {
		t.Fatalf("failed to load child terminal: %v", err)
	}
	if child.WorkspaceSessionID != "" {
		t.Fatalf("expected child workspace_session_id to be cleared, got %s", child.WorkspaceSessionID)
	}
	if child.GroupID != "" {
		t.Fatalf("expected child group_id to be cleared, got %s", child.GroupID)
	}
	if child.ParentID != "" {
		t.Fatalf("expected child parent_id to be cleared, got %s", child.ParentID)
	}
}

func TestManager_SyncWorkspaceMetadataRejectsInvalidAssignments(t *testing.T) {
	tests := []struct {
		name        string
		assignments func(firstID, secondID, claimedID string) []WorkspaceTerminalAssignment
		wantErr     error
	}{
		{
			name: "missing terminal",
			assignments: func(_, _, _ string) []WorkspaceTerminalAssignment {
				return []WorkspaceTerminalAssignment{{ID: "missing", GroupID: "group-1"}}
			},
			wantErr: ErrTerminalNotFound,
		},
		{
			name: "parent omitted from assignment",
			assignments: func(firstID, secondID, _ string) []WorkspaceTerminalAssignment {
				return []WorkspaceTerminalAssignment{{ID: firstID, GroupID: "group-1", ParentID: secondID}}
			},
			wantErr: ErrInvalidTerminalParent,
		},
		{
			name: "self parent",
			assignments: func(firstID, _, _ string) []WorkspaceTerminalAssignment {
				return []WorkspaceTerminalAssignment{{ID: firstID, GroupID: "group-1", ParentID: firstID}}
			},
			wantErr: ErrInvalidTerminalParent,
		},
		{
			name: "parent cycle",
			assignments: func(firstID, secondID, _ string) []WorkspaceTerminalAssignment {
				return []WorkspaceTerminalAssignment{
					{ID: firstID, GroupID: "group-1", ParentID: secondID},
					{ID: secondID, GroupID: "group-1", ParentID: firstID},
				}
			},
			wantErr: ErrInvalidTerminalParent,
		},
		{
			name: "parent in another group",
			assignments: func(firstID, secondID, _ string) []WorkspaceTerminalAssignment {
				return []WorkspaceTerminalAssignment{
					{ID: firstID, GroupID: "group-1"},
					{ID: secondID, GroupID: "group-2", ParentID: firstID},
				}
			},
			wantErr: ErrTerminalScopeMismatch,
		},
		{
			name: "terminal claimed by another workspace",
			assignments: func(_, _, claimedID string) []WorkspaceTerminalAssignment {
				return []WorkspaceTerminalAssignment{{ID: claimedID, GroupID: "group-1"}}
			},
			wantErr: ErrTerminalScopeMismatch,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := setupTestDB(t)
			for _, sessionID := range []string{"workspace-1", "workspace-2"} {
				if err := db.Create(&model.UserSession{ID: sessionID, Name: sessionID, State: "{}"}).Error; err != nil {
					t.Fatalf("create workspace %s: %v", sessionID, err)
				}
			}

			manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
			first, err := manager.Create(CreateOptions{Name: "first", Cwd: os.TempDir()})
			if err != nil {
				t.Fatalf("create first terminal: %v", err)
			}
			second, err := manager.Create(CreateOptions{Name: "second", Cwd: os.TempDir()})
			if err != nil {
				t.Fatalf("create second terminal: %v", err)
			}
			claimed, err := manager.Create(CreateOptions{
				Name:               "claimed",
				Cwd:                os.TempDir(),
				WorkspaceSessionID: "workspace-2",
				GroupID:            "claimed-group",
			})
			if err != nil {
				t.Fatalf("create claimed terminal: %v", err)
			}
			t.Cleanup(func() {
				_ = manager.Close(first.ID)
				_ = manager.Close(second.ID)
				_ = manager.Close(claimed.ID)
			})

			err = manager.SyncWorkspaceMetadata(
				"workspace-1",
				tt.assignments(first.ID, second.ID, claimed.ID),
			)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("expected %v, got %v", tt.wantErr, err)
			}

			for _, terminalID := range []string{first.ID, second.ID} {
				assertTerminalScope(t, db, manager, terminalID, "", "", "")
			}
			assertTerminalScope(t, db, manager, claimed.ID, "workspace-2", "claimed-group", "")
		})
	}
}

func TestManager_CreateRejectsInvalidParentScope(t *testing.T) {
	db := setupTestDB(t)
	for _, sessionID := range []string{"workspace-1", "workspace-2"} {
		if err := db.Create(&model.UserSession{ID: sessionID, Name: sessionID, State: "{}"}).Error; err != nil {
			t.Fatalf("create workspace %s: %v", sessionID, err)
		}
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	parent, err := manager.Create(CreateOptions{
		Name:               "parent",
		Cwd:                os.TempDir(),
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create parent terminal: %v", err)
	}
	defer manager.Close(parent.ID)

	tests := []struct {
		name    string
		opts    CreateOptions
		wantErr error
	}{
		{
			name: "missing parent",
			opts: CreateOptions{
				Name:               "missing-parent",
				WorkspaceSessionID: "workspace-1",
				GroupID:            "group-1",
				ParentID:           "missing",
			},
			wantErr: ErrTerminalNotFound,
		},
		{
			name: "parent in another group",
			opts: CreateOptions{
				Name:               "cross-group",
				WorkspaceSessionID: "workspace-1",
				GroupID:            "group-2",
				ParentID:           parent.ID,
			},
			wantErr: ErrTerminalScopeMismatch,
		},
		{
			name: "parent in another workspace",
			opts: CreateOptions{
				Name:               "cross-workspace",
				WorkspaceSessionID: "workspace-2",
				GroupID:            "group-1",
				ParentID:           parent.ID,
			},
			wantErr: ErrTerminalScopeMismatch,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := manager.Create(tt.opts)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("expected %v, got terminal=%v err=%v", tt.wantErr, info, err)
			}
		})
	}

	var count int64
	if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("count terminal sessions: %v", err)
	}
	if count != 1 {
		t.Fatalf("invalid parent requests created terminal rows: %d", count)
	}
}

func TestManager_CreateInheritsMissingParentScope(t *testing.T) {
	db := setupTestDB(t)
	if err := db.Create(&model.UserSession{ID: "workspace-1", Name: "Workspace", State: "{}"}).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	parent, err := manager.Create(CreateOptions{
		Name:               "parent",
		Cwd:                os.TempDir(),
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create parent terminal: %v", err)
	}
	defer manager.Close(parent.ID)

	tests := []struct {
		name string
		opts CreateOptions
	}{
		{
			name: "workspace and group omitted",
			opts: CreateOptions{Name: "inherit-both", Cwd: os.TempDir(), ParentID: parent.ID},
		},
		{
			name: "group omitted",
			opts: CreateOptions{
				Name:               "inherit-group",
				Cwd:                os.TempDir(),
				WorkspaceSessionID: "workspace-1",
				ParentID:           parent.ID,
			},
		},
		{
			name: "workspace omitted",
			opts: CreateOptions{
				Name:     "inherit-workspace",
				Cwd:      os.TempDir(),
				GroupID:  "group-1",
				ParentID: parent.ID,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			child, err := manager.Create(tt.opts)
			if err != nil {
				t.Fatalf("create child terminal: %v", err)
			}
			defer manager.Close(child.ID)
			if child.WorkspaceSessionID != "workspace-1" || child.GroupID != "group-1" || child.ParentID != parent.ID {
				t.Fatalf(
					"inherited scope = (%q, %q, %q), want (%q, %q, %q)",
					child.WorkspaceSessionID,
					child.GroupID,
					child.ParentID,
					"workspace-1",
					"group-1",
					parent.ID,
				)
			}
			assertTerminalScope(t, db, manager, child.ID, "workspace-1", "group-1", parent.ID)
		})
	}
}

func assertTerminalScope(
	t *testing.T,
	db *gorm.DB,
	manager *Manager,
	terminalID string,
	workspaceSessionID string,
	groupID string,
	parentID string,
) {
	t.Helper()
	var stored model.TerminalSession
	if err := db.First(&stored, "id = ?", terminalID).Error; err != nil {
		t.Fatalf("load terminal %s: %v", terminalID, err)
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
	active, ok := manager.Get(terminalID)
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

func TestManager_Delete(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, _ := manager.Create(CreateOptions{Name: "test", Cwd: os.TempDir(), Cols: 80, Rows: 24})

	err := manager.Delete(info.ID)
	if err != nil {
		t.Errorf("failed to delete: %v", err)
	}

	_, ok := manager.Get(info.ID)
	if ok {
		t.Error("expected terminal to be deleted")
	}
}

func TestManager_DeleteReturnsCloseErrorBeforeDeletingRows(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "close-error", Cwd: os.TempDir()})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	if err := db.Migrator().DropTable(&model.TerminalHistory{}); err != nil {
		t.Fatalf("drop terminal history table: %v", err)
	}

	err = manager.Delete(info.ID)
	if err == nil {
		t.Fatal("expected delete to return close error")
	}
	if !strings.Contains(err.Error(), "close terminal "+info.ID) {
		t.Fatalf("unexpected delete error: %v", err)
	}

	var count int64
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", info.ID).Count(&count).Error; err != nil {
		t.Fatalf("count terminal rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("terminal row was deleted after close failure: %d", count)
	}
}

func TestManager_DeleteRemovesSplitTree(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	root, err := manager.Create(CreateOptions{Name: "root", Cwd: os.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("failed to create root terminal: %v", err)
	}
	child, err := manager.Create(CreateOptions{Name: "child", Cwd: os.TempDir(), Cols: 80, Rows: 24, ParentID: root.ID})
	if err != nil {
		t.Fatalf("failed to create child terminal: %v", err)
	}
	grandchild, err := manager.Create(CreateOptions{
		Name: "grandchild", Cwd: os.TempDir(), Cols: 80, Rows: 24, ParentID: child.ID,
	})
	if err != nil {
		t.Fatalf("failed to create grandchild terminal: %v", err)
	}

	if err := db.Create(&model.TerminalHistory{SessionID: root.ID, Data: []byte("root"), CreatedAt: time.Now().Unix()}).Error; err != nil {
		t.Fatalf("failed to seed root history: %v", err)
	}
	if err := db.Create(&model.TerminalHistory{SessionID: child.ID, Data: []byte("child"), CreatedAt: time.Now().Unix()}).Error; err != nil {
		t.Fatalf("failed to seed child history: %v", err)
	}
	if err := db.Create(&model.TerminalHistory{SessionID: grandchild.ID, Data: []byte("grandchild"), CreatedAt: time.Now().Unix()}).Error; err != nil {
		t.Fatalf("failed to seed grandchild history: %v", err)
	}
	for line, terminalID := range []string{root.ID, child.ID, grandchild.ID} {
		block := model.BlockTermBlock{ID: fmt.Sprintf("block-%d", line), TerminalID: terminalID, LineNum: line}
		if err := db.Create(&block).Error; err != nil {
			t.Fatalf("failed to seed block for %s: %v", terminalID, err)
		}
		if err := db.Create(&model.BlockTermCommandHistory{
			ID:         block.ID,
			TerminalID: terminalID,
			LineNum:    line,
			Command:    fmt.Sprintf("command-%d", line),
		}).Error; err != nil {
			t.Fatalf("failed to seed command history for %s: %v", terminalID, err)
		}
	}

	if err := manager.Delete(root.ID); err != nil {
		t.Fatalf("failed to delete split tree: %v", err)
	}

	var remainingSessions int64
	terminalIDs := []string{root.ID, child.ID, grandchild.ID}
	if err := db.Model(&model.TerminalSession{}).Where("id IN ?", terminalIDs).Count(&remainingSessions).Error; err != nil {
		t.Fatalf("failed to count sessions: %v", err)
	}
	if remainingSessions != 0 {
		t.Fatalf("expected split tree sessions to be deleted, got %d", remainingSessions)
	}

	var remainingHistory int64
	if err := db.Model(&model.TerminalHistory{}).Where("session_id IN ?", terminalIDs).Count(&remainingHistory).Error; err != nil {
		t.Fatalf("failed to count history: %v", err)
	}
	if remainingHistory != 0 {
		t.Fatalf("expected split tree history to be deleted, got %d", remainingHistory)
	}

	var remainingBlocks int64
	if err := db.Model(&model.BlockTermBlock{}).Where("terminal_id IN ?", terminalIDs).Count(&remainingBlocks).Error; err != nil {
		t.Fatalf("failed to count blocks: %v", err)
	}
	if remainingBlocks != 0 {
		t.Fatalf("expected split tree blocks to be deleted, got %d", remainingBlocks)
	}

	var remainingCommandHistory int64
	if err := db.Model(&model.BlockTermCommandHistory{}).Where("terminal_id IN ?", terminalIDs).Count(&remainingCommandHistory).Error; err != nil {
		t.Fatalf("failed to count command history: %v", err)
	}
	if remainingCommandHistory != int64(len(terminalIDs)) {
		t.Fatalf("expected split tree command history to be retained, got %d", remainingCommandHistory)
	}
}

func TestManager_DeleteKeepsDescendantsOutsideRootScope(t *testing.T) {
	db := setupTestDB(t)
	for _, sessionID := range []string{"workspace-1", "workspace-2"} {
		if err := db.Create(&model.UserSession{ID: sessionID, Name: sessionID, State: "{}"}).Error; err != nil {
			t.Fatalf("create workspace %s: %v", sessionID, err)
		}
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	root, err := manager.Create(CreateOptions{
		Name:               "root",
		Cwd:                os.TempDir(),
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create root terminal: %v", err)
	}
	child, err := manager.Create(CreateOptions{
		Name:               "child",
		Cwd:                os.TempDir(),
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-1",
		ParentID:           root.ID,
	})
	if err != nil {
		t.Fatalf("create child terminal: %v", err)
	}
	otherGroup, err := manager.Create(CreateOptions{
		Name:               "other-group",
		Cwd:                os.TempDir(),
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-2",
	})
	if err != nil {
		t.Fatalf("create other-group terminal: %v", err)
	}
	otherWorkspace, err := manager.Create(CreateOptions{
		Name:               "other-workspace",
		Cwd:                os.TempDir(),
		WorkspaceSessionID: "workspace-2",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create other-workspace terminal: %v", err)
	}
	defer manager.Close(otherGroup.ID)
	defer manager.Close(otherWorkspace.ID)

	preservedIDs := []string{otherGroup.ID, otherWorkspace.ID}
	if err := db.Model(&model.TerminalSession{}).Where("id IN ?", preservedIDs).Update("parent_id", root.ID).Error; err != nil {
		t.Fatalf("seed cross-scope descendants: %v", err)
	}
	allIDs := []string{root.ID, child.ID, otherGroup.ID, otherWorkspace.ID}
	for i, terminalID := range allIDs {
		if err := db.Create(&model.TerminalHistory{SessionID: terminalID, Data: []byte("history"), CreatedAt: int64(i + 1)}).Error; err != nil {
			t.Fatalf("seed history for %s: %v", terminalID, err)
		}
		if err := db.Create(&model.BlockTermBlock{
			ID:         fmt.Sprintf("scoped-block-%d", i),
			TerminalID: terminalID,
			LineNum:    0,
			CreatedAt:  int64(i + 1),
			UpdatedAt:  int64(i + 1),
		}).Error; err != nil {
			t.Fatalf("seed block for %s: %v", terminalID, err)
		}
	}

	if err := manager.Delete(root.ID); err != nil {
		t.Fatalf("delete scoped terminal tree: %v", err)
	}

	deletedIDs := []string{root.ID, child.ID}
	var count int64
	if err := db.Model(&model.TerminalSession{}).Where("id IN ?", deletedIDs).Count(&count).Error; err != nil {
		t.Fatalf("count deleted terminals: %v", err)
	}
	if count != 0 {
		t.Fatalf("same-scope terminals remain: %d", count)
	}
	if err := db.Model(&model.TerminalSession{}).Where("id IN ?", preservedIDs).Count(&count).Error; err != nil {
		t.Fatalf("count preserved terminals: %v", err)
	}
	if count != int64(len(preservedIDs)) {
		t.Fatalf("cross-scope terminals were deleted: got %d, want %d", count, len(preservedIDs))
	}
	if err := db.Model(&model.TerminalHistory{}).Where("session_id IN ?", preservedIDs).Count(&count).Error; err != nil {
		t.Fatalf("count preserved history: %v", err)
	}
	if count != int64(len(preservedIDs)) {
		t.Fatalf("cross-scope history was deleted: got %d, want %d", count, len(preservedIDs))
	}
	if err := db.Model(&model.BlockTermBlock{}).Where("terminal_id IN ?", preservedIDs).Count(&count).Error; err != nil {
		t.Fatalf("count preserved blocks: %v", err)
	}
	if count != int64(len(preservedIDs)) {
		t.Fatalf("cross-scope blocks were deleted: got %d, want %d", count, len(preservedIDs))
	}
	for _, terminalID := range preservedIDs {
		if _, ok := manager.Get(terminalID); !ok {
			t.Fatalf("cross-scope terminal %s is no longer active", terminalID)
		}
	}
}

func TestManager_CleanupOnStart(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	running := &model.TerminalSession{
		ID:        "stale-running",
		Name:      "stale running",
		Status:    model.StatusRunning,
		Readonly:  false,
		UpdatedAt: 1,
	}
	if err := db.Create(running).Error; err != nil {
		t.Fatalf("failed to seed running terminal: %v", err)
	}

	exited := &model.TerminalSession{
		ID:        "already-exited",
		Name:      "already exited",
		Status:    model.StatusExited,
		Readonly:  false,
		UpdatedAt: 1,
	}
	if err := db.Create(exited).Error; err != nil {
		t.Fatalf("failed to seed exited terminal: %v", err)
	}

	manager.CleanupOnStart()

	var gotRunning model.TerminalSession
	if err := db.First(&gotRunning, "id = ?", running.ID).Error; err != nil {
		t.Fatalf("failed to load cleaned terminal: %v", err)
	}
	if gotRunning.Status != model.StatusExited {
		t.Fatalf("expected stale terminal status %s, got %s", model.StatusExited, gotRunning.Status)
	}
	if !gotRunning.Readonly {
		t.Fatal("expected stale terminal to be readonly")
	}
	if gotRunning.UpdatedAt <= running.UpdatedAt {
		t.Fatalf("expected stale terminal updated_at to advance, got %d", gotRunning.UpdatedAt)
	}

	var gotExited model.TerminalSession
	if err := db.First(&gotExited, "id = ?", exited.ID).Error; err != nil {
		t.Fatalf("failed to load existing exited terminal: %v", err)
	}
	if gotExited.Status != model.StatusExited {
		t.Fatalf("expected existing exited terminal to remain %s, got %s", model.StatusExited, gotExited.Status)
	}
	if gotExited.Readonly {
		t.Fatal("expected existing exited terminal readonly flag to remain unchanged")
	}
	if gotExited.UpdatedAt != exited.UpdatedAt {
		t.Fatalf("expected existing exited terminal updated_at to remain %d, got %d", exited.UpdatedAt, gotExited.UpdatedAt)
	}
}

func TestManagerCleanupStaleTerminalStateInterruptsOwnedRunningBlocks(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	staleID := "startup-stale-with-blocks"
	exitedID := "startup-already-exited-with-block"
	closedID := "startup-already-closed-with-block"
	if err := db.Create(&model.TerminalSession{ID: staleID, Status: model.StatusRunning, Readonly: false, UpdatedAt: 1}).Error; err != nil {
		t.Fatalf("create stale terminal: %v", err)
	}
	if err := db.Create(&model.TerminalSession{ID: exitedID, Status: model.StatusExited, Readonly: true, UpdatedAt: 2}).Error; err != nil {
		t.Fatalf("create exited terminal: %v", err)
	}
	if err := db.Create(&model.TerminalSession{ID: closedID, Status: model.StatusClosed, Readonly: true, UpdatedAt: 3}).Error; err != nil {
		t.Fatalf("create closed terminal: %v", err)
	}

	exitCode := 7
	startedAt := int64(10)
	if err := db.Create(&model.BlockTermBlock{
		ID: "startup-stale-running-block", TerminalID: staleID, LineNum: 0,
		Kind: "command", Status: "running", ExitCode: &exitCode, StartedAt: &startedAt,
	}).Error; err != nil {
		t.Fatalf("create stale running block: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{
		ID: "startup-stale-success-block", TerminalID: staleID, LineNum: 1,
		Kind: "command", Status: "success", ExitCode: &exitCode, StartedAt: &startedAt,
	}).Error; err != nil {
		t.Fatalf("create stale completed block: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{
		ID: "startup-exited-running-block", TerminalID: exitedID, LineNum: 0,
		Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create exited-terminal block: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{
		ID: "startup-closed-running-block", TerminalID: closedID, LineNum: 0,
		Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create closed-terminal block: %v", err)
	}

	manager.CleanupOnStart()

	var stale model.TerminalSession
	if err := db.First(&stale, "id = ?", staleID).Error; err != nil {
		t.Fatalf("load stale terminal: %v", err)
	}
	if stale.Status != model.StatusExited || !stale.Readonly || stale.UpdatedAt <= 1 {
		t.Fatalf("stale terminal state = status %q readonly %t updated_at %d", stale.Status, stale.Readonly, stale.UpdatedAt)
	}

	var interrupted model.BlockTermBlock
	if err := db.First(&interrupted, "id = ?", "startup-stale-running-block").Error; err != nil {
		t.Fatalf("load interrupted block: %v", err)
	}
	if interrupted.Status != "interrupted" || interrupted.ExitCode != nil || interrupted.FinishedAt == nil || *interrupted.FinishedAt <= 1 {
		t.Fatalf("stale running block state = status %q exit_code %v finished_at %v", interrupted.Status, interrupted.ExitCode, interrupted.FinishedAt)
	}

	var completed model.BlockTermBlock
	if err := db.First(&completed, "id = ?", "startup-stale-success-block").Error; err != nil {
		t.Fatalf("load completed block: %v", err)
	}
	if completed.Status != "success" || completed.ExitCode == nil || completed.FinishedAt != nil {
		t.Fatalf("completed block was changed: status %q exit_code %v finished_at %v", completed.Status, completed.ExitCode, completed.FinishedAt)
	}

	for _, id := range []string{"startup-exited-running-block", "startup-closed-running-block"} {
		var block model.BlockTermBlock
		if err := db.First(&block, "id = ?", id).Error; err != nil {
			t.Fatalf("load non-stale block %s: %v", id, err)
		}
		if block.Status != "running" || block.FinishedAt != nil {
			t.Fatalf("non-stale block %s changed: status %q finished_at %v", id, block.Status, block.FinishedAt)
		}
	}
}

func TestManagerCleanupStaleTerminalStateRollsBackTerminalAndBlocksTogether(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const terminalID = "startup-atomicity-terminal"
	const blockID = "startup-atomicity-block"
	if err := db.Create(&model.TerminalSession{ID: terminalID, Status: model.StatusRunning, Readonly: false, UpdatedAt: 1}).Error; err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running"}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}

	updateErr := errors.New("startup block update failed")
	const callbackName = "test:cleanup_stale_terminal_state_block_error"
	if err := db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermBlock{}).TableName() {
			tx.AddError(updateErr)
		}
	}); err != nil {
		t.Fatalf("register update callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	if err := manager.cleanupStaleTerminalState(); !errors.Is(err, updateErr) {
		t.Fatalf("cleanup error = %v, want %v", err, updateErr)
	}

	var session model.TerminalSession
	if err := db.First(&session, "id = ?", terminalID).Error; err != nil {
		t.Fatalf("load terminal after rollback: %v", err)
	}
	if session.Status != model.StatusRunning || session.Readonly || session.UpdatedAt != 1 {
		t.Fatalf("terminal changed despite rollback: status %q readonly %t updated_at %d", session.Status, session.Readonly, session.UpdatedAt)
	}
	var block model.BlockTermBlock
	if err := db.First(&block, "id = ?", blockID).Error; err != nil {
		t.Fatalf("load block after rollback: %v", err)
	}
	if block.Status != "running" || block.FinishedAt != nil || block.ExitCode != nil {
		t.Fatalf("block changed despite rollback: status %q finished_at %v exit_code %v", block.Status, block.FinishedAt, block.ExitCode)
	}
}

func TestManager_CreateDefaultCwd(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "test", Cols: 0, Rows: 0})
	if err != nil {
		t.Fatalf("failed to create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	if info.Cols != 80 {
		t.Errorf("expected default cols 80, got %d", info.Cols)
	}
	if info.Rows != 24 {
		t.Errorf("expected default rows 24, got %d", info.Rows)
	}
}

func TestManager_CleanupExpiredHistory(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh", HistoryMaxAge: time.Hour})

	err := manager.CleanupExpiredHistory()
	if err != nil {
		t.Errorf("failed to cleanup expired history: %v", err)
	}
}

func TestManager_CleanupExpiredHistoryDisabled(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh", HistoryMaxAge: 0})

	err := manager.CleanupExpiredHistory()
	if err != nil {
		t.Errorf("failed to cleanup expired history: %v", err)
	}
}

func TestManager_AttachNonExistent(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		_, err = manager.Attach("nonexistent", conn)
		if err != nil && err != ErrTerminalNotFound {
			t.Logf("attach returned: %v", err)
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, _ := websocket.DefaultDialer.Dial(wsURL, nil)
	if conn != nil {
		conn.Close()
	}
	time.Sleep(100 * time.Millisecond)
}

func TestManager_HistoryOnlyAttachRespectsConnectionLimit(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh", MaxConnections: 1})
	manager.activeConns.Store(1)

	if _, err := manager.AttachWithOptions("history-only-limit", nil, AttachOptions{}); !errors.Is(err, ErrMaxConnectionsReached) {
		t.Fatalf("history-only attach error = %v, want %v", err, ErrMaxConnectionsReached)
	}
	if got := manager.activeConns.Load(); got != 1 {
		t.Fatalf("active connection count = %d, want 1", got)
	}
}

func TestManager_SendHistoryOnlyIncludesReplayDoneAndExited(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	session := &model.TerminalSession{
		ID:        "history-only-session",
		Name:      "history-only",
		Shell:     "/bin/sh",
		Cwd:       os.TempDir(),
		Cols:      80,
		Rows:      24,
		Status:    model.StatusExited,
		CreatedAt: time.Now().Unix(),
		UpdatedAt: time.Now().Unix(),
	}
	if err := db.Create(session).Error; err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	if err := db.Create(&model.TerminalHistory{
		SessionID: session.ID,
		Data:      []byte("history payload"),
		CreatedAt: time.Now().Unix(),
	}).Error; err != nil {
		t.Fatalf("failed to create history: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_, _ = manager.AttachWithOptions(session.ID, conn, AttachOptions{Cursor: 999})
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial: %v", err)
	}
	defer conn.Close()

	var gotReplay bool
	var gotReplayDone bool
	var gotState bool
	var gotExited bool

	for {
		_, raw, readErr := conn.ReadMessage()
		if readErr != nil {
			break
		}
		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("failed to decode ws message: %v", err)
		}
		switch msg.Type {
		case MsgTypeReplay:
			gotReplay = true
			if !msg.Reset {
				t.Fatalf("expected reset replay")
			}
			decoded, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil {
				t.Fatalf("failed to decode replay data: %v", err)
			}
			if string(decoded) != "history payload" {
				t.Fatalf("expected history payload, got %q", string(decoded))
			}
		case MsgTypeReplayDone:
			gotReplayDone = true
		case MsgTypeState:
			gotState = true
		case MsgTypePtyExited:
			gotExited = true
		}
	}

	if !gotReplay {
		t.Fatal("expected replay history message")
	}
	if !gotReplayDone {
		t.Fatal("expected replay_done message")
	}
	if !gotState {
		t.Fatal("expected state message")
	}
	if !gotExited {
		t.Fatal("expected pty_exited message")
	}
}
