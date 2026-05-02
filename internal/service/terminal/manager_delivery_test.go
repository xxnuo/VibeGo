package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

type blockingDeliveryMaster struct {
	mu       sync.Mutex
	writes   [][]byte
	started  chan struct{}
	release  chan struct{}
	closed   chan struct{}
	startOne sync.Once
	closeOne sync.Once
}

type failingDeliveryMaster struct {
	mu        sync.Mutex
	writes    [][]byte
	failAt    int
	writeErr  error
	writeCall int
}

func (m *failingDeliveryMaster) ReadMessage() ([]byte, error) { return nil, ErrMasterClosed }

func (m *failingDeliveryMaster) Write(data []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writeCall++
	if m.writeCall == m.failAt {
		return 0, m.writeErr
	}
	m.writes = append(m.writes, append([]byte(nil), data...))
	return len(data), nil
}

func (m *failingDeliveryMaster) Ping() error  { return nil }
func (m *failingDeliveryMaster) Close() error { return nil }

func newBlockingDeliveryMaster() *blockingDeliveryMaster {
	return &blockingDeliveryMaster{
		started: make(chan struct{}),
		release: make(chan struct{}),
		closed:  make(chan struct{}),
	}
}

func (m *blockingDeliveryMaster) ReadMessage() ([]byte, error) { return nil, ErrMasterClosed }

func (m *blockingDeliveryMaster) Write(data []byte) (int, error) {
	m.startOne.Do(func() {
		close(m.started)
		select {
		case <-m.release:
		case <-m.closed:
		}
	})
	select {
	case <-m.closed:
		return 0, ErrMasterClosed
	default:
	}
	m.mu.Lock()
	m.writes = append(m.writes, append([]byte(nil), data...))
	m.mu.Unlock()
	return len(data), nil
}

func (m *blockingDeliveryMaster) Ping() error { return nil }

func (m *blockingDeliveryMaster) Close() error {
	m.closeOne.Do(func() { close(m.closed) })
	return nil
}

func (m *blockingDeliveryMaster) messages() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([][]byte, len(m.writes))
	for index, data := range m.writes {
		result[index] = append([]byte(nil), data...)
	}
	return result
}

func deliveryTestTerminal() *activeTerminal {
	at := &activeTerminal{
		ID:            "terminal-1",
		Done:          make(chan struct{}),
		historyBuffer: newHistoryBuffer(128),
		encoder:       base64.StdEncoding,
		Session: &model.TerminalSession{
			ID:     "terminal-1",
			Status: model.StatusRunning,
			Cols:   80,
			Rows:   24,
		},
	}
	at.status.Store(model.StatusRunning)
	_, _ = at.historyBuffer.Write([]byte("history"))
	return at
}

func deliveryMessageTypes(t *testing.T, messages [][]byte) []string {
	t.Helper()
	types := make([]string, len(messages))
	for index, raw := range messages {
		var message WSMessage
		if err := json.Unmarshal(raw, &message); err != nil {
			t.Fatalf("message %d is not JSON: %v", index, err)
		}
		types[index] = message.Type
	}
	return types
}

func waitForDeliveryMessages(t *testing.T, master *blockingDeliveryMaster, count int) [][]byte {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		messages := master.messages()
		if len(messages) >= count {
			return messages
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d delivery messages; got %d", count, len(master.messages()))
	return nil
}

func waitForMockMasterMessages(t *testing.T, master *mockMaster, count int) [][]byte {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		master.mu.Lock()
		messages := make([][]byte, len(master.writeData))
		for index, raw := range master.writeData {
			messages[index] = append([]byte(nil), raw...)
		}
		master.mu.Unlock()
		if len(messages) >= count {
			return messages
		}
		time.Sleep(time.Millisecond)
	}
	master.mu.Lock()
	countNow := len(master.writeData)
	master.mu.Unlock()
	t.Fatalf("timed out waiting for %d mock delivery messages; got %d", count, countNow)
	return nil
}

