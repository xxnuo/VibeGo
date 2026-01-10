package terminal

import (
	"sync"

	"github.com/gorilla/websocket"
)

type master interface {
	Read(p []byte) (n int, err error)
	Write(p []byte) (n int, err error)
}

type wsMaster struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func newWSMaster(conn *websocket.Conn) *wsMaster {
	return &wsMaster{conn: conn}
}

func (m *wsMaster) Read(p []byte) (int, error) {
	for {
		msgType, data, err := m.conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		if msgType == websocket.TextMessage || msgType == websocket.BinaryMessage {
			return copy(p, data), nil
		}
	}
}

func (m *wsMaster) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	err := m.conn.WriteMessage(websocket.TextMessage, p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}
