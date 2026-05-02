package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type blockTermInputRuntime struct {
	mu              sync.Mutex
	writes          [][]byte
	resizes         [][2]int
	writeErr        error
	partialWriteLen int
	maxWriteLen     int
}

type gatedBlockTermInputRuntime struct {
	blockTermInputRuntime
	started     chan struct{}
	release     chan struct{}
	startedOnce sync.Once
}

type closeReleasedBlockTermRuntime struct {
	blockTermInputRuntime
	readStarted  chan struct{}
	writeStarted chan struct{}
	closed       chan struct{}
	readOnce     sync.Once
	writeOnce    sync.Once
	closeOnce    sync.Once
}

func newGatedBlockTermInputRuntime() *gatedBlockTermInputRuntime {
	return &gatedBlockTermInputRuntime{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func newCloseReleasedBlockTermRuntime() *closeReleasedBlockTermRuntime {
	return &closeReleasedBlockTermRuntime{
		readStarted:  make(chan struct{}),
		writeStarted: make(chan struct{}),
		closed:       make(chan struct{}),
	}
}

func (r *closeReleasedBlockTermRuntime) Read([]byte) (int, error) {
	r.readOnce.Do(func() { close(r.readStarted) })
	<-r.closed
	return 0, io.EOF
}

func (r *closeReleasedBlockTermRuntime) Write(data []byte) (int, error) {
	r.writeOnce.Do(func() { close(r.writeStarted) })
	<-r.closed
	return r.blockTermInputRuntime.Write(data)
}

func (r *closeReleasedBlockTermRuntime) Close() error {
	r.closeOnce.Do(func() { close(r.closed) })
	return nil
}

func (r *gatedBlockTermInputRuntime) Write(data []byte) (int, error) {
	r.startedOnce.Do(func() { close(r.started) })
	<-r.release
	return r.blockTermInputRuntime.Write(data)
}

type gatedBlockTermMaster struct {
	mu        sync.Mutex
	readData  []byte
	writes    [][]byte
	started   chan struct{}
	release   chan struct{}
	startOnce sync.Once
}

func newGatedBlockTermMaster(readData []byte) *gatedBlockTermMaster {
	return &gatedBlockTermMaster{
		readData: append([]byte(nil), readData...),
		started:  make(chan struct{}),
		release:  make(chan struct{}),
	}
}

func (m *gatedBlockTermMaster) ReadMessage() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.readData) == 0 {
		return nil, ErrMasterClosed
	}
	data := append([]byte(nil), m.readData...)
	m.readData = nil
	return data, nil
}

func (m *gatedBlockTermMaster) Write(data []byte) (int, error) {
	m.startOnce.Do(func() {
		close(m.started)
		<-m.release
	})
	m.mu.Lock()
	m.writes = append(m.writes, append([]byte(nil), data...))
	m.mu.Unlock()
	return len(data), nil
}

func (m *gatedBlockTermMaster) Ping() error  { return nil }
func (m *gatedBlockTermMaster) Close() error { return nil }

func (m *gatedBlockTermMaster) messages() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	messages := make([][]byte, len(m.writes))
	for index, data := range m.writes {
		messages[index] = append([]byte(nil), data...)
	}
	return messages
}

func (r *blockTermInputRuntime) Type() string                       { return RuntimeTypeLocal }
func (r *blockTermInputRuntime) Capabilities() TerminalCapabilities { return TerminalCapabilities{} }
func (r *blockTermInputRuntime) Read([]byte) (int, error)           { return 0, io.EOF }
func (r *blockTermInputRuntime) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(data)
	if r.writeErr != nil {
		n = r.partialWriteLen
		if n > len(data) {
			n = len(data)
		}
	} else if r.maxWriteLen > 0 && n > r.maxWriteLen {
		n = r.maxWriteLen
	}
	if n > 0 {
		r.writes = append(r.writes, append([]byte(nil), data[:n]...))
	}
	return n, r.writeErr
}
func (r *blockTermInputRuntime) Resize(cols, rows int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resizes = append(r.resizes, [2]int{cols, rows})
	return nil
}
func (r *blockTermInputRuntime) Close() error               { return nil }
func (r *blockTermInputRuntime) ExitCode() int              { return 0 }
func (r *blockTermInputRuntime) Wait(context.Context) error { return nil }

func (r *blockTermInputRuntime) written() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([][]byte, len(r.writes))
	for index, data := range r.writes {
		result[index] = append([]byte(nil), data...)
	}
	return result
}

func (r *blockTermInputRuntime) resized() [][2]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([][2]int, len(r.resizes))
	copy(result, r.resizes)
	return result
}

func runBlockTermInputMessage(t *testing.T, manager *Manager, at *activeTerminal, blockID, input string) error {
	t.Helper()
	err, _ := runBlockTermClientMessage(t, manager, at, blockTermInputMessage(blockID, input))
	return err
}

func blockTermInputMessage(blockID, input string) WSMessage {
	msg := WSMessage{
		Type:    MsgTypeInput,
		Data:    base64.StdEncoding.EncodeToString([]byte(input)),
		BlockID: blockID,
	}
	if blockID != "" {
		msg.BlockToken = blockTermTestToken
	}
	return msg
}

func runBlockTermClientMessage(t *testing.T, manager *Manager, at *activeTerminal, msg WSMessage) (error, *mockMaster) {
	t.Helper()
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal terminal client message: %v", err)
	}
	master := &mockMaster{readData: raw}
	err = manager.readClientLoop(at, &terminalConnection{
		Master: master,
		Ctx:    context.Background(),
	})
	return err, master
}

func blockTermInputRejections(t *testing.T, master *mockMaster) []WSMessage {
	t.Helper()
	master.mu.Lock()
	defer master.mu.Unlock()
	rejections := make([]WSMessage, 0, len(master.writeData))
	for _, data := range master.writeData {
		var msg WSMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("decode server message: %v", err)
		}
		if msg.Type == MsgTypeInputRejected {
			rejections = append(rejections, msg)
		}
	}
	return rejections
}

