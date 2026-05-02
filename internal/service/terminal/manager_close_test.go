package terminal

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

// tailRuntime releases one final data+error Read when closed. This mirrors the
// io.Reader contract used by PTYs at shutdown and makes the drain race
// deterministic.
type tailRuntime struct {
	data       []byte
	started    chan struct{}
	release    chan struct{}
	closeErr   error
	waitErr    error
	closeOnce  sync.Once
	readOnce   sync.Once
	blockUntil bool
}

type blockingSnapshotStore struct {
	delegate TerminalSnapshotStore
	started  chan struct{}
	release  chan struct{}
	blockOne sync.Once
}

type failingSnapshotStore struct {
	err error
}

func (s *failingSnapshotStore) Load(string) (*TerminalSnapshot, error) {
	return nil, s.err
}

func (s *failingSnapshotStore) Save(*TerminalSnapshot) error {
	return s.err
}

func (s *failingSnapshotStore) Delete(string) error {
	return s.err
}

func newBlockingSnapshotStore(delegate TerminalSnapshotStore) *blockingSnapshotStore {
	return &blockingSnapshotStore{
		delegate: delegate,
		started:  make(chan struct{}),
		release:  make(chan struct{}),
	}
}

func (s *blockingSnapshotStore) Load(sessionID string) (*TerminalSnapshot, error) {
	return s.delegate.Load(sessionID)
}

func (s *blockingSnapshotStore) Save(snapshot *TerminalSnapshot) error {
	s.blockOne.Do(func() {
		close(s.started)
		<-s.release
	})
	return s.delegate.Save(snapshot)
}

func (s *blockingSnapshotStore) Delete(sessionID string) error {
	return s.delegate.Delete(sessionID)
}

func newTailRuntime(data []byte, blockUntilClose bool) *tailRuntime {
	return &tailRuntime{
		data:       append([]byte(nil), data...),
		started:    make(chan struct{}),
		release:    make(chan struct{}),
		blockUntil: blockUntilClose,
	}
}

func (r *tailRuntime) Type() string { return "test" }

func (r *tailRuntime) Capabilities() TerminalCapabilities { return TerminalCapabilities{} }

func (r *tailRuntime) Read(p []byte) (int, error) {
	r.readOnce.Do(func() { close(r.started) })
	if r.blockUntil {
		<-r.release
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, io.EOF
}

func (r *tailRuntime) Write([]byte) (int, error) { return 0, errors.New("test runtime is read-only") }

func (r *tailRuntime) Resize(int, int) error { return nil }

func (r *tailRuntime) Close() error {
	r.closeOnce.Do(func() { close(r.release) })
	return r.closeErr
}

func (r *tailRuntime) ExitCode() int { return 0 }

func (r *tailRuntime) Wait(context.Context) error { return r.waitErr }

func newTestActiveTerminalForDrain(id string, runtime TerminalRuntime, dbManager *Manager) *activeTerminal {
	at := &activeTerminal{
		ID:            id,
		Runtime:       runtime,
		Session:       &model.TerminalSession{ID: id, Status: model.StatusRunning},
		Done:          make(chan struct{}),
		readDone:      make(chan struct{}),
		historyBuffer: newHistoryBuffer(128),
		flushTicker:   time.NewTicker(time.Hour),
		bufferSize:    128,
		encoder:       base64.StdEncoding,
	}
	at.status.Store(model.StatusRunning)
	dbManager.terminals.Store(id, at)
	return at
}

func TestPTYReadLoopKeepsDataReturnedWithError(t *testing.T) {
	runtime := newTailRuntime([]byte("natural-tail"), false)
	at := &activeTerminal{
		ID:            "natural-tail",
		Runtime:       runtime,
		Session:       &model.TerminalSession{ID: "natural-tail", Status: model.StatusRunning},
		Done:          make(chan struct{}),
		readDone:      make(chan struct{}),
		historyBuffer: newHistoryBuffer(128),
		bufferSize:    128,
		encoder:       base64.StdEncoding,
	}
	at.status.Store(model.StatusRunning)

	go (&Manager{}).ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("ptyReadLoop did not finish")
	}
	if got := string(at.historyBuffer.Read()); got != "natural-tail" {
		t.Fatalf("history = %q, want %q", got, "natural-tail")
	}
}