func TestManagerInitializeConnectionQueuesHandshakeBeforeLiveOutput(t *testing.T) {
	manager := &Manager{}
	at := deliveryTestTerminal()
	master := newBlockingDeliveryMaster()
	ctx, cancel := context.WithCancel(context.Background())
	conn := &terminalConnection{
		ID:     "connection-1",
		Master: master,
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, 8),
	}

	if err := manager.initializeConnection(at, conn, 0); err != nil {
		t.Fatalf("initializeConnection failed: %v", err)
	}
	if _, ok := at.Connections.Load(conn.ID); !ok {
		t.Fatal("connection was not registered after its handshake was queued")
	}
	if queued := len(conn.sendCh); queued != 3 {
		t.Fatalf("queued handshake messages = %d, want replay, replay_done, state", queued)
	}

	writerDone := make(chan error, 1)
	go func() {
		writerDone <- manager.writeConnectionLoop(conn)
	}()
	select {
	case <-master.started:
	case <-time.After(time.Second):
		t.Fatal("connection writer did not start the queued replay")
	}

	liveQueued := make(chan struct{})
	go func() {
		manager.broadcast(at, WSMessage{Type: MsgTypeOutput, Data: "live", Cursor: 11})
		close(liveQueued)
	}()
	select {
	case <-liveQueued:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("blocked handshake writer held deliveryMu")
	}
	if queued := len(conn.sendCh); queued != 3 {
		t.Fatalf("queued messages behind blocked replay = %d, want replay_done, state, live output", queued)
	}

	close(master.release)
	messages := waitForDeliveryMessages(t, master, 4)
	if len(messages) != 4 {
		t.Fatalf("expected replay, replay_done, state, and live output; got %d messages", len(messages))
	}
	wantTypes := []string{MsgTypeReplay, MsgTypeReplayDone, MsgTypeState, MsgTypeOutput}
	for index, messageType := range deliveryMessageTypes(t, messages) {
		if messageType != wantTypes[index] {
			t.Fatalf("message %d type = %q, want %q", index, messageType, wantTypes[index])
		}
	}
	cancel()
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("connection writer did not stop after cancellation")
	}
}

func TestWatchConnectionShutdownInterruptsBlockedWriter(t *testing.T) {
	manager := &Manager{}
	at := deliveryTestTerminal()
	master := newBlockingDeliveryMaster()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &terminalConnection{
		ID:     "connection-1",
		Master: master,
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, 8),
	}
	if err := manager.initializeConnection(at, conn, 0); err != nil {
		t.Fatalf("initializeConnection failed: %v", err)
	}
	watcherDone := make(chan struct{})
	go func() {
		watchConnectionShutdown(at.Done, ctx, master)
		close(watcherDone)
	}()
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- manager.writeConnectionLoop(conn)
	}()

	select {
	case <-master.started:
	case <-time.After(time.Second):
		t.Fatal("blocked writer did not start its replay write")
	}
	close(at.Done)

	select {
	case err := <-writerDone:
		if err == nil {
			t.Fatal("blocked writer unexpectedly succeeded after terminal close")
		}
	case <-time.After(time.Second):
		t.Fatal("terminal close did not interrupt the blocked writer")
	}
	select {
	case <-watcherDone:
	case <-time.After(time.Second):
		t.Fatal("connection shutdown watcher did not exit")
	}
	if _, ok := at.Connections.Load("connection-1"); !ok {
		t.Fatal("connection was not registered after its handshake was queued")
	}
}

