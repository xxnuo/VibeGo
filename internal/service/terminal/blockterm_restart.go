package terminal

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermhistory"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	blockTermRestartMinCols       = 10
	blockTermRestartMaxCols       = 1024
	blockTermRestartMinRows       = 2
	blockTermRestartMaxRows       = 1024
	blockTermRestartMaxStateBytes = 4 * 1024
	blockTermPreparedRestartTTL   = 8 * time.Second
	blockTermPreparedRetryDelay   = 250 * time.Millisecond
)

type blockTermPreparedRestartLeaseKey struct {
	TerminalID string
	BlockID    string
	Token      string
}

type blockTermPreparedRestartLease struct {
	timer *time.Timer
}

// BlockTermRestartRequest describes the new execution lifecycle for an
// existing durable command block. Token is the HTTP-facing field; BlockToken
// is retained as a service-level compatibility alias.
type BlockTermRestartRequest struct {
	Token      string
	BlockToken string
	// IndependentRuntime selects the per-block PTY lifecycle. In this mode the
	// parent terminal recorder is deliberately untouched and sibling command
	// blocks may run concurrently. The follow-up CreateBlockRuntime call owns
	// the same block/token route.
	IndependentRuntime bool
	Mode               string
	TermCols           int
	TermRows           int
	TermFlexRows       bool
	TermMaxPTYSize     int
	BeforeStateJSON    string
}

func (request BlockTermRestartRequest) lifecycleToken() (string, error) {
	if request.Token != "" && request.BlockToken != "" && request.Token != request.BlockToken {
		return "", fmt.Errorf("%w: token aliases disagree", ErrBlockTermRestartInvalid)
	}
	token := request.Token
	if token == "" {
		token = request.BlockToken
	}
	if !validBlockTermToken(token) {
		return "", fmt.Errorf("%w: token must be 32-128 hexadecimal characters", ErrBlockTermRestartInvalid)
	}
	return token, nil
}

func validateBlockTermRestartRequest(blockID string, request BlockTermRestartRequest) (string, error) {
	if !validBlockTermBlockID(blockID) {
		return "", fmt.Errorf("%w: invalid block id", ErrBlockTermRestartInvalid)
	}
	token, err := request.lifecycleToken()
	if err != nil {
		return "", err
	}
	if request.Mode != "text" && request.Mode != "terminal" {
		return "", fmt.Errorf("%w: mode must be text or terminal", ErrBlockTermRestartInvalid)
	}
	if request.TermCols != 0 &&
		(request.TermCols < blockTermRestartMinCols || request.TermCols > blockTermRestartMaxCols) {
		return "", fmt.Errorf(
			"%w: term_cols must be between %d and %d",
			ErrBlockTermRestartInvalid,
			blockTermRestartMinCols,
			blockTermRestartMaxCols,
		)
	}
	if request.TermRows != 0 &&
		(request.TermRows < blockTermRestartMinRows || request.TermRows > blockTermRestartMaxRows) {
		return "", fmt.Errorf(
			"%w: term_rows must be between %d and %d",
			ErrBlockTermRestartInvalid,
			blockTermRestartMinRows,
			blockTermRestartMaxRows,
		)
	}
	if request.TermMaxPTYSize < 0 || request.TermMaxPTYSize > model.BlockTermMaxPTYSize {
		return "", fmt.Errorf(
			"%w: term_max_pty_size must be between 0 and %d",
			ErrBlockTermRestartInvalid,
			model.BlockTermMaxPTYSize,
		)
	}
	if len(request.BeforeStateJSON) > blockTermRestartMaxStateBytes {
		return "", fmt.Errorf(
			"%w: before_state_json too long, max length is %d",
			ErrBlockTermRestartInvalid,
			blockTermRestartMaxStateBytes,
		)
	}
	if request.BeforeStateJSON != "" {
		var state map[string]json.RawMessage
		if err := json.Unmarshal([]byte(request.BeforeStateJSON), &state); err != nil || state == nil {
			return "", fmt.Errorf("%w: before_state_json must be a valid JSON object", ErrBlockTermRestartInvalid)
		}
	}
	return token, nil
}

func validateBlockTermRestartTarget(block model.BlockTermBlock) error {
	if block.Kind != "command" || block.Renderer == "openai" {
		return fmt.Errorf("%w: block %s is not a shell command block", ErrBlockTermRestartUnsupported, block.ID)
	}
	if block.Status == "streaming" {
		return fmt.Errorf("%w: block %s is already active", ErrBlockTermRestartBusy, block.ID)
	}
	return nil
}

func blockTermRestartRequestMatches(block model.BlockTermBlock, request BlockTermRestartRequest) bool {
	return block.Status == "running" &&
		block.Mode == request.Mode &&
		block.TermCols == request.TermCols &&
		block.TermRows == request.TermRows &&
		block.TermFlexRows == request.TermFlexRows &&
		block.TermMaxPTYSize == request.TermMaxPTYSize &&
		block.BeforeStateJSON == request.BeforeStateJSON
}

func (m *Manager) activeBlockRuntimeOwner(terminalID, blockID string) *activeBlockRuntime {
	if m == nil {
		return nil
	}
	m.ensureBlockRuntimeStore()
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimeMu.RLock()
	owner := m.blockRuntimes[key]
	m.blockRuntimeMu.RUnlock()
	return owner
}

