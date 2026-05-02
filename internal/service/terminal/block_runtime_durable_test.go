package terminal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const blockRuntimeDurableTestToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type blockRuntimeDurableWireMessage struct {
	Type         string `json:"type"`
	Status       string `json:"status"`
	BlockStatus  string `json:"block_status"`
	DurableError string `json:"durable_error"`
	RouteMode    string `json:"route_mode"`
	BlockID      string `json:"block_id"`
	BlockToken   string `json:"block_token"`
	Cursor       uint64 `json:"cursor"`
	ExitCode     *int   `json:"exit_code"`
}

// blockRuntimeCloseGateRuntime lets the parent-shutdown ABA test pause after
// route detachment but before the child finalizer can settle its durable row.
type blockRuntimeCloseGateRuntime struct {
	closeStarted chan struct{}
	releaseClose chan struct{}
	closeOnce    sync.Once
}

func (r *blockRuntimeCloseGateRuntime) Type() string { return RuntimeTypeLocal }

func (r *blockRuntimeCloseGateRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}

func (r *blockRuntimeCloseGateRuntime) Read([]byte) (int, error) { return 0, io.EOF }

func (r *blockRuntimeCloseGateRuntime) Write(p []byte) (int, error) { return len(p), nil }

func (r *blockRuntimeCloseGateRuntime) Resize(int, int) error { return nil }

func (r *blockRuntimeCloseGateRuntime) Close() error {
	r.closeOnce.Do(func() { close(r.closeStarted) })
	<-r.releaseClose
	return nil
}

func (r *blockRuntimeCloseGateRuntime) ExitCode() int { return 0 }

func (r *blockRuntimeCloseGateRuntime) Wait(context.Context) error { return nil }

type blockRuntimeResizeFailureRuntime struct {
	mu      sync.Mutex
	resizes [][2]int
	err     error
}

func (r *blockRuntimeResizeFailureRuntime) Type() string { return RuntimeTypeLocal }

func (r *blockRuntimeResizeFailureRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}

func (r *blockRuntimeResizeFailureRuntime) Read([]byte) (int, error) { return 0, io.EOF }

func (r *blockRuntimeResizeFailureRuntime) Write(p []byte) (int, error) { return len(p), nil }

func (r *blockRuntimeResizeFailureRuntime) Resize(cols, rows int) error {
	r.mu.Lock()
	r.resizes = append(r.resizes, [2]int{cols, rows})
	r.mu.Unlock()
	return r.err
}

func (r *blockRuntimeResizeFailureRuntime) Close() error { return nil }

func (r *blockRuntimeResizeFailureRuntime) ExitCode() int { return 0 }

func (r *blockRuntimeResizeFailureRuntime) Wait(context.Context) error { return nil }

func (r *blockRuntimeResizeFailureRuntime) resized() [][2]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([][2]int, len(r.resizes))
	copy(result, r.resizes)
	return result
}

func setupBlockRuntimeDurableDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	return db
}

func seedBlockRuntimeDurableRows(
	t *testing.T,
	db *gorm.DB,
	terminalID string,
	blockID string,
	status string,
) model.BlockTermBlock {
	t.Helper()
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: terminalID, Name: terminalID, Status: model.StatusRunning,
		RuntimeType: RuntimeTypeLocal, Cols: 80, Rows: 24,
	}).Error)
	block := model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 1,
		Kind: "command", Command: "printf durable", Status: status,
		TermCols: 80, TermRows: 24, TermMaxPTYSize: 1024,
		CreatedAt: now, UpdatedAt: now,
	}
	require.NoError(t, db.Create(&block).Error)
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: block.ID, TerminalID: block.TerminalID, LineNum: block.LineNum,
		Command: block.Command, Kind: block.Kind, Status: block.Status,
		TermCols: block.TermCols, TermRows: block.TermRows,
		TermMaxPTYSize: block.TermMaxPTYSize,
		CreatedAt:      block.CreatedAt, SnapshotUpdatedAt: block.UpdatedAt,
	}).Error)
	return block
}

func registerBlockRuntimeDurableOwner(
	t *testing.T,
	manager *Manager,
	terminalID string,
	blockID string,
	runtime TerminalRuntime,
) *activeBlockRuntime {
	t.Helper()
	manager.ensureBlockRuntimeStore()
	owner := newBlockRuntimeLifecycleOwner(
		manager,
		terminalID,
		blockID,
		blockRuntimeDurableTestToken,
		runtime,
	)
	owner.status.Store(model.StatusRunning)
	handle, err := manager.blockTermRoutes.RegisterBlock(
		terminalID,
		blockID,
		blockRuntimeDurableTestToken,
		runtime,
	)
	require.NoError(t, err)
	owner.routeHandle = handle
	manager.blockRuntimeMu.Lock()
	manager.blockRuntimes[owner.key] = owner
	manager.blockRuntimeMu.Unlock()
	return owner
}

func attachBlockRuntimeDurableCapture(owner *activeBlockRuntime) *blockRuntimeCaptureMaster {
	capture := &blockRuntimeCaptureMaster{}
	owner.connections.Store("durable-capture", &terminalConnection{
		ID: "durable-capture", Master: capture,
	})
	return capture
}

func waitForBlockRuntimeDurableDone(t *testing.T, owner *activeBlockRuntime) {
	t.Helper()
	select {
	case <-owner.done:
	case <-time.After(5 * time.Second):
		t.Fatal("block runtime durable finalization did not finish")
	}
}

func decodeBlockRuntimeDurableMessages(t *testing.T, capture *blockRuntimeCaptureMaster) []blockRuntimeDurableWireMessage {
	t.Helper()
	rawMessages := capture.messages()
	messages := make([]blockRuntimeDurableWireMessage, 0, len(rawMessages))
	for index, raw := range rawMessages {
		var message blockRuntimeDurableWireMessage
		require.NoErrorf(t, json.Unmarshal(raw, &message), "decode message %d", index)
		messages = append(messages, message)
	}
	return messages
}

func TestResizeBlockRuntimePersistsGeometryAndHistory(t *testing.T) {
	const (
		terminalID = "durable-resize-terminal"
		blockID    = "durable-resize-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	runtime := &blockTermInputRuntime{}
	registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, runtime)
	t.Cleanup(func() {
		err := manager.CloseBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
		if err != nil && !errors.Is(err, ErrBlockRuntimeNotFound) {
			t.Errorf("close resized block runtime: %v", err)
		}
	})

	require.NoError(t, manager.ResizeBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken, 132, 43))
	require.Equal(t, [][2]int{{132, 43}}, runtime.resized())
	info, ok := manager.GetBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
	require.True(t, ok)
	require.Equal(t, 132, info.Cols)
	require.Equal(t, 43, info.Rows)

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, 132, block.TermCols)
	require.Equal(t, 43, block.TermRows)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, 132, history.TermCols)
	require.Equal(t, 43, history.TermRows)
	var session model.TerminalSession
	require.NoError(t, db.First(&session, "id = ?", terminalID).Error)
	require.Equal(t, 80, session.Cols)
	require.Equal(t, 24, session.Rows)
}