func newBlockTermInputActive(terminalID string, runtime TerminalRuntime, recorder *blockTermOutputRecorder) *activeTerminal {
	at := &activeTerminal{
		ID:             terminalID,
		Runtime:        runtime,
		Session:        &model.TerminalSession{ID: terminalID, Status: model.StatusRunning},
		encoder:        base64.StdEncoding,
		outputRecorder: recorder,
	}
	at.status.Store(model.StatusRunning)
	return at
}

func TestManagerTaggedInputRejectsForgedFirstBlockTermStart(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "correlated-input-terminal"
	const blockID = "correlated-input-block"
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	if recorder == nil {
		t.Fatal("create output recorder")
	}
	runtime := &blockTermInputRuntime{}
	manager := &Manager{db: db}
	at := newBlockTermInputActive(terminalID, runtime, recorder)

	_ = runBlockTermInputMessage(t, manager, at, blockID, "wrapped command")
	if writes := runtime.written(); len(writes) != 1 || string(writes[0]) != "wrapped command" {
		t.Fatalf("runtime writes = %q, want one wrapped command", writes)
	}

	fakeStart := blockTermTestOSCStart("forged-block")
	fakeEnd := blockTermTestOSCEnd("forged-block")
	realStart := blockTermTestOSCStart(blockID)
	realEnd := blockTermTestOSCEnd(blockID)
	data := append(append(append(append(append(append([]byte{}, fakeStart...), []byte("forged")...), fakeEnd...), realStart...), []byte("owned")...), realEnd...)
	recorder.Write(data, 0)
	recorder.CloseInput()
	if err := recorder.Wait(); err != nil {
		t.Fatalf("wait for recorder: %v", err)
	}

	var segments []model.BlockTermOutputSegment
	if err := db.Order("start_cursor ASC").Find(&segments).Error; err != nil {
		t.Fatalf("load output segments: %v", err)
	}
	if len(segments) != 1 || segments[0].BlockID != blockID || string(segments[0].Data) != "owned" {
		t.Fatalf("output segments = %#v, want only correlated block output", segments)
	}
}

func TestManagerTaggedInputRequiresOwnedRunningCommand(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "input-owner-terminal"
	if err := db.Create([]model.BlockTermBlock{
		{ID: "cross-terminal", TerminalID: "other-terminal", LineNum: 0, Kind: "command", Status: "running"},
		{ID: "finished-local", TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "success"},
		{ID: "renderer-local", TerminalID: terminalID, LineNum: 1, Kind: "renderer", Status: "running"},
		{ID: "archived-local", TerminalID: terminalID, LineNum: 2, Kind: "command", Status: "running", Archived: true},
	}).Error; err != nil {
		t.Fatalf("create rejected blocks: %v", err)
	}
	runtime := &blockTermInputRuntime{}
	manager := &Manager{db: db}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	if recorder == nil {
		t.Fatal("create output recorder")
	}
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	at := newBlockTermInputActive(terminalID, runtime, recorder)

	for _, blockID := range []string{"missing-local", "cross-terminal", "finished-local", "renderer-local", "archived-local"} {
		_ = runBlockTermInputMessage(t, manager, at, blockID, "must not run")
	}
	if writes := runtime.written(); len(writes) != 0 {
		t.Fatalf("rejected tagged input reached runtime: %q", writes)
	}

	_ = runBlockTermInputMessage(t, manager, at, "", "interactive")
	if err := db.Create(&model.BlockTermBlock{
		ID: "created-local", TerminalID: terminalID, LineNum: 3, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create local block: %v", err)
	}
	_ = runBlockTermInputMessage(t, manager, at, "created-local", "managed")
	writes := runtime.written()
	if len(writes) != 2 || string(writes[0]) != "interactive" || string(writes[1]) != "managed" {
		t.Fatalf("runtime writes = %q, want legacy interactive then managed input", writes)
	}
}

func TestManagerTaggedInputNACKsBeforeRuntimeWrite(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "input-nack-terminal"
	const blockID = "input-nack-block"
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}

	tests := []struct {
		name     string
		message  WSMessage
		status   string
		recorder func() *blockTermOutputRecorder
		want     InputRejectedReason
	}{
		{name: "empty", message: WSMessage{Type: MsgTypeInput, BlockID: blockID, BlockToken: blockTermTestToken}, status: model.StatusRunning, recorder: func() *blockTermOutputRecorder { return newBlockTermOutputRecorder(db, terminalID) }, want: InputRejectedEmptyInput},
		{name: "encoding", message: WSMessage{Type: MsgTypeInput, Data: "%%%", BlockID: blockID, BlockToken: blockTermTestToken}, status: model.StatusRunning, recorder: func() *blockTermOutputRecorder { return newBlockTermOutputRecorder(db, terminalID) }, want: InputRejectedInvalidEncoding},
		{name: "token", message: WSMessage{Type: MsgTypeInput, Data: "eA==", BlockID: blockID, BlockToken: "bad"}, status: model.StatusRunning, recorder: func() *blockTermOutputRecorder { return newBlockTermOutputRecorder(db, terminalID) }, want: InputRejectedInvalidBlock},
		{name: "stopped", message: WSMessage{Type: MsgTypeInput, Data: "eA==", BlockID: blockID, BlockToken: blockTermTestToken}, status: model.StatusExited, recorder: func() *blockTermOutputRecorder { return newBlockTermOutputRecorder(db, terminalID) }, want: InputRejectedTerminalNotRunning},
		{name: "ownership", message: WSMessage{Type: MsgTypeInput, Data: "eA==", BlockID: "missing", BlockToken: blockTermTestToken}, status: model.StatusRunning, recorder: func() *blockTermOutputRecorder { return newBlockTermOutputRecorder(db, terminalID) }, want: InputRejectedInvalidBlock},
		{name: "unavailable", message: WSMessage{Type: MsgTypeInput, Data: "eA==", BlockID: blockID, BlockToken: blockTermTestToken}, status: model.StatusRunning, want: InputRejectedRecorderUnavailable},
		{name: "busy", message: WSMessage{Type: MsgTypeInput, Data: "eA==", BlockID: blockID, BlockToken: blockTermTestToken}, status: model.StatusRunning, recorder: func() *blockTermOutputRecorder {
			recorder := newBlockTermOutputRecorder(db, terminalID)
			if !recorder.ExpectBlock("other-block", blockTermTestToken) {
				t.Fatal("arm busy recorder")
			}
			return recorder
		}, want: InputRejectedRecorderBusy},
		{name: "recorder error", message: WSMessage{Type: MsgTypeInput, Data: "eA==", BlockID: blockID, BlockToken: blockTermTestToken}, status: model.StatusRunning, recorder: func() *blockTermOutputRecorder {
			recorder := newBlockTermOutputRecorder(db, terminalID)
			recorder.setError(errors.New("recorder failed"))
			return recorder
		}, want: InputRejectedRecorderError},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runtime := &blockTermInputRuntime{}
			var recorder *blockTermOutputRecorder
			if test.recorder != nil {
				recorder = test.recorder()
				defer func() {
					recorder.CloseInput()
					_ = recorder.Wait()
				}()
			}
			at := newBlockTermInputActive(terminalID, runtime, recorder)
			at.status.Store(test.status)
			_, master := runBlockTermClientMessage(t, &Manager{db: db}, at, test.message)
			rejections := blockTermInputRejections(t, master)
			if len(rejections) != 1 || rejections[0].BlockID != test.message.BlockID ||
				rejections[0].BlockToken != test.message.BlockToken || rejections[0].Reason != test.want {
				t.Fatalf("rejections = %#v, want block %q reason %q", rejections, test.message.BlockID, test.want)
			}
			if writes := runtime.written(); len(writes) != 0 {
				t.Fatalf("rejected input reached runtime: %q", writes)
			}
		})
	}
}

