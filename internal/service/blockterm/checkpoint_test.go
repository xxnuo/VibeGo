package blockterm

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/vt"
)

func checkpointServiceFixture(t *testing.T) (*Service, *activeSession, string, func()) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "checkpoint.sqlite")
	s, err := Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	a := &activeSession{info: Session{ID: "checkpoint", GroupID: "group", Shell: "bash", Phase: "editing", Cols: 40, Rows: 12, CreatedAt: 1}, owner: "owner", lease: time.Now().Add(time.Hour), vt: newEmulator(40, 12), temp: t.TempDir()}
	if err := s.db.Create(&a.info).Error; err != nil {
		t.Fatal(err)
	}
	s.sessions[a.info.ID] = a
	var once sync.Once
	closeFixture := func() {
		once.Do(func() {
			delete(s.sessions, a.info.ID)
			a.clearPending()
			_ = a.vt.Close()
			_ = a.vt.InputPipe().(io.Closer).Close()
			if err := s.Close(); err != nil {
				t.Error(err)
			}
		})
	}
	t.Cleanup(closeFixture)
	s.output(a, []byte("\x1b[31mA"))
	return s, a, path, closeFixture
}

func TestReplayCheckpointPersistsWithoutPruning(t *testing.T) {
	s, a, path, closeFixture := checkpointServiceFixture(t)
	if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	s.output(a, []byte("B"))
	state, checkpoint, err := s.ReplayCheckpoint(a.info.ID)
	if err != nil || state.Session.Seq != 1 {
		t.Fatalf("checkpoint: %+v %v", state, err)
	}
	target := newEmulator(20, 5)
	defer target.Close()
	defer target.InputPipe().(io.Closer).Close()
	if err := target.RestoreCheckpoint(checkpoint); err != nil {
		t.Fatal(err)
	}
	events, err := s.Events(a.info.ID, state.Session.Seq)
	if err != nil || len(events) != 1 {
		t.Fatalf("suffix: %d %v", len(events), err)
	}
	_, _ = target.Write(events[0].Data)
	if target.Render() != a.vt.Render() || target.CursorPosition() != a.vt.CursorPosition() {
		t.Fatal("persisted prefix plus suffix differs from live state")
	}
	all, err := s.Events(a.info.ID, 0)
	if err != nil || len(all) != 2 {
		t.Fatal("saving checkpoint changed retained events")
	}
	closeFixture()
	reopened, err := Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state, checkpoint, err = reopened.ReplayCheckpoint(a.info.ID)
	if err != nil || state.Session.Seq != 1 || checkpoint == nil {
		t.Fatalf("checkpoint did not survive reopen: %v", err)
	}
	current, err := reopened.Get(a.info.ID)
	if err != nil || current.Phase != "exited" {
		t.Fatal("checkpoint unexpectedly revived a PTY")
	}
}

func TestReplayCheckpointRejectsUncommittedState(t *testing.T) {
	for _, kind := range []string{"owner", "pending", "pending-file", "accepted", "cancelled", "uncertain", "stopped", "stale", "geometry", "partial"} {
		t.Run(kind, func(t *testing.T) {
			s, a, _, _ := checkpointServiceFixture(t)
			owner := "owner"
			switch kind {
			case "owner":
				owner = "other"
			case "pending":
				a.pendingOutput = []byte("uncommitted")
			case "pending-file":
				if err := a.bufferPending(bytes.Repeat([]byte("x"), maxStreamEventBytes+1)); err != nil {
					t.Fatal(err)
				}
			case "accepted":
				a.accepted = true
			case "cancelled":
				a.cancelRequested = true
			case "uncertain":
				a.uncertainSubmit = "unconfirmed"
			case "stopped":
				a.recordingStopped = true
			case "stale":
				a.info.Cwd = "not-committed"
			case "geometry":
				a.info.Cols++
			case "partial":
				s.output(a, []byte("\x1b[31"))
			}
			err := s.SaveReplayCheckpoint(a.info.ID, owner)
			if kind == "partial" {
				if !errors.Is(err, vt.ErrCheckpointIncomplete) {
					t.Fatalf("partial accepted: %v", err)
				}
			} else if !errors.Is(err, ErrConflict) {
				t.Fatalf("uncommitted state accepted: %v", err)
			}
			var count int64
			if err := s.db.Model(&storedCheckpoint{}).Count(&count).Error; err != nil || count != 0 {
				t.Fatal("rejected snapshot was stored")
			}
		})
	}
}

func TestReplayCheckpointFailureKeepsPreviousRecord(t *testing.T) {
	s, a, _, _ := checkpointServiceFixture(t)
	if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	var before storedCheckpoint
	if err := s.db.First(&before, "session_id = ?", a.info.ID).Error; err != nil {
		t.Fatal(err)
	}
	s.output(a, []byte("B"))
	if err := s.db.Exec("CREATE TRIGGER deny_checkpoint BEFORE UPDATE ON terminal_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err == nil {
		t.Fatal("injected failure was ignored")
	}
	var after storedCheckpoint
	if err := s.db.First(&after, "session_id = ?", a.info.ID).Error; err != nil {
		t.Fatal(err)
	}
	if after.Seq != before.Seq || after.Digest != before.Digest || !bytes.Equal(after.Terminal, before.Terminal) || a.recordingStopped || a.info.Seq != 2 {
		t.Fatal("failed replacement changed record or recording state")
	}
	if err := s.db.Exec("DROP TRIGGER deny_checkpoint").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	var count int64
	_ = s.db.Model(&storedCheckpoint{}).Count(&count).Error
	state, _, err := s.ReplayCheckpoint(a.info.ID)
	if err != nil || state.Session.Seq != 2 || count != 1 {
		t.Fatal("replacement did not retain exactly one latest checkpoint")
	}
}

