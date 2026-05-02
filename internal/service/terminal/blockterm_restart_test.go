package terminal

import (
	"encoding/base64"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const blockTermRestartTestToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
const blockTermRestartOtherToken = "fedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcba"

type blockTermRestartFixture struct {
	manager  *Manager
	active   *activeTerminal
	recorder *blockTermOutputRecorder
	db       *gorm.DB
	blockID  string
	termID   string
}

func newBlockTermRestartFixture(t *testing.T, status string, archived bool) blockTermRestartFixture {
	t.Helper()
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	termID := "restart-terminal"
	blockID := "restart-block"
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: termID, Status: model.StatusRunning, Readonly: false,
		RuntimeType: RuntimeTypeLocal, Cols: 80, Rows: 24,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: termID, LineNum: 7, Kind: "command",
		Command: "echo original", Text: "display text", Cwd: "/original",
		Status: status, Mode: "text", Output: []byte("legacy output"),
		TermCols: 80, TermRows: 24, TermFlexRows: false, TermMaxPTYSize: 4096,
		BeforeStateJSON: `{"cwd":"/before"}`, AfterStateJSON: `{"cwd":"/after"}`,
		Collapsed: true, Pinned: true, Archived: archived, Starred: true,
		Renderer: "terminal", StateJSON: `{"renderer":"state"}`,
		PresentationJSON: `{"height":123}`, ExitCode: intPtr(17),
		StartedAt: int64Ptr(1000), FinishedAt: int64Ptr(2000),
		CreatedAt: 11, UpdatedAt: 22,
	}).Error)

	recorder := newBlockTermOutputRecorder(db, termID)
	require.NotNil(t, recorder)
	runtime := &blockTermInputRuntime{}
	active := newBlockTermInputActive(termID, runtime, recorder)
	active.Done = make(chan struct{})
	active.readDone = make(chan struct{})
	manager := &Manager{db: db}
	manager.terminals.Store(termID, active)
	t.Cleanup(func() {
		manager.clearBlockTermPreparedRestartLeasesForTerminal(termID)
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})
	return blockTermRestartFixture{
		manager: manager, active: active, recorder: recorder,
		db: db, blockID: blockID, termID: termID,
	}
}

func intPtr(value int) *int { return &value }

func int64Ptr(value int64) *int64 { return &value }

func blockTermRestartRequest(token string) BlockTermRestartRequest {
	return BlockTermRestartRequest{
		Token:           token,
		Mode:            "terminal",
		TermCols:        120,
		TermRows:        32,
		TermFlexRows:    true,
		TermMaxPTYSize:  8192,
		BeforeStateJSON: `{"cwd":"/restarted"}`,
	}
}

func currentBlockTermRestartLease(fixture blockTermRestartFixture, token string) *blockTermPreparedRestartLease {
	key := blockTermPreparedRestartLeaseKey{
		TerminalID: fixture.termID,
		BlockID:    fixture.blockID,
		Token:      token,
	}
	fixture.manager.blockTermRestartLeaseMu.Lock()
	defer fixture.manager.blockTermRestartLeaseMu.Unlock()
	return fixture.manager.blockTermRestartLeases[key]
}

func newBlockTermRestartShutdownFixture(
	t *testing.T,
	terminalID string,
	runtime *tailRuntime,
) (*Manager, *activeTerminal, *blockTermOutputRecorder, *gorm.DB, string) {
	t.Helper()
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	blockID := terminalID + "-block"
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: terminalID, Status: model.StatusRunning, Readonly: false,
		RuntimeType: RuntimeTypeLocal, Cols: 80, Rows: 24,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 1, Kind: "command",
		Command: "echo restart", Status: "success", Mode: "text", Renderer: "terminal",
		BeforeStateJSON: `{"cwd":"/before"}`, AfterStateJSON: `{"cwd":"/after"}`,
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	recorder := newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, recorder)
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	at.outputRecorder = recorder
	t.Cleanup(func() {
		manager.clearBlockTermPreparedRestartLeasesForTerminal(terminalID)
		if at.flushTicker != nil {
			at.flushTicker.Stop()
		}
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})
	return manager, at, recorder, db, blockID
}