func TestManagerUntaggedInputDoesNotBypassPreparedRestart(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	const terminalID = "prepared-input-terminal"
	const blockID = "prepared-input-block"
	const token = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error)

	recorder := newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, recorder)
	require.NoError(t, recorder.RearmBlock(blockID, token))
	t.Cleanup(func() {
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})
	runtime := &blockTermInputRuntime{}
	manager := &Manager{db: db}
	at := newBlockTermInputActive(terminalID, runtime, recorder)

	_, _ = runBlockTermClientMessage(t, manager, at, WSMessage{
		Type: MsgTypeInput,
		Data: base64.StdEncoding.EncodeToString([]byte("interactive")),
	})
	require.Empty(t, runtime.written())
	phase, ok := recorder.RearmBindingState(blockID, token)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)

	_, _ = runBlockTermClientMessage(t, manager, at, WSMessage{
		Type:       MsgTypeInput,
		Data:       base64.StdEncoding.EncodeToString([]byte("managed")),
		BlockID:    blockID,
		BlockToken: token,
	})
	require.Equal(t, [][]byte{[]byte("managed")}, runtime.written())
}

func TestManagerTaggedInputWritesFullAfterShortWrite(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "short-write-terminal"
	const blockID = "short-write-block"
	if err := db.Create(&model.BlockTermBlock{ID: blockID, TerminalID: terminalID, Kind: "command", Status: "running"}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	runtime := &blockTermInputRuntime{maxWriteLen: 3}
	_ = runBlockTermInputMessage(t, &Manager{db: db}, newBlockTermInputActive(terminalID, runtime, recorder), blockID, "abcdefgh")
	var written []byte
	for _, chunk := range runtime.written() {
		written = append(written, chunk...)
	}
	if string(written) != "abcdefgh" || len(runtime.written()) != 3 {
		t.Fatalf("runtime writes = %q, want three chunks containing full input", runtime.written())
	}
}

func TestManagerTaggedInputHoldsMutationGateThroughRuntimeWrite(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "input-mutation-gate-terminal"
	const blockID = "input-mutation-gate-block"
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	runtime := newGatedBlockTermInputRuntime()
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(runtime.release) }) })
	manager := &Manager{db: db}
	at := newBlockTermInputActive(terminalID, runtime, recorder)

	inputDone := make(chan error, 1)
	go func() {
		inputDone <- runBlockTermInputMessage(t, manager, at, blockID, "wrapped command")
	}()
	select {
	case <-runtime.started:
	case <-time.After(time.Second):
		t.Fatal("tagged input did not reach the runtime write")
	}

	mutationEntered := make(chan struct{})
	mutationDone := make(chan struct{})
	go func() {
		manager.BlockTermMutationGate().Lock()
		close(mutationEntered)
		manager.BlockTermMutationGate().Unlock()
		close(mutationDone)
	}()
	select {
	case <-mutationEntered:
		t.Fatal("block mutation entered while the tagged runtime write was in flight")
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(runtime.release) })
	select {
	case <-mutationDone:
	case <-time.After(time.Second):
		t.Fatal("block mutation did not enter after the runtime write completed")
	}
	select {
	case <-inputDone:
	case <-time.After(time.Second):
		t.Fatal("tagged input loop did not finish")
	}
}