func TestResizeBlockRuntimeRejectsInvalidOrFailedGeometryWithoutDurableMutation(t *testing.T) {
	const (
		terminalID = "durable-resize-reject-terminal"
		blockID    = "durable-resize-reject-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	injectedErr := errors.New("injected resize failure")
	runtime := &blockRuntimeResizeFailureRuntime{err: injectedErr}
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, runtime)
	t.Cleanup(func() {
		err := manager.CloseBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
		if err != nil && !errors.Is(err, ErrBlockRuntimeNotFound) {
			t.Errorf("close rejected block runtime: %v", err)
		}
	})

	for _, size := range [][2]int{{9, 24}, {1025, 24}, {80, 1}, {80, 1025}} {
		err := manager.ResizeBlockRuntime(
			terminalID,
			blockID,
			blockRuntimeDurableTestToken,
			size[0],
			size[1],
		)
		require.ErrorIs(t, err, ErrBlockRuntimeInvalid)
	}
	require.Empty(t, runtime.resized())

	err := manager.ResizeBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken, 120, 40)
	require.ErrorIs(t, err, injectedErr)
	require.Equal(t, [][2]int{{120, 40}}, runtime.resized())
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, 80, block.TermCols)
	require.Equal(t, 24, block.TermRows)
	info, ok := manager.GetBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
	require.True(t, ok)
	require.Equal(t, 80, info.Cols)
	require.Equal(t, 24, info.Rows)
}

func TestBlockRuntimeFinalizerPersistsLastKnownGeometry(t *testing.T) {
	const (
		terminalID = "durable-final-geometry-terminal"
		blockID    = "durable-final-geometry-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	owner := registerBlockRuntimeDurableOwner(
		t,
		manager,
		terminalID,
		blockID,
		&blockRuntimeLifecycleTestRuntime{},
	)
	owner.infoMu.Lock()
	owner.info.Cols = 144
	owner.info.Rows = 52
	owner.infoMu.Unlock()

	owner.finish(nil, model.StatusClosed)
	waitForBlockRuntimeDurableDone(t, owner)

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, 144, block.TermCols)
	require.Equal(t, 52, block.TermRows)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, 144, history.TermCols)
	require.Equal(t, 52, history.TermRows)
}

func requireBlockRuntimeDurableFinalWire(
	t *testing.T,
	capture *blockRuntimeCaptureMaster,
	wireStatus string,
	blockStatus string,
	durableError string,
	exitCode *int,
) {
	t.Helper()
	messages := decodeBlockRuntimeDurableMessages(t, capture)
	require.GreaterOrEqual(t, len(messages), 2)
	state := messages[len(messages)-2]
	exited := messages[len(messages)-1]
	for _, message := range []blockRuntimeDurableWireMessage{state, exited} {
		require.Equal(t, RouteModeBlock, message.RouteMode)
		require.NotEmpty(t, message.BlockID)
		require.Equal(t, blockRuntimeDurableTestToken, message.BlockToken)
		require.Equal(t, blockStatus, message.BlockStatus)
		if durableError == "" {
			require.Empty(t, message.DurableError)
		} else {
			require.Contains(t, message.DurableError, durableError)
		}
	}
	require.Equal(t, MsgTypeState, state.Type)
	require.Equal(t, wireStatus, state.Status)
	require.Equal(t, exitCode, state.ExitCode)
	require.Equal(t, MsgTypePtyExited, exited.Type)
	require.Equal(t, exitCode, exited.ExitCode)
}

func TestAttachBlockRuntimeInitialStateIncludesRunningDurableStatus(t *testing.T) {
	const (
		terminalID = "attach-running-terminal"
		blockID    = "attach-running-block"
	)
	manager := NewManager(nil, &ManagerConfig{Shell: "/bin/sh"})
	owner := registerBlockRuntimeDurableOwner(
		t,
		manager,
		terminalID,
		blockID,
		&blockRuntimeLifecycleTestRuntime{},
	)
	_, _ = owner.buffer.Write([]byte("attached replay"))
	t.Cleanup(func() {
		err := manager.CloseBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
		if err != nil && !errors.Is(err, ErrBlockRuntimeNotFound) {
			t.Errorf("close attached block runtime: %v", err)
		}
	})
	attachErr := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			attachErr <- err
			return
		}
		_, err = manager.AttachBlockRuntime(
			terminalID,
			blockID,
			blockRuntimeDurableTestToken,
			conn,
			BlockRuntimeAttachOptions{},
		)
		attachErr <- err
	}))
	defer server.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	require.NoError(t, err)
	defer conn.Close()
	select {
	case err := <-attachErr:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("AttachBlockRuntime did not return")
	}

	messages := make([]blockRuntimeDurableWireMessage, 0, 3)
	for attempts := 0; attempts < 3; attempts++ {
		_, raw, err := conn.ReadMessage()
		require.NoError(t, err)
		var message blockRuntimeDurableWireMessage
		require.NoError(t, json.Unmarshal(raw, &message))
		messages = append(messages, message)
	}
	require.Equal(t, []string{MsgTypeReplay, MsgTypeReplayDone, MsgTypeState}, []string{
		messages[0].Type, messages[1].Type, messages[2].Type,
	})
	for _, message := range messages {
		require.Equal(t, RouteModeBlock, message.RouteMode)
		require.Equal(t, blockID, message.BlockID)
		require.Equal(t, blockRuntimeDurableTestToken, message.BlockToken)
	}
	state := messages[2]
	require.Equal(t, MsgTypeState, state.Type)
	require.Equal(t, model.StatusRunning, state.Status)
	require.Equal(t, model.StatusRunning, state.BlockStatus)
	require.Empty(t, state.DurableError)
	require.Nil(t, state.ExitCode)

	// A message on an attached socket cannot switch to another token. The NACK
	// echoes the attempted exact route without touching the admitted owner.
	require.NoError(t, conn.WriteJSON(WSMessage{
		Type:       MsgTypeState,
		RouteMode:  RouteModeBlock,
		BlockID:    blockID,
		BlockToken: blockTermRestartOtherToken,
	}))
	_, raw, err := conn.ReadMessage()
	require.NoError(t, err)
	var rejected WSMessage
	require.NoError(t, json.Unmarshal(raw, &rejected))
	require.Equal(t, MsgTypeInputRejected, rejected.Type)
	require.Equal(t, InputRejectedTokenMismatch, rejected.Reason)
	require.Equal(t, RouteModeBlock, rejected.RouteMode)
	require.Equal(t, blockID, rejected.BlockID)
	require.Equal(t, blockTermRestartOtherToken, rejected.BlockToken)

	require.NoError(t, conn.WriteJSON(WSMessage{
		Type:       MsgTypeState,
		RouteMode:  RouteModeBlock,
		BlockID:    blockID,
		BlockToken: blockRuntimeDurableTestToken,
	}))
	_, raw, err = conn.ReadMessage()
	require.NoError(t, err)
	var refreshed blockRuntimeDurableWireMessage
	require.NoError(t, json.Unmarshal(raw, &refreshed))
	require.Equal(t, MsgTypeState, refreshed.Type)
	require.Equal(t, model.StatusRunning, refreshed.Status)
	require.Equal(t, model.StatusRunning, refreshed.BlockStatus)
	require.Equal(t, blockRuntimeDurableTestToken, refreshed.BlockToken)
}

