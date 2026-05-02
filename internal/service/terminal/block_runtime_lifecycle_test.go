package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

type blockRuntimeLifecycleTestRuntime struct {
	mu       sync.Mutex
	chunks   [][]byte
	closeErr error
	exitCode int
	closed   atomic.Int64
}

func (r *blockRuntimeLifecycleTestRuntime) Type() string { return RuntimeTypeLocal }

func (r *blockRuntimeLifecycleTestRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}

func (r *blockRuntimeLifecycleTestRuntime) Read(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[0])
	if n == len(r.chunks[0]) {
		r.chunks = r.chunks[1:]
	} else {
		r.chunks[0] = r.chunks[0][n:]
	}
	return n, nil
}

func (r *blockRuntimeLifecycleTestRuntime) Write(p []byte) (int, error) { return len(p), nil }

func (r *blockRuntimeLifecycleTestRuntime) Resize(int, int) error { return nil }

func (r *blockRuntimeLifecycleTestRuntime) Close() error {
	r.closed.Add(1)
	return r.closeErr
}

func (r *blockRuntimeLifecycleTestRuntime) ExitCode() int { return r.exitCode }

func (r *blockRuntimeLifecycleTestRuntime) Wait(context.Context) error { return nil }

type blockRuntimeCaptureMaster struct {
	mu     sync.Mutex
	writes [][]byte
	closed atomic.Int64
}

func (m *blockRuntimeCaptureMaster) ReadMessage() ([]byte, error) { return nil, ErrMasterClosed }

func (m *blockRuntimeCaptureMaster) Write(p []byte) (int, error) {
	m.mu.Lock()
	m.writes = append(m.writes, append([]byte(nil), p...))
	m.mu.Unlock()
	return len(p), nil
}

func (m *blockRuntimeCaptureMaster) Ping() error { return nil }

func (m *blockRuntimeCaptureMaster) Close() error {
	m.closed.Add(1)
	return nil
}

func (m *blockRuntimeCaptureMaster) messages() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([][]byte, len(m.writes))
	for i, data := range m.writes {
		result[i] = append([]byte(nil), data...)
	}
	return result
}

type blockRuntimeGatedMaster struct {
	mu           sync.Mutex
	writes       [][]byte
	writeStarted chan struct{}
	allowWrite   chan struct{}
	closed       atomic.Int64
}

func newBlockRuntimeGatedMaster() *blockRuntimeGatedMaster {
	return &blockRuntimeGatedMaster{
		writeStarted: make(chan struct{}),
		allowWrite:   make(chan struct{}),
	}
}

func (m *blockRuntimeGatedMaster) ReadMessage() ([]byte, error) { return nil, ErrMasterClosed }

func (m *blockRuntimeGatedMaster) Write(p []byte) (int, error) {
	m.writeStarted <- struct{}{}
	<-m.allowWrite
	if m.closed.Load() != 0 {
		return 0, ErrMasterClosed
	}
	m.mu.Lock()
	m.writes = append(m.writes, append([]byte(nil), p...))
	m.mu.Unlock()
	return len(p), nil
}

func (m *blockRuntimeGatedMaster) Ping() error { return nil }

func (m *blockRuntimeGatedMaster) Close() error {
	m.closed.Add(1)
	return nil
}

func (m *blockRuntimeGatedMaster) messages() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([][]byte, len(m.writes))
	for i, data := range m.writes {
		result[i] = append([]byte(nil), data...)
	}
	return result
}

type blockRuntimeWaitControlledRuntime struct {
	waitStarted chan struct{}
	allowWait   chan struct{}
	exitCode    atomic.Int64
}

func newBlockRuntimeWaitControlledRuntime() *blockRuntimeWaitControlledRuntime {
	return &blockRuntimeWaitControlledRuntime{
		waitStarted: make(chan struct{}),
		allowWait:   make(chan struct{}),
	}
}

func (r *blockRuntimeWaitControlledRuntime) Type() string { return RuntimeTypeLocal }

func (r *blockRuntimeWaitControlledRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}

func (r *blockRuntimeWaitControlledRuntime) Read([]byte) (int, error) { return 0, io.EOF }

func (r *blockRuntimeWaitControlledRuntime) Write(p []byte) (int, error) { return len(p), nil }

func (r *blockRuntimeWaitControlledRuntime) Resize(int, int) error { return nil }

func (r *blockRuntimeWaitControlledRuntime) Close() error { return nil }

func (r *blockRuntimeWaitControlledRuntime) ExitCode() int { return int(r.exitCode.Load()) }

func (r *blockRuntimeWaitControlledRuntime) Wait(context.Context) error {
	close(r.waitStarted)
	<-r.allowWait
	r.exitCode.Store(23)
	return nil
}