func TestManagerDeleteClosesBlockedTaggedInputBeforeMutationGate(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "delete-blocked-input-terminal"
	const blockID = "delete-blocked-input-block"
	if err := db.Create(&model.TerminalSession{ID: terminalID, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	runtime := newCloseReleasedBlockTermRuntime()
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	at.outputRecorder = newBlockTermOutputRecorder(db, terminalID)
	go manager.ptyReadLoop(at)
	select {
	case <-runtime.readStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal reader did not start")
	}

	inputDone := make(chan error, 1)
	go func() {
		inputDone <- runBlockTermInputMessage(t, manager, at, blockID, "wrapped command")
	}()
	select {
	case <-runtime.writeStarted:
	case <-time.After(time.Second):
		t.Fatal("tagged input did not reach the blocked runtime write")
	}

	mutationAcquired := make(chan struct{})
	releaseMutation := make(chan struct{})
	mutationDone := make(chan struct{})
	go func() {
		manager.blockTermMutationMu.Lock()
		close(mutationAcquired)
		<-releaseMutation
		manager.blockTermMutationMu.Unlock()
		close(mutationDone)
	}()
	deadline := time.Now().Add(time.Second)
	for manager.blockTermMutationMu.TryRLock() {
		manager.blockTermMutationMu.RUnlock()
		if time.Now().After(deadline) {
			close(releaseMutation)
			t.Fatal("block mutation writer did not begin waiting")
		}
		time.Sleep(time.Millisecond)
	}

	deleteDone := make(chan error, 1)
	go func() { deleteDone <- manager.Delete(terminalID) }()
	select {
	case <-runtime.closed:
	case <-time.After(time.Second):
		close(releaseMutation)
		t.Fatal("terminal delete waited on the mutation gate before closing the runtime")
	}
	select {
	case <-mutationAcquired:
	case <-time.After(time.Second):
		close(releaseMutation)
		t.Fatal("queued block mutation did not acquire after runtime close released input")
	}
	select {
	case err := <-deleteDone:
		close(releaseMutation)
		t.Fatalf("terminal delete bypassed the held mutation gate: %v", err)
	default:
	}

	close(releaseMutation)
	select {
	case <-mutationDone:
	case <-time.After(time.Second):
		t.Fatal("block mutation did not finish")
	}
	select {
	case err := <-deleteDone:
		if err != nil {
			t.Fatalf("delete terminal: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal delete did not finish after releasing the mutation gate")
	}
	select {
	case <-inputDone:
	case <-time.After(time.Second):
		t.Fatal("tagged input did not finish after runtime close")
	}

	var count int64
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", terminalID).Count(&count).Error; err != nil {
		t.Fatalf("count terminal: %v", err)
	}
	if count != 0 {
		t.Fatalf("terminal remains after delete: %d", count)
	}
	if err := db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Count(&count).Error; err != nil {
		t.Fatalf("count block: %v", err)
	}
	if count != 0 {
		t.Fatalf("block remains after delete: %d", count)
	}
}

func TestManagerTaggedInputCancelsExpectationAfterPartialWriteFailure(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "failed-input-terminal"
	const blockID = "failed-input-block"
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	if recorder == nil {
		t.Fatal("create output recorder")
	}
	writeErr := errors.New("write failed")
	runtime := &blockTermInputRuntime{writeErr: writeErr, partialWriteLen: 1}
	manager := &Manager{db: db}
	at := newBlockTermInputActive(terminalID, runtime, recorder)

	err, master := runBlockTermClientMessage(t, manager, at, blockTermInputMessage(blockID, "wrapped command"))
	if !errors.Is(err, writeErr) {
		t.Fatalf("read loop error = %v, want %v", err, writeErr)
	}
	recorder.queueMu.Lock()
	expected := recorder.parser.expectedBlockID
	recorder.queueMu.Unlock()
	if expected != "" {
		t.Fatalf("expected block remained after failed write: %q", expected)
	}
	rejections := blockTermInputRejections(t, master)
	if len(rejections) != 1 || rejections[0].Reason != InputRejectedRuntimeWriteFailed ||
		rejections[0].BlockID != blockID || rejections[0].BlockToken != blockTermTestToken {
		t.Fatalf("runtime failure rejections = %#v", rejections)
	}
	recorder.CloseInput()
	if err := recorder.Wait(); err != nil {
		t.Fatalf("wait for recorder: %v", err)
	}
}

func TestManagerTaggedINTCancelsUnconsumedExpectation(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "signal-cancel-terminal")
	if !recorder.ExpectBlock("signal-cancel-block", blockTermTestToken) {
		t.Fatal("arm expected block")
	}
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	runtime := &blockTermInputRuntime{}
	at := newBlockTermInputActive("signal-cancel-terminal", runtime, recorder)
	_, _ = runBlockTermClientMessage(t, &Manager{}, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "INT",
		BlockID:    "signal-cancel-block",
		BlockToken: blockTermTestToken,
	})
	blockID, _, _ := recorder.CurrentBinding()
	if blockID != "" {
		t.Fatalf("expected binding remained after tagged INT: %q", blockID)
	}
	writes := runtime.written()
	if len(writes) != 1 || len(writes[0]) != 1 || writes[0][0] != 3 {
		t.Fatalf("signal fallback writes = %v, want Ctrl-C", writes)
	}
}

func TestManagerTaggedSignalFailurePreservesExpectedBinding(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "signal-failure-terminal")
	if !recorder.ExpectBlock("signal-failure-block", blockTermTestToken) {
		t.Fatal("arm expected block")
	}
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})

	signalErr := errors.New("signal failed")
	runtime := &signalTestRuntime{signalErr: signalErr}
	at := newBlockTermInputActive("signal-failure-terminal", runtime, recorder)
	_, master := runBlockTermClientMessage(t, &Manager{}, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "INT",
		BlockID:    "signal-failure-block",
		BlockToken: blockTermTestToken,
	})

	blockID, token, phase := recorder.CurrentBinding()
	if blockID != "signal-failure-block" || token != blockTermTestToken || phase != "expected" {
		t.Fatalf("binding after failed signal = (%q, %q, %q)", blockID, token, phase)
	}
	rejections := blockTermInputRejections(t, master)
	if len(rejections) != 1 || rejections[0].Reason != InputRejectedRuntimeSignalFailed ||
		rejections[0].BlockID != blockID || rejections[0].BlockToken != token {
		t.Fatalf("signal failure rejections = %#v", rejections)
	}
}