func TestManagerBroadcastDoesNotBlockFastConnectionBehindSlowWriter(t *testing.T) {
	manager := &Manager{}
	at := deliveryTestTerminal()
	slowMaster := newBlockingDeliveryMaster()
	fastMaster := &mockMaster{}
	slowCtx, slowCancel := context.WithCancel(context.Background())
	fastCtx, fastCancel := context.WithCancel(context.Background())
	defer slowCancel()
	defer fastCancel()
	slowConn := &terminalConnection{
		ID:     "slow",
		Master: slowMaster,
		Ctx:    slowCtx,
		Cancel: slowCancel,
		sendCh: make(chan terminalOutboundMessage, 8),
	}
	fastConn := &terminalConnection{
		ID:     "fast",
		Master: fastMaster,
		Ctx:    fastCtx,
		Cancel: fastCancel,
		sendCh: make(chan terminalOutboundMessage, 8),
	}
	at.Connections.Store(slowConn.ID, slowConn)
	at.Connections.Store(fastConn.ID, fastConn)
	if err := manager.sendConnectionMessage(slowConn, WSMessage{Type: MsgTypeState}); err != nil {
		t.Fatalf("queue slow prelude: %v", err)
	}
	slowWriterDone := make(chan error, 1)
	fastWriterDone := make(chan error, 1)
	go func() { slowWriterDone <- manager.writeConnectionLoop(slowConn) }()
	go func() { fastWriterDone <- manager.writeConnectionLoop(fastConn) }()
	select {
	case <-slowMaster.started:
	case <-time.After(time.Second):
		t.Fatal("slow writer did not block")
	}

	broadcastDone := make(chan struct{})
	go func() {
		manager.broadcast(at, WSMessage{Type: MsgTypeOutput, Data: "live", Cursor: 12})
		close(broadcastDone)
	}()
	select {
	case <-broadcastDone:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("slow writer blocked broadcast enqueue")
	}
	fastMessages := waitForMockMasterMessages(t, fastMaster, 1)
	if types := deliveryMessageTypes(t, fastMessages); len(types) != 1 || types[0] != MsgTypeOutput {
		t.Fatalf("fast connection messages = %v, want output", types)
	}
	if messages := slowMaster.messages(); len(messages) != 0 {
		t.Fatalf("slow writer completed before release: %v", deliveryMessageTypes(t, messages))
	}

	close(slowMaster.release)
	if types := deliveryMessageTypes(t, waitForDeliveryMessages(t, slowMaster, 2)); len(types) != 2 || types[0] != MsgTypeState || types[1] != MsgTypeOutput {
		t.Fatalf("slow connection message order = %v", types)
	}
	slowCancel()
	fastCancel()
	select {
	case <-slowWriterDone:
	case <-time.After(time.Second):
		t.Fatal("slow writer did not stop")
	}
	select {
	case <-fastWriterDone:
	case <-time.After(time.Second):
		t.Fatal("fast writer did not stop")
	}
}

func TestSendConnectionMessageCancelsFullOutboundQueue(t *testing.T) {
	manager := &Manager{}
	ctx, cancel := context.WithCancel(context.Background())
	conn := &terminalConnection{
		Master: &mockMaster{},
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, 1),
	}
	if err := manager.sendConnectionMessage(conn, WSMessage{Type: MsgTypeState}); err != nil {
		t.Fatalf("fill outbound queue: %v", err)
	}
	if err := manager.sendConnectionMessage(conn, WSMessage{Type: MsgTypeOutput}); err != ErrOutboundQueueFull {
		t.Fatalf("full outbound queue error = %v, want %v", err, ErrOutboundQueueFull)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("full outbound queue did not cancel the connection")
	}
}

func TestSendHistoryOnlyHandshakeStopsAtFirstWriteError(t *testing.T) {
	writeErr := errors.New("history handshake write failed")
	master := &failingDeliveryMaster{failAt: 2, writeErr: writeErr}
	err := (&Manager{}).sendHistoryOnlyHandshake(master, model.TerminalSession{
		Status: model.StatusExited,
	}, &TerminalSnapshot{Data: []byte("history"), Cursor: 7})
	if !errors.Is(err, writeErr) {
		t.Fatalf("history handshake error = %v, want %v", err, writeErr)
	}
	master.mu.Lock()
	defer master.mu.Unlock()
	if master.writeCall != 2 {
		t.Fatalf("history handshake write calls = %d, want 2", master.writeCall)
	}
	if types := deliveryMessageTypes(t, master.writes); len(types) != 1 || types[0] != MsgTypeReplay {
		t.Fatalf("history handshake messages before failure = %v, want replay only", types)
	}
}

func TestSendHistoryOnlyHandshakeOmitsLiveCompletionCapability(t *testing.T) {
	master := &failingDeliveryMaster{}
	err := (&Manager{}).sendHistoryOnlyHandshake(master, model.TerminalSession{
		Status:      model.StatusExited,
		RuntimeType: RuntimeTypeSSH,
	}, nil)
	if err != nil {
		t.Fatalf("history handshake failed: %v", err)
	}
	master.mu.Lock()
	messages := append([][]byte(nil), master.writes...)
	master.mu.Unlock()
	if types := deliveryMessageTypes(t, messages); len(types) != 3 ||
		types[0] != MsgTypeReplayDone || types[1] != MsgTypeState || types[2] != MsgTypePtyExited {
		t.Fatalf("history handshake messages = %v, want replay_done, state, pty_exited", types)
	}
	var state WSMessage
	if err := json.Unmarshal(messages[1], &state); err != nil {
		t.Fatalf("decode history state: %v", err)
	}
	if state.Capabilities.Completion {
		t.Fatal("history state advertised unavailable SSH completion capability")
	}
}
