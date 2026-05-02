package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/config"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func pooledFixture(t *testing.T) (*Service, *config.DBPair) {
	t.Helper()
	pair, err := config.OpenDBPair(filepath.Join(t.TempDir(), "workspace.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, db := range []*gorm.DB{pair.Writer, pair.Reader} {
		pool, _ := db.DB()
		t.Cleanup(func() { _ = pool.Close() })
	}
	if err := pair.Writer.AutoMigrate(&model.UserSession{}, &model.TerminalSession{}); err != nil {
		t.Fatal(err)
	}
	if err := config.MigrateLegacySessionsToWorkspaces(pair.Writer); err != nil {
		t.Fatal(err)
	}
	if err := pair.Writer.Create(&model.Workspace{ID: "ws", Name: "Workspace"}).Error; err != nil {
		t.Fatal(err)
	}
	return New(pair.Writer, pair.Reader), pair
}

func rename(id string, base int64) ClientMutation {
	return ClientMutation{ID: id, WorkspaceID: "ws", ClientID: "test", Type: "workspace/rename", Payload: json.RawMessage(`{"name":"Updated"}`), BaseRevision: base, CreatedAt: time.Now().UnixMilli()}
}

func TestCompactionBoundsAndRetryHorizon(t *testing.T) {
	s, pair := pooledFixture(t)
	for i := int64(1); i <= 600; i++ {
		if _, err := s.Commit(rename(fmt.Sprint(i), i-1)); err != nil {
			t.Fatal(err)
		}
		var count int64
		if err := pair.Reader.Model(&model.WorkspaceMutation{}).Where("workspace_id = ?", "ws").Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count > KeepRecentRevisions {
			t.Fatalf("unbounded at %d: %d", i, count)
		}
	}
	earliest, err := s.EarliestRevision("ws")
	if err != nil || earliest != 101 {
		t.Fatalf("earliest %d: %v", earliest, err)
	}
	events, err := s.Events("ws", 100)
	if err != nil || len(events) != 500 || events[499].Revision != 600 {
		t.Fatalf("replay: %d %v", len(events), err)
	}
	if _, err := s.Commit(rename("1", 0)); !errors.Is(err, ErrConflict) {
		t.Fatalf("pruned retry accepted: %v", err)
	}
	if event, err := s.Commit(rename("600", 599)); err != nil || event.Revision != 600 {
		t.Fatalf("retained retry: %+v %v", event, err)
	}
	notification := rename("server", 0)
	notification.ClientID = "server"
	if _, err := s.Commit(notification); err != nil {
		t.Fatalf("server notification: %v", err)
	}
	if _, err := s.CompactWorkspaceMutations("ws", 0); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid retention accepted")
	}
	if removed, err := s.CompactWorkspaceMutations("ws", 50); err != nil || removed != 450 {
		t.Fatalf("compact %d: %v", removed, err)
	}
	if err := pair.Writer.Transaction(func(tx *gorm.DB) error { return DeleteInventory(tx, "ws") }); err != nil {
		t.Fatal(err)
	}
	if first, err := s.EarliestRevision("ws"); err != nil || first != 0 {
		t.Fatalf("deleted log: %d %v", first, err)
	}
}

func TestWALReaderPoolDoesNotBlockWriter(t *testing.T) {
	s, pair := pooledFixture(t)
	writer, _ := pair.Writer.DB()
	reader, _ := pair.Reader.DB()
	if writer.Stats().MaxOpenConnections != 1 || reader.Stats().MaxOpenConnections < 4 {
		t.Fatal("incorrect pool sizes")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 4; i++ {
		conn, err := reader.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		var journal string
		var busy, queryOnly, synchronous int
		for pragma, dest := range map[string]any{"journal_mode": &journal, "busy_timeout": &busy, "query_only": &queryOnly, "synchronous": &synchronous} {
			if err := conn.QueryRowContext(ctx, "PRAGMA "+pragma).Scan(dest); err != nil {
				t.Fatal(err)
			}
		}
		if journal != "wal" || busy != 5000 || queryOnly != 1 || synchronous != 1 {
			t.Fatalf("connection pragmas: %s %d %d %d", journal, busy, queryOnly, synchronous)
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM workspaces").Scan(&count); err != nil {
			t.Fatal(err)
		}
	}
	result := make(chan error, 1)
	go func() { _, err := s.Commit(rename("while-reading", 0)); result <- err }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("held WAL readers blocked writer")
	}
}

func TestFourReadersFourWriters(t *testing.T) {
	s, pair := pooledFixture(t)
	folders := make([]model.WorkspaceFolder, 400)
	for i := range folders {
		folders[i] = model.WorkspaceFolder{WorkspaceID: "ws", ID: fmt.Sprint(i), Name: "Folder", Path: "/repo", Data: `{"config":"value"}`}
	}
	if err := pair.Writer.CreateInBatches(folders, 100).Error; err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var elapsed atomic.Int64
	for worker := 0; worker < 4; worker++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				if snapshot, err := s.Snapshot("ws"); err != nil || len(snapshot.Folders) != 400 {
					t.Errorf("snapshot: %d %v", len(snapshot.Folders), err)
					return
				}
			}
		}()
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				started := time.Now()
				if _, err := s.Commit(rename(fmt.Sprintf("%d-%d", worker, i), 0)); err != nil {
					t.Error(err)
					return
				}
				elapsed.Add(int64(time.Since(started)))
			}
		}(worker)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("concurrent workload stalled")
	}
	average := time.Duration(elapsed.Load() / 400)
	t.Logf("4 readers + 4 writers, 400-folder snapshots, 400 commits: average write latency %s", average)
	if average > 100*time.Millisecond {
		t.Fatalf("write latency regression: %s", average)
	}
	snapshot, err := s.Snapshot("ws")
	if err != nil || snapshot.Workspace.Revision != 400 {
		t.Fatalf("lost writes: %+v %v", snapshot.Workspace, err)
	}
}

func TestCompactionUpgradesUntouchedWorkspaces(t *testing.T) {
	s, pair := pooledFixture(t)
	if err := pair.Writer.Create(&model.Workspace{ID: "other", Name: "Other", Revision: 700}).Error; err != nil {
		t.Fatal(err)
	}
	if err := pair.Writer.Model(&model.Workspace{}).Where("id = ?", "ws").Update("revision", 600).Error; err != nil {
		t.Fatal(err)
	}
	for id, count := range map[string]int{"ws": 600, "other": 700} {
		rows := make([]model.WorkspaceMutation, count)
		for i := range rows {
			rows[i] = model.WorkspaceMutation{WorkspaceID: id, ID: fmt.Sprint(i + 1), Revision: int64(i + 1), Mutation: "{}", Request: "{}"}
		}
		if err := pair.Writer.CreateInBatches(rows, 100).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := s.CompactExistingMutations(); err != nil {
		t.Fatal(err)
	}
	for id, expected := range map[string]int64{"ws": 101, "other": 201} {
		earliest, err := s.EarliestRevision(id)
		if err != nil || earliest != expected {
			t.Fatalf("%s: %d %v", id, earliest, err)
		}
	}
	if err := pair.Writer.Transaction(func(tx *gorm.DB) error { return DeleteInventory(tx, "ws") }); err != nil {
		t.Fatal(err)
	}
	if first, err := s.EarliestRevision("other"); err != nil || first != 201 {
		t.Fatalf("cross-workspace cleanup: %d %v", first, err)
	}
}