func TestManagerCloseFlushesReaderTail(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const id = "close-tail"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	runtime := newTailRuntime([]byte("close-tail-bytes"), true)
	at := newTestActiveTerminalForDrain(id, runtime, manager)

	readerDone := make(chan struct{})
	go func() {
		manager.ptyReadLoop(at)
		close(readerDone)
	}()
	select {
	case <-runtime.started:
	case <-time.After(time.Second):
		t.Fatal("reader did not start")
	}

	closeDone := make(chan struct{})
	go func() {
		if err := manager.Close(id); err != nil {
			t.Errorf("Close failed: %v", err)
		}
		close(closeDone)
	}()
	select {
	case <-closeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not finish after runtime release")
	}
	select {
	case <-readerDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not drain after Close")
	}

	var history model.TerminalHistory
	if err := db.Where("session_id = ?", id).First(&history).Error; err != nil {
		t.Fatalf("load flushed history: %v", err)
	}
	if got := string(history.Data); got != "close-tail-bytes" {
		t.Fatalf("history = %q, want %q", got, "close-tail-bytes")
	}
	if history.Cursor != uint64(len("close-tail-bytes")) {
		t.Fatalf("cursor = %d, want %d", history.Cursor, len("close-tail-bytes"))
	}
}

func TestManagerCloseReturnsRuntimeCloseError(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const id = "close-runtime-error"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}

	runtimeErr := errors.New("runtime close failed")
	runtime := newTailRuntime(nil, false)
	runtime.closeErr = runtimeErr
	at := newTestActiveTerminalForDrain(id, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	if err := manager.Close(id); !errors.Is(err, runtimeErr) {
		t.Fatalf("Close error = %v, want %v", err, runtimeErr)
	}
}

func TestManagerDeleteWaitsForHistoryFlushGoroutine(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	store := newBlockingSnapshotStore(manager.snapshotStore)
	manager.snapshotStore = store

	const id = "delete-during-history-flush"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	runtime := newTailRuntime(nil, false)
	at := &activeTerminal{
		ID:            id,
		Runtime:       runtime,
		Session:       &model.TerminalSession{ID: id, Status: model.StatusRunning},
		Done:          make(chan struct{}),
		readDone:      make(chan struct{}),
		flushDone:     make(chan struct{}),
		historyBuffer: newHistoryBuffer(128),
		flushTicker:   time.NewTicker(time.Millisecond),
		bufferSize:    128,
		encoder:       base64.StdEncoding,
	}
	at.status.Store(model.StatusRunning)
	manager.terminals.Store(id, at)

	go manager.ptyReadLoop(at)
	go manager.flushHistory(at)

	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("periodic history flush did not start")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.Delete(id)
	}()

	select {
	case err := <-deleteDone:
		t.Fatalf("Delete returned before the history flush completed: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	close(store.release)
	select {
	case err := <-deleteDone:
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Delete did not finish after the history flush completed")
	}

	select {
	case <-at.flushDone:
	default:
		t.Fatal("Delete returned before the history flush goroutine exited")
	}

	var sessionCount int64
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", id).Count(&sessionCount).Error; err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if sessionCount != 0 {
		t.Fatalf("session was recreated after Delete: count=%d", sessionCount)
	}

	var historyCount int64
	if err := db.Model(&model.TerminalHistory{}).Where("session_id = ?", id).Count(&historyCount).Error; err != nil {
		t.Fatalf("count history: %v", err)
	}
	if historyCount != 0 {
		t.Fatalf("history was recreated after Delete: count=%d", historyCount)
	}
}

func TestManagerDeleteJoinsConcurrentCloseBeforeDeletingHistory(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	store := newBlockingSnapshotStore(manager.snapshotStore)
	manager.snapshotStore = store

	const id = "delete-joins-concurrent-close"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	runtime := newTailRuntime([]byte("final-history"), false)
	at := newTestActiveTerminalForDrain(id, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- manager.Close(id)
	}()
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("Close did not reach its final history snapshot")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.Delete(id)
	}()
	select {
	case err := <-deleteDone:
		t.Fatalf("Delete bypassed the in-flight Close: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	close(store.release)
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not finish after snapshot release")
	}
	select {
	case err := <-deleteDone:
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Delete did not join the concurrent Close")
	}

	var sessionCount int64
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", id).Count(&sessionCount).Error; err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if sessionCount != 0 {
		t.Fatalf("terminal session remained after Delete: count=%d", sessionCount)
	}

	var historyCount int64
	if err := db.Model(&model.TerminalHistory{}).Where("session_id = ?", id).Count(&historyCount).Error; err != nil {
		t.Fatalf("count history: %v", err)
	}
	if historyCount != 0 {
		t.Fatalf("history was recreated after Delete: count=%d", historyCount)
	}
}