func TestBlockRuntimeNaturalExitFinalizesDurableBlockAndHistory(t *testing.T) {
	tests := []struct {
		name          string
		exitCode      int
		durableStatus string
	}{
		{name: "success", exitCode: 0, durableStatus: blockRuntimeDurableSuccess},
		{name: "error", exitCode: 23, durableStatus: blockRuntimeDurableError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			terminalID := "durable-natural-" + test.name + "-terminal"
			blockID := "durable-natural-" + test.name + "-block"
			db := setupBlockRuntimeDurableDB(t)
			seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)

			chunks := [][]byte{[]byte("first\x00"), {0xff, 't', 'a', 'i', 'l'}}
			expectedOutput := bytes.Join(chunks, nil)
			runtime := &blockRuntimeLifecycleTestRuntime{chunks: chunks, exitCode: test.exitCode}
			manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
			owner := registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, runtime)
			owner.readDone = make(chan struct{})
			owner.recorder = newBlockTermOutputRecorder(db, terminalID)
			require.NotNil(t, owner.recorder)
			capture := attachBlockRuntimeDurableCapture(owner)

			go manager.blockRuntimeReadLoop(owner)
			go manager.blockRuntimeMonitor(owner)
			waitForBlockRuntimeDurableDone(t, owner)

			var block model.BlockTermBlock
			require.NoError(t, db.First(&block, "id = ?", blockID).Error)
			require.Equal(t, test.durableStatus, block.Status)
			require.NotNil(t, block.ExitCode)
			require.Equal(t, test.exitCode, *block.ExitCode)
			require.Equal(t, expectedOutput, block.Output)
			require.NotNil(t, block.OutputCursor)
			require.EqualValues(t, len(expectedOutput), *block.OutputCursor)
			require.NotNil(t, block.FinishedAt)

			var history model.BlockTermCommandHistory
			require.NoError(t, db.First(&history, "id = ?", blockID).Error)
			require.Equal(t, test.durableStatus, history.Status)
			require.NotNil(t, history.ExitCode)
			require.Equal(t, test.exitCode, *history.ExitCode)
			require.Equal(t, expectedOutput, history.Output)
			require.NotNil(t, history.OutputCursor)
			require.EqualValues(t, len(expectedOutput), *history.OutputCursor)

			var segments []model.BlockTermOutputSegment
			require.NoError(t, db.Where("terminal_id = ? AND block_id = ?", terminalID, blockID).
				Order("start_cursor ASC").Find(&segments).Error)
			require.NotEmpty(t, segments)
			var segmentOutput []byte
			for _, segment := range segments {
				segmentOutput = append(segmentOutput, segment.Data...)
			}
			require.Equal(t, expectedOutput, segmentOutput)

			requireBlockRuntimeDurableFinalWire(
				t,
				capture,
				model.StatusExited,
				test.durableStatus,
				"",
				intPtr(test.exitCode),
			)
			require.EqualValues(t, 1, capture.closed.Load())
			require.Zero(t, runtime.closed.Load(), "natural exit must not close the runtime again")
			_, ok := manager.GetBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
			require.False(t, ok)
		})
	}
}

func TestCloseBlockRuntimeFinalizesDurableBlockAsInterrupted(t *testing.T) {
	const (
		terminalID = "durable-close-terminal"
		blockID    = "durable-close-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	runtime := &blockRuntimeLifecycleTestRuntime{}
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	owner := registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, runtime)
	owner.recorder = newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, owner.recorder)
	capture := attachBlockRuntimeDurableCapture(owner)

	require.NoError(t, manager.CloseBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken))
	waitForBlockRuntimeDurableDone(t, owner)

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status)
	require.Nil(t, block.ExitCode)
	require.NotNil(t, block.FinishedAt)
	require.NotNil(t, block.OutputCursor)
	require.Zero(t, *block.OutputCursor)

	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, history.Status)
	require.Nil(t, history.ExitCode)
	require.NotNil(t, history.OutputCursor)
	require.Zero(t, *history.OutputCursor)

	requireBlockRuntimeDurableFinalWire(
		t,
		capture,
		model.StatusClosed,
		blockRuntimeDurableInterrupted,
		"",
		nil,
	)
	require.EqualValues(t, 1, runtime.closed.Load())
	require.EqualValues(t, 1, capture.closed.Load())
}

func TestBlockRuntimeFinalizerPublishesOnlyAfterDurableCommit(t *testing.T) {
	const (
		terminalID = "durable-order-terminal"
		blockID    = "durable-order-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	runtime := &blockRuntimeLifecycleTestRuntime{}
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	owner := registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, runtime)
	capture := attachBlockRuntimeDurableCapture(owner)

	updateStarted := make(chan struct{})
	releaseUpdate := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseUpdate) }) }
	const callbackName = "test:block_runtime_durable_publish_order"
	var callbackOnce sync.Once
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		callbackOnce.Do(func() {
			close(updateStarted)
			<-releaseUpdate
		})
	}))
	t.Cleanup(func() {
		release()
		_ = db.Callback().Update().Remove(callbackName)
	})

	finishDone := make(chan struct{})
	go func() {
		owner.finish(nil, model.StatusExited)
		close(finishDone)
	}()
	select {
	case <-updateStarted:
	case <-time.After(time.Second):
		t.Fatal("durable block update did not start")
	}

	require.Equal(t, model.StatusRunning, owner.snapshot().Status)
	info, ok := manager.GetBlockRuntime(terminalID, blockID, blockRuntimeDurableTestToken)
	require.True(t, ok)
	require.Equal(t, model.StatusRunning, info.Status)
	require.Empty(t, capture.messages())
	require.Zero(t, capture.closed.Load())
	require.Equal(t, BlockTermRuntimeRouteStatusBlock,
		manager.blockTermRoutes.ResolveByKey(terminalID, blockID, blockRuntimeDurableTestToken).Status)
	select {
	case <-finishDone:
		t.Fatal("runtime finish returned before the durable transaction completed")
	default:
	}

	release()
	select {
	case <-finishDone:
	case <-time.After(3 * time.Second):
		t.Fatal("runtime finish did not return after the durable transaction completed")
	}

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableSuccess, block.Status)
	requireBlockRuntimeDurableFinalWire(
		t,
		capture,
		model.StatusExited,
		blockRuntimeDurableSuccess,
		"",
		intPtr(0),
	)
	require.EqualValues(t, 1, capture.closed.Load())
	require.Equal(t, BlockTermRuntimeRouteStatusUnknownTagged,
		manager.blockTermRoutes.ResolveByKey(terminalID, blockID, blockRuntimeDurableTestToken).Status)
}

