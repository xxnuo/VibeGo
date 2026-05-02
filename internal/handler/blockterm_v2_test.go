package handler

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/service/blockterm"
)

func TestBlockTermV2ReplayAndAccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix bash fixture; native shells covered by service matrix")
	}
	shell, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	service, err := blockterm.Open(filepath.Join(t.TempDir(), "core.sqlite"), shell)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	session, err := service.Create("test", t.TempDir(), shell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Claim(session.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 140; i++ {
		if err = service.Resize(session.ID, "owner", 80+i%2, 24); err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	api := router.Group("/api", func(c *gin.Context) {
		if c.GetHeader("Authorization") != "test-key" {
			c.AbortWithStatus(http.StatusUnauthorized)
		}
	})
	RegisterBlockTermV2(api, service)
	server := httptest.NewServer(router)
	defer server.Close()
	path := "/api/blockterm/v2/sessions/" + session.ID + "/events?after=0"
	response, err := http.Get(server.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status: %d", response.StatusCode)
	}
	url := "ws" + strings.TrimPrefix(server.URL, "http") + path
	headers := http.Header{"Authorization": {"test-key"}, "Origin": {"https://foreign.invalid"}}
	ws, response, err := websocket.DefaultDialer.Dial(url, headers)
	if err == nil {
		ws.Close()
		t.Fatal("cross-origin websocket accepted")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("origin rejection: %v %v", response, err)
	}
	response.Body.Close()
	headers.Del("Origin")
	ws, _, err = websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	var hello, batch []blockterm.Event
	if err = ws.ReadJSON(&hello); err != nil || len(hello) != 1 || hello[0].Type != "hello" {
		t.Fatalf("hello: %v %v", hello, err)
	}
	if err = ws.ReadJSON(&batch); err != nil || len(batch) != 128 {
		t.Fatalf("batch length %d: %v", len(batch), err)
	}
	cursor := batch[len(batch)-1].Seq
	next := make(chan []blockterm.Event, 1)
	readErr := make(chan error, 1)
	go func() {
		var events []blockterm.Event
		if err := ws.ReadJSON(&events); err != nil {
			readErr <- err
			return
		}
		next <- events
	}()
	select {
	case <-next:
		t.Fatal("sent second batch before acknowledgement")
	case err := <-readErr:
		t.Fatal(err)
	case <-time.After(150 * time.Millisecond):
	}
	if err = ws.WriteJSON(map[string]uint64{"ack": cursor}); err != nil {
		t.Fatal(err)
	}
	select {
	case events := <-next:
		if len(events) == 0 || events[0].Seq != cursor+1 {
			t.Fatalf("discontinuous replay: %v", events)
		}
	case err := <-readErr:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("ack did not resume replay")
	}
	reconnectURL := strings.TrimSuffix(url, "0") + strconv.FormatUint(cursor, 10)
	reconnected, _, err := websocket.DefaultDialer.Dial(reconnectURL, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer reconnected.Close()
	reconnected.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err = reconnected.ReadJSON(&hello); err != nil {
		t.Fatal(err)
	}
	if err = reconnected.ReadJSON(&batch); err != nil || len(batch) == 0 || batch[0].Seq != cursor+1 {
		t.Fatalf("reconnect cursor: %v %v", batch, err)
	}
}
