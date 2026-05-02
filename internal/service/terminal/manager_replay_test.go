package terminal

import (
	"bytes"
	"sync/atomic"
	"testing"
)

type replaySnapshotStoreStub struct {
	loadCount atomic.Int32
	snapshot  *TerminalSnapshot
}

func (s *replaySnapshotStoreStub) Load(string) (*TerminalSnapshot, error) {
	s.loadCount.Add(1)
	return s.snapshot, nil
}

func (*replaySnapshotStoreStub) Save(*TerminalSnapshot) error { return nil }
func (*replaySnapshotStoreStub) Delete(string) error          { return nil }

func TestManagerGetReplaySnapshotIncremental(t *testing.T) {
	manager := &Manager{}
	at := &activeTerminal{
		historyBuffer: newHistoryBuffer(16),
	}

	_, _ = at.historyBuffer.Write([]byte("abcdef"))
	snapshot := manager.getReplaySnapshot(at, 2)

	if snapshot.reset {
		t.Fatal("expected incremental replay")
	}
	if snapshot.cursor != 6 {
		t.Fatalf("expected cursor 6, got %d", snapshot.cursor)
	}
	if !bytes.Equal(snapshot.data, []byte("cdef")) {
		t.Fatalf("expected %q, got %q", []byte("cdef"), snapshot.data)
	}
}

func TestManagerGetReplaySnapshotFallbackToReset(t *testing.T) {
	manager := &Manager{}
	at := &activeTerminal{
		historyBuffer: newHistoryBuffer(5),
	}

	_, _ = at.historyBuffer.Write([]byte("abcdef"))
	snapshot := manager.getReplaySnapshot(at, 0)

	if !snapshot.reset {
		t.Fatal("expected reset replay on stale cursor")
	}
	if snapshot.cursor != 6 {
		t.Fatalf("expected cursor 6, got %d", snapshot.cursor)
	}
	if !bytes.Equal(snapshot.data, []byte("bcdef")) {
		t.Fatalf("expected %q, got %q", []byte("bcdef"), snapshot.data)
	}
}

func TestManagerGetReplaySnapshotStaleCursorUsesCurrentRing(t *testing.T) {
	store := &replaySnapshotStoreStub{snapshot: &TerminalSnapshot{
		SessionID: "terminal-1",
		Data:      []byte("old-db-snapshot"),
		Cursor:    6,
	}}
	manager := &Manager{snapshotStore: store}
	at := &activeTerminal{
		ID:            "terminal-1",
		historyBuffer: newHistoryBuffer(5),
	}

	_, _ = at.historyBuffer.Write([]byte("abcdefghijkl"))
	snapshot := manager.getReplaySnapshot(at, 0)

	if !snapshot.reset {
		t.Fatal("expected reset replay for stale cursor")
	}
	if snapshot.cursor != 12 {
		t.Fatalf("expected current ring cursor 12, got %d", snapshot.cursor)
	}
	if !bytes.Equal(snapshot.data, []byte("hijkl")) {
		t.Fatalf("expected current ring data %q, got %q", []byte("hijkl"), snapshot.data)
	}
	if store.loadCount.Load() != 0 {
		t.Fatalf("active stale replay must not load a lagging DB snapshot; loads=%d", store.loadCount.Load())
	}
}