func (m *Manager) blockRuntimePreparationState(terminalID, blockID, token string) (exists, exact, cancelled bool) {
	if m == nil {
		return false, false, false
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimePrepareMu.Lock()
	entry := m.blockRuntimePrepared[key]
	if entry == nil {
		m.blockRuntimePrepareMu.Unlock()
		return false, false, false
	}
	exact = entry.token == token
	cancelled = entry.cancelled
	m.blockRuntimePrepareMu.Unlock()
	return true, exact, cancelled
}

func (m *Manager) setBlockRuntimePreparation(terminalID, blockID, token string) {
	if m == nil {
		return
	}
	m.clearBlockRuntimeCancellation(terminalID, blockID)
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	entry := &blockRuntimePreparation{token: token}
	m.blockRuntimePrepareMu.Lock()
	if m.blockRuntimePrepared == nil {
		m.blockRuntimePrepared = make(map[BlockTermRuntimeRouteKey]*blockRuntimePreparation)
	}
	if previous := m.blockRuntimePrepared[key]; previous != nil && previous.timer != nil {
		previous.timer.Stop()
	}
	m.blockRuntimePrepared[key] = entry
	entry.timer = time.AfterFunc(blockTermPreparedRestartTTL, func() {
		m.expireBlockRuntimePreparation(key, entry)
	})
	m.blockRuntimePrepareMu.Unlock()
}

func (m *Manager) consumeBlockRuntimePreparation(terminalID, blockID, token string) bool {
	if m == nil {
		return false
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimePrepareMu.Lock()
	defer m.blockRuntimePrepareMu.Unlock()
	entry := m.blockRuntimePrepared[key]
	if entry == nil || entry.token != token || entry.cancelled {
		return false
	}
	delete(m.blockRuntimePrepared, key)
	if entry.timer != nil {
		entry.timer.Stop()
	}
	return true
}

// ClearBlockRuntimePreparation releases an abandoned independent restart
// reservation. The caller serializes this with the block lifecycle lock.
func (m *Manager) ClearBlockRuntimePreparation(terminalID, blockID string) {
	if m == nil {
		return
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimePrepareMu.Lock()
	entry := m.blockRuntimePrepared[key]
	delete(m.blockRuntimePrepared, key)
	var timer *time.Timer
	if entry != nil {
		timer = entry.timer
		entry.timer = nil
	}
	m.blockRuntimePrepareMu.Unlock()
	if timer != nil {
		timer.Stop()
	}
	m.clearBlockRuntimeCancellation(terminalID, blockID)
}

func (m *Manager) blockRuntimeCancellationState(terminalID, blockID, token string) (exists, exact bool) {
	if m == nil {
		return false, false
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimeCancelMu.Lock()
	cancelledToken, exists := m.blockRuntimeCancelled[key]
	m.blockRuntimeCancelMu.Unlock()
	return exists, exists && cancelledToken == token
}

func (m *Manager) markBlockRuntimeCancellation(terminalID, blockID, token string) {
	if m == nil {
		return
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimeCancelMu.Lock()
	if m.blockRuntimeCancelled == nil {
		m.blockRuntimeCancelled = make(map[BlockTermRuntimeRouteKey]string)
	}
	m.blockRuntimeCancelled[key] = token
	m.blockRuntimeCancelMu.Unlock()
}

func (m *Manager) clearBlockRuntimeCancellation(terminalID, blockID string) {
	if m == nil {
		return
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimeCancelMu.Lock()
	delete(m.blockRuntimeCancelled, key)
	m.blockRuntimeCancelMu.Unlock()
}

// blockRuntimePreparationKeysForTerminal snapshots every independent runtime
// lifecycle marker for a terminal. Cancellation markers are included because a
// cancelled preparation is still an ABA fence until its owning terminal is
// closed or deleted.
func (m *Manager) blockRuntimePreparationKeysForTerminal(terminalID string) []BlockTermRuntimeRouteKey {
	if m == nil || terminalID == "" {
		return nil
	}
	keys := make(map[BlockTermRuntimeRouteKey]struct{})
	m.blockRuntimePrepareMu.Lock()
	for key := range m.blockRuntimePrepared {
		if key.TerminalID == terminalID {
			keys[key] = struct{}{}
		}
	}
	m.blockRuntimePrepareMu.Unlock()
	m.blockRuntimeCancelMu.Lock()
	for key := range m.blockRuntimeCancelled {
		if key.TerminalID == terminalID {
			keys[key] = struct{}{}
		}
	}
	m.blockRuntimeCancelMu.Unlock()

	result := make([]BlockTermRuntimeRouteKey, 0, len(keys))
	for key := range keys {
		result = append(result, key)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].BlockID != result[j].BlockID {
			return result[i].BlockID < result[j].BlockID
		}
		return result[i].TerminalID < result[j].TerminalID
	})
	return result
}

// blockRuntimeLifecycleKeysForTerminal snapshots all in-memory lifecycle
// markers and durable block IDs for a terminal. The durable IDs cover a restart
// that already passed the closing check but has not yet installed its map
// entry.
func (m *Manager) blockRuntimeLifecycleKeysForTerminal(
	terminalID string,
) ([]BlockTermRuntimeRouteKey, error) {
	if m == nil || terminalID == "" {
		return nil, nil
	}
	unique := make(map[BlockTermRuntimeRouteKey]struct{})
	for _, key := range m.blockRuntimePreparationKeysForTerminal(terminalID) {
		unique[key] = struct{}{}
	}
	if m.db != nil && m.db.Migrator().HasTable(&model.BlockTermBlock{}) {
		var blockIDs []string
		if err := m.db.Model(&model.BlockTermBlock{}).
			Where("terminal_id = ?", terminalID).
			Pluck("id", &blockIDs).Error; err != nil {
			return nil, err
		}
		for _, blockID := range blockIDs {
			if validBlockTermBlockID(blockID) {
				unique[BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}] = struct{}{}
			}
		}
	}
	keys := make([]BlockTermRuntimeRouteKey, 0, len(unique))
	for key := range unique {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].BlockID != keys[j].BlockID {
			return keys[i].BlockID < keys[j].BlockID
		}
		return keys[i].TerminalID < keys[j].TerminalID
	})
	return keys, nil
}

// lockBlockRuntimePreparationKeysForTerminal joins all preparation lifecycles
// that existed after the terminal closing marker was published. A brief
// mutation-gate barrier lets operations which crossed the marker finish their
// durable reset before the first snapshot; durable block IDs then cover the
// window before the in-memory preparation entry is installed. No mutation gate
// is held while waiting for a lifecycle lock.
func (m *Manager) lockBlockRuntimePreparationKeysForTerminal(
	terminalID string,
) ([]BlockTermRuntimeRouteKey, []func(), error) {
	if m == nil || terminalID == "" {
		return nil, nil, nil
	}
	// Do not hold a lifecycle lock across this barrier. An in-flight restart
	// holds its lifecycle lock while acquiring the mutation gate.
	m.blockTermMutationMu.Lock()
	m.blockTermMutationMu.Unlock()

	locked := make(map[BlockTermRuntimeRouteKey]struct{})
	keys := make([]BlockTermRuntimeRouteKey, 0)
	unlockers := make([]func(), 0)
	for {
		pending, err := m.blockRuntimeLifecycleKeysForTerminal(terminalID)
		if err != nil {
			return keys, unlockers, err
		}
		added := false
		for _, key := range pending {
			if _, exists := locked[key]; exists {
				continue
			}
			unlockers = append(unlockers, m.LockBlockRuntimeLifecycle(key.TerminalID, key.BlockID))
			locked[key] = struct{}{}
			keys = append(keys, key)
			added = true
		}
		if !added {
			break
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].BlockID != keys[j].BlockID {
			return keys[i].BlockID < keys[j].BlockID
		}
		return keys[i].TerminalID < keys[j].TerminalID
	})
	return keys, unlockers, nil
}

