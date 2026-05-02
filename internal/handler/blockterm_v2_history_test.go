package handler

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/blockterm"
)

func TestBlockTermV2HistoryCursorProtocol(t *testing.T) {
	s, err := blockterm.Open(filepath.Join(t.TempDir(), "history.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	router := gin.New()
	RegisterBlockTermV2(router.Group("/api"), s)
	for _, tc := range []struct {
		query  string
		status int
	}{
		{"?group_id=empty", 200}, {"?cursor=!", 400}, {"?offset=200", 409},
	} {
		r := httptest.NewRecorder()
		router.ServeHTTP(r, httptest.NewRequest("GET", "/api/blockterm/v2/history"+tc.query, nil))
		if r.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.query, r.Code, r.Body.String())
		}
		if r.Code == 200 {
			var page blockterm.HistoryPage
			if err := json.Unmarshal(r.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
			if page.Blocks == nil || len(page.Blocks) != 0 || page.HasMore || page.NextCursor != "" {
				t.Fatalf("unexpected empty page: %+v", page)
			}
		}
	}
}