func newBlockRuntimeLifecycleOwner(manager *Manager, terminalID, blockID, token string, runtime TerminalRuntime) *activeBlockRuntime {
	return &activeBlockRuntime{
		manager: manager,
		key:     BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID},
		runtime: runtime,
		info: BlockRuntimeInfo{
			TerminalID:  terminalID,
			BlockID:     blockID,
			BlockToken:  token,
			RuntimeType: RuntimeTypeLocal,
			Cols:        80,
			Rows:        24,
			Status:      model.StatusRunning,
		},
		buffer:     newHistoryBuffer(1024),
		bufferSize: 1024,
		encoder:    base64.StdEncoding,
		readDone:   closedBlockRuntimeChannel(),
		done:       make(chan struct{}),
		closeDone:  make(chan struct{}),
	}
}

func closedBlockRuntimeChannel() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

func TestCloseBlockRuntimesForTerminalDetachesAndClosesChildren(t *testing.T) {
	manager := &Manager{blockTermRoutes: NewBlockTermRuntimeRegistry(), blockRuntimes: make(map[BlockTermRuntimeRouteKey]*activeBlockRuntime)}
	parent := &blockRuntimeLifecycleTestRuntime{}
	childA := &blockRuntimeLifecycleTestRuntime{}
	childB := &blockRuntimeLifecycleTestRuntime{}
	const terminalID = "parent-close-block-runtime"
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	for _, entry := range []struct {
		id      string
		runtime *blockRuntimeLifecycleTestRuntime
	}{
		{id: "block-a", runtime: childA},
		{id: "block-b", runtime: childB},
	} {
		handle, err := manager.blockTermRoutes.RegisterBlock(terminalID, entry.id, token, entry.runtime)
		if err != nil {
			t.Fatalf("register %s: %v", entry.id, err)
		}
		owner := newBlockRuntimeLifecycleOwner(manager, terminalID, entry.id, token, entry.runtime)
		owner.routeHandle = handle
		owner.status.Store(model.StatusRunning)
		manager.blockRuntimes[owner.key] = owner
	}
	parentHandle, err := manager.blockTermRoutes.RegisterSession(terminalID, parent)
	if err != nil {
		t.Fatalf("register parent route: %v", err)
	}

	if err := manager.CloseBlockRuntimesForTerminal(terminalID); err != nil {
		t.Fatalf("close child runtimes: %v", err)
	}
	if childA.closed.Load() != 1 || childB.closed.Load() != 1 {
		t.Fatalf("child close counts = %d/%d, want 1/1", childA.closed.Load(), childB.closed.Load())
	}
	if parent.closed.Load() != 0 {
		t.Fatal("parent runtime was closed by child cleanup")
	}
	if got := manager.blockTermRoutes.ResolveByKey(terminalID, "block-a", token).Status; got != BlockTermRuntimeRouteStatusUnknownTagged {
		t.Fatalf("block-a route status = %q, want unknown", got)
	}
	if got := manager.blockTermRoutes.ResolveByKey(terminalID, "block-b", token).Status; got != BlockTermRuntimeRouteStatusUnknownTagged {
		t.Fatalf("block-b route status = %q, want unknown", got)
	}
	if got := manager.blockTermRoutes.Resolve(BlockTermRuntimeRouteRequest{TerminalID: terminalID}); got.Status != BlockTermRuntimeRouteStatusSession || got.Route.Runtime != parent {
		t.Fatalf("parent route after child cleanup = %+v", got)
	}
	if _, ok := manager.blockRuntimes[BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: "block-a"}]; ok {
		t.Fatal("block-a owner remained in manager map")
	}
	if _, ok := manager.blockTermRoutes.Remove(parentHandle); !ok {
		t.Fatal("parent route could not be removed")
	}
}

