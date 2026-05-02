package terminal

import (
	"encoding/base64"
	"encoding/json"
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

	if err := db.AutoMigrate(&model.TerminalSession{}, &model.TerminalHistory{}); err != nil {
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
	if child.ParentID != info1.ID {
		t.Fatalf("expected child parent_id to remain %s, got %s", info1.ID, child.ParentID)
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

	if err := db.Create(&model.TerminalHistory{SessionID: root.ID, Data: []byte("root"), CreatedAt: time.Now().Unix()}).Error; err != nil {
		t.Fatalf("failed to seed root history: %v", err)
	}
	if err := db.Create(&model.TerminalHistory{SessionID: child.ID, Data: []byte("child"), CreatedAt: time.Now().Unix()}).Error; err != nil {
		t.Fatalf("failed to seed child history: %v", err)
	}

	if err := manager.Delete(root.ID); err != nil {
		t.Fatalf("failed to delete split tree: %v", err)
	}

	var remainingSessions int64
	if err := db.Model(&model.TerminalSession{}).Where("id IN ?", []string{root.ID, child.ID}).Count(&remainingSessions).Error; err != nil {
		t.Fatalf("failed to count sessions: %v", err)
	}
	if remainingSessions != 0 {
		t.Fatalf("expected split tree sessions to be deleted, got %d", remainingSessions)
	}

	var remainingHistory int64
	if err := db.Model(&model.TerminalHistory{}).Where("session_id IN ?", []string{root.ID, child.ID}).Count(&remainingHistory).Error; err != nil {
		t.Fatalf("failed to count history: %v", err)
	}
	if remainingHistory != 0 {
		t.Fatalf("expected split tree history to be deleted, got %d", remainingHistory)
	}
}

func TestManager_CleanupOnStart(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	manager.CleanupOnStart()
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