// removeBlockRuntimePreparationIfCurrent removes one preparation without
// touching a replacement lifecycle. The timer is stopped after releasing the
// map lock so a callback can never observe a partially-mutated entry.
func (m *Manager) removeBlockRuntimePreparationIfCurrent(
	key BlockTermRuntimeRouteKey,
	expected *blockRuntimePreparation,
) *time.Timer {
	if m == nil {
		return nil
	}
	m.blockRuntimePrepareMu.Lock()
	current := m.blockRuntimePrepared[key]
	if expected != nil && current != expected {
		m.blockRuntimePrepareMu.Unlock()
		return nil
	}
	if current == nil {
		m.blockRuntimePrepareMu.Unlock()
		return nil
	}
	delete(m.blockRuntimePrepared, key)
	timer := current.timer
	current.timer = nil
	m.blockRuntimePrepareMu.Unlock()
	if timer != nil {
		timer.Stop()
	}
	return timer
}

// clearBlockRuntimePreparationStateForTerminal drops all in-memory independent
// lifecycle markers for a terminal. It is used after a delete transaction has
// removed the durable rows, so it intentionally performs no database writes.
// The caller holds the workspace lifecycle write lock; expiry callbacks take
// the corresponding read lock and therefore cannot race this sweep.
func (m *Manager) clearBlockRuntimePreparationStateForTerminal(terminalID string) {
	if m == nil || terminalID == "" {
		return
	}
	var timers []*time.Timer
	m.blockRuntimePrepareMu.Lock()
	for key, entry := range m.blockRuntimePrepared {
		if key.TerminalID != terminalID {
			continue
		}
		delete(m.blockRuntimePrepared, key)
		if entry != nil && entry.timer != nil {
			timers = append(timers, entry.timer)
			entry.timer = nil
		}
	}
	m.blockRuntimePrepareMu.Unlock()
	m.blockRuntimeCancelMu.Lock()
	for key := range m.blockRuntimeCancelled {
		if key.TerminalID == terminalID {
			delete(m.blockRuntimeCancelled, key)
		}
	}
	m.blockRuntimeCancelMu.Unlock()
	for _, timer := range timers {
		timer.Stop()
	}
}

// settleBlockRuntimePreparationsForTerminal finishes independent restarts that
// were durable-running but never admitted a child runtime. It must be called
// after the terminal closing marker is published and after active child owners
// have been closed. The workspace read lock is held by the caller.
func (m *Manager) settleBlockRuntimePreparationsForTerminal(terminalID string) error {
	if m == nil || !validBlockTermRuntimeTerminalID(terminalID) {
		return nil
	}
	keys, unlockers, lockErr := m.lockBlockRuntimePreparationKeysForTerminal(terminalID)
	defer func() {
		for index := len(unlockers) - 1; index >= 0; index-- {
			unlockers[index]()
		}
	}()
	if lockErr != nil {
		return lockErr
	}

	// Join active finalizers before taking the mutation gate. Their durable
	// completion path also takes this gate, and holding it while waiting would
	// deadlock parent shutdown.
	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	var errs []error
	for _, key := range keys {
		m.blockRuntimePrepareMu.Lock()
		entry := m.blockRuntimePrepared[key]
		cancelled := entry != nil && entry.cancelled
		m.blockRuntimePrepareMu.Unlock()
		if entry == nil {
			continue
		}
		if cancelled {
			m.removeBlockRuntimePreparationIfCurrent(key, entry)
			continue
		}
		if err := m.interruptOwnedRunningBlockTermRestart(key.TerminalID, key.BlockID); err != nil {
			errs = append(errs, fmt.Errorf(
				"settle independent BlockTerm preparation %s/%s: %w",
				key.TerminalID,
				key.BlockID,
				err,
			))
			continue
		}
		m.removeBlockRuntimePreparationIfCurrent(key, entry)
	}
	// A cancellation marker has no useful meaning once its parent terminal is
	// closed. Clear it even when a durable retry is retained above; the retry is
	// represented by the preparation entry and its timer.
	m.blockRuntimeCancelMu.Lock()
	for key := range m.blockRuntimeCancelled {
		if key.TerminalID == terminalID {
			delete(m.blockRuntimeCancelled, key)
		}
	}
	m.blockRuntimeCancelMu.Unlock()
	return joinTerminalErrors(errs...)
}

func (m *Manager) expireBlockRuntimePreparation(
	key BlockTermRuntimeRouteKey,
	entry *blockRuntimePreparation,
) {
	if m == nil {
		return
	}
	// Workspace deletion takes the write side before removing durable rows. The
	// read lock keeps expiry from writing an interrupted state into a block that
	// the delete transaction is about to remove.
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	unlock := m.LockBlockRuntimeLifecycle(key.TerminalID, key.BlockID)
	defer unlock()
	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	m.blockRuntimePrepareMu.Lock()
	current := m.blockRuntimePrepared[key]
	if current != entry || entry.cancelled {
		m.blockRuntimePrepareMu.Unlock()
		return
	}
	if m.activeBlockRuntimeOwner(key.TerminalID, key.BlockID) != nil {
		delete(m.blockRuntimePrepared, key)
		m.blockRuntimePrepareMu.Unlock()
		return
	}
	entry.timer = nil
	m.blockRuntimePrepareMu.Unlock()
	if err := m.interruptOwnedRunningBlockTermRestart(key.TerminalID, key.BlockID); err != nil {
		log.Printf("independent BlockTerm restart expiry failed for terminal %s block %s: %v", key.TerminalID, key.BlockID, err)
		m.blockRuntimePrepareMu.Lock()
		if m.blockRuntimePrepared[key] == entry && !entry.cancelled {
			entry.timer = time.AfterFunc(blockTermPreparedRetryDelay, func() {
				m.expireBlockRuntimePreparation(key, entry)
			})
		}
		m.blockRuntimePrepareMu.Unlock()
		return
	}
	m.blockRuntimePrepareMu.Lock()
	if m.blockRuntimePrepared[key] == entry {
		entry.cancelled = true
		entry.timer = nil
	}
	m.blockRuntimePrepareMu.Unlock()
}