func TestManagerRestartBlockTermResetsOutputAndPreservesHistoryAndPresentation(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	require.NoError(t, fixture.db.Create(&model.BlockTermCommandHistory{
		ID: fixture.blockID, TerminalID: fixture.termID, LineNum: 7,
		Command: "echo original", Cwd: "/original", CreatedAt: 10,
	}).Error)
	require.NoError(t, fixture.db.Create(&model.BlockTermOutputSegment{
		ID: "restart-segment", TerminalID: fixture.termID, BlockID: fixture.blockID,
		StartCursor: 10, EndCursor: 22, Data: []byte("old raw data"), CreatedAt: 10,
	}).Error)

	request := blockTermRestartRequest(blockTermRestartTestToken)
	startedBefore := time.Now().Unix()
	got, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	startedAfter := time.Now().Unix()
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, fixture.blockID, got.ID)
	require.Equal(t, fixture.termID, got.TerminalID)
	require.Equal(t, 7, got.LineNum)
	require.Equal(t, "echo original", got.Command)
	require.Equal(t, "display text", got.Text)
	require.Equal(t, "/original", got.Cwd)
	require.Equal(t, "terminal", got.Renderer)
	require.Equal(t, `{"renderer":"state"}`, got.StateJSON)
	require.Equal(t, `{"height":123}`, got.PresentationJSON)
	require.True(t, got.Collapsed)
	require.True(t, got.Pinned)
	require.True(t, got.Starred)
	require.False(t, got.Archived)
	require.Equal(t, "running", got.Status)
	require.Equal(t, request.Mode, got.Mode)
	require.Equal(t, request.TermCols, got.TermCols)
	require.Equal(t, request.TermRows, got.TermRows)
	require.Equal(t, request.TermFlexRows, got.TermFlexRows)
	require.Equal(t, request.TermMaxPTYSize, got.TermMaxPTYSize)
	require.Equal(t, request.BeforeStateJSON, got.BeforeStateJSON)
	require.Empty(t, got.Output)
	require.Nil(t, got.OutputCursor)
	require.Nil(t, got.CmdPID)
	require.Nil(t, got.RemotePID)
	require.Empty(t, got.AfterStateJSON)
	require.Nil(t, got.ExitCode)
	require.Nil(t, got.FinishedAt)
	require.NotNil(t, got.StartedAt)
	require.GreaterOrEqual(t, *got.StartedAt, startedBefore)
	require.LessOrEqual(t, *got.StartedAt, startedAfter)
	require.Equal(t, int64(11), got.CreatedAt)
	require.NotEqual(t, int64(22), got.UpdatedAt)

	var segments []model.BlockTermOutputSegment
	require.NoError(t, fixture.db.Where("block_id = ?", fixture.blockID).Find(&segments).Error)
	require.Empty(t, segments)
	var history []model.BlockTermCommandHistory
	require.NoError(t, fixture.db.Where("id = ?", fixture.blockID).Find(&history).Error)
	require.Len(t, history, 1)
	require.Equal(t, "echo original", history[0].Command)
	require.Equal(t, "/original", history[0].Cwd)

	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
}

func TestManagerRestartBlockTermAllowsInterruptedAndArchivedExactTokenInput(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "interrupted", true)
	request := blockTermRestartRequest(blockTermRestartTestToken)
	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)

	oldMessage := WSMessage{
		Type: MsgTypeInput, BlockID: fixture.blockID, BlockToken: blockTermTestToken,
		Data: base64.StdEncoding.EncodeToString([]byte("old token input")),
	}
	_, oldMaster := runBlockTermClientMessage(t, fixture.manager, fixture.active, oldMessage)
	require.Empty(t, fixture.active.Runtime.(*blockTermInputRuntime).written())
	rejections := blockTermInputRejections(t, oldMaster)
	require.Len(t, rejections, 1)
	require.Equal(t, InputRejectedInvalidBlock, rejections[0].Reason)

	newMessage := WSMessage{
		Type: MsgTypeInput, BlockID: fixture.blockID, BlockToken: blockTermRestartTestToken,
		Data: base64.StdEncoding.EncodeToString([]byte("new token input")),
	}
	_, _ = runBlockTermClientMessage(t, fixture.manager, fixture.active, newMessage)
	writes := fixture.active.Runtime.(*blockTermInputRuntime).written()
	require.Len(t, writes, 1)
	require.Equal(t, "new token input", string(writes[0]))
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "expected", phase)
	require.Nil(t, currentBlockTermRestartLease(fixture, blockTermRestartTestToken))
}

