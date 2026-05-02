package blockterm

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"testing"
)

func TestHookLifecycleStatesAreAtomic(t *testing.T) {
	for _, stage := range []struct{ frame, before, after, status string }{
		{"accept;ZWNobyBoaQ==;1", "ready", "submitted", "submitted"},
		{"start;ZWNobyBoaQ==;1", "submitted", "running", "running"},
		{"end;7;L3RtcA==;;;1", "running", "ready", "done"},
	} {
		for _, fail := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/fail=%v", stage.after, fail), func(t *testing.T) {
				s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
				if err != nil {
					t.Fatal(err)
				}
				defer s.Close()
				a := &activeSession{info: Session{ID: "hook", Phase: stage.before, Cwd: "/old"}, hookSeq: 1, accepted: true, temp: t.TempDir(), vt: newEmulator(80, 24)}
				defer a.vt.Close()
				defer a.vt.InputPipe().(io.Closer).Close()
				if stage.before != "ready" {
					a.current = &Block{ID: "command", SessionID: "hook", Status: stage.before}
					if err := s.db.Create(a.current).Error; err != nil {
						t.Fatal(err)
					}
				}
				if err := s.db.Create(&a.info).Error; err != nil {
					t.Fatal(err)
				}
				if fail {
					if err := s.db.Exec("CREATE TRIGGER reject_hook_state BEFORE INSERT ON events WHEN NEW.type = 'state' BEGIN SELECT RAISE(ABORT, 'injected hook failure'); END").Error; err != nil {
						t.Fatal(err)
					}
				}
				s.hook(a, stage.frame)
				stored, err := s.Get("hook")
				if err != nil {
					t.Fatal(err)
				}
				var blocks []Block
				if err := s.db.Where("session_id = ?", "hook").Find(&blocks).Error; err != nil {
					t.Fatal(err)
				}
				events := allEvents(t, s, "hook")
				if fail {
					if stored.Phase != stage.before || stored.Cwd != "/old" || stored.Seq != 0 || a.info.Seq != 0 || len(events) != 0 || !a.recordingStopped {
						t.Fatalf("partial transaction: %+v events=%v", stored, events)
					}
					if stage.before == "ready" {
						if len(blocks) != 0 {
							t.Fatal("failed acceptance left a block")
						}
					} else if len(blocks) != 1 || blocks[0].Status != stage.before || blocks[0].StartedAt != 0 || blocks[0].FinishedAt != 0 || blocks[0].ExitCode != nil {
						t.Fatalf("partial block: %+v", blocks)
					}
					return
				}
				if stored.Phase != stage.after || stored.Seq != 2 || len(blocks) != 1 || blocks[0].Status != stage.status || len(events) != 2 || events[0].Type != "block" || events[1].Type != "state" {
					t.Fatalf("missing transaction: %+v blocks=%+v events=%v", stored, blocks, events)
				}
				var state Session
				if err := json.Unmarshal(events[1].Data, &state); err != nil {
					t.Fatal(err)
				}
				if state.Phase != stage.after {
					t.Fatalf("wrong state payload: %+v", state)
				}
				if stage.status == "done" && (stored.Cwd != "/tmp" || state.Cwd != "/tmp" || blocks[0].ExitCode == nil || *blocks[0].ExitCode != 7) {
					t.Fatal("completion metadata lost")
				}
			})
		}
	}
}
