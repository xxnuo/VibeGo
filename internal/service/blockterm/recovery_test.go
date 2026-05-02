package blockterm

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestReopenPreservesRecordingError(t *testing.T) {
	for _, original := range []string{"", "输出记录存在缺口", "持久化失败: disk full"} {
		t.Run(original, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "core.sqlite")
			s, err := Open(path, "bash")
			if err != nil {
				t.Fatal(err)
			}
			a := &activeSession{info: Session{ID: "restart", Phase: "running", Error: original}}
			if err := s.append(a, "gap", "", []byte(original)); err != nil {
				s.Close()
				t.Fatal(err)
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			want := "服务已重启，会话已结束"
			if original != "" {
				want = original + "\n" + want
			}
			// Reopening twice exercises both real recovery and its idempotent path.
			for attempt := 0; attempt < 2; attempt++ {
				s, err := Open(path, "bash")
				if err != nil {
					t.Fatal(err)
				}
				func() {
					defer s.Close()
					stored, err := s.Get(a.info.ID)
					if err != nil {
						t.Fatal(err)
					}
					if stored.Error != want || stored.Phase != "exited" || stored.Seq != 2 {
						t.Fatalf("reopened session: %+v", stored)
					}
					events, err := s.Events(a.info.ID, 0)
					if err != nil {
						t.Fatal(err)
					}
					if len(events) != 2 || events[0].Type != "gap" || string(events[0].Data) != original || events[1].Type != "state" || events[1].Seq != 2 {
						t.Fatalf("recovery events: %+v", events)
					}
					var replayed Session
					if err := json.Unmarshal(events[1].Data, &replayed); err != nil {
						t.Fatal(err)
					}
					if replayed != stored {
						t.Fatalf("replay differs from stored session: %+v / %+v", replayed, stored)
					}
				}()
			}
		})
	}
}