func TestManagerRestartBlockTermSameTokenRetryIsIdempotentAndDifferentTokenIsBusy(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "interrupted", false)
	request := blockTermRestartRequest(blockTermRestartTestToken)
	first, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	require.NotNil(t, first.StartedAt)

	// Simulate output that arrived after the first response was lost. An
	// idempotent retry must return the row as-is instead of clearing this data.
	firstOutput := []byte("new lifecycle output")
	require.NoError(t, fixture.db.Model(&model.BlockTermBlock{}).Where("id = ?", fixture.blockID).Updates(map[string]any{
		"output": firstOutput, "updated_at": int64(777),
	}).Error)
	require.NoError(t, fixture.db.Create(&model.BlockTermOutputSegment{
		ID: "new-retry-segment", TerminalID: fixture.termID, BlockID: fixture.blockID,
		StartCursor: 50, EndCursor: 50 + uint64(len(firstOutput)), Data: firstOutput, CreatedAt: 777,
	}).Error)

	retry, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	require.Equal(t, *first.StartedAt, *retry.StartedAt)
	require.Equal(t, firstOutput, retry.Output)
	require.Equal(t, int64(777), retry.UpdatedAt)
	var count int64
	require.NoError(t, fixture.db.Model(&model.BlockTermOutputSegment{}).Where("block_id = ?", fixture.blockID).Count(&count).Error)
	require.Equal(t, int64(1), count)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)

	_, err = fixture.manager.RestartBlockTermBlock(fixture.blockID, BlockTermRestartRequest{
		Token:           blockTermRestartOtherToken,
		Mode:            request.Mode,
		TermCols:        request.TermCols,
		TermRows:        request.TermRows,
		TermFlexRows:    request.TermFlexRows,
		TermMaxPTYSize:  request.TermMaxPTYSize,
		BeforeStateJSON: request.BeforeStateJSON,
	})
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	phase, ok = fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
}

func TestManagerRestartBlockTermSameTokenRetryRenewsPreparedLease(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "interrupted", false)
	request := blockTermRestartRequest(blockTermRestartTestToken)
	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)

	fixture.manager.scheduleBlockTermPreparedRestartExpiry(
		fixture.termID,
		fixture.blockID,
		blockTermRestartTestToken,
		100*time.Millisecond,
	)
	oldLease := currentBlockTermRestartLease(fixture, blockTermRestartTestToken)
	require.NotNil(t, oldLease)
	time.Sleep(20 * time.Millisecond)

	_, err = fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)
	newLease := currentBlockTermRestartLease(fixture, blockTermRestartTestToken)
	require.NotNil(t, newLease)
	require.NotSame(t, oldLease, newLease)

	time.Sleep(130 * time.Millisecond)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "running", block.Status)
}

func TestManagerRestartBlockTermRejectsActiveParserForInterruptedDurableBlock(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "interrupted", false)
	require.True(t, fixture.recorder.ExpectBlock(fixture.blockID, blockTermTestToken))
	require.Empty(t, fixture.recorder.parser.Feed(blockTermTestOSCStart(fixture.blockID), 0))

	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "interrupted", block.Status)
	require.Equal(t, []byte("legacy output"), block.Output)
	require.Equal(t, fixture.blockID, fixture.recorder.parser.activeBlockID)
	require.Equal(t, blockTermTestToken, fixture.recorder.parser.activeBlockToken)
}

func TestManagerRestartBlockTermRejectsMissingUnsupportedBusyAndReadonly(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		fixture := newBlockTermRestartFixture(t, "success", false)
		_, err := fixture.manager.RestartBlockTermBlock("missing-block", blockTermRestartRequest(blockTermRestartTestToken))
		require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	})

	t.Run("unsupported kind and renderer", func(t *testing.T) {
		fixture := newBlockTermRestartFixture(t, "success", false)
		require.NoError(t, fixture.db.Create(&model.BlockTermBlock{
			ID: "restart-note", TerminalID: fixture.termID, LineNum: 8,
			Kind: "note", Status: "success",
		}).Error)
		require.NoError(t, fixture.db.Create(&model.BlockTermBlock{
			ID: "restart-model", TerminalID: fixture.termID, LineNum: 9,
			Kind: "command", Renderer: "openai", Status: "success",
		}).Error)
		for _, blockID := range []string{"restart-note", "restart-model"} {
			_, err := fixture.manager.RestartBlockTermBlock(blockID, blockTermRestartRequest(blockTermRestartTestToken))
			require.ErrorIs(t, err, ErrBlockTermRestartUnsupported)
		}
	})

	t.Run("already running", func(t *testing.T) {
		fixture := newBlockTermRestartFixture(t, "running", false)
		_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, blockTermRestartRequest(blockTermRestartTestToken))
		require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	})

	t.Run("readonly terminal", func(t *testing.T) {
		fixture := newBlockTermRestartFixture(t, "success", false)
		require.NoError(t, fixture.db.Model(&model.TerminalSession{}).Where("id = ?", fixture.termID).Updates(map[string]any{
			"readonly": true,
		}).Error)
		fixture.active.sessionMu.Lock()
		fixture.active.Session.Readonly = true
		fixture.active.sessionMu.Unlock()
		_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, blockTermRestartRequest(blockTermRestartTestToken))
		require.ErrorIs(t, err, ErrBlockTermRestartUnsupported)
	})
}