func TestManagerRuntimeWriteFailureFlushesQueuedNACKBeforeReadLoopReturns(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	const terminalID = "queued-nack-terminal"
	const blockID = "queued-nack-block"
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})

	raw, err := json.Marshal(blockTermInputMessage(blockID, "wrapped command"))
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	master := newGatedBlockTermMaster(raw)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &terminalConnection{
		Master: master,
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, 4),
	}
	manager := &Manager{db: db, wsWriteTimeout: time.Second}
	if err := manager.sendConnectionMessage(conn, WSMessage{Type: MsgTypeState}); err != nil {
		t.Fatalf("queue prelude: %v", err)
	}

	writerDone := make(chan error, 1)
	go func() { writerDone <- manager.writeConnectionLoop(conn) }()
	readDone := make(chan error, 1)
	writeErr := errors.New("runtime write failed")
	go func() {
		readDone <- manager.readClientLoop(
			newBlockTermInputActive(terminalID, &blockTermInputRuntime{writeErr: writeErr}, recorder),
			conn,
		)
	}()

	select {
	case <-master.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not start queued prelude")
	}
	select {
	case err := <-readDone:
		t.Fatalf("read loop returned before queued NACK was written: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(master.release)

	select {
	case err := <-readDone:
		if !errors.Is(err, writeErr) {
			t.Fatalf("read loop error = %v, want %v", err, writeErr)
		}
	case <-time.After(time.Second):
		t.Fatal("read loop did not return after queued NACK was written")
	}
	messages := master.messages()
	if types := deliveryMessageTypes(t, messages); len(types) != 2 ||
		types[0] != MsgTypeState || types[1] != MsgTypeInputRejected {
		t.Fatalf("queued message order = %v", types)
	}
	var rejection WSMessage
	if err := json.Unmarshal(messages[1], &rejection); err != nil {
		t.Fatalf("decode rejection: %v", err)
	}
	if rejection.Reason != InputRejectedRuntimeWriteFailed || rejection.BlockID != blockID ||
		rejection.BlockToken != blockTermTestToken {
		t.Fatalf("queued rejection = %#v", rejection)
	}

	cancel()
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("writer did not stop after cancellation")
	}
}

func TestManagerTaggedSignalRequiresCurrentBinding(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "signal-binding-terminal")
	if !recorder.ExpectBlock("signal-binding-block", blockTermTestToken) {
		t.Fatal("arm expected block")
	}
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	runtime := &signalTestRuntime{}
	at := newBlockTermInputActive("signal-binding-terminal", runtime, recorder)
	manager := &Manager{}

	_, wrongTokenMaster := runBlockTermClientMessage(t, manager, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "TERM",
		BlockID:    "signal-binding-block",
		BlockToken: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	})
	_, wrongBlockMaster := runBlockTermClientMessage(t, manager, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "TERM",
		BlockID:    "stale-block",
		BlockToken: blockTermTestToken,
	})

	runtime.mu.Lock()
	if len(runtime.signals) != 0 {
		t.Fatalf("stale tagged signals were forwarded: %v", runtime.signals)
	}
	runtime.mu.Unlock()
	for name, master := range map[string]*mockMaster{
		"wrong token": wrongTokenMaster,
		"wrong block": wrongBlockMaster,
	} {
		rejections := blockTermInputRejections(t, master)
		if len(rejections) != 1 || rejections[0].Reason != InputRejectedInvalidBlock {
			t.Fatalf("%s rejections = %#v", name, rejections)
		}
	}

	_, acceptedMaster := runBlockTermClientMessage(t, manager, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "TERM",
		BlockID:    "signal-binding-block",
		BlockToken: blockTermTestToken,
	})
	if rejections := blockTermInputRejections(t, acceptedMaster); len(rejections) != 0 {
		t.Fatalf("accepted signal rejections = %#v", rejections)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.signals) != 1 || runtime.signals[0] != "TERM" {
		t.Fatalf("accepted signals = %v, want [TERM]", runtime.signals)
	}
}

func TestManagerTaggedSignalPrefersRetainedActiveOverExpectedBinding(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "signal-retained-terminal")
	recorder.queueMu.Lock()
	recorder.parser.activeBlockID = "signal-old-block"
	recorder.parser.activeBlockToken = blockTermTestToken
	recorder.parser.expectedBlockID = "signal-new-block"
	recorder.parser.expectedToken = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	recorder.queueMu.Unlock()
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})

	runtime := &signalTestRuntime{}
	at := newBlockTermInputActive("signal-retained-terminal", runtime, recorder)
	manager := &Manager{}
	_, acceptedMaster := runBlockTermClientMessage(t, manager, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "TERM",
		BlockID:    "signal-old-block",
		BlockToken: blockTermTestToken,
	})
	_, rejectedMaster := runBlockTermClientMessage(t, manager, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "TERM",
		BlockID:    "signal-new-block",
		BlockToken: recorder.parser.expectedToken,
	})

	if rejections := blockTermInputRejections(t, acceptedMaster); len(rejections) != 0 {
		t.Fatalf("active signal rejections = %#v", rejections)
	}
	rejections := blockTermInputRejections(t, rejectedMaster)
	if len(rejections) != 1 || rejections[0].Reason != InputRejectedInvalidBlock {
		t.Fatalf("expected signal rejections = %#v", rejections)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.signals) != 1 || runtime.signals[0] != "TERM" {
		t.Fatalf("forwarded signals = %v, want [TERM]", runtime.signals)
	}
}

func TestManagerExpectationTimeoutNACKsOnlyUnconsumedBinding(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "timeout-terminal")
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	manager := &Manager{}
	master := &mockMaster{}
	at := newBlockTermInputActive("timeout-terminal", &blockTermInputRuntime{}, recorder)
	at.Connections.Store("replacement", &terminalConnection{ID: "replacement", Master: master})

	timeoutGeneration, err := recorder.expectBlock("timeout-block", blockTermTestToken)
	if err != nil {
		t.Fatalf("arm timeout block: %v", err)
	}
	timer := manager.scheduleBlockTermExpectationTimeout(
		at,
		recorder,
		"timeout-block",
		blockTermTestToken,
		timeoutGeneration,
		10*time.Millisecond,
	)
	t.Cleanup(func() { timer.Stop() })
	time.Sleep(30 * time.Millisecond)
	rejections := blockTermInputRejections(t, master)
	if len(rejections) != 1 || rejections[0].Reason != InputRejectedRecorderTimeout ||
		rejections[0].BlockID != "timeout-block" || rejections[0].BlockToken != blockTermTestToken {
		t.Fatalf("timeout rejections = %#v", rejections)
	}

	master.mu.Lock()
	master.writeData = nil
	master.mu.Unlock()
	activeGeneration, err := recorder.expectBlock("active-block", blockTermTestToken)
	if err != nil {
		t.Fatalf("arm active block: %v", err)
	}
	recorder.Write(blockTermTestOSCStart("active-block"), 0)
	timer = manager.scheduleBlockTermExpectationTimeout(
		at,
		recorder,
		"active-block",
		blockTermTestToken,
		activeGeneration,
		10*time.Millisecond,
	)
	time.Sleep(30 * time.Millisecond)
	if rejections := blockTermInputRejections(t, master); len(rejections) != 0 {
		t.Fatalf("consumed binding timed out: %#v", rejections)
	}
}