func blockTermRestartRecorderError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, errBlockTermRecorderBusy):
		return fmt.Errorf("%w: %v", ErrBlockTermRestartBusy, err)
	case errors.Is(err, errBlockTermRecorderUnavailable), errors.Is(err, errBlockTermRecorderFailed):
		return fmt.Errorf("%w: %v", ErrBlockTermRestartUnavailable, err)
	default:
		return err
	}
}

func blockTermRestartInterruptedUpdates(block model.BlockTermBlock, finishedAt int64) map[string]any {
	return map[string]any{
		"status":           "interrupted",
		"cmd_pid":          nil,
		"remote_pid":       nil,
		"after_state_json": block.BeforeStateJSON,
		"exit_code":        nil,
		"finished_at":      finishedAt,
		"updated_at":       finishedAt,
	}
}

// ValidateBlockTermOwnershipMutation checks whether a block's terminal/line
// ownership may be changed. Callers pass both durable states from inside their
// database transaction and must hold BlockTermMutationGate while applying the
// mutation so tagged input cannot invalidate ownership midway.
func (m *Manager) ValidateBlockTermOwnershipMutation(
	existing model.BlockTermBlock,
	candidate model.BlockTermBlock,
) error {
	if existing.ID == "" || existing.TerminalID == "" ||
		(existing.TerminalID == candidate.TerminalID && existing.LineNum == candidate.LineNum) {
		return nil
	}
	if (existing.Kind == "command" && existing.Status == "running") ||
		(candidate.Kind == "command" && candidate.Status == "running") {
		return fmt.Errorf("%w: block %s has a running command lifecycle", ErrBlockTermRestartBusy, existing.ID)
	}

	var source *activeTerminal
	sourceRecorderDrained := true
	sourceLifecycleBound := false
	if m != nil {
		if at, ok := m.getActive(existing.TerminalID); ok {
			source = at
			at.outputRecorderMu.Lock()
			recorder := at.outputRecorder
			sourceLifecycleBound = recorder != nil && recorder.HasLifecycleBindingForBlock(existing.ID)
			sourceRecorderDrained = recorder == nil || recorder.IsDrained()
			at.outputRecorderMu.Unlock()
		}
	}
	if sourceLifecycleBound && !sourceRecorderDrained {
		return fmt.Errorf("%w: block %s has an active output lifecycle", ErrBlockTermRestartBusy, existing.ID)
	}

	commandMoved := existing.TerminalID != candidate.TerminalID &&
		(existing.Kind == "command" || candidate.Kind == "command")
	if commandMoved && source != nil {
		if source.status.Load().(string) == model.StatusRunning {
			return fmt.Errorf("%w: block %s source terminal is still running", ErrBlockTermRestartBusy, existing.ID)
		}
		if !sourceRecorderDrained {
			return fmt.Errorf("%w: block %s source output is still draining", ErrBlockTermRestartBusy, existing.ID)
		}
	}
	return nil
}

// interruptOwnedRunningBlockTermRestart is the durable half of timeout and
// runtime-write cleanup. Callers hold the BlockTerm mutation gate and invoke it
// from a recorder transaction so parser cancellation is committed only after
// this database mutation succeeds.
func (m *Manager) interruptOwnedRunningBlockTermRestart(terminalID, blockID string) error {
	if m == nil || m.db == nil {
		return ErrBlockTermRestartUnavailable
	}
	return m.db.Transaction(func(tx *gorm.DB) error {
		var block model.BlockTermBlock
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&block, "id = ?", blockID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if block.TerminalID != terminalID || block.Status != "running" {
			return nil
		}
		finishedAt := time.Now().Unix()
		result := tx.Model(&model.BlockTermBlock{}).
			Where("id = ? AND terminal_id = ? AND status = ?", block.ID, terminalID, "running").
			Updates(blockTermRestartInterruptedUpdates(block, finishedAt))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return fmt.Errorf("%w: block %s restart state changed", ErrBlockTermRestartBusy, blockID)
		}
		return blocktermhistory.SyncByID(tx, block.ID)
	})
}

// interruptPendingBlockTermRestartAfterRuntimeStop settles a prepared or
// expected restart after the PTY reader and recorder worker have stopped.
// Closed recorders still retain the exact parser binding needed for fencing.
func (m *Manager) interruptPendingBlockTermRestartAfterRuntimeStop(
	at *activeTerminal,
	recorder *blockTermOutputRecorder,
) error {
	var lastErr error
	for attempt := 0; attempt < blockTermRecorderMaxAttempts; attempt++ {
		handled, err := m.tryInterruptPendingBlockTermRestartAfterRuntimeStop(at, recorder)
		if err == nil || !handled {
			return err
		}
		lastErr = err
		if attempt+1 < blockTermRecorderMaxAttempts {
			time.Sleep(blockTermPreparedRetryDelay)
		}
	}
	return lastErr
}

func (m *Manager) tryInterruptPendingBlockTermRestartAfterRuntimeStop(
	at *activeTerminal,
	recorder *blockTermOutputRecorder,
) (bool, error) {
	if m == nil || at == nil || recorder == nil {
		return false, nil
	}
	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	at.inputMu.Lock()
	defer at.inputMu.Unlock()
	at.outputRecorderMu.Lock()
	defer at.outputRecorderMu.Unlock()
	if at.outputRecorder != recorder {
		return false, nil
	}

	blockID, token, phase, generation := recorder.PendingRearmBinding()
	switch phase {
	case "prepared":
		err := recorder.WithCancelPreparedBlock(blockID, token, func() error {
			return m.interruptOwnedRunningBlockTermRestart(at.ID, blockID)
		})
		return true, err
	case "expected":
		return recorder.WithCancelExpectedRearmBlockGeneration(
			blockID,
			token,
			generation,
			func() error {
				return m.interruptOwnedRunningBlockTermRestart(at.ID, blockID)
			},
		)
	default:
		return false, nil
	}
}