func TestManagerRestartBlockTermMutationFailureDoesNotReserveToken(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	forcedErr := errors.New("forced restart mutation failure")
	const callbackName = "test:blockterm_restart_mutation_failure"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })

	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, blockTermRestartRequest(blockTermRestartTestToken))
	require.ErrorIs(t, err, forcedErr)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.False(t, ok)
	require.Empty(t, phase)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "success", block.Status)
	require.Equal(t, []byte("legacy output"), block.Output)
}

func TestManagerCancelBlockTermRestartReleasesExactPreparedToken(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)
	require.NotNil(t, currentBlockTermRestartLease(fixture, blockTermRestartTestToken))

	_, err = fixture.manager.CancelBlockTermRestart(fixture.blockID, blockTermRestartOtherToken)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
	require.NotNil(t, currentBlockTermRestartLease(fixture, blockTermRestartTestToken))

	interrupted, err := fixture.manager.CancelBlockTermRestart(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	require.Equal(t, "interrupted", interrupted.Status)
	require.Equal(t, interrupted.BeforeStateJSON, interrupted.AfterStateJSON)
	require.Nil(t, interrupted.ExitCode)
	require.NotNil(t, interrupted.FinishedAt)
	_, ok = fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.False(t, ok)
	require.Nil(t, currentBlockTermRestartLease(fixture, blockTermRestartTestToken))
	retry, err := fixture.manager.CancelBlockTermRestart(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	require.Equal(t, interrupted.Status, retry.Status)
	require.Equal(t, interrupted.FinishedAt, retry.FinishedAt)
	_, err = fixture.manager.CancelBlockTermRestart(fixture.blockID, blockTermRestartOtherToken)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	_, err = fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartOtherToken),
	)
	require.NoError(t, err)
	phase, ok = fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartOtherToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
}

func TestManagerCancelBlockTermRestartMutationFailurePreservesPreparedToken(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)

	forcedErr := errors.New("forced restart cancellation failure")
	const callbackName = "test:blockterm_restart_cancel_mutation_failure"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })

	_, err = fixture.manager.CancelBlockTermRestart(fixture.blockID, blockTermRestartTestToken)
	require.ErrorIs(t, err, forcedErr)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
	require.NotNil(t, currentBlockTermRestartLease(fixture, blockTermRestartTestToken))
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "running", block.Status)
}

func TestManagerPreparedRestartExpiryInterruptsAndReleasesReservation(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)

	fixture.manager.expireBlockTermPreparedRestart(fixture.termID, fixture.blockID, blockTermRestartTestToken)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.False(t, ok)
	require.Empty(t, phase)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "interrupted", block.Status)
	require.Equal(t, block.BeforeStateJSON, block.AfterStateJSON)

	_, err = fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartOtherToken),
	)
	require.NoError(t, err)
}

