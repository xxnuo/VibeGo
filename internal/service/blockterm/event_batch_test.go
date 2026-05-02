package blockterm

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"
)

func TestEventBatchByteBudget(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for index, size := range []int{400000, 400000, 400000, eventBatchBytes + 1, 0, 10} {
		event := Event{SessionID: "budget", Seq: uint64(index + 1), Type: "output", BlockID: "block", Data: bytes.Repeat([]byte{byte(index)}, size)}
		if err := s.db.Create(&event).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, output := range []bool{false, true} {
		var cursor uint64
		for _, want := range [][]uint64{{1, 2}, {3}, {4}, {5, 6}, {}} {
			var events []Event
			if output {
				var more bool
				events, more, err = s.OutputPageContext(context.Background(), "budget", "block", cursor)
				if more != (len(want) > 0 && want[len(want)-1] < 6) {
					t.Fatalf("incorrect has_more at cursor %d: %v", cursor, more)
				}
			} else {
				events, err = s.Events("budget", cursor)
			}
			if err != nil || len(events) != len(want) {
				t.Fatalf("output=%v cursor=%d count=%d want=%v error=%v", output, cursor, len(events), want, err)
			}
			for index, event := range events {
				if event.Seq != want[index] {
					t.Fatalf("wrong sequence: %+v", event.Seq)
				}
				for _, value := range event.Data {
					if value != byte(event.Seq-1) {
						t.Fatal("payload corrupted across batches")
					}
				}
				cursor = event.Seq
			}
		}
	}
}

func TestEventBatchCountLookahead(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for seq := uint64(1); seq <= 129; seq++ {
		if err := s.db.Create(&Event{SessionID: "count", BlockID: "block", Type: "output", Seq: seq}).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, more, err := s.OutputPageContext(context.Background(), "count", "block", 0)
	if err != nil || len(first) != 128 || !more {
		t.Fatalf("first page: %d %v %v", len(first), more, err)
	}
	last, more, err := s.OutputPageContext(context.Background(), "count", "block", 128)
	if err != nil || len(last) != 1 || more || last[0].Seq != 129 {
		t.Fatalf("last page: %d %v %v", len(last), more, err)
	}
}
