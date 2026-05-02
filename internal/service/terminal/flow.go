package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
)

const flowWindow = 512 * 1024
const flowChunk = 32 * 1024

type terminalFlow struct {
	mu     sync.Mutex
	stream string
	sent   uint64
	ack    uint64
	wake   chan struct{}
}

func (f *terminalFlow) signal() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}
func (f *terminalFlow) acknowledge(stream string, cursor uint64) {
	f.mu.Lock()
	if stream == f.stream && cursor > f.ack && cursor <= f.sent {
		f.ack = cursor
	}
	f.mu.Unlock()
	f.signal()
}

func (m *Manager) attachFlow(id string, socket *websocket.Conn, opts AttachOptions) (*Connection, error) {
	if !m.reserveConnectionSlot() {
		return nil, ErrMaxConnectionsReached
	}
	at, live := m.getActive(id)
	if !live {
		snapshot, err := m.loadSnapshot(id)
		if err != nil || snapshot == nil {
			m.activeConns.Add(-1)
			return nil, ErrTerminalNotFound
		}
		var session model.TerminalSession
		if err := m.db.First(&session, "id = ?", id).Error; err != nil {
			m.activeConns.Add(-1)
			return nil, err
		}
		at = &activeTerminal{ID: id, Session: &session, Done: make(chan struct{}), readDone: make(chan struct{}), historyBuffer: newHistoryBuffer(m.historyBufferSize), encoder: base64.StdEncoding, capabilities: TerminalCapabilities{Resume: true, Snapshot: true, ShellIntegration: session.ShellIntegration}}
		at.status.Store(session.Status)
		at.historyBuffer.Restore(snapshot.Data, snapshot.Cursor)
		close(at.readDone)
	}
	m.configureWSConn(socket)
	ctx, cancel := context.WithCancel(context.Background())
	tc := &terminalConnection{ID: uuid.NewString(), Master: newWSMaster(socket, m.wsWriteTimeout), Ctx: ctx, Cancel: cancel, sendCh: make(chan terminalOutboundMessage, terminalOutboundQueueSize), flow: &terminalFlow{wake: make(chan struct{}, 1)}}
	done := make(chan struct{})
	at.deliveryMu.Lock()
	// An attach can race retirement. The old instance remains readable and is
	// closed by its retirement deadline; a reconnect uses the durable snapshot.
	at.Connections.Store(tc.ID, tc)
	at.deliveryMu.Unlock()
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			cancel()
			_ = tc.Master.Close()
			at.Connections.Delete(tc.ID)
			m.activeConns.Add(-1)
			close(done)
		})
	}
	go func() { defer cleanup(); _ = m.readClientLoop(at, tc) }()
	go func() { defer cleanup(); _ = m.writeFlow(at, tc, opts.Cursor) }()
	go func() {
		select {
		case <-at.Done:
			cleanup()
		case <-ctx.Done():
		}
	}()
	go func() {
		if m.pingLoop(ctx, tc) != nil {
			cleanup()
		}
	}()
	return &Connection{Done: done}, nil
}

func (m *Manager) writeFlow(at *activeTerminal, conn *terminalConnection, cursor uint64) error {
	f := conn.flow
	var snapshot []byte
	replaying := true
	reset := false
	reason := InputRejectedReason("")
	prepare := func() {
		snapshot, reset, cursor = func() ([]byte, bool, uint64) {
			data, ok, end := at.historyBuffer.ReadFrom(cursor)
			if ok {
				return data, false, cursor
			}
			data = at.historyBuffer.Read()
			_, end = at.historyBuffer.CursorRange()
			return data, true, end - uint64(len(data))
		}()
		f.mu.Lock()
		f.stream, f.sent, f.ack = uuid.NewString(), cursor, cursor
		f.mu.Unlock()
		replaying = true
	}
	// Snapshot and cursor must be captured under the same history lock as writes.
	at.historyMu.RLock()
	prepare()
	at.historyMu.RUnlock()
	sendStart := func() error {
		return m.sendMessage(conn.Master, WSMessage{Type: MsgTypeReplay, StreamID: f.stream, Flow: "ack-v1", Cursor: cursor, Reset: reset, Reason: reason})
	}
	if err := sendStart(); err != nil {
		return err
	}
	deliverControl := func(message terminalOutboundMessage) error {
		var msg WSMessage
		if err := json.Unmarshal(message.data, &msg); err != nil {
			completeTerminalOutboundMessage(message, err)
			return err
		}
		// The exit marker is emitted below only after all output has been consumed.
		if msg.Type == MsgTypePtyExited {
			completeTerminalOutboundMessage(message, nil)
			return nil
		}
		_, err := conn.Master.Write(message.data)
		completeTerminalOutboundMessage(message, err)
		return err
	}
	defer failPendingTerminalOutboundMessages(conn, ErrMasterClosed)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-conn.Ctx.Done():
			return conn.Ctx.Err()
		default:
		}
		select {
		case message := <-conn.sendCh:
			if err := deliverControl(message); err != nil {
				return err
			}
		default:
		}
		f.mu.Lock()
		available := flowWindow - int(f.sent-f.ack)
		drained := f.sent == f.ack
		f.mu.Unlock()
		if replaying && len(snapshot) == 0 {
			replaying = false
			snapshot = nil
			if err := m.sendMessage(conn.Master, WSMessage{Type: MsgTypeReplayDone, StreamID: f.stream}); err != nil {
				return err
			}
			if err := m.sendTerminalState(at, conn); err != nil {
				return err
			}
			continue
		}
		var data []byte
		end := cursor
		if available > 0 {
			size := min(flowChunk, available)
			if replaying {
				size = min(size, len(snapshot))
				data = snapshot[:size]
				snapshot = snapshot[size:]
				end = cursor + uint64(size)
			} else {
				var ok bool
				data, ok, end = at.historyBuffer.ReadChunk(cursor, size)
				if !ok && drained {
					reason = "history_expired"
					at.historyMu.RLock()
					prepare()
					at.historyMu.RUnlock()
					if err := sendStart(); err != nil {
						return err
					}
					continue
				}
			}
		}
		if len(data) > 0 {
			kind := MsgTypeOutput
			if replaying {
				kind = MsgTypeReplay
			}
			f.mu.Lock()
			f.sent = end
			f.mu.Unlock()
			if err := m.sendMessage(conn.Master, WSMessage{Type: kind, Data: base64.StdEncoding.EncodeToString(data), Cursor: end, StreamID: f.stream}); err != nil {
				return err
			}
			cursor = end
			continue
		}
		_, tail := at.historyBuffer.CursorRange()
		if !replaying && drained && cursor == tail && at.status.Load().(string) != model.StatusRunning {
			select {
			case <-at.readDone:
				return m.sendMessage(conn.Master, WSMessage{Type: MsgTypePtyExited, StreamID: f.stream})
			default:
			}
		}
		select {
		case <-conn.Ctx.Done():
			return conn.Ctx.Err()
		case <-f.wake:
		case <-ticker.C:
		case message := <-conn.sendCh:
			if err := deliverControl(message); err != nil {
				return err
			}
		}
	}
}