func TestManagerValidateBlockTermOwnershipMutationFencesRestartLifecycle(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	request := blockTermRestartRequest(blockTermRestartTestToken)
	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, request)
	require.NoError(t, err)

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	candidate := block
	candidate.LineNum++
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "running command lifecycle")

	settled := block
	settled.Status = "success"
	settledCandidate := settled
	settledCandidate.LineNum++
	err = fixture.manager.ValidateBlockTermOwnershipMutation(settled, settledCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "active output lifecycle")

	_, err = fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	err = fixture.manager.ValidateBlockTermOwnershipMutation(settled, settledCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	start := blockTermTestOSCStartWithToken(fixture.blockID, blockTermRestartTestToken)
	fixture.recorder.Write(start, 0)
	err = fixture.manager.ValidateBlockTermOwnershipMutation(settled, settledCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	end := blockTermTestOSCEndWithToken(fixture.blockID, blockTermRestartTestToken)
	fixture.recorder.Write(end, uint64(len(start)))
	barrier, err := fixture.recorder.BeginFlush()
	require.NoError(t, err)
	require.NoError(t, <-barrier)
	_, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.False(t, bound)
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "command", block.Kind)
	require.Equal(t, "running", block.Status)
	candidate = block
	candidate.LineNum++
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "running command lifecycle")

	nonCommand := block
	nonCommand.Kind = "note"
	nonCommandCandidate := nonCommand
	nonCommandCandidate.LineNum++
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(nonCommand, nonCommandCandidate))
	finished := block
	finished.Status = "success"
	finishedCandidate := finished
	finishedCandidate.LineNum++
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(finished, finishedCandidate))
	inactive := block
	inactive.ID = "inactive-running-block"
	inactive.TerminalID = "inactive-terminal"
	inactiveCandidate := inactive
	inactiveCandidate.LineNum++
	err = fixture.manager.ValidateBlockTermOwnershipMutation(inactive, inactiveCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "running command lifecycle")

	inactiveSettled := inactive
	inactiveSettled.Status = "success"
	inactiveRunningCandidate := inactiveSettled
	inactiveRunningCandidate.LineNum++
	inactiveRunningCandidate.Status = "running"
	err = fixture.manager.ValidateBlockTermOwnershipMutation(inactiveSettled, inactiveRunningCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "running command lifecycle")
}

func TestManagerValidateBlockTermOwnershipMutationFencesClosedRestartRecorderUntilDrain(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)

	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	block.Status = "success"
	candidate := block
	candidate.LineNum++

	persistStarted := make(chan struct{})
	releasePersist := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releasePersist) }) }
	const callbackName = "test:blockterm_restart_closed_recorder_delayed_create"
	var blockOnce sync.Once
	require.NoError(t, fixture.db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermOutputSegment{}).TableName() {
			blockOnce.Do(func() {
				close(persistStarted)
				<-releasePersist
			})
		}
	}))
	t.Cleanup(func() {
		_ = fixture.db.Callback().Create().Remove(callbackName)
		release()
	})

	_, err = fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	start := blockTermTestOSCStartWithToken(fixture.blockID, blockTermRestartTestToken)
	fixture.recorder.Write(append(append([]byte{}, start...), []byte("pending")...), 0)
	fixture.recorder.CloseInput()
	select {
	case <-persistStarted:
	case <-time.After(time.Second):
		t.Fatal("recorder persistence did not start")
	}

	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "active output lifecycle")

	release()
	require.NoError(t, fixture.recorder.Wait())
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate))
}

func TestManagerValidateBlockTermOwnershipMutationFencesOrdinaryLifecycleUntilDrain(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	candidate := block
	candidate.LineNum++

	_, err := fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	start := blockTermTestOSCStartWithToken(fixture.blockID, blockTermRestartTestToken)
	fixture.recorder.Write(start, 0)
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	const nextBlockID = "restart-next-block"
	_, err = fixture.recorder.expectBlock(nextBlockID, blockTermRestartOtherToken)
	require.NoError(t, err)
	state := fixture.recorder.CurrentState()
	require.Equal(t, nextBlockID, state.BlockID)
	require.Equal(t, fixture.blockID, state.BlockTailID)
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)

	fixture.active.status.Store(model.StatusExited)
	fixture.recorder.CloseInput()
	require.NoError(t, fixture.recorder.Wait())
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(block, candidate))
	movedCandidate := block
	movedCandidate.TerminalID = "restart-drained-target"
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(block, movedCandidate))
}

func TestManagerValidateBlockTermOwnershipMutationWaitsForSourceDrain(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)

	lineCandidate := block
	lineCandidate.LineNum++
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(block, lineCandidate))

	runningCandidate := lineCandidate
	runningCandidate.Status = "running"
	err := fixture.manager.ValidateBlockTermOwnershipMutation(block, runningCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "running command lifecycle")

	movedCandidate := block
	movedCandidate.TerminalID = "restart-target-terminal"
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, movedCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "source terminal is still running")

	fixture.active.status.Store(model.StatusExited)
	err = fixture.manager.ValidateBlockTermOwnershipMutation(block, movedCandidate)
	require.ErrorIs(t, err, ErrBlockTermRestartBusy)
	require.Contains(t, err.Error(), "source output is still draining")

	fixture.recorder.CloseInput()
	require.NoError(t, fixture.recorder.Wait())
	require.NoError(t, fixture.manager.ValidateBlockTermOwnershipMutation(block, movedCandidate))
}