// RestartBlockTermBlock resets one durable command block in place. The
// recorder barrier is ordered with PTY delivery, and the parser transition is
// published only after the database transaction commits.
func (m *Manager) RestartBlockTermBlock(
	blockID string,
	request BlockTermRestartRequest,
) (*model.BlockTermBlock, error) {
	token, err := validateBlockTermRestartRequest(blockID, request)
	if err != nil {
		return nil, err
	}
	if m == nil || m.db == nil {
		return nil, ErrBlockTermRestartUnavailable
	}
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	// Serialize this lifecycle with child-runtime creation and durable deletion.
	// The key is the globally stable block ID; terminal_id is intentionally not
	// part of the lock because a legacy PATCH may move a block between terminals.
	unlockBlockLifecycle := m.LockBlockRuntimeLifecycle("", blockID)
	defer unlockBlockLifecycle()

	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()

	var initial model.BlockTermBlock
	if err := m.db.First(&initial, "id = ?", blockID).Error; err != nil {
		return nil, err
	}
	if m.blockRuntimeTerminalClosing(initial.TerminalID) {
		return nil, fmt.Errorf("%w: terminal %s is closing", ErrBlockTermRestartBusy, initial.TerminalID)
	}
	if err := validateBlockTermRestartTarget(initial); err != nil {
		return nil, err
	}
	if request.IndependentRuntime {
		return m.restartBlockTermBlockIndependent(initial, request, token)
	}

	at, ok := m.getActive(initial.TerminalID)
	if !ok {
		return nil, ErrTerminalNotFound
	}
	at.modelRunMu.Lock()
	defer at.modelRunMu.Unlock()
	at.runtimeMu.RLock()
	defer at.runtimeMu.RUnlock()
	at.inputMu.Lock()
	defer at.inputMu.Unlock()

	at.stateMu.Lock()
	running := at.status.Load().(string) == model.StatusRunning
	at.sessionMu.RLock()
	readonly := at.Session == nil || at.Session.Readonly
	sessionID := ""
	if at.Session != nil {
		sessionID = at.Session.ID
	}
	at.sessionMu.RUnlock()
	hasRuntime := at.Runtime != nil
	at.stateMu.Unlock()
	if !running || readonly {
		return nil, fmt.Errorf("%w: terminal %s is not writable", ErrBlockTermRestartUnsupported, initial.TerminalID)
	}
	if !hasRuntime || at.ID != initial.TerminalID || sessionID != initial.TerminalID {
		return nil, fmt.Errorf("%w: terminal %s has no active runtime", ErrBlockTermRestartUnavailable, initial.TerminalID)
	}
	if owner := m.activeBlockRuntimeOwner(initial.TerminalID, blockID); owner != nil {
		return nil, fmt.Errorf("%w: block %s has an active independent runtime", ErrBlockTermRestartBusy, blockID)
	}

	// Keep the PTY reader behind the same delivery boundary used by recorder
	// writes while the old FIFO is drained and durable output is cleared.
	at.deliveryMu.Lock()
	defer at.deliveryMu.Unlock()
	at.outputRecorderMu.Lock()
	recorder := at.outputRecorder
	if recorder == nil {
		at.outputRecorderMu.Unlock()
		return nil, ErrBlockTermRestartUnavailable
	}
	if initial.Status == "running" {
		phase, sameLifecycle := recorder.RearmBindingState(blockID, token)
		at.outputRecorderMu.Unlock()
		if sameLifecycle && blockTermRestartRequestMatches(initial, request) {
			if phase == "prepared" {
				m.scheduleBlockTermPreparedRestartExpiry(initial.TerminalID, blockID, token, blockTermPreparedRestartTTL)
			} else {
				m.clearBlockTermPreparedRestartLease(initial.TerminalID, blockID, token)
			}
			return &initial, nil
		}
		return nil, fmt.Errorf("%w: block %s already has a different active lifecycle", ErrBlockTermRestartBusy, blockID)
	}
	barrier, err := recorder.BeginFlush()
	at.outputRecorderMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBlockTermRestartUnavailable, err)
	}
	if err := <-barrier; err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBlockTermRestartUnavailable, err)
	}

	at.outputRecorderMu.Lock()
	defer at.outputRecorderMu.Unlock()
	if at.outputRecorder != recorder {
		return nil, ErrBlockTermRestartUnavailable
	}

	var restarted model.BlockTermBlock
	err = recorder.WithRearmBlock(blockID, token, func() error {
		return m.db.Transaction(func(tx *gorm.DB) error {
			var block model.BlockTermBlock
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&block, "id = ?", blockID).Error; err != nil {
				return err
			}
			if block.TerminalID != initial.TerminalID {
				return fmt.Errorf("%w: block terminal changed", ErrBlockTermRestartBusy)
			}
			if err := validateBlockTermRestartTarget(block); err != nil {
				return err
			}

			var terminal model.TerminalSession
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&terminal, "id = ?", block.TerminalID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrTerminalNotFound
				}
				return err
			}
			if terminal.Status != model.StatusRunning || terminal.Readonly {
				return fmt.Errorf("%w: terminal %s is not writable", ErrBlockTermRestartUnsupported, block.TerminalID)
			}

			var activeOwners int64
			if err := tx.Model(&model.BlockTermBlock{}).
				Where(
					"terminal_id = ? AND id <> ? AND kind = ? AND status IN ?",
					block.TerminalID,
					block.ID,
					"command",
					[]string{"running", "streaming"},
				).
				Count(&activeOwners).Error; err != nil {
				return err
			}
			if activeOwners > 0 {
				return fmt.Errorf("%w: terminal %s already has an active command", ErrBlockTermRestartBusy, block.TerminalID)
			}

			startedAt := time.Now().Unix()
			updatedAt := time.Now().Unix()
			result := tx.Model(&model.BlockTermBlock{}).
				Where("id = ? AND terminal_id = ?", block.ID, block.TerminalID).
				Updates(map[string]any{
					"status":            "running",
					"mode":              request.Mode,
					"output":            []byte{},
					"output_cursor":     nil,
					"cmd_pid":           nil,
					"remote_pid":        nil,
					"term_cols":         request.TermCols,
					"term_rows":         request.TermRows,
					"term_flex_rows":    request.TermFlexRows,
					"term_max_pty_size": request.TermMaxPTYSize,
					"before_state_json": request.BeforeStateJSON,
					"after_state_json":  "",
					"exit_code":         nil,
					"started_at":        startedAt,
					"finished_at":       nil,
					"updated_at":        updatedAt,
				})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return gorm.ErrRecordNotFound
			}
			if tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := tx.Where("block_id = ? AND terminal_id = ?", block.ID, block.TerminalID).
					Delete(&model.BlockTermOutputSegment{}).Error; err != nil {
					return err
				}
			}
			if err := tx.First(&restarted, "id = ?", block.ID).Error; err != nil {
				return err
			}
			return blocktermhistory.Sync(tx, restarted)
		})
	})
	if err != nil {
		return nil, blockTermRestartRecorderError(err)
	}
	m.clearBlockRuntimeCancellation(initial.TerminalID, blockID)
	m.scheduleBlockTermPreparedRestartExpiry(initial.TerminalID, blockID, token, blockTermPreparedRestartTTL)
	return &restarted, nil
}

