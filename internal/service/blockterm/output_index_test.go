package blockterm

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOutputIndexMigrationAndPagination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.sqlite")
	s, err := Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if s != nil {
			_ = s.Close()
		}
	}()
	var events, expected []Event
	for index := 1; index <= 900; index++ {
		e := Event{SessionID: "session", Seq: uint64(index), Type: "output", BlockID: "other", Data: []byte{byte(index)}}
		if index%3 == 0 {
			e.BlockID = "target"
		}
		if index%5 == 0 {
			e.Type = "terminal"
		}
		if e.BlockID == "target" && e.Type == "output" {
			expected = append(expected, e)
		}
		events = append(events, e)
	}
	if err := s.db.CreateInBatches(events, 100).Error; err != nil {
		t.Fatal(err)
	}
	// Model an existing database without the new index; reopening must add it
	// without altering retained output or cursor semantics.
	if err := s.db.Migrator().DropIndex(&Event{}, "idx_blockterm_output"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	var plan []struct{ Detail string }
	if err := s.db.Raw("EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id = ? AND block_id = ? AND type = ? AND seq > ? ORDER BY seq LIMIT 128", "session", "target", "output", 0).Scan(&plan).Error; err != nil {
		t.Fatal(err)
	}
	indexed := false
	for _, row := range plan {
		t.Log(row.Detail)
		if strings.Contains(row.Detail, "idx_blockterm_output") && strings.Contains(row.Detail, "block_id=?") && strings.Contains(row.Detail, "seq>?") {
			indexed = true
		}
		if strings.Contains(row.Detail, "TEMP B-TREE") {
			t.Fatalf("output query sorts outside the index: %s", row.Detail)
		}
	}
	if !indexed {
		t.Fatalf("output query does not use its range index: %+v", plan)
	}
	var actual []Event
	var cursor uint64
	for {
		page, err := s.Output("session", "target", cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) > 128 {
			t.Fatalf("unbounded page: %d", len(page))
		}
		actual = append(actual, page...)
		if len(page) == 0 {
			break
		}
		cursor = page[len(page)-1].Seq
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("index migration or pagination changed output events")
	}
}