func TestManagerPreparedRestartExpiryRetriesDatabaseFailure(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)

	forcedErr := errors.New("forced prepared expiry failure")
	var attempts atomic.Int32
	const callbackName = "test:blockterm_prepared_expiry_retry"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() && attempts.Add(1) == 1 {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })

	fixture.manager.scheduleBlockTermPreparedRestartExpiry(
		fixture.termID,
		fixture.blockID,
		blockTermRestartTestToken,
		10*time.Millisecond,
	)
	require.Eventually(t, func() bool { return attempts.Load() >= 1 }, time.Second, 5*time.Millisecond)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "prepared", phase)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "running", block.Status)

	require.Eventually(t, func() bool {
		if err := fixture.db.First(&block, "id = ?", fixture.blockID).Error; err != nil {
			return false
		}
		_, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
		return block.Status == "interrupted" && !bound
	}, 2*time.Second, 10*time.Millisecond)
	require.Nil(t, currentBlockTermRestartLease(fixture, blockTermRestartTestToken))
}

func TestManagerPreparedRestartExpiryReleasesReservationAfterBlockMutation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, blockTermRestartFixture)
	}{
		{
			name: "patched interrupted",
			mutate: func(t *testing.T, fixture blockTermRestartFixture) {
				require.NoError(t, fixture.db.Model(&model.BlockTermBlock{}).
					Where("id = ?", fixture.blockID).Update("status", "interrupted").Error)
			},
		},
		{
			name: "deleted",
			mutate: func(t *testing.T, fixture blockTermRestartFixture) {
				require.NoError(t, fixture.db.Delete(&model.BlockTermBlock{}, "id = ?", fixture.blockID).Error)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newBlockTermRestartFixture(t, "success", false)
			_, err := fixture.manager.RestartBlockTermBlock(
				fixture.blockID,
				blockTermRestartRequest(blockTermRestartTestToken),
			)
			require.NoError(t, err)
			test.mutate(t, fixture)

			fixture.manager.expireBlockTermPreparedRestart(fixture.termID, fixture.blockID, blockTermRestartTestToken)
			require.False(t, fixture.recorder.HasPreparedBinding())
		})
	}
}

func TestManagerExpectedRestartTimeoutInterruptsDurableRowBeforeParserCancel(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)
	generation, err := fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	fixture.manager.clearBlockTermPreparedRestartLease(fixture.termID, fixture.blockID, blockTermRestartTestToken)

	master := &mockMaster{}
	fixture.active.Connections.Store("timeout", &terminalConnection{ID: "timeout", Master: master})
	timer := fixture.manager.scheduleBlockTermExpectationTimeout(
		fixture.active,
		fixture.recorder,
		fixture.blockID,
		blockTermRestartTestToken,
		generation,
		10*time.Millisecond,
	)
	t.Cleanup(func() { timer.Stop() })

	var block model.BlockTermBlock
	require.Eventually(t, func() bool {
		if err := fixture.db.First(&block, "id = ?", fixture.blockID).Error; err != nil {
			return false
		}
		_, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
		return block.Status == "interrupted" && !bound
	}, time.Second, 5*time.Millisecond)
	require.Eventually(t, func() bool {
		return len(blockTermInputRejections(t, master)) == 1
	}, time.Second, 5*time.Millisecond)
	rejections := blockTermInputRejections(t, master)
	require.Equal(t, InputRejectedRecorderTimeout, rejections[0].Reason)
	require.Equal(t, fixture.blockID, rejections[0].BlockID)
	require.Equal(t, blockTermRestartTestToken, rejections[0].BlockToken)
}