func TestManagerExpectationTimeoutIgnoresReboundGeneration(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "timeout-rebind-terminal")
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	manager := &Manager{}
	master := &mockMaster{}
	at := newBlockTermInputActive("timeout-rebind-terminal", &blockTermInputRuntime{}, recorder)
	at.Connections.Store("replacement", &terminalConnection{ID: "replacement", Master: master})

	oldGeneration, err := recorder.expectBlock("timeout-rebind-block", blockTermTestToken)
	if err != nil {
		t.Fatalf("arm old generation: %v", err)
	}
	timer := manager.scheduleBlockTermExpectationTimeout(
		at,
		recorder,
		"timeout-rebind-block",
		blockTermTestToken,
		oldGeneration,
		20*time.Millisecond,
	)
	t.Cleanup(func() { timer.Stop() })
	if !recorder.CancelExpectedBlockGeneration("timeout-rebind-block", blockTermTestToken, oldGeneration) {
		t.Fatal("cancel old generation")
	}
	newGeneration, err := recorder.expectBlock("timeout-rebind-block", blockTermTestToken)
	if err != nil {
		t.Fatalf("arm rebound generation: %v", err)
	}
	if newGeneration == oldGeneration {
		t.Fatalf("rebound generation was reused: %d", newGeneration)
	}

	time.Sleep(50 * time.Millisecond)
	blockID, token, phase := recorder.CurrentBinding()
	if blockID != "timeout-rebind-block" || token != blockTermTestToken || phase != "expected" {
		t.Fatalf("rebound binding = %q %q %q", blockID, token, phase)
	}
	if rejections := blockTermInputRejections(t, master); len(rejections) != 0 {
		t.Fatalf("old timeout rejected rebound generation: %#v", rejections)
	}
}

func TestManagerExpectationTimeoutPublishesBeforeSameBindingRearm(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "timeout-order-terminal")
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	manager := &Manager{}
	master := newBlockingDeliveryMaster()
	at := newBlockTermInputActive("timeout-order-terminal", &blockTermInputRuntime{}, recorder)
	at.Connections.Store("replacement", &terminalConnection{ID: "replacement", Master: master})

	oldGeneration, err := recorder.expectBlock("timeout-order-block", blockTermTestToken)
	if err != nil {
		t.Fatalf("arm timeout generation: %v", err)
	}
	timer := manager.scheduleBlockTermExpectationTimeout(
		at,
		recorder,
		"timeout-order-block",
		blockTermTestToken,
		oldGeneration,
		time.Millisecond,
	)
	t.Cleanup(func() { timer.Stop() })
	select {
	case <-master.started:
	case <-time.After(time.Second):
		t.Fatal("timeout rejection did not start delivery")
	}

	rearmed := make(chan uint64, 1)
	go func() {
		at.inputMu.Lock()
		defer at.inputMu.Unlock()
		generation, rearmErr := recorder.expectBlock("timeout-order-block", blockTermTestToken)
		if rearmErr != nil {
			rearmed <- 0
			return
		}
		rearmed <- generation
	}()
	select {
	case generation := <-rearmed:
		t.Fatalf("binding rearmed before timeout rejection was published: %d", generation)
	case <-time.After(25 * time.Millisecond):
	}

	close(master.release)
	var newGeneration uint64
	select {
	case newGeneration = <-rearmed:
	case <-time.After(time.Second):
		t.Fatal("binding did not rearm after timeout rejection delivery")
	}
	if newGeneration == 0 || newGeneration == oldGeneration {
		t.Fatalf("rearmed generation = %d, old = %d", newGeneration, oldGeneration)
	}
	messages := master.messages()
	if len(messages) != 1 {
		t.Fatalf("timeout messages = %d, want 1", len(messages))
	}
	var rejection WSMessage
	if err := json.Unmarshal(messages[0], &rejection); err != nil {
		t.Fatalf("decode timeout rejection: %v", err)
	}
	if rejection.Type != MsgTypeInputRejected || rejection.Reason != InputRejectedRecorderTimeout ||
		rejection.BlockID != "timeout-order-block" || rejection.BlockToken != blockTermTestToken {
		t.Fatalf("timeout rejection = %#v", rejection)
	}
}

func TestManagerTerminalStateIncludesRecorderBinding(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate output segments: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, "state-binding-terminal")
	if !recorder.ExpectBlock("state-binding-block", blockTermTestToken) {
		t.Fatal("arm expected block")
	}
	t.Cleanup(func() {
		recorder.CloseInput()
		_ = recorder.Wait()
	})
	at := newBlockTermInputActive("state-binding-terminal", &blockTermInputRuntime{}, recorder)
	at.historyBuffer = newHistoryBuffer(128)

	master := &mockMaster{}
	if err := (&Manager{}).sendTerminalState(at, &terminalConnection{Master: master}); err != nil {
		t.Fatalf("send expected state: %v", err)
	}
	recorder.Write(blockTermTestOSCStart("state-binding-block"), 0)
	if err := (&Manager{}).sendTerminalState(at, &terminalConnection{Master: master}); err != nil {
		t.Fatalf("send active state: %v", err)
	}

	master.mu.Lock()
	defer master.mu.Unlock()
	if len(master.writeData) != 2 {
		t.Fatalf("state messages = %d, want 2", len(master.writeData))
	}
	wantPhases := []string{"expected", "active"}
	for index, data := range master.writeData {
		var msg WSMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("decode state %d: %v", index, err)
		}
		if msg.BlockID != "state-binding-block" || msg.BlockToken != blockTermTestToken || msg.BlockPhase != wantPhases[index] {
			t.Fatalf("state %d binding = %#v", index, msg)
		}
	}
}