// restartBlockTermBlockIndependent resets a durable block for the independent
// per-block runtime path. The parent recorder is only inspected for conflicts;
// it is never rearmed, cancelled, or otherwise mutated here.
// The caller holds workspaceLifecycleMu.RLock, blockTermMutationMu and the
// block lifecycle lock for blockID.
func (m *Manager) restartBlockTermBlockIndependent(
	initial model.BlockTermBlock,
	request BlockTermRestartRequest,
	token string,
) (*model.BlockTermBlock, error) {
	if owner := m.activeBlockRuntimeOwner(initial.TerminalID, initial.ID); owner != nil {
		return nil, fmt.Errorf("%w: block %s already has an active independent runtime", ErrBlockTermRestartBusy, initial.ID)
	}
	preparationExists, exactPreparation, cancelledPreparation := m.blockRuntimePreparationState(
		initial.TerminalID,
		initial.ID,
		token,
	)
	if preparationExists && !cancelledPreparation {
		if !exactPreparation || !blockTermRestartRequestMatches(initial, request) {
			return nil, fmt.Errorf("%w: block %s already has a different independent lifecycle", ErrBlockTermRestartBusy, initial.ID)
		}
		// Match the legacy prepared-restart behavior: an exact retry is
		// idempotent and refreshes its bounded creation lease.
		m.setBlockRuntimePreparation(initial.TerminalID, initial.ID, token)
		return &initial, nil
	}
	if initial.Status == model.StatusRunning {
		return nil, fmt.Errorf("%w: block %s has an unowned running lifecycle", ErrBlockTermRestartBusy, initial.ID)
	}
	at, ok := m.getActive(initial.TerminalID)
	if !ok {
		return nil, ErrTerminalNotFound
	}
	at.modelRunMu.Lock()
	defer at.modelRunMu.Unlock()
	at.runtimeMu.RLock()
	defer at.runtimeMu.RUnlock()
	at.stateMu.Lock()
	running := at.status.Load().(string) == model.StatusRunning
	at.sessionMu.RLock()
	readonly := at.Session == nil || at.Session.Readonly
	sessionID := ""
	if at.Session != nil {
		sessionID = at.Session.ID
	}
	at.sessionMu.RUnlock()
	hasRuntime := at.Runtime != nil
	at.stateMu.Unlock()
	if !running || readonly {
		return nil, fmt.Errorf("%w: terminal %s is not writable", ErrBlockTermRestartUnsupported, initial.TerminalID)
	}
	if !hasRuntime || sessionID != initial.TerminalID {
		return nil, fmt.Errorf("%w: terminal %s has no active runtime", ErrBlockTermRestartUnavailable, initial.TerminalID)
	}
	// A parent recorder lifecycle would consume or overwrite bytes from the
	// session PTY. Independent mode must leave it intact and report busy.
	at.outputRecorderMu.Lock()
	parentRecorder := at.outputRecorder
	parentBound := parentRecorder != nil && parentRecorder.HasLifecycleBindingForBlock(initial.ID)
	at.outputRecorderMu.Unlock()
	if parentBound {
		return nil, fmt.Errorf("%w: block %s is owned by the parent recorder", ErrBlockTermRestartBusy, initial.ID)
	}

	var restarted model.BlockTermBlock
	err := m.db.Transaction(func(tx *gorm.DB) error {
		var block model.BlockTermBlock
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&block, "id = ?", initial.ID).Error; err != nil {
			return err
		}
		if block.TerminalID != initial.TerminalID {
			return fmt.Errorf("%w: block terminal changed", ErrBlockTermRestartBusy)
		}
		if err := validateBlockTermRestartTarget(block); err != nil {
			return err
		}
		var terminal model.TerminalSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&terminal, "id = ?", block.TerminalID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTerminalNotFound
			}
			return err
		}
		if terminal.Status != model.StatusRunning || terminal.Readonly {
			return fmt.Errorf("%w: terminal %s is not writable", ErrBlockTermRestartUnsupported, block.TerminalID)
		}
		// Do not impose the legacy one-command-per-terminal rule here. Sibling
		// independent runtimes are intentionally allowed to execute in parallel.
		startedAt := time.Now().Unix()
		updatedAt := startedAt
		result := tx.Model(&model.BlockTermBlock{}).
			Where("id = ? AND terminal_id = ? AND status <> ?", block.ID, block.TerminalID, model.StatusRunning).
			Updates(map[string]any{
				"status":            model.StatusRunning,
				"mode":              request.Mode,
				"output":            []byte{},
				"output_cursor":     nil,
				"cmd_pid":           nil,
				"remote_pid":        nil,
				"term_cols":         request.TermCols,
				"term_rows":         request.TermRows,
				"term_flex_rows":    request.TermFlexRows,
				"term_max_pty_size": request.TermMaxPTYSize,
				"before_state_json": request.BeforeStateJSON,
				"after_state_json":  "",
				"exit_code":         nil,
				"started_at":        startedAt,
				"finished_at":       nil,
				"updated_at":        updatedAt,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return fmt.Errorf("%w: block %s lifecycle changed", ErrBlockTermRestartBusy, block.ID)
		}
		if tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
			if err := tx.Where("block_id = ? AND terminal_id = ?", block.ID, block.TerminalID).
				Delete(&model.BlockTermOutputSegment{}).Error; err != nil {
				return err
			}
		}
		if err := tx.First(&restarted, "id = ?", block.ID).Error; err != nil {
			return err
		}
		return blocktermhistory.Sync(tx, restarted)
	})
	if err != nil {
		return nil, err
	}
	m.setBlockRuntimePreparation(initial.TerminalID, initial.ID, token)
	return &restarted, nil
}