func TestReplayCheckpointDetectsCorruption(t *testing.T) {
	for _, field := range []string{"metadata", "terminal", "seq", "digest"} {
		t.Run(field, func(t *testing.T) {
			s, a, _, _ := checkpointServiceFixture(t)
			if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err != nil {
				t.Fatal(err)
			}
			value := any([]byte("corrupt"))
			if field == "seq" {
				value = 99
			}
			if field == "digest" {
				value = "wrong"
			}
			if err := s.db.Model(&storedCheckpoint{}).Where("session_id = ?", a.info.ID).Update(field, value).Error; err != nil {
				t.Fatal(err)
			}
			state, checkpoint, err := s.ReplayCheckpoint(a.info.ID)
			if err == nil || checkpoint != nil || state.Session.ID != "" {
				t.Fatal("corrupt state exposed")
			}
		})
	}
}

func TestReplayCheckpointValidatesChecksummedPayload(t *testing.T) {
	for _, kind := range []string{"version", "geometry", "block", "terminal"} {
		t.Run(kind, func(t *testing.T) {
			s, a, _, _ := checkpointServiceFixture(t)
			if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err != nil {
				t.Fatal(err)
			}
			var record storedCheckpoint
			if err := s.db.First(&record, "session_id = ?", a.info.ID).Error; err != nil {
				t.Fatal(err)
			}
			var state ReplayCheckpointState
			if err := json.Unmarshal(record.Metadata, &state); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "version":
				state.Version = 2
			case "geometry":
				state.Session.Cols++
			case "block":
				state.Current = &Block{ID: "foreign", SessionID: "another-session"}
			case "terminal":
				record.Terminal = []byte(`{"Version":999}`)
			}
			var err error
			record.Metadata, err = json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			record.Digest = checkpointDigest(&record)
			if err := s.db.Save(&record).Error; err != nil {
				t.Fatal(err)
			}
			state, checkpoint, err := s.ReplayCheckpoint(a.info.ID)
			if err == nil || checkpoint != nil || state.Session.ID != "" {
				t.Fatal("checksum bypassed structural validation")
			}
		})
	}
}

func TestReplayCheckpointRejectsLossyMetadata(t *testing.T) {
	s, a, _, _ := checkpointServiceFixture(t)
	a.current = &Block{ID: "block", SessionID: a.info.ID, Command: "\xff"}
	if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); !errors.Is(err, errCheckpointCorrupt) {
		t.Fatalf("lossy metadata accepted: %v", err)
	}
}

func TestReplayCheckpointRequiresCommittedBlocks(t *testing.T) {
	for _, kind := range []string{"current-missing", "current-stale", "current-event-missing", "current-event-stale", "background-missing", "background-stale", "grid-missing", "grid-foreign", "committed"} {
		t.Run(kind, func(t *testing.T) {
			s, a, _, _ := checkpointServiceFixture(t)
			if err := s.SaveReplayCheckpoint(a.info.ID, "owner"); err != nil {
				t.Fatal(err)
			}
			block := Block{ID: "block", SessionID: a.info.ID, Status: "running", Command: "original", CreatedAt: 1}
			if kind != "current-missing" && kind != "background-missing" && kind != "grid-missing" {
				if kind == "grid-foreign" {
					block.SessionID = "foreign"
				}
				if kind == "grid-foreign" || kind == "current-event-missing" {
					if err := s.db.Create(&block).Error; err != nil {
						t.Fatal(err)
					}
				} else if err := s.blockEvent(a, &block); err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "current-missing", "current-stale", "current-event-missing", "current-event-stale":
				a.current = &block
			case "background-missing", "background-stale":
				a.background = &block
			case "grid-missing", "grid-foreign":
				a.gridBlock = block.ID
			case "committed":
				a.current = &block
				a.gridBlock = block.ID
			}
			if kind == "current-stale" || kind == "background-stale" {
				block.Command = "not committed"
			}
			if kind == "current-event-stale" {
				block.Command = "row changed without event"
				if err := s.db.Save(&block).Error; err != nil {
					t.Fatal(err)
				}
			}
			err := s.SaveReplayCheckpoint(a.info.ID, "owner")
			if kind == "committed" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, ErrConflict) {
				t.Fatalf("uncommitted block accepted: %v", err)
			}
			state, _, err := s.ReplayCheckpoint(a.info.ID)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "committed" {
				if state.Current == nil || state.Current.Command != "original" || state.GridBlock != block.ID {
					t.Fatal("committed context lost")
				}
			} else if state.Current != nil || state.Background != nil || state.GridBlock != "" {
				t.Fatal("failed validation replaced old checkpoint")
			}
		})
	}
}