func TestManagerExpectedRestartTimeoutRetriesDatabaseFailure(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)
	generation, err := fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	fixture.manager.clearBlockTermPreparedRestartLease(fixture.termID, fixture.blockID, blockTermRestartTestToken)

	forcedErr := errors.New("forced expected timeout failure")
	var attempts atomic.Int32
	const callbackName = "test:blockterm_expected_timeout_retry"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() && attempts.Add(1) == 1 {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })
	master := &mockMaster{}
	fixture.active.Connections.Store("timeout-retry", &terminalConnection{ID: "timeout-retry", Master: master})
	timer := fixture.manager.scheduleBlockTermExpectationTimeout(
		fixture.active,
		fixture.recorder,
		fixture.blockID,
		blockTermRestartTestToken,
		generation,
		10*time.Millisecond,
	)
	t.Cleanup(func() { timer.Stop() })

	require.Eventually(t, func() bool { return attempts.Load() >= 1 }, time.Second, 5*time.Millisecond)
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "expected", phase)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "running", block.Status)
	require.Empty(t, blockTermInputRejections(t, master))

	require.Eventually(t, func() bool {
		if err := fixture.db.First(&block, "id = ?", fixture.blockID).Error; err != nil {
			return false
		}
		_, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
		return block.Status == "interrupted" && !bound
	}, 2*time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool {
		return len(blockTermInputRejections(t, master)) == 1
	}, time.Second, 5*time.Millisecond)
}

func TestManagerRestartWriteFailureRetriesAtomicCleanup(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)

	forcedErr := errors.New("forced write cleanup failure")
	var attempts atomic.Int32
	const callbackName = "test:blockterm_restart_write_cleanup_retry"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() && attempts.Add(1) == 1 {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })
	runtime := fixture.active.Runtime.(*blockTermInputRuntime)
	runtime.writeErr = errors.New("restart runtime write failed")
	runtime.partialWriteLen = 1

	err, master := runBlockTermClientMessage(t, fixture.manager, fixture.active, WSMessage{
		Type:       MsgTypeInput,
		Data:       base64.StdEncoding.EncodeToString([]byte("wrapped restart")),
		BlockID:    fixture.blockID,
		BlockToken: blockTermRestartTestToken,
	})
	require.ErrorIs(t, err, runtime.writeErr)
	require.Equal(t, int32(1), attempts.Load())
	phase, ok := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, ok)
	require.Equal(t, "expected", phase)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "running", block.Status)
	rejections := blockTermInputRejections(t, master)
	require.Len(t, rejections, 1)
	require.Equal(t, InputRejectedRuntimeWriteFailed, rejections[0].Reason)

	require.Eventually(t, func() bool {
		if err := fixture.db.First(&block, "id = ?", fixture.blockID).Error; err != nil {
			return false
		}
		_, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
		return block.Status == "interrupted" && !bound
	}, 2*time.Second, 10*time.Millisecond)
	require.Len(t, blockTermInputRejections(t, master), 1)

	runtime.writeErr = nil
	runtime.partialWriteLen = 0
	_, err = fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartOtherToken),
	)
	require.NoError(t, err)
}

func TestManagerTaggedINTInterruptsExpectedRestartDurably(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)
	_, err = fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	fixture.manager.clearBlockTermPreparedRestartLease(fixture.termID, fixture.blockID, blockTermRestartTestToken)

	_, master := runBlockTermClientMessage(t, fixture.manager, fixture.active, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "INT",
		BlockID:    fixture.blockID,
		BlockToken: blockTermRestartTestToken,
	})
	require.Empty(t, blockTermInputRejections(t, master))
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "interrupted", block.Status)
	require.Nil(t, block.ExitCode)
	_, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.False(t, bound)
	writes := fixture.active.Runtime.(*blockTermInputRuntime).written()
	require.Equal(t, [][]byte{{3}}, writes)
}

func TestManagerTaggedINTRestartCleanupRetriesDatabaseFailure(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	_, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)
	generation, err := fixture.recorder.expectBlock(fixture.blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	fixture.manager.clearBlockTermPreparedRestartLease(fixture.termID, fixture.blockID, blockTermRestartTestToken)

	forcedErr := errors.New("forced restart signal cleanup failure")
	var attempts atomic.Int32
	const callbackName = "test:blockterm_restart_signal_cleanup_retry"
	require.NoError(t, fixture.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() && attempts.Add(1) == 1 {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = fixture.db.Callback().Update().Remove(callbackName) })

	_, master := runBlockTermClientMessage(t, fixture.manager, fixture.active, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "INT",
		BlockID:    fixture.blockID,
		BlockToken: blockTermRestartTestToken,
	})
	require.Empty(t, blockTermInputRejections(t, master))
	require.Equal(t, int32(1), attempts.Load())
	phase, bound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
	require.True(t, bound)
	require.Equal(t, "expected", phase)
	_, _, _, currentGeneration := fixture.recorder.CurrentSignalBindingGeneration()
	require.Equal(t, generation, currentGeneration)
	var block model.BlockTermBlock
	require.NoError(t, fixture.db.First(&block, "id = ?", fixture.blockID).Error)
	require.Equal(t, "running", block.Status)

	require.Eventually(t, func() bool {
		if err := fixture.db.First(&block, "id = ?", fixture.blockID).Error; err != nil {
			return false
		}
		_, stillBound := fixture.recorder.RearmBindingState(fixture.blockID, blockTermRestartTestToken)
		return attempts.Load() >= 2 && block.Status == "interrupted" && !stillBound
	}, 2*time.Second, 10*time.Millisecond)
	writes := fixture.active.Runtime.(*blockTermInputRuntime).written()
	require.Equal(t, [][]byte{{3}}, writes)
}

