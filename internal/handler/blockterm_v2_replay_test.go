package handler

import (
	"bytes"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/service/blockterm"
	"gorm.io/gorm"
)

func TestBlockTermV2ByteBatchesAckAndResume(t *testing.T) {
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
	if err := db.Create(&blockterm.Session{ID: "byte-batches", Phase: "exited", Seq: 6}).Error; err != nil {
		t.Fatal(err)
	}
	for seq := uint64(1); seq <= 6; seq++ {
		if err := db.Create(&blockterm.Event{SessionID: "byte-batches", Seq: seq, Type: "output", BlockID: "block", Data: bytes.Repeat([]byte{byte(seq)}, 400000)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	RegisterBlockTermV2(router.Group("/api"), service)
	server := httptest.NewServer(router)
	defer server.Close()
	connect := func(after uint64) *websocket.Conn {
		t.Helper()
		ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/blockterm/v2/sessions/byte-batches/events?after="+strconv.FormatUint(after, 10), nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.Close() })
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		var hello []blockterm.Event
		if err := ws.ReadJSON(&hello); err != nil || len(hello) != 1 || hello[0].Type != "hello" || hello[0].Seq != 6 {
			t.Fatalf("invalid hello: count=%d error=%v", len(hello), err)
		}
		return ws
	}
	check := func(events []blockterm.Event, first uint64) {
		t.Helper()
		if len(events) != 2 {
			t.Fatalf("expected two-event byte-limited batch, got %d", len(events))
		}
		for index, event := range events {
			seq := first + uint64(index)
			if event.Seq != seq || event.Type != "output" || !bytes.Equal(event.Data, bytes.Repeat([]byte{byte(seq)}, 400000)) {
				t.Fatalf("incorrect batch event seq=%d expected=%d bytes=%d", event.Seq, seq, len(event.Data))
			}
		}
	}
	ws := connect(0)
	var first []blockterm.Event
	if err := ws.ReadJSON(&first); err != nil {
		t.Fatal(err)
	}
	check(first, 1)
	type received struct {
		events []blockterm.Event
		err    error
	}
	next := make(chan received, 1)
	go func() {
		var batch []blockterm.Event
		err := ws.ReadJSON(&batch)
		next <- received{batch, err}
	}()
	select {
	case result := <-next:
		t.Fatalf("sent next batch before ACK: count=%d error=%v", len(result.events), result.err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := ws.WriteJSON(map[string]uint64{"ack": 2}); err != nil {
		t.Fatal(err)
	}
	result := <-next
	if result.err != nil {
		t.Fatal(result.err)
	}
	check(result.events, 3)
	// The second batch was received but not applied/ACKed. Resume at 2.
	_ = ws.Close()
	resumed := connect(2)
	for _, start := range []uint64{3, 5} {
		var batch []blockterm.Event
		if err := resumed.ReadJSON(&batch); err != nil {
			t.Fatal(err)
		}
		check(batch, start)
		if err := resumed.WriteJSON(map[string]uint64{"ack": start + 1}); err != nil {
			t.Fatal(err)
		}
	}
	_ = resumed.Close()
}

func TestBlockTermV2MissingTailSendsFault(t *testing.T) {
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
	if err := db.Create(&blockterm.Session{ID: "missing-tail", Phase: "exited", Seq: 2}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&blockterm.Event{SessionID: "missing-tail", Seq: 1, Type: "state"}).Error; err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	RegisterBlockTermV2(router.Group("/api"), service)
	server := httptest.NewServer(router)
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/blockterm/v2/sessions/missing-tail/events?after=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var events []blockterm.Event
	if err := ws.ReadJSON(&events); err != nil || len(events) != 1 || events[0].Type != "hello" || events[0].Seq != 2 {
		t.Fatalf("hello %+v %v", events, err)
	}
	if err := ws.ReadJSON(&events); err != nil || len(events) != 1 || events[0].Type != "fault" || len(events[0].Data) == 0 {
		t.Fatalf("missing-tail fault %+v %v", events, err)
	}
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("fault connection remained open")
	} else if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
		t.Fatalf("connection timed out instead of closing: %v", err)
	}
}

func TestBlockTermReplayContinuity(t *testing.T) {
	event := func(seq uint64) blockterm.Event { return blockterm.Event{SessionID: "session", Seq: seq} }
	for _, tc := range []struct {
		name              string
		cursor, watermark uint64
		events            []blockterm.Event
		valid             bool
	}{
		{"caught up", 5, 5, nil, true},
		{"live cursor past hello", 7, 5, nil, true},
		{"missing tail", 4, 5, nil, false},
		{"partial page", 0, 5, []blockterm.Event{event(1), event(2)}, true},
		{"live append", 5, 5, []blockterm.Event{event(6)}, true},
		{"missing prefix", 0, 5, []blockterm.Event{event(2)}, false},
		{"missing middle", 0, 5, []blockterm.Event{event(1), event(3)}, false},
		{"duplicate", 1, 5, []blockterm.Event{event(1)}, false},
		{"wrong session", 0, 1, []blockterm.Event{{SessionID: "other", Seq: 1}}, false},
		{"overflow", ^uint64(0), ^uint64(0), []blockterm.Event{event(0)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateBlockTermReplay(tc.events, "session", tc.cursor, tc.watermark); (err == nil) != tc.valid {
				t.Fatalf("validation result %v, want valid %v", err, tc.valid)
			}
		})
	}
}