func TestBlockRuntimeFinalizerDoesNotOverwriteSettledDurableBlock(t *testing.T) {
	const (
		terminalID = "durable-fence-terminal"
		blockID    = "durable-fence-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, blockRuntimeDurableSuccess)
	originalCursor := int64(7)
	originalExitCode := 0
	originalFinishedAt := int64(99)
	originalOutput := []byte("settled")
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Updates(map[string]any{
		"output": originalOutput, "output_cursor": &originalCursor,
		"exit_code": &originalExitCode, "finished_at": &originalFinishedAt,
	}).Error)
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", blockID).Updates(map[string]any{
		"status": blockRuntimeDurableSuccess, "output": originalOutput,
		"output_cursor": &originalCursor, "exit_code": &originalExitCode,
		"finished_at": &originalFinishedAt,
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	owner := newBlockRuntimeLifecycleOwner(
		manager,
		terminalID,
		blockID,
		blockRuntimeDurableTestToken,
		&blockRuntimeLifecycleTestRuntime{exitCode: 42},
	)
	owner.status.Store(model.StatusRunning)
	owner.exitCode.Store(42)
	_, _ = owner.buffer.Write([]byte("late finalizer output"))

	require.NoError(t, owner.finalizeDurable(model.StatusExited))

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableSuccess, block.Status)
	require.Equal(t, originalOutput, block.Output)
	require.NotNil(t, block.OutputCursor)
	require.Equal(t, originalCursor, *block.OutputCursor)
	require.NotNil(t, block.ExitCode)
	require.Equal(t, originalExitCode, *block.ExitCode)
	require.NotNil(t, block.FinishedAt)
	require.Equal(t, originalFinishedAt, *block.FinishedAt)

	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableSuccess, history.Status)
	require.Equal(t, originalOutput, history.Output)
	require.NotNil(t, history.OutputCursor)
	require.Equal(t, originalCursor, *history.OutputCursor)
	require.NotNil(t, history.ExitCode)
	require.Equal(t, originalExitCode, *history.ExitCode)
}

func TestIndependentRestartFencesFinalizerDetachedByParentShutdown(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, model.StatusRunning, false)
	fixture.manager.ClearBlockRuntimePreparation(fixture.termID, fixture.blockID)
	gatedRuntime := &blockRuntimeCloseGateRuntime{
		closeStarted: make(chan struct{}),
		releaseClose: make(chan struct{}),
	}
	registerBlockRuntimeDurableOwner(t, fixture.manager, fixture.termID, fixture.blockID, gatedRuntime)

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- fixture.manager.CloseBlockRuntimesForTerminal(fixture.termID)
	}()
	select {
	case <-gatedRuntime.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("parent shutdown did not reach child runtime close")
	}

	// Route detachment happens before Runtime.Close. Restart must still wait for
	// the old lifecycle finalizer; otherwise it can reset the durable row to
	// running and have that row overwritten by the detached old owner.
	type restartResult struct {
		block *model.BlockTermBlock
		err   error
	}
	restartDone := make(chan restartResult, 1)
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true
	go func() {
		block, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
		restartDone <- restartResult{block: block, err: err}
	}()

	select {
	case result := <-restartDone:
		t.Fatalf("independent restart finished before child close release: block=%v err=%v", result.block, result.err)
	case <-time.After(100 * time.Millisecond):
		// Expected once parent shutdown owns the per-block lifecycle lock.
	}

	close(gatedRuntime.releaseClose)
	select {
	case err := <-closeDone:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("parent shutdown did not finish after releasing child close")
	}
	var result restartResult
	select {
	case result = <-restartDone:
	case <-time.After(3 * time.Second):
		t.Fatal("independent restart did not finish after child shutdown")
	}
	require.ErrorIs(t, result.err, ErrBlockTermRestartBusy)
	require.Nil(t, result.block)

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status,
		"parent shutdown must finalize the detached old lifecycle before rejecting restart")
	require.Nil(t, block.ExitCode)
	require.NotNil(t, block.FinishedAt)
}

func TestIndependentRestartDoesNotDeadlockTerminalDelete(t *testing.T) {
	const (
		terminalID = "restart-delete-lock-terminal"
		blockID    = "restart-delete-lock-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, &blockRuntimeLifecycleTestRuntime{})

	deleteQueryEntered := make(chan struct{})
	releaseDeleteQuery := make(chan struct{})
	var releaseOnce sync.Once
	releaseDelete := func() { releaseOnce.Do(func() { close(releaseDeleteQuery) }) }
	t.Cleanup(releaseDelete)
	var callbackOnce sync.Once
	const callbackName = "test:block_runtime_restart_delete_lock_order"
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.TerminalSession{}).TableName() {
			return
		}
		callbackOnce.Do(func() {
			close(deleteQueryEntered)
			<-releaseDeleteQuery
		})
	}))
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

	deleteDone := make(chan error, 1)
	go func() { deleteDone <- manager.Delete(terminalID) }()
	select {
	case <-deleteQueryEntered:
	case <-time.After(time.Second):
		t.Fatal("terminal delete did not enter its workspace-locked query")
	}

	previousProcs := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(previousProcs)
	restartStarted := make(chan struct{})
	restartDone := make(chan error, 1)
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true
	go func() {
		close(restartStarted)
		_, err := manager.RestartBlockTermBlock(blockID, request)
		restartDone <- err
	}()
	<-restartStarted

	// While Delete owns workspaceLifecycleMu, restart must wait before taking the
	// block lifecycle. The previous inverse order made Delete and restart wait on
	// each other permanently.
	probeDone := make(chan struct{})
	go func() {
		unlock := manager.LockBlockRuntimeLifecycle(terminalID, blockID)
		unlock()
		close(probeDone)
	}()
	select {
	case <-probeDone:
	case <-time.After(time.Second):
		t.Fatal("restart held the block lifecycle while waiting for the workspace lock")
	}

	releaseDelete()
	select {
	case err := <-deleteDone:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("terminal delete deadlocked with independent restart")
	}
	select {
	case err := <-restartDone:
		require.Error(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("independent restart did not return after terminal delete")
	}
}