func TestManagerCloseInterruptsPreparedRestartAfterRecorderDrain(t *testing.T) {
	const terminalID = "restart-prepared-close"
	runtime := newTailRuntime(nil, true)
	manager, at, recorder, db, blockID := newBlockTermRestartShutdownFixture(t, terminalID, runtime)
	go manager.ptyReadLoop(at)
	select {
	case <-runtime.started:
	case <-time.After(time.Second):
		t.Fatal("reader did not start")
	}

	_, err := manager.RestartBlockTermBlock(blockID, blockTermRestartRequest(blockTermRestartTestToken))
	require.NoError(t, err)
	phase, bound := recorder.RearmBindingState(blockID, blockTermRestartTestToken)
	require.True(t, bound)
	require.Equal(t, "prepared", phase)
	forcedErr := errors.New("forced close restart cleanup failure")
	var attempts atomic.Int32
	const callbackName = "test:blockterm_restart_close_cleanup_retry"
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.BlockTermBlock{}).TableName() && attempts.Add(1) == 1 {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })
	require.NoError(t, manager.Close(terminalID))
	require.GreaterOrEqual(t, attempts.Load(), int32(2))

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, "interrupted", block.Status)
	require.Nil(t, block.ExitCode)
	require.Equal(t, block.BeforeStateJSON, block.AfterStateJSON)
	_, bound = recorder.RearmBindingState(blockID, blockTermRestartTestToken)
	require.False(t, bound)
	key := blockTermPreparedRestartLeaseKey{
		TerminalID: terminalID,
		BlockID:    blockID,
		Token:      blockTermRestartTestToken,
	}
	manager.blockTermRestartLeaseMu.Lock()
	_, leased := manager.blockTermRestartLeases[key]
	manager.blockTermRestartLeaseMu.Unlock()
	require.False(t, leased)
	var terminal model.TerminalSession
	require.NoError(t, db.First(&terminal, "id = ?", terminalID).Error)
	require.Equal(t, model.StatusClosed, terminal.Status)
}

func TestManagerNaturalExitInterruptsExpectedRestartAfterRecorderDrain(t *testing.T) {
	const terminalID = "restart-expected-exit"
	runtime := newTailRuntime(nil, true)
	manager, at, recorder, db, blockID := newBlockTermRestartShutdownFixture(t, terminalID, runtime)
	go manager.ptyReadLoop(at)
	select {
	case <-runtime.started:
	case <-time.After(time.Second):
		t.Fatal("reader did not start")
	}

	_, err := manager.RestartBlockTermBlock(blockID, blockTermRestartRequest(blockTermRestartTestToken))
	require.NoError(t, err)
	_, err = recorder.expectBlock(blockID, blockTermRestartTestToken)
	require.NoError(t, err)
	manager.clearBlockTermPreparedRestartLease(terminalID, blockID, blockTermRestartTestToken)

	monitorDone := make(chan error, 1)
	go func() { monitorDone <- manager.monitorRuntime(at) }()
	require.NoError(t, runtime.Close())
	select {
	case err := <-monitorDone:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("monitor did not finish after runtime exit")
	}

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, "interrupted", block.Status)
	require.Nil(t, block.ExitCode)
	_, bound := recorder.RearmBindingState(blockID, blockTermRestartTestToken)
	require.False(t, bound)
	require.True(t, recorder.closed)
}

func TestManagerRestartBlockTermRequiresActiveWritableRuntime(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	fixture.manager.terminals.Delete(fixture.termID)
	_, err := fixture.manager.RestartBlockTermBlock(fixture.blockID, blockTermRestartRequest(blockTermRestartTestToken))
	require.ErrorIs(t, err, ErrTerminalNotFound)
}
