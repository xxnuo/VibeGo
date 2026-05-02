package terminal

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestWorkspaceLifecycleSerializesCreateAndDelete(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.UserSession{}); err != nil {
		t.Fatalf("migrate user sessions: %v", err)
	}
	if err := db.Create(&model.UserSession{ID: "workspace-1", Name: "Workspace", State: "{}"}).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
	})
	const callbackName = "test:workspace_lifecycle_create_gate"
	if err := db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.TerminalSession{}).TableName() {
			return
		}
		enterOnce.Do(func() { close(entered) })
		<-release
	}); err != nil {
		t.Fatalf("register create callback: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Callback().Create().Remove(callbackName)
	})

	createDone := make(chan error, 1)
	var createdID string
	go func() {
		info, err := manager.Create(CreateOptions{
			Name:               "terminal",
			WorkspaceSessionID: "workspace-1",
		})
		if err == nil {
			createdID = info.ID
		}
		createDone <- err
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("workspace create did not enter lifecycle guard")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.DeleteWorkspace("workspace-1")
	}()

	select {
	case err := <-deleteDone:
		t.Fatalf("workspace delete bypassed in-flight create: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(release) })
	if err := <-createDone; err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("delete workspace: %v", err)
	}

	var count int64
	if err := db.Model(&model.UserSession{}).Where("id = ?", "workspace-1").Count(&count).Error; err != nil {
		t.Fatalf("count workspace: %v", err)
	}
	if count != 0 {
		t.Fatalf("workspace remains after delete: %d", count)
	}
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", createdID).Count(&count).Error; err != nil {
		t.Fatalf("count terminal: %v", err)
	}
	if count != 0 {
		t.Fatalf("terminal escaped workspace delete: %d", count)
	}
	if _, ok := manager.Get(createdID); ok {
		t.Fatal("terminal remains active after workspace delete")
	}

	callbackCalled := false
	err := manager.WithWorkspaceSession("workspace-1", func() error {
		callbackCalled = true
		return nil
	})
	if !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("expected ErrWorkspaceNotFound, got %v", err)
	}
	if callbackCalled {
		t.Fatal("deleted workspace callback was executed")
	}
}

func TestWorkspaceLifecycleAllowsNestedSync(t *testing.T) {
	db := setupTestDB(t)
	if err := db.Create(&model.UserSession{ID: "workspace-sync", Name: "Workspace", State: "{}"}).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	info, err := manager.Create(CreateOptions{Name: "terminal"})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	entered := make(chan struct{})
	release := make(chan struct{})
	syncDone := make(chan error, 1)
	go func() {
		syncDone <- manager.WithWorkspaceSession("workspace-sync", func() error {
			close(entered)
			<-release
			return manager.SyncWorkspaceMetadata("workspace-sync", []WorkspaceTerminalAssignment{
				{ID: info.ID, GroupID: "group-1"},
			})
		})
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("workspace sync did not enter lifecycle guard")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.DeleteWorkspace("workspace-sync")
	}()

	select {
	case err := <-deleteDone:
		t.Fatalf("workspace delete bypassed in-flight sync: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	close(release)
	if err := <-syncDone; err != nil {
		t.Fatalf("sync workspace metadata: %v", err)
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("delete workspace: %v", err)
	}
	if _, ok := manager.Get(info.ID); ok {
		t.Fatal("synced terminal remains active after workspace delete")
	}
}

func TestCreateRejectsMissingWorkspace(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	_, err := manager.Create(CreateOptions{
		Name:               "terminal",
		WorkspaceSessionID: "missing-workspace",
	})
	if !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("expected ErrWorkspaceNotFound, got %v", err)
	}

	var count int64
	if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("count terminals: %v", err)
	}
	if count != 0 {
		t.Fatalf("missing workspace created %d terminals", count)
	}
}

func TestDeleteWorkspaceKeepsCrossWorkspaceDescendantData(t *testing.T) {
	db := setupTestDB(t)
	for _, sessionID := range []string{"workspace-1", "workspace-2"} {
		if err := db.Create(&model.UserSession{ID: sessionID, Name: sessionID, State: "{}"}).Error; err != nil {
			t.Fatalf("create workspace %s: %v", sessionID, err)
		}
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	root, err := manager.Create(CreateOptions{
		Name:               "root",
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create root terminal: %v", err)
	}
	fakeChild, err := manager.Create(CreateOptions{
		Name:               "fake-child",
		WorkspaceSessionID: "workspace-2",
		GroupID:            "group-1",
	})
	if err != nil {
		t.Fatalf("create fake child terminal: %v", err)
	}
	defer manager.Close(fakeChild.ID)
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", fakeChild.ID).Update("parent_id", root.ID).Error; err != nil {
		t.Fatalf("seed cross-workspace parent link: %v", err)
	}
	for i, terminalID := range []string{root.ID, fakeChild.ID} {
		if err := db.Create(&model.TerminalHistory{SessionID: terminalID, Data: []byte("history"), CreatedAt: int64(i + 1)}).Error; err != nil {
			t.Fatalf("seed history for %s: %v", terminalID, err)
		}
		if err := db.Create(&model.BlockTermBlock{
			ID:         terminalID + "-block",
			TerminalID: terminalID,
			LineNum:    0,
			CreatedAt:  int64(i + 1),
			UpdatedAt:  int64(i + 1),
		}).Error; err != nil {
			t.Fatalf("seed block for %s: %v", terminalID, err)
		}
	}

	if err := manager.DeleteWorkspace("workspace-1"); err != nil {
		t.Fatalf("delete workspace: %v", err)
	}

	var count int64
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", root.ID).Count(&count).Error; err != nil {
		t.Fatalf("count deleted root: %v", err)
	}
	if count != 0 {
		t.Fatalf("workspace root remains: %d", count)
	}
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", fakeChild.ID).Count(&count).Error; err != nil {
		t.Fatalf("count fake child: %v", err)
	}
	if count != 1 {
		t.Fatalf("cross-workspace fake child was deleted: %d", count)
	}
	if err := db.Model(&model.TerminalHistory{}).Where("session_id = ?", fakeChild.ID).Count(&count).Error; err != nil {
		t.Fatalf("count fake child history: %v", err)
	}
	if count != 1 {
		t.Fatalf("cross-workspace history was deleted: %d", count)
	}
	if err := db.Model(&model.BlockTermBlock{}).Where("terminal_id = ?", fakeChild.ID).Count(&count).Error; err != nil {
		t.Fatalf("count fake child blocks: %v", err)
	}
	if count != 1 {
		t.Fatalf("cross-workspace block was deleted: %d", count)
	}
	if _, ok := manager.Get(fakeChild.ID); !ok {
		t.Fatal("cross-workspace fake child is no longer active")
	}
}