func TestMonitorRuntimeWaitsForReaderTailBeforeExitSnapshot(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const id = "natural-exit-tail"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	runtime := newTailRuntime([]byte("natural-exit-bytes"), true)
	at := newTestActiveTerminalForDrain(id, runtime, manager)

	go manager.ptyReadLoop(at)
	select {
	case <-runtime.started:
	case <-time.After(time.Second):
		t.Fatal("reader did not start")
	}

	monitorDone := make(chan struct{})
	go func() {
		manager.monitorRuntime(at)
		close(monitorDone)
	}()
	select {
	case <-monitorDone:
		t.Fatal("monitor completed before the reader drained its tail")
	case <-time.After(25 * time.Millisecond):
	}

	if err := runtime.Close(); err != nil {
		t.Fatalf("release runtime: %v", err)
	}
	select {
	case <-monitorDone:
	case <-time.After(2 * time.Second):
		t.Fatal("monitor did not finish after reader drain")
	}

	var history model.TerminalHistory
	if err := db.Where("session_id = ?", id).First(&history).Error; err != nil {
		t.Fatalf("load exit history: %v", err)
	}
	if got := string(history.Data); got != "natural-exit-bytes" {
		t.Fatalf("history = %q, want %q", got, "natural-exit-bytes")
	}
	if history.Cursor != uint64(len("natural-exit-bytes")) {
		t.Fatalf("cursor = %d, want %d", history.Cursor, len("natural-exit-bytes"))
	}

	var session model.TerminalSession
	if err := db.First(&session, "id = ?", id).Error; err != nil {
		t.Fatalf("load exited session: %v", err)
	}
	if session.Status != model.StatusExited || !session.Readonly {
		t.Fatalf("session exit state = status %q readonly %t", session.Status, session.Readonly)
	}
	at.flushTicker.Stop()
}

func TestMonitorRuntimeReturnsFinalSnapshotErrorAndLeavesExitedState(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	finalErr := errors.New("final snapshot failed")
	manager.snapshotStore = &failingSnapshotStore{err: finalErr}
	const id = "natural-exit-snapshot-error"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}

	runtime := newTailRuntime(nil, false)
	at := newTestActiveTerminalForDrain(id, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	if err := manager.monitorRuntime(at); !errors.Is(err, finalErr) {
		t.Fatalf("monitorRuntime error = %v, want %v", err, finalErr)
	}
	if got := at.status.Load().(string); got != model.StatusExited {
		t.Fatalf("active status = %q, want %q", got, model.StatusExited)
	}
	at.sessionMu.RLock()
	status := at.Session.Status
	readonly := at.Session.Readonly
	at.sessionMu.RUnlock()
	if status != model.StatusExited || !readonly {
		t.Fatalf("session state = status %q readonly %t, want exited/read-only", status, readonly)
	}

	var session model.TerminalSession
	if err := db.First(&session, "id = ?", id).Error; err != nil {
		t.Fatalf("load exited session: %v", err)
	}
	if session.Status != model.StatusExited || !session.Readonly {
		t.Fatalf("database state = status %q readonly %t, want exited/read-only", session.Status, session.Readonly)
	}
	at.flushTicker.Stop()
}

func TestMonitorRuntimeReturnsWaitErrorAndLeavesExitedState(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	waitErr := errors.New("runtime wait failed")
	const id = "natural-exit-wait-error"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}

	runtime := newTailRuntime(nil, false)
	runtime.waitErr = waitErr
	at := newTestActiveTerminalForDrain(id, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	if err := manager.monitorRuntime(at); !errors.Is(err, waitErr) {
		t.Fatalf("monitorRuntime error = %v, want %v", err, waitErr)
	}
	if got := at.status.Load().(string); got != model.StatusExited {
		t.Fatalf("active status = %q, want %q", got, model.StatusExited)
	}

	var session model.TerminalSession
	if err := db.First(&session, "id = ?", id).Error; err != nil {
		t.Fatalf("load exited session: %v", err)
	}
	if session.Status != model.StatusExited || !session.Readonly {
		t.Fatalf("database state = status %q readonly %t, want exited/read-only", session.Status, session.Readonly)
	}
	at.flushTicker.Stop()
}

