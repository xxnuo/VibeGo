package blockterm

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestLargeStreamEventsStayWithinReplayBudget(t *testing.T) {
	for _, kind := range []string{"output", "terminal"} {
		t.Run(kind, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{info: Session{ID: "large", Phase: "submitted"}}
			payload := bytes.Repeat([]byte("中文\x1b[31mX\x1b[0m"), eventBatchBytes/8)
			if err := s.append(a, kind, "block", payload); err != nil {
				t.Fatal(err)
			}
			var got []byte
			var cursor uint64
			pages := 0
			for {
				events, err := s.Events(a.info.ID, cursor)
				if err != nil {
					t.Fatal(err)
				}
				if len(events) == 0 {
					break
				}
				pages++
				pageBytes := 0
				for _, event := range events {
					if event.Seq != cursor+1 || event.Type != kind || event.BlockID != "block" || len(event.Data) > maxStreamEventBytes {
						t.Fatalf("invalid stream chunk: seq=%d bytes=%d", event.Seq, len(event.Data))
					}
					cursor = event.Seq
					pageBytes += len(event.Data)
					got = append(got, event.Data...)
				}
				if pageBytes > eventBatchBytes {
					t.Fatalf("page used %d bytes", pageBytes)
				}
			}
			if pages < 2 || !bytes.Equal(got, payload) || cursor != a.info.Seq {
				t.Fatal("chunked replay lost bytes or watermark")
			}
		})
	}
}

func TestChunkedStreamFailureRetainsCommittedWatermark(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.db.Exec(`CREATE TRIGGER reject_second_stream BEFORE INSERT ON events WHEN NEW.seq = 2 BEGIN SELECT RAISE(FAIL, 'test failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	a := &activeSession{info: Session{ID: "failure", Phase: "running"}}
	payload := bytes.Repeat([]byte("x"), 2*maxStreamEventBytes+1)
	if err := s.append(a, "output", "block", payload); err == nil {
		t.Fatal("chunk persistence failure was hidden")
	}
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 1 || !bytes.Equal(events[0].Data, payload[:maxStreamEventBytes]) {
		t.Fatalf("committed prefix changed: events=%d error=%v", len(events), err)
	}
	stored, err := s.Get(a.info.ID)
	if err != nil || stored.Seq != 1 || a.info.Seq != 1 || !a.recordingStopped {
		t.Fatalf("failed chunk advanced watermark: stored=%+v error=%v", stored, err)
	}
}