func (m *Manager) scheduleBlockTermPreparedRestartExpiry(
	terminalID string,
	blockID string,
	token string,
	delay time.Duration,
) *time.Timer {
	if m == nil || terminalID == "" || !validBlockTermBlockID(blockID) || !validBlockTermToken(token) {
		return nil
	}
	if delay <= 0 {
		delay = blockTermPreparedRestartTTL
	}
	key := blockTermPreparedRestartLeaseKey{TerminalID: terminalID, BlockID: blockID, Token: token}
	lease := &blockTermPreparedRestartLease{}
	m.blockTermRestartLeaseMu.Lock()
	if m.blockTermRestartLeases == nil {
		m.blockTermRestartLeases = make(map[blockTermPreparedRestartLeaseKey]*blockTermPreparedRestartLease)
	}
	if previous := m.blockTermRestartLeases[key]; previous != nil && previous.timer != nil {
		previous.timer.Stop()
	}
	m.blockTermRestartLeases[key] = lease
	lease.timer = time.AfterFunc(delay, func() {
		m.runBlockTermPreparedRestartLease(key, lease)
	})
	timer := lease.timer
	m.blockTermRestartLeaseMu.Unlock()
	return timer
}

func (m *Manager) expireBlockTermPreparedRestart(terminalID, blockID, token string) {
	if m == nil {
		return
	}
	key := blockTermPreparedRestartLeaseKey{TerminalID: terminalID, BlockID: blockID, Token: token}
	m.blockTermRestartLeaseMu.Lock()
	lease := m.blockTermRestartLeases[key]
	m.blockTermRestartLeaseMu.Unlock()
	if lease != nil {
		m.runBlockTermPreparedRestartLease(key, lease)
	}
}

func (m *Manager) runBlockTermPreparedRestartLease(
	key blockTermPreparedRestartLeaseKey,
	lease *blockTermPreparedRestartLease,
) {
	if !m.isBlockTermPreparedRestartLeaseCurrent(key, lease) {
		return
	}
	retry, err := m.expireBlockTermPreparedRestartLease(key, lease)
	if err != nil {
		log.Printf(
			"blockterm prepared restart expiry failed for terminal %s block %s: %v",
			key.TerminalID,
			key.BlockID,
			err,
		)
	}
	if retry {
		m.rescheduleBlockTermPreparedRestartLease(key, lease, blockTermPreparedRetryDelay)
		return
	}
	m.clearBlockTermPreparedRestartLeaseIfCurrent(key, lease)
}

func (m *Manager) expireBlockTermPreparedRestartLease(
	key blockTermPreparedRestartLeaseKey,
	lease *blockTermPreparedRestartLease,
) (bool, error) {
	if m == nil || m.db == nil || key.TerminalID == "" || !validBlockTermBlockID(key.BlockID) ||
		!validBlockTermToken(key.Token) {
		return false, nil
	}
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	if !m.isBlockTermPreparedRestartLeaseCurrent(key, lease) {
		return false, nil
	}

	at, ok := m.getActive(key.TerminalID)
	if !ok || at.status.Load().(string) != model.StatusRunning {
		return false, nil
	}
	at.inputMu.Lock()
	defer at.inputMu.Unlock()
	at.outputRecorderMu.Lock()
	defer at.outputRecorderMu.Unlock()
	recorder := at.outputRecorder
	if recorder == nil {
		return false, nil
	}
	phase, exact := recorder.RearmBindingState(key.BlockID, key.Token)
	if !exact || phase != "prepared" {
		return false, nil
	}
	err := recorder.WithCancelPreparedBlock(key.BlockID, key.Token, func() error {
		return m.interruptOwnedRunningBlockTermRestart(key.TerminalID, key.BlockID)
	})
	if err == nil {
		return false, nil
	}
	phase, exact = recorder.RearmBindingState(key.BlockID, key.Token)
	return exact && phase == "prepared", err
}

func (m *Manager) rescheduleBlockTermPreparedRestartLease(
	key blockTermPreparedRestartLeaseKey,
	lease *blockTermPreparedRestartLease,
	delay time.Duration,
) {
	if m == nil || lease == nil {
		return
	}
	if delay <= 0 {
		delay = blockTermPreparedRetryDelay
	}
	m.blockTermRestartLeaseMu.Lock()
	defer m.blockTermRestartLeaseMu.Unlock()
	if m.blockTermRestartLeases[key] != lease {
		return
	}
	lease.timer = time.AfterFunc(delay, func() {
		m.runBlockTermPreparedRestartLease(key, lease)
	})
}

func (m *Manager) isBlockTermPreparedRestartLeaseCurrent(
	key blockTermPreparedRestartLeaseKey,
	lease *blockTermPreparedRestartLease,
) bool {
	if m == nil || lease == nil {
		return false
	}
	m.blockTermRestartLeaseMu.Lock()
	defer m.blockTermRestartLeaseMu.Unlock()
	return m.blockTermRestartLeases[key] == lease
}