func decodeTerminalState(t *testing.T, master *mockMaster) WSMessage {
	t.Helper()
	master.mu.Lock()
	defer master.mu.Unlock()
	if len(master.writeData) == 0 {
		t.Fatal("state response is missing")
	}
	var msg WSMessage
	if err := json.Unmarshal(master.writeData[len(master.writeData)-1], &msg); err != nil {
		t.Fatalf("decode state response: %v", err)
	}
	return msg
}

func TestBlockTermCompletionJSONTokenCompatibility(t *testing.T) {
	legacyJSON, err := json.Marshal(BlockTermCompletion{BlockID: "legacy-completion"})
	if err != nil {
		t.Fatalf("marshal legacy completion: %v", err)
	}
	var legacy map[string]any
	if err := json.Unmarshal(legacyJSON, &legacy); err != nil {
		t.Fatalf("decode legacy completion: %v", err)
	}
	if _, exists := legacy["block_token"]; exists {
		t.Fatalf("legacy completion exposed an empty block_token: %s", legacyJSON)
	}

	v3JSON, err := json.Marshal(BlockTermCompletion{
		BlockID: "v3-completion", BlockToken: blockTermTestToken,
	})
	if err != nil {
		t.Fatalf("marshal v3 completion: %v", err)
	}
	var v3 map[string]any
	if err := json.Unmarshal(v3JSON, &v3); err != nil {
		t.Fatalf("decode v3 completion: %v", err)
	}
	if v3["block_token"] != blockTermTestToken {
		t.Fatalf("v3 completion token = %#v, want %q", v3["block_token"], blockTermTestToken)
	}
}

func TestManagerTerminalStateFiltersCompletionsAndRepairsExitedMetadata(t *testing.T) {
	db := setupTestDB(t)
	const terminalID = "completion-state-terminal"
	if err := db.Create([]model.BlockTermBlock{
		{ID: "completion-cross", TerminalID: "other-terminal", LineNum: 0, Kind: "command", Status: "running", Command: "cross"},
		{ID: "completion-finished", TerminalID: terminalID, LineNum: 1, Kind: "command", Status: "success", Command: "finished"},
		{ID: "completion-renderer", TerminalID: terminalID, LineNum: 2, Kind: "renderer", Status: "running", Command: "renderer"},
		{ID: "completion-old", TerminalID: terminalID, LineNum: 3, Kind: "command", Status: "running", Command: "echo old"},
		{ID: "completion-latest", TerminalID: terminalID, LineNum: 4, Kind: "command", Status: "running", Command: "echo latest"},
	}).Error; err != nil {
		t.Fatalf("create completion blocks: %v", err)
	}
	recorder := &blockTermOutputRecorder{}
	recorder.parser.completedLifecycles = []blockTermCompletedLifecycle{
		{BlockID: "completion-cross", ExitCode: 1, Cwd: "/cross", EndCursor: 10},
		{BlockID: "completion-finished", ExitCode: 2, Cwd: "/finished", EndCursor: 20},
		{BlockID: "completion-renderer", ExitCode: 3, Cwd: "/renderer", EndCursor: 30},
		{BlockID: "completion-old", ExitCode: 4, Cwd: "/old", EndCursor: 40},
		{BlockID: "completion-latest", BlockToken: blockTermTestToken, ExitCode: 9, Cwd: "/latest", EndCursor: 50},
	}
	at := newBlockTermInputActive(terminalID, &blockTermInputRuntime{}, recorder)
	at.Session.Status = model.StatusExited
	at.Session.CurrentCwd = "/stale"
	at.Session.ShellState = "running"
	at.Session.ShellIntegration = false
	at.Session.LastCommand = "stale command"
	staleExit := 1
	at.Session.LastCommandExitCode = &staleExit
	at.status.Store(model.StatusExited)
	at.historyBuffer = newHistoryBuffer(128)

	master := &mockMaster{}
	if err := (&Manager{db: db}).sendTerminalState(at, &terminalConnection{Master: master}); err != nil {
		t.Fatalf("send terminal state: %v", err)
	}
	msg := decodeTerminalState(t, master)
	if msg.Status != model.StatusExited {
		t.Fatalf("state status = %q, want exited", msg.Status)
	}
	if msg.BlockID != "" || msg.BlockToken != "" || msg.BlockPhase != "" {
		t.Fatalf("exited state unexpectedly exposed binding: %#v", msg)
	}
	if len(msg.BlockCompletions) != 3 {
		t.Fatalf("completion list = %#v, want three same-terminal command rows", msg.BlockCompletions)
	}
	if msg.BlockCompletions[0] != (BlockTermCompletion{BlockID: "completion-finished", ExitCode: 2, Cwd: "/finished", EndCursor: 20}) ||
		msg.BlockCompletions[1] != (BlockTermCompletion{BlockID: "completion-old", ExitCode: 4, Cwd: "/old", EndCursor: 40}) ||
		msg.BlockCompletions[2] != (BlockTermCompletion{BlockID: "completion-latest", BlockToken: blockTermTestToken, ExitCode: 9, Cwd: "/latest", EndCursor: 50}) {
		t.Fatalf("completion order/content = %#v", msg.BlockCompletions)
	}
	if msg.CurrentCwd != "/latest" || msg.ShellState != "ready" || !msg.ShellIntegration ||
		msg.LastCommand != "echo latest" || msg.LastCommandExitCode == nil || *msg.LastCommandExitCode != 9 {
		t.Fatalf("exited metadata = %#v", msg)
	}
}