func TestBlockRuntimeDurableFinalizerRetriesBeforePublishingSuccess(t *testing.T) {
	const (
		terminalID = "durable-retry-terminal"
		blockID    = "durable-retry-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	owner := registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, &blockRuntimeLifecycleTestRuntime{})
	capture := attachBlockRuntimeDurableCapture(owner)

	injectedErr := errors.New("injected durable retry failure")
	var attempts atomic.Int32
	const callbackName = "test:block_runtime_durable_retry_success"
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		attempt := attempts.Add(1)
		if attempt <= 3 {
			tx.AddError(injectedErr)
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	owner.finish(nil, model.StatusExited)

	require.EqualValues(t, 4, attempts.Load())
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableSuccess, block.Status)
	require.NotNil(t, block.ExitCode)
	require.Zero(t, *block.ExitCode)
	requireBlockRuntimeDurableFinalWire(
		t,
		capture,
		model.StatusExited,
		blockRuntimeDurableSuccess,
		"",
		intPtr(0),
	)
	owner.closeErrMu.Lock()
	closeErr := owner.closeErr
	owner.closeErrMu.Unlock()
	require.NoError(t, closeErr)
}

func TestBlockRuntimeDurableFinalizerPublishesFinalFailure(t *testing.T) {
	const (
		terminalID = "durable-failure-terminal"
		blockID    = "durable-failure-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	owner := registerBlockRuntimeDurableOwner(t, manager, terminalID, blockID, &blockRuntimeLifecycleTestRuntime{})
	capture := attachBlockRuntimeDurableCapture(owner)

	injectedErr := errors.New("injected durable terminal failure")
	var attempts atomic.Int32
	const callbackName = "test:block_runtime_durable_retry_failure"
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		attempts.Add(1)
		tx.AddError(injectedErr)
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	owner.finish(nil, model.StatusExited)

	require.EqualValues(t, 4, attempts.Load())
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, model.StatusRunning, block.Status)
	require.Nil(t, block.ExitCode)
	require.Nil(t, block.FinishedAt)
	requireBlockRuntimeDurableFinalWire(
		t,
		capture,
		model.StatusExited,
		model.StatusRunning,
		injectedErr.Error(),
		intPtr(0),
	)
	owner.closeErrMu.Lock()
	closeErr := owner.closeErr
	owner.closeErrMu.Unlock()
	require.ErrorContains(t, closeErr, injectedErr.Error())
}

func TestIndependentRestartPreparationIsConsumedByCreateBlockRuntime(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, blockRuntimeDurableSuccess, false)
	createdRuntime := &blockRuntimeLifecycleTestRuntime{}
	fixture.manager.runtimeFactory = runtimeFactoryFunc(func(RuntimeCreateRequest) (TerminalRuntime, error) {
		return createdRuntime, nil
	})
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true

	restarted, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	require.Equal(t, model.StatusRunning, restarted.Status)
	exists, exact, cancelled := fixture.manager.blockRuntimePreparationState(
		fixture.termID,
		fixture.blockID,
		blockRuntimeDurableTestToken,
	)
	require.True(t, exists)
	require.True(t, exact)
	require.False(t, cancelled)

	info, err := fixture.manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
		TerminalID:  fixture.termID,
		BlockID:     fixture.blockID,
		BlockToken:  blockRuntimeDurableTestToken,
		RuntimeType: RuntimeTypeSSH,
		Cwd:         "/tmp",
		Cols:        80,
		Rows:        24,
	})
	require.NoError(t, err)
	require.Equal(t, fixture.termID, info.TerminalID)
	require.Equal(t, fixture.blockID, info.BlockID)
	require.Equal(t, blockRuntimeDurableTestToken, info.BlockToken)
	exists, exact, cancelled = fixture.manager.blockRuntimePreparationState(
		fixture.termID,
		fixture.blockID,
		blockRuntimeDurableTestToken,
	)
	require.False(t, exists)
	require.False(t, exact)
	require.False(t, cancelled)

	require.Eventually(t, func() bool {
		var block model.BlockTermBlock
		if err := fixture.db.First(&block, "id = ?", fixture.blockID).Error; err != nil {
			return false
		}
		return block.Status == blockRuntimeDurableSuccess
	}, 3*time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool {
		return fixture.manager.BlockTermRuntimeRegistry().ResolveByKey(
			fixture.termID,
			fixture.blockID,
			blockRuntimeDurableTestToken,
		).Status == BlockTermRuntimeRouteStatusUnknownTagged
	}, 3*time.Second, 10*time.Millisecond)
}

func TestIndependentRestartRejectsExistingRuntimeOwner(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, blockRuntimeDurableSuccess, false)
	runtime := &blockRuntimeLifecycleTestRuntime{}
	owner := registerBlockRuntimeDurableOwner(t, fixture.manager, fixture.termID, fixture.blockID, runtime)
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true

	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "active independent runtime")

	require.NoError(t, fixture.manager.CloseBlockRuntime(
		fixture.termID,
		fixture.blockID,
		blockRuntimeDurableTestToken,
	))
	require.EqualValues(t, 1, runtime.closed.Load())
	require.NotNil(t, owner)
}

func TestIndependentRestartSameTokenRetryIsIdempotentAndDifferentTokenIsBusy(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, blockRuntimeDurableSuccess, false)
	t.Cleanup(func() {
		fixture.manager.ClearBlockRuntimePreparation(fixture.termID, fixture.blockID)
	})
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true

	first, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	require.Equal(t, model.StatusRunning, first.Status)
	require.NotNil(t, first.StartedAt)

	retainedOutput := []byte("new independent output")
	retainedCursor := int64(len(retainedOutput))
	require.NoError(t, fixture.db.Model(&model.BlockTermBlock{}).
		Where("id = ?", fixture.blockID).Updates(map[string]any{
		"output":        retainedOutput,
		"output_cursor": &retainedCursor,
		"updated_at":    int64(777),
	}).Error)
	require.NoError(t, fixture.db.Create(&model.BlockTermOutputSegment{
		ID: "independent-retry-retained-segment", TerminalID: fixture.termID, BlockID: fixture.blockID,
		StartCursor: 10, EndCursor: 13, Data: []byte("new"), CreatedAt: 10,
	}).Error)

	retry, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	require.Equal(t, first.StartedAt, retry.StartedAt)
	require.Equal(t, retainedOutput, retry.Output)
	require.NotNil(t, retry.OutputCursor)
	require.Equal(t, retainedCursor, *retry.OutputCursor)
	require.Equal(t, int64(777), retry.UpdatedAt)
	var segmentCount int64
	require.NoError(t, fixture.db.Model(&model.BlockTermOutputSegment{}).
		Where("block_id = ? AND terminal_id = ?", fixture.blockID, fixture.termID).
		Count(&segmentCount).Error)
	require.EqualValues(t, 1, segmentCount)
	exists, exact, cancelled := fixture.manager.blockRuntimePreparationState(
		fixture.termID,
		fixture.blockID,
		blockRuntimeDurableTestToken,
	)
	require.True(t, exists)
	require.True(t, exact)
	require.False(t, cancelled)

	different := blockTermRestartRequest(blockTermRestartOtherToken)
	different.IndependentRuntime = true
	_, err = fixture.manager.RestartBlockTermBlock(fixture.blockID, different)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, retainedOutput, block.Output)
	require.NotNil(t, block.OutputCursor)
	require.Equal(t, retainedCursor, *block.OutputCursor)
	require.Equal(t, int64(777), block.UpdatedAt)
	exists, exact, cancelled = fixture.manager.blockRuntimePreparationState(
		fixture.termID,
		fixture.blockID,
		blockTermRestartOtherToken,
	)
	require.True(t, exists)
	require.False(t, exact)
	require.False(t, cancelled)
}