func TestMonitorRuntimeReturnsExitStateUpdateErrorAndKeepsMemoryExited(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	updateErr := errors.New("terminal exit state update failed")
	const id = "natural-exit-db-update-error"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}

	const callbackName = "test:monitor_runtime_exit_state_update_error"
	if err := db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.TerminalSession{}).TableName() {
			tx.AddError(updateErr)
		}
	}); err != nil {
		t.Fatalf("register update callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	runtime := newTailRuntime(nil, false)
	at := newTestActiveTerminalForDrain(id, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	err := manager.monitorRuntime(at)
	if !errors.Is(err, updateErr) {
		t.Fatalf("monitorRuntime error = %v, want %v", err, updateErr)
	}
	if got := at.status.Load().(string); got != model.StatusExited {
		t.Fatalf("active status = %q, want %q", got, model.StatusExited)
	}
	at.sessionMu.RLock()
	status := at.Session.Status
	readonly := at.Session.Readonly
	at.sessionMu.RUnlock()
	if status != model.StatusExited || !readonly {
		t.Fatalf("in-memory session state = status %q readonly %t, want exited/read-only", status, readonly)
	}
	at.flushTicker.Stop()
}

func TestMonitorRuntimeReturnsOutputRecorderWaitError(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate raw output segments: %v", err)
	}
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const id = "natural-exit-recorder-error"
	const blockID = "recorder-error-block"
	if err := db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{ID: blockID, TerminalID: id, LineNum: 0}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}

	recorderErr := errors.New("raw output persistence failed")
	const callbackName = "test:monitor_runtime_recorder_wait_error"
	if err := db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermOutputSegment{}).TableName() {
			tx.AddError(recorderErr)
		}
	}); err != nil {
		t.Fatalf("register create callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	recorder := newBlockTermOutputRecorder(db, id)
	if recorder == nil {
		t.Fatal("raw output recorder was not created")
	}
	if !recorder.ExpectBlock(blockID, blockTermTestToken) {
		t.Fatal("raw output recorder did not accept the expected block")
	}
	at := newTestActiveTerminalForDrain(id, newTailRuntime(append(append([]byte{}, blockTermTestOSCStart(blockID)...), []byte("output")...), false), manager)
	at.bufferSize = 512
	at.outputRecorder = recorder
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	err := manager.monitorRuntime(at)
	if !errors.Is(err, recorderErr) {
		t.Fatalf("monitorRuntime error = %v, want %v", err, recorderErr)
	}
	if got := at.status.Load().(string); got != model.StatusExited {
		t.Fatalf("active status = %q, want %q", got, model.StatusExited)
	}
	at.flushTicker.Stop()
}

func TestMonitorRuntimeDoesNotPublishExitWithoutCorrelatedCompletionState(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate raw output segments: %v", err)
	}
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const terminalID = "exit-completion-query-error"
	const blockID = "exit-completion-block"
	if err := db.Create(&model.TerminalSession{ID: terminalID, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create terminal session: %v", err)
	}
	if err := db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}

	recorder := newBlockTermOutputRecorder(db, terminalID)
	if recorder == nil {
		t.Fatal("create output recorder")
	}
	recorder.queueMu.Lock()
	recorder.parser.completedLifecycles = append(recorder.parser.completedLifecycles, blockTermCompletedLifecycle{
		BlockID: blockID, ExitCode: 0, Cwd: "/completed", EndCursor: 10,
	})
	recorder.queueMu.Unlock()
	recorder.CloseInput()

	queryErr := errors.New("completion lookup failed")
	const callbackName = "test:monitor_runtime_completion_lookup_error"
	if err := db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() {
			tx.AddError(queryErr)
		}
	}); err != nil {
		t.Fatalf("register completion query callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

	runtime := newTailRuntime(nil, false)
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	at.outputRecorder = recorder
	ctx, cancel := context.WithCancel(context.Background())
	master := &mockMaster{}
	at.Connections.Store("connection-1", &terminalConnection{
		ID: "connection-1", Master: master, Ctx: ctx, Cancel: cancel,
	})
	go manager.ptyReadLoop(at)
	select {
	case <-at.readDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish")
	}

	err := manager.monitorRuntime(at)
	if !errors.Is(err, queryErr) {
		t.Fatalf("monitorRuntime error = %v, want %v", err, queryErr)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("completion query failure did not cancel the connection")
	}
	master.mu.Lock()
	defer master.mu.Unlock()
	if len(master.writeData) != 0 {
		t.Fatalf("exit notification was published without correlated state: %q", master.writeData)
	}
	at.flushTicker.Stop()
}