func TestManagerTerminalStatePropagatesCompletionLookupErrors(t *testing.T) {
	newState := func(terminalID string) (*activeTerminal, *blockTermOutputRecorder) {
		recorder := &blockTermOutputRecorder{}
		recorder.parser.completedLifecycles = []blockTermCompletedLifecycle{{
			BlockID: "completion-query-error", ExitCode: 0, Cwd: "/completed", EndCursor: 10,
		}}
		at := newBlockTermInputActive(terminalID, &blockTermInputRuntime{}, recorder)
		at.historyBuffer = newHistoryBuffer(128)
		return at, recorder
	}

	t.Run("query error", func(t *testing.T) {
		db := setupTestDB(t)
		const terminalID = "completion-query-error-terminal"
		if err := db.Create(&model.BlockTermBlock{
			ID: "completion-query-error", TerminalID: terminalID, LineNum: 0,
			Kind: "command", Status: "running", Command: "echo completed",
		}).Error; err != nil {
			t.Fatalf("create completion block: %v", err)
		}
		forcedErr := errors.New("forced completion lookup failure")
		const callbackName = "test:blockterm_completion_lookup_error"
		if err := db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
			if tx.Statement.Table == (model.BlockTermBlock{}).TableName() {
				tx.AddError(forcedErr)
			}
		}); err != nil {
			t.Fatalf("register completion query callback: %v", err)
		}
		t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

		at, _ := newState(terminalID)
		master := &mockMaster{}
		err := (&Manager{db: db}).sendTerminalState(at, &terminalConnection{Master: master})
		if !errors.Is(err, forcedErr) {
			t.Fatalf("send terminal state error = %v, want %v", err, forcedErr)
		}
		if len(master.writeData) != 0 {
			t.Fatalf("state was written after completion lookup failure: %q", master.writeData)
		}
	})

	t.Run("closed database", func(t *testing.T) {
		db := setupTestDB(t)
		sqlDB, err := db.DB()
		if err != nil {
			t.Fatalf("get sql database: %v", err)
		}
		if err := sqlDB.Close(); err != nil {
			t.Fatalf("close sql database: %v", err)
		}

		at, _ := newState("completion-closed-db-terminal")
		master := &mockMaster{}
		if err := (&Manager{db: db}).sendTerminalState(at, &terminalConnection{Master: master}); err == nil {
			t.Fatal("send terminal state succeeded with a closed completion database")
		}
		if len(master.writeData) != 0 {
			t.Fatalf("state was written after database closure: %q", master.writeData)
		}
	})

	t.Run("missing table remains compatible", func(t *testing.T) {
		db := setupTestDB(t)
		if err := db.Migrator().DropTable(&model.BlockTermBlock{}); err != nil {
			t.Fatalf("drop blockterm table: %v", err)
		}

		at, _ := newState("completion-missing-table-terminal")
		master := &mockMaster{}
		if err := (&Manager{db: db}).sendTerminalState(at, &terminalConnection{Master: master}); err != nil {
			t.Fatalf("send terminal state without blockterm table: %v", err)
		}
		msg := decodeTerminalState(t, master)
		if len(msg.BlockCompletions) != 0 {
			t.Fatalf("completion payload without table = %#v", msg.BlockCompletions)
		}
	})
}

func TestManagerTerminalStateKeepsMetadataWithCurrentBinding(t *testing.T) {
	db := setupTestDB(t)
	const terminalID = "completion-binding-terminal"
	if err := db.Create(&model.BlockTermBlock{
		ID: "completion-binding-block", TerminalID: terminalID, LineNum: 0,
		Kind: "command", Status: "running", Command: "echo current",
	}).Error; err != nil {
		t.Fatalf("create binding block: %v", err)
	}
	for _, phase := range []string{"expected", "active"} {
		t.Run(phase, func(t *testing.T) {
			recorder := &blockTermOutputRecorder{}
			if phase == "expected" {
				recorder.parser.expectedBlockID = phase + "-binding"
				recorder.parser.expectedToken = blockTermTestToken
			} else {
				recorder.parser.activeBlockID = phase + "-binding"
				recorder.parser.activeBlockToken = blockTermTestToken
			}
			recorder.parser.completedLifecycles = []blockTermCompletedLifecycle{{
				BlockID: "completion-binding-block", ExitCode: 6, Cwd: "/completed", EndCursor: 60,
			}}
			at := newBlockTermInputActive(terminalID, &blockTermInputRuntime{}, recorder)
			at.historyBuffer = newHistoryBuffer(128)
			at.Session.CurrentCwd = "/session"
			at.Session.ShellState = "busy"
			at.Session.ShellIntegration = false
			at.Session.LastCommand = "session command"
			staleExit := 2
			at.Session.LastCommandExitCode = &staleExit

			master := &mockMaster{}
			if err := (&Manager{db: db}).sendTerminalState(at, &terminalConnection{Master: master}); err != nil {
				t.Fatalf("send terminal state: %v", err)
			}
			msg := decodeTerminalState(t, master)
			if msg.BlockID != phase+"-binding" || msg.BlockToken != blockTermTestToken || msg.BlockPhase != phase {
				t.Fatalf("binding = %#v", msg)
			}
			if msg.CurrentCwd != "/session" || msg.ShellState != "busy" || msg.ShellIntegration ||
				msg.LastCommand != "session command" || msg.LastCommandExitCode == nil || *msg.LastCommandExitCode != 2 {
				t.Fatalf("metadata was overwritten despite binding: %#v", msg)
			}
			if len(msg.BlockCompletions) != 1 || msg.BlockCompletions[0].BlockID != "completion-binding-block" {
				t.Fatalf("completion payload = %#v", msg.BlockCompletions)
			}
		})
	}
}

func TestManagerStateRequestSendsStateResponse(t *testing.T) {
	at := newBlockTermInputActive("state-request-terminal", &blockTermInputRuntime{}, nil)
	at.historyBuffer = newHistoryBuffer(128)
	err, master := runBlockTermClientMessage(t, &Manager{}, at, WSMessage{Type: MsgTypeState})
	if !errors.Is(err, ErrMasterClosed) {
		t.Fatalf("state request loop error = %v, want master close", err)
	}
	msg := decodeTerminalState(t, master)
	if msg.Type != MsgTypeState || msg.Status != model.StatusRunning {
		t.Fatalf("state response = %#v", msg)
	}
}