func TestIndependentRestartCancelIsIdempotentAndFenced(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, blockRuntimeDurableSuccess, false)
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true
	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)

	// A foreign token cannot cancel the prepared independent lifecycle.
	_, err = fixture.manager.CancelBlockTermRestart(fixture.blockID, blockTermRestartOtherToken)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	interrupted, err := fixture.manager.CancelBlockTermRestart(fixture.blockID, blockRuntimeDurableTestToken)
	require.NoError(t, err)
	require.Equal(t, blockRuntimeDurableInterrupted, interrupted.Status)
	require.Nil(t, interrupted.ExitCode)
	require.NotNil(t, interrupted.FinishedAt)
	exists, exact, cancelled := fixture.manager.blockRuntimePreparationState(
		fixture.termID, fixture.blockID, blockRuntimeDurableTestToken,
	)
	require.False(t, exists)
	require.False(t, exact)
	require.False(t, cancelled)

	// Retrying the same cancellation is an idempotent acknowledgement.
	retry, err := fixture.manager.CancelBlockTermRestart(fixture.blockID, blockRuntimeDurableTestToken)
	require.NoError(t, err)
	require.Equal(t, interrupted.Status, retry.Status)
	require.Equal(t, interrupted.FinishedAt, retry.FinishedAt)
}

func TestIndependentRestartPreparationExpiryInterruptsAndRejectsCreate(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, blockRuntimeDurableSuccess, false)
	createdRuntime := &blockRuntimeLifecycleTestRuntime{}
	var factoryCalls atomic.Int32
	fixture.manager.runtimeFactory = runtimeFactoryFunc(func(RuntimeCreateRequest) (TerminalRuntime, error) {
		factoryCalls.Add(1)
		return createdRuntime, nil
	})
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true

	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	key := BlockTermRuntimeRouteKey{TerminalID: fixture.termID, BlockID: fixture.blockID}
	fixture.manager.blockRuntimePrepareMu.Lock()
	preparation := fixture.manager.blockRuntimePrepared[key]
	fixture.manager.blockRuntimePrepareMu.Unlock()
	require.NotNil(t, preparation)

	fixture.manager.expireBlockRuntimePreparation(key, preparation)

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status)
	require.Nil(t, block.ExitCode)
	require.NotNil(t, block.FinishedAt)
	exists, exact, cancelled := fixture.manager.blockRuntimePreparationState(
		fixture.termID,
		fixture.blockID,
		blockRuntimeDurableTestToken,
	)
	require.True(t, exists)
	require.True(t, exact)
	require.True(t, cancelled)

	_, err = fixture.manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
		TerminalID:  fixture.termID,
		BlockID:     fixture.blockID,
		BlockToken:  blockRuntimeDurableTestToken,
		RuntimeType: RuntimeTypeSSH,
		Cwd:         "/tmp",
		Cols:        80,
		Rows:        24,
	})
	require.ErrorIs(t, err, ErrBlockRuntimeNotRunning)
	require.Zero(t, factoryCalls.Load(), "expired preparation must be rejected before runtime construction")
	require.Equal(t, BlockTermRuntimeRouteStatusUnknownTagged,
		fixture.manager.BlockTermRuntimeRegistry().ResolveByKey(
			fixture.termID,
			fixture.blockID,
			blockRuntimeDurableTestToken,
		).Status)
	if factoryCalls.Load() > 0 {
		require.EqualValues(t, 1, createdRuntime.closed.Load())
	}
}

func assertBlockRuntimePreparationStateCleared(
	t *testing.T,
	manager *Manager,
	terminalID string,
	blockID string,
	token string,
) {
	t.Helper()
	exists, exact, cancelled := manager.blockRuntimePreparationState(terminalID, blockID, token)
	require.False(t, exists)
	require.False(t, exact)
	require.False(t, cancelled)
	cancellationExists, exactCancellation := manager.blockRuntimeCancellationState(terminalID, blockID, token)
	require.False(t, cancellationExists)
	require.False(t, exactCancellation)
}

func TestCloseBlockRuntimesForTerminalSettlesUnadmittedPreparation(t *testing.T) {
	const (
		terminalID = "close-preparation-only-terminal"
		blockID    = "close-preparation-only-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	manager.setBlockRuntimePreparation(terminalID, blockID, blockRuntimeDurableTestToken)

	require.NoError(t, manager.CloseBlockRuntimesForTerminal(terminalID))

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status)
	require.Nil(t, block.ExitCode)
	require.NotNil(t, block.FinishedAt)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, history.Status)
	assertBlockRuntimePreparationStateCleared(t, manager, terminalID, blockID, blockRuntimeDurableTestToken)
}

func TestCloseBlockRuntimesForTerminalJoinsRestartBeforePreparationPublish(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, blockRuntimeDurableSuccess, false)
	request := blockTermRestartRequest(blockRuntimeDurableTestToken)
	request.IndependentRuntime = true

	updateEntered := make(chan struct{})
	releaseUpdate := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseUpdate) }) }
	t.Cleanup(release)
	var callbackOnce sync.Once
	const callbackName = "test:block_runtime_close_restart_before_preparation"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		callbackOnce.Do(func() {
			close(updateEntered)
			<-releaseUpdate
		})
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })

	type restartResult struct {
		block *model.BlockTermBlock
		err   error
	}
	restartDone := make(chan restartResult, 1)
	go func() {
		block, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
		restartDone <- restartResult{block: block, err: err}
	}()
	select {
	case <-updateEntered:
	case <-time.After(time.Second):
		t.Fatal("independent restart did not reach its durable update")
	}

	// Restart has passed the closing check and reset is in flight, but its
	// preparation entry is deliberately not published yet.
	exists, _, _ := fixture.manager.blockRuntimePreparationState(
		fixture.termID, fixture.blockID, blockRuntimeDurableTestToken,
	)
	require.False(t, exists)
	closeDone := make(chan error, 1)
	go func() { closeDone <- fixture.manager.CloseBlockRuntimesForTerminal(fixture.termID) }()
	require.Eventually(t, func() bool {
		return fixture.manager.blockRuntimeTerminalClosing(fixture.termID)
	}, time.Second, time.Millisecond)
	select {
	case err := <-closeDone:
		t.Fatalf("terminal close returned before the in-flight restart published its preparation: %v", err)
	default:
	}

	release()
	select {
	case result := <-restartDone:
		require.NoError(t, result.err)
		require.NotNil(t, result.block)
	case <-time.After(3 * time.Second):
		t.Fatal("independent restart did not finish after durable update release")
	}
	select {
	case err := <-closeDone:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("terminal close did not join the late preparation")
	}

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status)
	assertBlockRuntimePreparationStateCleared(
		t,
		fixture.manager,
		fixture.termID,
		fixture.blockID,
		blockRuntimeDurableTestToken,
	)
}