func TestBlockRuntimeReadLoopBroadcastsOutputAndExit(t *testing.T) {
	const terminalID = "block-output-terminal"
	const blockID = "block-output"
	const token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	runtime := &blockRuntimeLifecycleTestRuntime{
		chunks:   [][]byte{[]byte("a"), []byte("bc")},
		exitCode: 17,
	}
	manager := &Manager{blockTermRoutes: NewBlockTermRuntimeRegistry()}
	owner := newBlockRuntimeLifecycleOwner(manager, terminalID, blockID, token, runtime)
	owner.readDone = make(chan struct{})
	owner.status.Store(model.StatusRunning)
	capture := &blockRuntimeCaptureMaster{}
	owner.connections.Store("capture", &terminalConnection{ID: "capture", Master: capture, Ctx: context.Background()})

	readLoopDone := make(chan struct{})
	go func() {
		manager.blockRuntimeReadLoop(owner)
		close(readLoopDone)
	}()
	monitorDone := make(chan struct{})
	go func() {
		manager.blockRuntimeMonitor(owner)
		close(monitorDone)
	}()
	select {
	case <-readLoopDone:
	case <-time.After(time.Second):
		t.Fatal("block runtime read loop did not finish")
	}
	select {
	case <-monitorDone:
	case <-time.After(time.Second):
		t.Fatal("block runtime monitor did not finish")
	}

	messages := capture.messages()
	if len(messages) != 4 {
		t.Fatalf("message count = %d, want output/output/state/pty_exited", len(messages))
	}
	var decoded []WSMessage
	for i, raw := range messages {
		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("message %d decode: %v", i, err)
		}
		decoded = append(decoded, msg)
		if msg.RouteMode != RouteModeBlock || msg.BlockID != blockID || msg.BlockToken != token {
			t.Fatalf("message %d route = %+v", i, msg)
		}
	}
	if decoded[0].Type != MsgTypeOutput || decoded[0].Cursor != 1 {
		t.Fatalf("first output = %+v", decoded[0])
	}
	if decoded[1].Type != MsgTypeOutput || decoded[1].Cursor != 3 {
		t.Fatalf("second output = %+v", decoded[1])
	}
	if decoded[2].Type != MsgTypeState || decoded[2].Status != model.StatusExited || decoded[2].Cursor != 3 || decoded[2].ExitCode == nil || *decoded[2].ExitCode != 17 || !decoded[2].Readonly {
		t.Fatalf("exit state = %+v", decoded[2])
	}
	if decoded[3].Type != MsgTypePtyExited || decoded[3].Cursor != 3 || decoded[3].ExitCode == nil || *decoded[3].ExitCode != 17 {
		t.Fatalf("exit notification = %+v", decoded[3])
	}
	if got := string(owner.buffer.Read()); got != "abc" {
		t.Fatalf("buffer = %q, want abc", got)
	}
	if owner.status.Load().(string) != model.StatusExited {
		t.Fatalf("status = %q, want exited", owner.status.Load())
	}
}

func TestBlockRuntimeEOFWaitsForRuntimeWaitBeforePublishingExit(t *testing.T) {
	const terminalID = "block-wait-terminal"
	const blockID = "block-wait"
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	runtime := newBlockRuntimeWaitControlledRuntime()
	manager := &Manager{blockTermRoutes: NewBlockTermRuntimeRegistry()}
	owner := newBlockRuntimeLifecycleOwner(manager, terminalID, blockID, token, runtime)
	owner.readDone = make(chan struct{})
	owner.status.Store(model.StatusRunning)
	capture := &blockRuntimeCaptureMaster{}
	owner.connections.Store("capture", &terminalConnection{ID: "capture", Master: capture, Ctx: context.Background()})

	go manager.blockRuntimeReadLoop(owner)
	monitorDone := make(chan struct{})
	go func() {
		manager.blockRuntimeMonitor(owner)
		close(monitorDone)
	}()

	select {
	case <-runtime.waitStarted:
	case <-time.After(time.Second):
		t.Fatal("runtime Wait did not start")
	}
	select {
	case <-owner.readDone:
	case <-time.After(time.Second):
		t.Fatal("block runtime reader did not reach EOF")
	}
	select {
	case <-owner.done:
		t.Fatal("EOF published exit before runtime Wait completed")
	default:
	}
	if status := owner.status.Load().(string); status != model.StatusRunning {
		t.Fatalf("status before Wait completion = %q, want running", status)
	}
	if messages := capture.messages(); len(messages) != 0 {
		t.Fatalf("messages before Wait completion = %d, want 0", len(messages))
	}

	close(runtime.allowWait)
	select {
	case <-monitorDone:
	case <-time.After(time.Second):
		t.Fatal("block runtime did not publish exit after Wait completed")
	}
	if got := owner.exitCode.Load(); got != 23 {
		t.Fatalf("exit code = %d, want 23", got)
	}
	if messages := capture.messages(); len(messages) != 2 {
		t.Fatalf("final message count = %d, want state/pty_exited", len(messages))
	}
}