func (m *Manager) clearBlockTermPreparedRestartLease(terminalID, blockID, token string) {
	if m == nil {
		return
	}
	key := blockTermPreparedRestartLeaseKey{TerminalID: terminalID, BlockID: blockID, Token: token}
	m.blockTermRestartLeaseMu.Lock()
	lease := m.blockTermRestartLeases[key]
	if lease != nil {
		delete(m.blockTermRestartLeases, key)
	}
	m.blockTermRestartLeaseMu.Unlock()
	if lease != nil && lease.timer != nil {
		lease.timer.Stop()
	}
}

func (m *Manager) clearBlockTermPreparedRestartLeaseIfCurrent(
	key blockTermPreparedRestartLeaseKey,
	lease *blockTermPreparedRestartLease,
) {
	if m == nil || lease == nil {
		return
	}
	m.blockTermRestartLeaseMu.Lock()
	if m.blockTermRestartLeases[key] != lease {
		m.blockTermRestartLeaseMu.Unlock()
		return
	}
	delete(m.blockTermRestartLeases, key)
	m.blockTermRestartLeaseMu.Unlock()
	if lease.timer != nil {
		lease.timer.Stop()
	}
}

func (m *Manager) clearBlockTermPreparedRestartLeasesForTerminal(terminalID string) {
	if m == nil || terminalID == "" {
		return
	}
	var leases []*blockTermPreparedRestartLease
	m.blockTermRestartLeaseMu.Lock()
	for key, lease := range m.blockTermRestartLeases {
		if key.TerminalID != terminalID {
			continue
		}
		delete(m.blockTermRestartLeases, key)
		leases = append(leases, lease)
	}
	m.blockTermRestartLeaseMu.Unlock()
	for _, lease := range leases {
		if lease != nil && lease.timer != nil {
			lease.timer.Stop()
		}
	}
}

// CancelBlockTermRestart interrupts an exact prepared restart whose wrapper
// was never written to the PTY. The durable row and parser reservation change
// together so a later restart cannot be left permanently busy.
func (m *Manager) CancelBlockTermRestart(blockID, token string) (*model.BlockTermBlock, error) {
	if !validBlockTermBlockID(blockID) || !validBlockTermToken(token) {
		return nil, fmt.Errorf("%w: invalid block id or token", ErrBlockTermRestartInvalid)
	}
	if m == nil || m.db == nil {
		return nil, ErrBlockTermRestartUnavailable
	}
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	unlockBlockLifecycle := m.LockBlockRuntimeLifecycle("", blockID)
	defer unlockBlockLifecycle()

	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()

	var initial model.BlockTermBlock
	if err := m.db.First(&initial, "id = ?", blockID).Error; err != nil {
		return nil, err
	}
	preparationExists, exactPreparation, cancelledPreparation := m.blockRuntimePreparationState(
		initial.TerminalID,
		blockID,
		token,
	)
	if preparationExists {
		if !exactPreparation {
			return nil, fmt.Errorf("%w: block %s has a different independent lifecycle", ErrBlockTermRestartBusy, blockID)
		}
		if cancelledPreparation || initial.Status != model.StatusRunning {
			if initial.Status == blockRuntimeDurableInterrupted {
				m.ClearBlockRuntimePreparation(initial.TerminalID, blockID)
				m.markBlockRuntimeCancellation(initial.TerminalID, blockID, token)
				return &initial, nil
			}
			return nil, fmt.Errorf("%w: block %s is not awaiting independent runtime creation", ErrBlockTermRestartBusy, blockID)
		}
		if err := m.interruptOwnedRunningBlockTermRestart(initial.TerminalID, blockID); err != nil {
			return nil, err
		}
		m.ClearBlockRuntimePreparation(initial.TerminalID, blockID)
		m.markBlockRuntimeCancellation(initial.TerminalID, blockID, token)
		var interrupted model.BlockTermBlock
		if err := m.db.First(&interrupted, "id = ?", blockID).Error; err != nil {
			return nil, err
		}
		return &interrupted, nil
	}
	if cancellationExists, exactCancellation := m.blockRuntimeCancellationState(
		initial.TerminalID,
		blockID,
		token,
	); cancellationExists {
		if !exactCancellation || initial.Status != blockRuntimeDurableInterrupted {
			return nil, fmt.Errorf("%w: block %s has a different independent lifecycle", ErrBlockTermRestartBusy, blockID)
		}
		return &initial, nil
	}
	at, ok := m.getActive(initial.TerminalID)
	if !ok {
		return nil, ErrTerminalNotFound
	}
	at.inputMu.Lock()
	defer at.inputMu.Unlock()
	at.outputRecorderMu.Lock()
	defer at.outputRecorderMu.Unlock()
	recorder := at.outputRecorder
	if recorder == nil {
		return nil, ErrBlockTermRestartUnavailable
	}
	if initial.Status != "running" {
		if initial.Status == "interrupted" && recorder.WasCancelledRearmBinding(blockID, token) {
			m.clearBlockTermPreparedRestartLease(initial.TerminalID, blockID, token)
			return &initial, nil
		}
		return nil, fmt.Errorf("%w: block %s is not awaiting restart input", ErrBlockTermRestartBusy, blockID)
	}

	var interrupted model.BlockTermBlock
	err := recorder.WithCancelPreparedBlock(blockID, token, func() error {
		return m.db.Transaction(func(tx *gorm.DB) error {
			var block model.BlockTermBlock
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&block, "id = ?", blockID).Error; err != nil {
				return err
			}
			if block.TerminalID != initial.TerminalID || block.Status != "running" {
				return fmt.Errorf("%w: block %s restart state changed", ErrBlockTermRestartBusy, blockID)
			}
			finishedAt := time.Now().Unix()
			result := tx.Model(&model.BlockTermBlock{}).
				Where("id = ? AND terminal_id = ? AND status = ?", block.ID, block.TerminalID, "running").
				Updates(blockTermRestartInterruptedUpdates(block, finishedAt))
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return fmt.Errorf("%w: block %s restart state changed", ErrBlockTermRestartBusy, blockID)
			}
			if err := tx.First(&interrupted, "id = ?", block.ID).Error; err != nil {
				return err
			}
			return blocktermhistory.Sync(tx, interrupted)
		})
	})
	if err != nil {
		return nil, blockTermRestartRecorderError(err)
	}
	m.clearBlockTermPreparedRestartLease(initial.TerminalID, blockID, token)
	return &interrupted, nil
}