func TestManagerCloseSettlesUnadmittedIndependentPreparation(t *testing.T) {
	const (
		terminalID = "manager-close-preparation-terminal"
		blockID    = "manager-close-preparation-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	runtime := newTailRuntime(nil, true)
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	manager.setBlockRuntimePreparation(terminalID, blockID, blockRuntimeDurableTestToken)
	go manager.ptyReadLoop(at)

	require.NoError(t, manager.Close(terminalID))

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status)
	var terminal model.TerminalSession
	require.NoError(t, db.First(&terminal, "id = ?", terminalID).Error)
	require.Equal(t, model.StatusClosed, terminal.Status)
	assertBlockRuntimePreparationStateCleared(t, manager, terminalID, blockID, blockRuntimeDurableTestToken)
}

func TestManagerNaturalExitSettlesUnadmittedIndependentPreparation(t *testing.T) {
	const (
		terminalID = "natural-exit-preparation-terminal"
		blockID    = "natural-exit-preparation-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	runtime := &blockRuntimeLifecycleTestRuntime{}
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	close(at.readDone)
	manager.setBlockRuntimePreparation(terminalID, blockID, blockRuntimeDurableTestToken)

	require.NoError(t, manager.monitorRuntime(at))

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, block.Status)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, blockRuntimeDurableInterrupted, history.Status)
	var terminal model.TerminalSession
	require.NoError(t, db.First(&terminal, "id = ?", terminalID).Error)
	require.Equal(t, model.StatusExited, terminal.Status)
	assertBlockRuntimePreparationStateCleared(t, manager, terminalID, blockID, blockRuntimeDurableTestToken)
}

func TestManagerDeleteClearsPreparationWithoutDurableInterruptedWrite(t *testing.T) {
	const (
		terminalID = "delete-preparation-only-terminal"
		blockID    = "delete-preparation-only-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	manager.setBlockRuntimePreparation(terminalID, blockID, blockRuntimeDurableTestToken)
	manager.markBlockRuntimeCancellation(terminalID, blockID, blockRuntimeDurableTestToken)

	const callbackName = "test:block_runtime_delete_no_block_update"
	var blockUpdate atomic.Int32
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermBlock{}).TableName() {
			blockUpdate.Add(1)
			tx.AddError(errors.New("unexpected block update during delete"))
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	require.NoError(t, manager.Delete(terminalID))
	require.Zero(t, blockUpdate.Load())
	assertBlockRuntimePreparationStateCleared(t, manager, terminalID, blockID, blockRuntimeDurableTestToken)
	var count int64
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Count(&count).Error)
	require.Zero(t, count)
}

func TestManagerDeleteWorkspaceClearsPreparationWithoutDurableInterruptedWrite(t *testing.T) {
	const (
		workspaceID = "delete-workspace-preparation-workspace"
		terminalID  = "delete-workspace-preparation-terminal"
		blockID     = "delete-workspace-preparation-block"
	)
	db := setupBlockRuntimeDurableDB(t)
	require.NoError(t, db.Create(&model.UserSession{ID: workspaceID, Name: workspaceID, State: "{}"}).Error)
	seedBlockRuntimeDurableRows(t, db, terminalID, blockID, model.StatusRunning)
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", terminalID).
		Update("workspace_session_id", workspaceID).Error)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	manager.setBlockRuntimePreparation(terminalID, blockID, blockRuntimeDurableTestToken)
	manager.markBlockRuntimeCancellation(terminalID, blockID, blockRuntimeDurableTestToken)

	const callbackName = "test:block_runtime_delete_workspace_no_block_update"
	var blockUpdate atomic.Int32
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermBlock{}).TableName() {
			blockUpdate.Add(1)
			tx.AddError(errors.New("unexpected block update during workspace delete"))
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	require.NoError(t, manager.DeleteWorkspace(workspaceID))
	require.Zero(t, blockUpdate.Load())
	assertBlockRuntimePreparationStateCleared(t, manager, terminalID, blockID, blockRuntimeDurableTestToken)
}

func TestCreateBlockRuntimeRejectsBeforeCallingFactory(t *testing.T) {
	tests := []struct {
		name      string
		prepare   func(*testing.T, *Manager, *gorm.DB, model.BlockTermBlock)
		wantError error
	}{
		{
			name: "invalid durable owner",
			prepare: func(t *testing.T, _ *Manager, db *gorm.DB, block model.BlockTermBlock) {
				require.NoError(t, db.Model(&model.BlockTermBlock{}).
					Where("id = ?", block.ID).Update("status", blockRuntimeDurableInterrupted).Error)
			},
			wantError: ErrBlockRuntimeNotRunning,
		},
		{
			name: "terminal is closing",
			prepare: func(t *testing.T, manager *Manager, _ *gorm.DB, block model.BlockTermBlock) {
				manager.ensureBlockRuntimeStore()
				manager.blockRuntimeMu.Lock()
				manager.blockRuntimeClosing[block.TerminalID] = struct{}{}
				manager.blockRuntimeMu.Unlock()
			},
			wantError: ErrBlockRuntimeNotRunning,
		},
		{
			name: "wrong preparation token",
			prepare: func(t *testing.T, manager *Manager, _ *gorm.DB, block model.BlockTermBlock) {
				manager.setBlockRuntimePreparation(block.TerminalID, block.ID, blockTermRestartOtherToken)
			},
			wantError: ErrBlockRuntimeAlreadyExists,
		},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			slug := fmt.Sprintf("case-%d", index)
			db := setupBlockRuntimeDurableDB(t)
			block := seedBlockRuntimeDurableRows(t, db,
				"create-admission-"+slug+"-terminal",
				"create-admission-"+slug+"-block",
				model.StatusRunning,
			)
			manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
			var factoryCalls atomic.Int32
			manager.runtimeFactory = runtimeFactoryFunc(func(RuntimeCreateRequest) (TerminalRuntime, error) {
				factoryCalls.Add(1)
				return &blockRuntimeLifecycleTestRuntime{}, nil
			})
			test.prepare(t, manager, db, block)
			t.Cleanup(func() {
				manager.ClearBlockRuntimePreparation(block.TerminalID, block.ID)
			})

			_, err := manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
				TerminalID:  block.TerminalID,
				BlockID:     block.ID,
				BlockToken:  blockRuntimeDurableTestToken,
				RuntimeType: RuntimeTypeSSH,
				Cwd:         "/tmp",
				Cols:        80,
				Rows:        24,
			})
			require.ErrorIs(t, err, test.wantError)
			require.Zero(t, factoryCalls.Load(), "runtime factory must not run before admission")
			require.Equal(t, BlockTermRuntimeRouteStatusUnknownTagged,
				manager.BlockTermRuntimeRegistry().ResolveByKey(
					block.TerminalID, block.ID, blockRuntimeDurableTestToken,
				).Status)
		})
	}
}

