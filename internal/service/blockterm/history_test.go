package blockterm

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestHistoryCursorConcurrentInsert(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "history.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, group := range []string{"wanted", "other"} {
		if err := s.db.Create(&Session{ID: group, GroupID: group, Phase: "exited"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 405; i++ {
		if err := s.db.Create(&Block{ID: fmt.Sprintf("b-%04d", i), SessionID: "wanted", Command: "echo test", CreatedAt: 100}).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.History("wanted", "test", "")
	if err != nil || len(first.Blocks) != 200 || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("first page: %+v %v", first, err)
	}
	for _, b := range []Block{
		{ID: "new", SessionID: "wanted", Command: "echo test", CreatedAt: 200},
		{ID: "foreign", SessionID: "other", Command: "echo test", CreatedAt: 50},
		{ID: "unmatched", SessionID: "wanted", Command: "unrelated", CreatedAt: 50},
	} {
		if err := s.db.Create(&b).Error; err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	page := first
	for {
		for _, b := range page.Blocks {
			if seen[b.ID] || b.ID == "new" || b.ID == "foreign" || b.ID == "unmatched" {
				t.Fatalf("unexpected or duplicate: %s", b.ID)
			}
			seen[b.ID] = true
		}
		if !page.HasMore {
			break
		}
		page, err = s.History("wanted", "test", page.NextCursor)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 405 || len(page.Blocks) != 5 || page.NextCursor != "" {
		t.Fatalf("missing history: count=%d last=%+v", len(seen), page)
	}
	for _, cursor := range []string{"!", "e30", "bnVsbA"} {
		if _, err = s.History("wanted", "", cursor); err == nil {
			t.Fatalf("accepted invalid cursor %q", cursor)
		}
	}
}
