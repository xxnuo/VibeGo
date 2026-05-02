package terminal

import (
	"bytes"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func newSnapshotStoreTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.AutoMigrate(&model.TerminalSession{}, &model.TerminalHistory{}); err != nil {
		t.Fatalf("migrate db: %v", err)
	}
	return db
}

func TestDBTerminalSnapshotStoreRoundTripsAbsoluteCursor(t *testing.T) {
	db := newSnapshotStoreTestDB(t)
	session := &model.TerminalSession{ID: "snapshot-session", Status: model.StatusExited}
	if err := db.Create(session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}

	store := NewDBTerminalSnapshotStore(db)
	want := &TerminalSnapshot{
		SessionID: "snapshot-session",
		Data:      []byte("retained"),
		Cursor:    42,
		Status:    model.StatusExited,
		UpdatedAt: 10,
	}
	if err := store.Save(want); err != nil {
		t.Fatalf("save snapshot: %v", err)
	}

	got, err := store.Load(want.SessionID)
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if got == nil || got.Cursor != want.Cursor {
		t.Fatalf("expected cursor %d, got %#v", want.Cursor, got)
	}
	if !bytes.Equal(got.Data, want.Data) {
		t.Fatalf("expected data %q, got %q", want.Data, got.Data)
	}
}

func TestDBTerminalSnapshotStoreLegacyCursorFallback(t *testing.T) {
	db := newSnapshotStoreTestDB(t)
	session := &model.TerminalSession{ID: "legacy-session", Status: model.StatusExited}
	if err := db.Create(session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := db.Create(&model.TerminalHistory{
		SessionID: session.ID,
		Data:      []byte("legacy"),
		Cursor:    0,
		CreatedAt: 1,
	}).Error; err != nil {
		t.Fatalf("create legacy history: %v", err)
	}

	got, err := NewDBTerminalSnapshotStore(db).Load(session.ID)
	if err != nil {
		t.Fatalf("load legacy snapshot: %v", err)
	}
	if got == nil || got.Cursor != uint64(len("legacy")) {
		t.Fatalf("expected legacy cursor %d, got %#v", len("legacy"), got)
	}
}