func TestCreateBlockRuntimeClosesPreparedRuntimeWhenOwnerChangesBeforeAdmission(t *testing.T) {
	db := setupBlockRuntimeDurableDB(t)
	block := seedBlockRuntimeDurableRows(t, db,
		"create-revalidate-terminal", "create-revalidate-block", model.StatusRunning)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	manager.setBlockRuntimePreparation(block.TerminalID, block.ID, blockRuntimeDurableTestToken)
	t.Cleanup(func() { manager.ClearBlockRuntimePreparation(block.TerminalID, block.ID) })

	runtime := &blockRuntimeLifecycleTestRuntime{}
	factoryEntered := make(chan struct{})
	releaseFactory := make(chan struct{})
	var factoryOnce sync.Once
	var factoryCalls atomic.Int32
	manager.runtimeFactory = runtimeFactoryFunc(func(RuntimeCreateRequest) (TerminalRuntime, error) {
		factoryCalls.Add(1)
		factoryOnce.Do(func() { close(factoryEntered) })
		<-releaseFactory
		return runtime, nil
	})

	createDone := make(chan error, 1)
	go func() {
		_, err := manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
			TerminalID:  block.TerminalID,
			BlockID:     block.ID,
			BlockToken:  blockRuntimeDurableTestToken,
			RuntimeType: RuntimeTypeSSH,
			Cwd:         "/tmp",
			Cols:        80,
			Rows:        24,
		})
		createDone <- err
	}()
	select {
	case <-factoryEntered:
	case <-time.After(time.Second):
		t.Fatal("runtime factory was not entered")
	}

	// The owner is revoked while runtime construction is in flight. The second
	// admission check must close the returned runtime and leave both route and
	// restart reservation untouched.
	require.NoError(t, db.Model(&model.BlockTermBlock{}).
		Where("id = ?", block.ID).
		Updates(map[string]any{"status": blockRuntimeDurableInterrupted, "exit_code": nil}).Error)
	close(releaseFactory)

	select {
	case err := <-createDone:
		require.ErrorIs(t, err, ErrBlockRuntimeNotRunning)
	case <-time.After(3 * time.Second):
		t.Fatal("CreateBlockRuntime did not return after factory release")
	}
	require.EqualValues(t, 1, factoryCalls.Load())
	require.EqualValues(t, 1, runtime.closed.Load(), "prepared runtime must be closed on admission failure")
	require.Equal(t, BlockTermRuntimeRouteStatusUnknownTagged,
		manager.BlockTermRuntimeRegistry().ResolveByKey(
			block.TerminalID, block.ID, blockRuntimeDurableTestToken,
		).Status)
	exists, exact, cancelled := manager.blockRuntimePreparationState(
		block.TerminalID, block.ID, blockRuntimeDurableTestToken,
	)
	require.True(t, exists)
	require.True(t, exact)
	require.False(t, cancelled)
}

func TestBlockTermOutputRecorderRetryDoesNotRecreateDeletedBlockSegment(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "recorder-delete-retry.sqlite")
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)",
		dbPath,
	)), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(4)
	sqlDB.SetMaxIdleConns(4)
	require.NoError(t, db.AutoMigrate(
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
		&model.BlockTermOutputSegment{},
	))
	const (
		terminalID = "recorder-delete-retry-terminal"
		blockID    = "recorder-delete-retry-block"
	)
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 1,
		Kind: "command", Command: "printf late", Status: model.StatusRunning,
		CreatedAt: now, UpdatedAt: now,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: blockID, TerminalID: terminalID, LineNum: 1,
		Kind: "command", Command: "printf late", Status: model.StatusRunning,
		CreatedAt: now, SnapshotUpdatedAt: now,
	}).Error)

	recorder := newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, recorder)
	firstPersistStarted := make(chan struct{})
	releaseFirstPersist := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseFirstPersist) }) }
	injectedErr := errors.New("injected first segment persistence failure")
	var segmentCreates atomic.Int32
	var historyReads atomic.Int32
	const createCallbackName = "test:blockterm_deleted_recorder_retry_create"
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(createCallbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermOutputSegment{}).TableName() {
			return
		}
		if segmentCreates.Add(1) == 1 {
			close(firstPersistStarted)
			<-releaseFirstPersist
			tx.AddError(injectedErr)
		}
	}))
	const queryCallbackName = "test:blockterm_deleted_recorder_retry_query"
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register(queryCallbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermCommandHistory{}).TableName() {
			historyReads.Add(1)
		}
	}))
	t.Cleanup(func() {
		release()
		_ = db.Callback().Create().Remove(createCallbackName)
		_ = db.Callback().Query().Remove(queryCallbackName)
		recorder.CloseInput()
		_ = recorder.Wait()
	})

	recorder.WriteRawBlock(blockID, []byte("late output"), 20)
	flushDone := make(chan error, 1)
	go func() { flushDone <- recorder.Flush() }()
	select {
	case <-firstPersistStarted:
	case <-time.After(time.Second):
		t.Fatal("first recorder persistence did not start")
	}

	deletedAt := time.Now().Unix()
	require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.BlockTermCommandHistory{}).Where("id = ?", blockID).
			UpdateColumn("block_deleted_at", deletedAt).Error; err != nil {
			return err
		}
		if err := tx.Where("terminal_id = ? AND block_id = ?", terminalID, blockID).
			Delete(&model.BlockTermOutputSegment{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.BlockTermBlock{}, "id = ? AND terminal_id = ?", blockID, terminalID).Error
	}))
	release()
	select {
	case flushErr := <-flushDone:
		require.NoError(t, flushErr)
	case <-time.After(3 * time.Second):
		t.Fatal("recorder retry did not finish after the tombstone was committed")
	}
	recorder.CloseInput()
	require.NoError(t, recorder.Wait())

	require.EqualValues(t, 1, segmentCreates.Load(), "retry must stop at the tombstone before segment creation")
	require.GreaterOrEqual(t, historyReads.Load(), int32(2), "retry must re-read the durable tombstone")
	var blockCount int64
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Count(&blockCount).Error)
	require.Zero(t, blockCount)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	require.NotNil(t, history.BlockDeletedAt)
	var segmentCount int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("terminal_id = ? AND block_id = ?", terminalID, blockID).Count(&segmentCount).Error)
	require.Zero(t, segmentCount)
}
