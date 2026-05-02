package handler

import (
	"net/http/httptest"
	"os"
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

func TestBlockTermV2UnsolicitedAckOverflowClosesConnection(t *testing.T) {
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
	session, err := service.Create("ack-test", t.TempDir(), shell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Claim(session.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	if err := service.CloseSession(session.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		session, err = service.Get(session.ID)
		if err != nil {
			t.Fatal(err)
		}
		if session.Phase == "exited" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session did not exit")
		}
		time.Sleep(time.Millisecond)
	}
	router := gin.New()
	RegisterBlockTermV2(router.Group("/api"), service)
	server := httptest.NewServer(router)
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/blockterm/v2/sessions/" + session.ID + "/events?after=" + strconv.FormatUint(session.Seq, 10)
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var hello []blockterm.Event
	if err := ws.ReadJSON(&hello); err != nil {
		t.Fatal(err)
	}
	if len(hello) != 1 || hello[0].Type != "hello" {
		t.Fatalf("unexpected handshake: %+v", hello)
	}
	var readDone chan error
	mode := os.Getenv("BLOCKTERM_HEARTBEAT_SMOKE")
	if mode == "timeout" {
		_ = ws.SetReadDeadline(time.Now().Add(70 * time.Second))
		ws.SetPingHandler(func(string) error { return nil })
		started := time.Now()
		_, _, err := ws.ReadMessage()
		if err == nil {
			t.Fatal("unresponsive connection remained open")
		}
		if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
			t.Fatalf("client timed out instead of server closing: %v", err)
		}
		if time.Since(started) < 55*time.Second {
			t.Fatalf("connection closed before the liveness interval: %v", err)
		}
		t.Logf("unresponsive connection closed after %s", time.Since(started))
		return
	}
	if mode == "1" || mode == "renew" {
		wait, count := 25*time.Second, 1
		if mode == "renew" {
			wait, count = 90*time.Second, 4
		}
		_ = ws.SetReadDeadline(time.Now().Add(wait))
		pong := make(chan struct{}, count)
		ws.SetPingHandler(func(data string) error {
			err := ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
			if err == nil {
				select {
				case pong <- struct{}{}:
				default:
				}
			}
			return err
		})
		readDone = make(chan error, 1)
		go func() { _, _, err := ws.ReadMessage(); readDone <- err }()
		started := time.Now()
		for i := 0; i < count; i++ {
			select {
			case <-pong:
			case err := <-readDone:
				t.Fatalf("connection ended before idle ping: %v", err)
			case <-time.After(wait):
				t.Fatal("idle connection did not receive a ping")
			}
		}
		t.Logf("completed %d ping/pong exchanges over %s", count, time.Since(started))
	}
	for i := 0; i < 3; i++ {
		if err := ws.WriteJSON(map[string]uint64{"ack": session.Seq}); err != nil {
			t.Fatal(err)
		}
	}
	if readDone != nil {
		err = <-readDone
	} else {
		_, _, err = ws.ReadMessage()
	}
	if err == nil {
		t.Fatal("unsolicited ACK overflow did not close the connection")
	}
	if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
		t.Fatalf("connection timed out instead of closing: %v", err)
	}
}
