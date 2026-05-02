package handler

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/xxnuo/vibego/internal/service/blockterm"
	"gorm.io/gorm"
)

func TestBlockTermOutputByteBudgetPagination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.sqlite")
	service, err := blockterm.Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err := db.Create(&blockterm.Session{ID: "budget", Phase: "exited", Seq: 3}).Error; err != nil {
		t.Fatal(err)
	}
	for seq := uint64(1); seq <= 3; seq++ {
		if err := db.Create(&blockterm.Event{SessionID: "budget", Seq: seq, BlockID: "block", Type: "output", Data: bytes.Repeat([]byte("x"), 400000)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	RegisterBlockTermV2(router.Group("/api"), service)
	for _, page := range []struct {
		after string
		count int
		more  bool
	}{{"0", 2, true}, {"2", 1, false}, {"3", 0, false}} {
		response := httptest.NewRecorder()
		query := "after=" + page.after
		if page.after != "0" {
			query += "&through=3"
		}
		router.ServeHTTP(response, httptest.NewRequest("GET", "/api/blockterm/v2/sessions/budget/blocks/block/output?"+query, nil))
		var body struct {
			Events  []blockterm.Event `json:"events"`
			More    bool              `json:"has_more"`
			Through uint64            `json:"through"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 || len(body.Events) != page.count || body.More != page.more || body.Through != 3 {
			t.Fatalf("after=%s status=%d count=%d more=%v error=%v", page.after, response.Code, len(body.Events), body.More, err)
		}
		if page.after == "0" {
			if err := db.Create(&blockterm.Event{SessionID: "budget", Seq: 4, BlockID: "block", Type: "output", Data: []byte("appended after snapshot")}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&blockterm.Session{}).Where("id = ?", "budget").Update("seq", 4).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, query := range []string{"after=0&through=5", "after=4&through=3", "after=0&through=-1"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", "/api/blockterm/v2/sessions/budget/blocks/block/output?"+query, nil))
		if response.Code == 200 {
			t.Fatalf("invalid snapshot accepted: %s", query)
		}
	}
}
