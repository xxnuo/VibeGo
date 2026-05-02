package terminal

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type observingNetConn struct {
	net.Conn
	watchWrite atomic.Bool
	writeOnce  sync.Once
	writeStart chan struct{}
}

func (c *observingNetConn) Write(p []byte) (int, error) {
	if c.watchWrite.Load() {
		c.writeOnce.Do(func() { close(c.writeStart) })
	}
	return c.Conn.Write(p)
}

func newPipeWebsocketClient(t *testing.T) (*websocket.Conn, *observingNetConn, net.Conn) {
	t.Helper()
	clientRaw, serverRaw := net.Pipe()
	clientConn := &observingNetConn{Conn: clientRaw, writeStart: make(chan struct{})}
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		reader := bufio.NewReader(serverRaw)
		var key string
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			if line == "" {
				break
			}
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[0]), "Sec-WebSocket-Key") {
				key = strings.TrimSpace(parts[1])
			}
		}
		if key == "" {
			return
		}
		sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		response := fmt.Sprintf("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
		if _, err := serverRaw.Write([]byte(response)); err != nil {
			return
		}
		// Keep the peer effectively stalled. Reading one byte is enough to let
		// the frame writer start, but the remaining payload stays blocked until
		// the client closes the socket.
		one := make([]byte, 1)
		_, _ = serverRaw.Read(one)
	}()

	u, err := url.Parse("ws://pipe.test/")
	if err != nil {
		clientRaw.Close()
		serverRaw.Close()
		t.Fatalf("parse websocket URL: %v", err)
	}
	wsConn, _, err := websocket.NewClient(clientConn, u, nil, 1024, 1024)
	if err != nil {
		clientRaw.Close()
		serverRaw.Close()
		<-serverDone
		t.Fatalf("create websocket client: %v", err)
	}
	return wsConn, clientConn, serverRaw
}

func TestWSMaster_ReadWrite(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("failed to upgrade: %v", err)
			return
		}
		defer conn.Close()

		master := newWSMaster(conn, 5*time.Second)

		n, err := master.Write([]byte("hello"))
		if err != nil {
			t.Errorf("Write failed: %v", err)
			return
		}
		if n != 5 {
			t.Errorf("expected to write 5 bytes, wrote %d", n)
		}

		data, err := master.ReadMessage()
		if err != nil {
			t.Errorf("Read failed: %v", err)
			return
		}
		if string(data) != "world" {
			t.Errorf("expected 'world', got %s", string(data))
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial: %v", err)
	}
	defer conn.Close()

	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}
	if string(msg) != "hello" {
		t.Errorf("expected 'hello', got %s", string(msg))
	}

	err = conn.WriteMessage(websocket.BinaryMessage, []byte("world"))
	if err != nil {
		t.Fatalf("failed to write: %v", err)
	}
}

func TestWSMaster_ConcurrentWrite(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		master := newWSMaster(conn, 5*time.Second)

		done := make(chan bool, 10)
		for i := 0; i < 10; i++ {
			go func(id int) {
				master.Write([]byte("test"))
				done <- true
			}(i)
		}

		for i := 0; i < 10; i++ {
			<-done
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial: %v", err)
	}
	defer conn.Close()

	count := 0
	for i := 0; i < 10; i++ {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("failed to read message %d: %v", i, err)
			break
		}
		if string(msg) == "test" {
			count++
		}
	}

	if count != 10 {
		t.Errorf("expected 10 messages, got %d", count)
	}
}

func TestWSMasterCloseInterruptsBlockedWrite(t *testing.T) {
	conn, observingConn, serverConn := newPipeWebsocketClient(t)
	defer serverConn.Close()

	master := newWSMaster(conn, 0)
	defer master.Close()
	observingConn.watchWrite.Store(true)
	writeDone := make(chan error, 1)
	go func() {
		_, err := master.Write(make([]byte, 4<<20))
		writeDone <- err
	}()

	select {
	case <-observingConn.writeStart:
	case <-time.After(time.Second):
		t.Fatal("write did not reach the network")
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- master.Close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close blocked behind an in-flight write")
	}

	select {
	case err := <-writeDone:
		if err == nil {
			t.Fatal("blocked write unexpectedly succeeded after Close")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked write was not interrupted by Close")
	}
	_ = observingConn.Close()
}
