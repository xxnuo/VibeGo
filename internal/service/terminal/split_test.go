package terminal

import (
	"testing"

	"github.com/xxnuo/vibego/internal/model"
)

func TestSplitIdentitySurvivesRootExitAndHistoryDeletion(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	create := func(parent string) *TerminalInfo {
		t.Helper()
		info, err := manager.Create(CreateOptions{Cwd: t.TempDir(), ParentID: parent})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = manager.Delete(info.ID) })
		return info
	}
	root := create("")
	child := create(root.ID)
	nested := create(child.ID)
	for _, id := range []string{root.ID, child.ID, nested.ID} {
		info, ok := manager.Get(id)
		if !ok || info.SplitGroupID != root.ID {
			t.Fatalf("split identity for %s: %+v", id, info)
		}
	}
	if err := manager.Close(root.ID); err != nil {
		t.Fatal(err)
	}
	if err := manager.DeleteHistory(root.ID); err != nil {
		t.Fatal(err)
	}
	if err := manager.DeleteHistory(child.ID); err == nil {
		t.Fatal("history deletion accepted a running pane")
	}
	if err := manager.Close(child.ID); err != nil {
		t.Fatal(err)
	}
	if err := manager.DeleteHistory(child.ID); err != nil {
		t.Fatal(err)
	}
	info, ok := manager.Get(nested.ID)
	if !ok || info.Status != model.StatusRunning || info.SplitGroupID != root.ID {
		t.Fatalf("survivor was stopped or lost its tab: %+v", info)
	}
	var stored model.TerminalSession
	if err := db.First(&stored, "id = ?", nested.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.SplitGroupID != root.ID {
		t.Fatalf("split identity not durable: %+v", stored)
	}
	// A new pane can use the surviving runtime even after both historical ancestors were deleted.
	sibling := create(nested.ID)
	if sibling.SplitGroupID != root.ID {
		t.Fatalf("new pane changed tabs: %+v", sibling)
	}
}

func TestDeleteLegacyHistoryKeepsLiveDescendantsAndStableAncestry(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	rows := []model.TerminalSession{
		{ID: "root", GroupID: "shell", Status: model.StatusRunning},
		{ID: "middle", GroupID: "shell", ParentID: "root", Status: model.StatusExited},
		{ID: "live", GroupID: "shell", ParentID: "middle", Status: model.StatusRunning},
		{ID: "foreign", GroupID: "other", ParentID: "middle", Status: model.StatusRunning},
	}
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.TerminalHistory{SessionID: "middle", Data: []byte("old output")}).Error; err != nil {
		t.Fatal(err)
	}
	if err := manager.DeleteHistory("middle"); err != nil {
		t.Fatal(err)
	}
	var live model.TerminalSession
	if err := db.First(&live, "id = ?", "live").Error; err != nil {
		t.Fatal(err)
	}
	if live.Status != model.StatusRunning || live.SplitGroupID != "root" {
		t.Fatalf("legacy descendant changed: %+v", live)
	}
	var foreign model.TerminalSession
	if err := db.First(&foreign, "id = ?", "foreign").Error; err != nil {
		t.Fatal(err)
	}
	if foreign.SplitGroupID != "" || foreign.Status != model.StatusRunning {
		t.Fatalf("foreign scope changed: %+v", foreign)
	}
	var count int64
	if err := db.Model(&model.TerminalHistory{}).Where("session_id = ?", "middle").Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("history remained: %d %v", count, err)
	}
}

func TestSplitIdentityTransactionRollsBackWithFailedChildInsert(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	root, err := manager.Create(CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Delete(root.ID)
	if err := db.Exec("CREATE TRIGGER reject_split BEFORE INSERT ON terminal_sessions WHEN NEW.parent_id != '' BEGIN SELECT RAISE(ABORT, 'reject split'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Create(CreateOptions{Cwd: t.TempDir(), ParentID: root.ID}); err == nil {
		t.Fatal("expected child insert to fail")
	}
	var stored model.TerminalSession
	if err := db.First(&stored, "id = ?", root.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.SplitGroupID != "" {
		t.Fatalf("failed split changed persisted parent: %+v", stored)
	}
	active, ok := manager.Get(root.ID)
	if !ok || active.SplitGroupID != "" {
		t.Fatalf("failed split changed live parent: %+v", active)
	}
}