func TestCloseBlockRuntimeWaitsForFinalFramesBeforeClosingConnection(t *testing.T) {
	const terminalID = "block-final-write-terminal"
	const blockID = "block-final-write"
	const token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	runtime := &blockRuntimeLifecycleTestRuntime{}
	manager := &Manager{blockTermRoutes: NewBlockTermRuntimeRegistry()}
	owner := newBlockRuntimeLifecycleOwner(manager, terminalID, blockID, token, runtime)
	owner.status.Store(model.StatusRunning)
	master := newBlockRuntimeGatedMaster()
	ctx, cancel := context.WithCancel(context.Background())
	conn := &terminalConnection{
		ID:     "gated",
		Master: master,
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, 4),
	}
	owner.connections.Store(conn.ID, conn)

	writerDone := make(chan error, 1)
	go func() { writerDone <- manager.writeConnectionLoop(conn) }()
	closeDone := make(chan error, 1)
	go func() { closeDone <- manager.closeBlockRuntimeOwner(owner, model.StatusClosed) }()

	for frame := 0; frame < 2; frame++ {
		select {
		case <-master.writeStarted:
		case <-time.After(time.Second):
			t.Fatalf("final frame %d did not reach websocket writer", frame)
		}
		if got := master.closed.Load(); got != 0 {
			t.Fatalf("connection closed before final frame %d completed: %d", frame, got)
		}
		select {
		case err := <-closeDone:
			t.Fatalf("runtime close returned before final frame %d completed: %v", frame, err)
		default:
		}
		master.allowWrite <- struct{}{}
	}

	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("close block runtime: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runtime close did not finish after final frames were written")
	}
	if got := master.closed.Load(); got != 1 {
		t.Fatalf("connection close count = %d, want 1", got)
	}
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("websocket writer did not stop after connection close")
	}

	messages := master.messages()
	if len(messages) != 2 {
		t.Fatalf("final message count = %d, want 2", len(messages))
	}
	var state, exited WSMessage
	if err := json.Unmarshal(messages[0], &state); err != nil {
		t.Fatalf("decode final state: %v", err)
	}
	if err := json.Unmarshal(messages[1], &exited); err != nil {
		t.Fatalf("decode final exit: %v", err)
	}
	if state.Type != MsgTypeState || state.Status != model.StatusClosed || !state.Readonly {
		t.Fatalf("final state = %+v", state)
	}
	if exited.Type != MsgTypePtyExited || exited.RouteMode != RouteModeBlock {
		t.Fatalf("final exit = %+v", exited)
	}
}

func TestCloseBlockRuntimesForTerminalClosesUnownedRegistryRoute(t *testing.T) {
	manager := &Manager{blockTermRoutes: NewBlockTermRuntimeRegistry(), blockRuntimes: make(map[BlockTermRuntimeRouteKey]*activeBlockRuntime)}
	runtime := &blockRuntimeLifecycleTestRuntime{}
	const terminalID = "unowned-block-parent"
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := manager.blockTermRoutes.RegisterBlock(terminalID, "unowned", token, runtime); err != nil {
		t.Fatalf("register unowned route: %v", err)
	}
	if err := manager.CloseBlockRuntimesForTerminal(terminalID); err != nil {
		t.Fatalf("close unowned route: %v", err)
	}
	if runtime.closed.Load() != 1 {
		t.Fatalf("unowned runtime close count = %d, want 1", runtime.closed.Load())
	}
}

func TestCloseBlockRuntimeReturnsCloseError(t *testing.T) {
	closeErr := errors.New("block close failed")
	runtime := &blockRuntimeLifecycleTestRuntime{closeErr: closeErr}
	manager := &Manager{blockTermRoutes: NewBlockTermRuntimeRegistry(), blockRuntimes: make(map[BlockTermRuntimeRouteKey]*activeBlockRuntime)}
	const terminalID = "close-error-parent"
	const blockID = "close-error-block"
	const token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	handle, err := manager.blockTermRoutes.RegisterBlock(terminalID, blockID, token, runtime)
	if err != nil {
		t.Fatalf("register route: %v", err)
	}
	owner := newBlockRuntimeLifecycleOwner(manager, terminalID, blockID, token, runtime)
	owner.routeHandle = handle
	manager.blockRuntimes[owner.key] = owner
	if err := manager.CloseBlockRuntime(terminalID, blockID, token); !errors.Is(err, closeErr) {
		t.Fatalf("close error = %v, want %v", err, closeErr)
	}
}

func TestCreateBlockRuntimeRejectsNilManager(t *testing.T) {
	var manager *Manager
	if err := manager.CloseBlockRuntimesForTerminal("nil-manager-terminal"); err != nil {
		t.Fatalf("CloseBlockRuntimesForTerminal error = %v, want nil", err)
	}
	info, err := manager.CreateBlockRuntime(BlockRuntimeCreateOptions{})
	if info != nil {
		t.Fatalf("runtime info = %+v, want nil", info)
	}
	if !errors.Is(err, ErrBlockRuntimeInvalid) {
		t.Fatalf("CreateBlockRuntime error = %v, want ErrBlockRuntimeInvalid", err)
	}
}
