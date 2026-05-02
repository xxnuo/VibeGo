package terminal

// This file owns the per-block runtime path. A block runtime is deliberately
// independent from activeTerminal: it has its own PTY, reader, cursor and
// websocket connections. The parent terminal is used only for defaults and
// ownership context; closing a block runtime never closes the parent.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermhistory"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const blockRuntimeDefaultBufferSize = 10 * 1024 * 1024

const blockRuntimeFinalizeRetryDelay = 50 * time.Millisecond

// BlockRuntimeCreateOptions describes one independent command/line runtime.
// RuntimeType and SSHProfileID default to the durable block selection, then to
// the parent terminal for legacy blocks whose selection is still blank. Token
// is accepted as a compatibility spelling for BlockToken; callers should
// prefer BlockToken.
type BlockRuntimeCreateOptions struct {
	TerminalID string
	BlockID    string
	BlockToken string
	Token      string

	RuntimeType  string
	SSHProfileID string
	ProfileID    string
	Cwd          string
	Cols         int
	Rows         int
	SSHAuth      SSHAuthSecrets
	Context      context.Context

	// InitialInput is written after the runtime is registered. It is useful for
	// launching a command immediately, while callers that need a handshake can
	// leave it empty and use WriteBlockRuntime later.
	InitialInput []byte
	// Command is a convenience form of InitialInput. A trailing newline is
	// added when it is non-empty and InitialInput is omitted.
	Command string
}

// BlockTermRuntimeCreateOptions is an alias retained for protocol-facing
// callers that use the longer BlockTerm name.
type BlockTermRuntimeCreateOptions = BlockRuntimeCreateOptions

// BlockRuntimeAttachOptions controls replay from the independent stream.
type BlockRuntimeAttachOptions struct {
	Cursor uint64
}

type BlockTermRuntimeAttachOptions = BlockRuntimeAttachOptions

// BlockRuntimeInfo is a stable value snapshot of an independent runtime.
type BlockRuntimeInfo struct {
	TerminalID   string               `json:"terminal_id"`
	BlockID      string               `json:"block_id"`
	BlockToken   string               `json:"block_token"`
	RuntimeType  string               `json:"runtime_type"`
	SSHProfileID string               `json:"ssh_profile_id,omitempty"`
	Cwd          string               `json:"cwd"`
	Cols         int                  `json:"cols"`
	Rows         int                  `json:"rows"`
	Status       string               `json:"status"`
	Cursor       uint64               `json:"cursor"`
	ExitCode     int                  `json:"exit_code"`
	Capabilities TerminalCapabilities `json:"capabilities"`
}

type BlockTermRuntimeInfo = BlockRuntimeInfo

// BlockRuntimeConnection is returned by AttachBlockRuntime. Done closes when
// the websocket or its runtime is closed.
type BlockRuntimeConnection struct {
	Done <-chan struct{}
}

type BlockTermRuntimeConnection = BlockRuntimeConnection

// activeBlockRuntime is intentionally not embedded in activeTerminal. The
// locks here provide operation/close ordering without taking the parent
// terminal's runtime lock.
type activeBlockRuntime struct {
	manager *Manager
	key     BlockTermRuntimeRouteKey
	infoMu  sync.RWMutex
	info    BlockRuntimeInfo

	runtime   TerminalRuntime
	runtimeMu sync.RWMutex
	inputMu   sync.Mutex
	closeDone chan struct{}

	deliveryMu    sync.Mutex
	connections   sync.Map // map[string]*terminalConnection
	buffer        *historyBuffer
	bufferMu      sync.RWMutex
	bufferSize    int
	encoder       *base64.Encoding
	recorder      *blockTermOutputRecorder
	readDone      chan struct{}
	done          chan struct{}
	doneOnce      sync.Once
	closeOnce     sync.Once
	closeDoneOnce sync.Once
	closeErrMu    sync.Mutex
	closeErr      error
	status        atomic.Value // string
	lifecycleMu   sync.Mutex
	finishing     atomic.Bool
	finishStatus  string
	exitCode      atomic.Int64
	routeHandle   BlockTermRuntimeHandle
	finishedOnce  sync.Once
	finalizeOnce  sync.Once
	finalizeErrMu sync.Mutex
	finalizeErr   error
	durableMu     sync.RWMutex
	durableStatus string
	durableError  string
	waitOnce      sync.Once
	waitMu        sync.Mutex
	waitDone      chan struct{}
	waitErr       error
}

func (m *Manager) ensureBlockRuntimeStore() {
	if m == nil {
		return
	}
	m.blockRuntimeRouteInitMu.Lock()
	defer m.blockRuntimeRouteInitMu.Unlock()
	if m.blockRuntimes == nil {
		m.blockRuntimes = make(map[BlockTermRuntimeRouteKey]*activeBlockRuntime)
	}
	if m.blockRuntimeClosing == nil {
		m.blockRuntimeClosing = make(map[string]struct{})
	}
	if m.blockTermRoutes == nil {
		m.blockTermRoutes = NewBlockTermRuntimeRegistry()
	}
}

func normalizeBlockRuntimeToken(opts BlockRuntimeCreateOptions) string {
	if opts.BlockToken != "" {
		return opts.BlockToken
	}
	return opts.Token
}

func (m *Manager) blockRuntimeDefaults(opts BlockRuntimeCreateOptions) (BlockRuntimeCreateOptions, error) {
	opts.TerminalID = strings.TrimSpace(opts.TerminalID)
	if opts.TerminalID == "" || !validBlockTermRuntimeTerminalID(opts.TerminalID) {
		return opts, fmt.Errorf("%w: terminal id", ErrBlockRuntimeInvalid)
	}
	opts.BlockToken = normalizeBlockRuntimeToken(opts)
	if !validBlockTermBlockID(opts.BlockID) || !validBlockTermToken(opts.BlockToken) {
		return opts, fmt.Errorf("%w: block id or token", ErrBlockRuntimeInvalid)
	}

	requestedRuntimeType := strings.TrimSpace(opts.RuntimeType)
	requestedProfileID := strings.TrimSpace(opts.SSHProfileID)
	if requestedProfileID == "" {
		requestedProfileID = strings.TrimSpace(opts.ProfileID)
	}
	runtimeExplicit := requestedRuntimeType != ""
	profileExplicit := requestedProfileID != ""
	opts.RuntimeType = requestedRuntimeType
	opts.SSHProfileID = requestedProfileID

	// A durable block is the source of truth for per-block runtime selection.
	// Build the projection dynamically so low-level callers can still operate
	// against databases created before these columns existed.
	if m.db != nil && m.db.Migrator().HasTable(&model.BlockTermBlock{}) {
		type blockDefaults struct {
			TerminalID   string `gorm:"column:terminal_id"`
			RuntimeType  string `gorm:"column:runtime_type"`
			SSHProfileID string `gorm:"column:ssh_profile_id"`
			Cwd          string `gorm:"column:cwd"`
			TermCols     int    `gorm:"column:term_cols"`
			TermRows     int    `gorm:"column:term_rows"`
		}
		columns := []string{"terminal_id"}
		if m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "runtime_type") {
			columns = append(columns, "runtime_type")
		}
		if m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "ssh_profile_id") {
			columns = append(columns, "ssh_profile_id")
		}
		if !runtimeExplicit || opts.Cwd == "" {
			if m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "cwd") {
				columns = append(columns, "cwd")
			}
		}
		if opts.Cols <= 0 && m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "term_cols") {
			columns = append(columns, "term_cols")
		}
		if opts.Rows <= 0 && m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "term_rows") {
			columns = append(columns, "term_rows")
		}
		var block blockDefaults
		if err := m.db.Table((model.BlockTermBlock{}).TableName()).Select(columns).First(&block, "id = ?", opts.BlockID).Error; err == nil &&
			block.TerminalID == opts.TerminalID {
			durableRuntimeType := strings.TrimSpace(block.RuntimeType)
			durableProfileID := strings.TrimSpace(block.SSHProfileID)
			if durableRuntimeType != "" {
				if runtimeExplicit && requestedRuntimeType != durableRuntimeType {
					return opts, fmt.Errorf("%w: runtime type conflicts with durable block selection", ErrBlockRuntimeInvalid)
				}
				opts.RuntimeType = durableRuntimeType
			}
			if durableProfileID != "" {
				if profileExplicit && requestedProfileID != durableProfileID {
					return opts, fmt.Errorf("%w: ssh profile conflicts with durable block selection", ErrBlockRuntimeInvalid)
				}
				opts.SSHProfileID = durableProfileID
			}
			if opts.Cwd == "" && block.Cwd != "" {
				opts.Cwd = block.Cwd
			}
			if opts.Cols <= 0 && block.TermCols > 0 {
				opts.Cols = block.TermCols
			}
			if opts.Rows <= 0 && block.TermRows > 0 {
				opts.Rows = block.TermRows
			}
		}
	}

	// Parent terminal values are compatibility defaults only. Do not hold any
	// parent lock while creating a potentially blocking local or SSH runtime.
	if at, ok := m.getActive(opts.TerminalID); ok {
		at.sessionMu.RLock()
		session := cloneTerminalSession(at.Session)
		at.sessionMu.RUnlock()
		if opts.RuntimeType == "" {
			opts.RuntimeType = session.RuntimeType
		}
		if opts.SSHProfileID == "" && opts.RuntimeType == RuntimeTypeSSH {
			opts.SSHProfileID = session.SSHProfileID
		}
		if opts.Cwd == "" {
			opts.Cwd = session.CurrentCwd
			if opts.Cwd == "" {
				opts.Cwd = session.Cwd
			}
		}
		if opts.Cols <= 0 {
			opts.Cols = session.Cols
		}
		if opts.Rows <= 0 {
			opts.Rows = session.Rows
		}
	} else if m.db != nil {
		// A closed/history-only parent may not be in memory. Reading it here
		// keeps the API useful after a reconnect, without making a DB row a hard
		// prerequisite for low-level runtime tests.
		var session model.TerminalSession
		if err := m.db.Select("runtime_type", "ssh_profile_id", "cwd", "current_cwd", "cols", "rows").First(&session, "id = ?", opts.TerminalID).Error; err == nil {
			if opts.RuntimeType == "" {
				opts.RuntimeType = session.RuntimeType
			}
			if opts.SSHProfileID == "" && opts.RuntimeType == RuntimeTypeSSH {
				opts.SSHProfileID = session.SSHProfileID
			}
			if opts.Cwd == "" {
				opts.Cwd = session.CurrentCwd
				if opts.Cwd == "" {
					opts.Cwd = session.Cwd
				}
			}
			if opts.Cols <= 0 {
				opts.Cols = session.Cols
			}
			if opts.Rows <= 0 {
				opts.Rows = session.Rows
			}
		}
	}
	if opts.RuntimeType == "" {
		opts.RuntimeType = RuntimeTypeLocal
	}
	opts.RuntimeType = strings.TrimSpace(opts.RuntimeType)
	if opts.RuntimeType != RuntimeTypeLocal && opts.RuntimeType != RuntimeTypeSSH {
		return opts, fmt.Errorf("%w: unsupported runtime type %s", ErrUnsupportedRuntime, opts.RuntimeType)
	}
	if opts.RuntimeType == RuntimeTypeLocal {
		// A profile cannot affect a local PTY. Rejecting this combination catches
		// ambiguous API requests while retaining SSH's historical factory-level
		// missing-profile error behavior for low-level callers.
		if opts.SSHProfileID != "" {
			return opts, fmt.Errorf("%w: ssh profile is only valid for ssh runtime", ErrBlockRuntimeInvalid)
		}
	}
	if opts.Cols <= 0 {
		opts.Cols = 80
	}
	if opts.Rows <= 0 {
		opts.Rows = 24
	}
	if opts.Context == nil {
		opts.Context = context.Background()
	}
	return opts, nil
}

// validateBlockRuntimeOwnerLocked validates the durable terminal and block for
// an API runtime admission. The caller holds blockTermMutationMu, which keeps
// handler-side mutations from changing either owner during the lookup. A nil
// database is intentionally accepted for low-level Manager users and in-memory
// runtime tests that do not have durable BlockTerm rows.
func (m *Manager) validateBlockRuntimeOwnerLocked(ctx context.Context, terminalID, blockID string) error {
	if m == nil || m.db == nil {
		return nil
	}
	if terminalID == "" || blockID == "" {
		return fmt.Errorf("%w: terminal_id and block_id are required", ErrBlockRuntimeInvalid)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	db := m.db.WithContext(ctx)
	var session model.TerminalSession
	if err := db.First(&session, "id = ?", terminalID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrTerminalNotFound
		}
		return err
	}
	if session.Status != model.StatusRunning || session.Readonly {
		return ErrBlockRuntimeNotRunning
	}
	return m.validateBlockRuntimeBlockOwnerLocked(ctx, terminalID, blockID)
}

// validateBlockRuntimeBlockOwnerLocked is the post-factory durable check. The
// terminal was fully authorized before construction; parent shutdown is fenced
// by blockRuntimeClosing, while this lookup catches block deletion, movement,
// kind changes, lifecycle settlement, and a terminal status change without
// issuing a second TerminalSession query on the response path. The joined query
// is rooted at the block table so GORM callbacks that count terminal-owner
// queries still observe only the initial full authorization.
func (m *Manager) validateBlockRuntimeBlockOwnerLocked(ctx context.Context, terminalID, blockID string) error {
	if m == nil || m.db == nil {
		return nil
	}
	if terminalID == "" || blockID == "" {
		return fmt.Errorf("%w: terminal_id and block_id are required", ErrBlockRuntimeInvalid)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	type joinedOwner struct {
		BlockID          string `gorm:"column:block_id"`
		BlockTerminalID  string `gorm:"column:block_terminal_id"`
		BlockKind        string `gorm:"column:block_kind"`
		BlockStatus      string `gorm:"column:block_status"`
		TerminalID       string `gorm:"column:owner_terminal_id"`
		TerminalStatus   string `gorm:"column:terminal_status"`
		TerminalReadonly bool   `gorm:"column:terminal_readonly"`
	}
	var owner joinedOwner
	result := m.db.WithContext(ctx).
		Table("blockterm_blocks AS b").
		Select(
			"b.id AS block_id, b.terminal_id AS block_terminal_id, b.kind AS block_kind, b.status AS block_status, "+
				"t.id AS owner_terminal_id, t.status AS terminal_status, t.readonly AS terminal_readonly",
		).
		Joins("JOIN terminal_sessions AS t ON t.id = b.terminal_id").
		Where("b.id = ?", blockID).
		Take(&owner)
	if result.Error != nil {
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return ErrBlockRuntimeNotFound
		}
		return result.Error
	}
	if owner.BlockID == "" || owner.BlockTerminalID != terminalID || owner.TerminalID == "" {
		return ErrBlockRuntimeNotFound
	}
	if owner.TerminalStatus != model.StatusRunning || owner.TerminalReadonly {
		return ErrBlockRuntimeNotRunning
	}
	if owner.BlockKind != "command" {
		return fmt.Errorf("%w: block must be a command block", ErrBlockRuntimeInvalid)
	}
	if owner.BlockStatus != model.StatusRunning {
		return ErrBlockRuntimeNotRunning
	}
	return nil
}

func (m *Manager) blockRuntimeTerminalClosing(terminalID string) bool {
	if m == nil {
		return false
	}
	m.ensureBlockRuntimeStore()
	m.blockRuntimeMu.RLock()
	_, closing := m.blockRuntimeClosing[terminalID]
	m.blockRuntimeMu.RUnlock()
	return closing
}

// validateBlockRuntimeAdmissionLocked checks every in-memory and durable owner
// that can reject runtime construction. The caller holds blockTermMutationMu
// and blockRuntimeAdmissionMu. The returned boolean records whether an exact
// independent restart reservation must be consumed after route registration.
func (m *Manager) validateBlockRuntimeAdmissionLocked(
	opts BlockRuntimeCreateOptions,
	key BlockTermRuntimeRouteKey,
	validateTerminal bool,
) (bool, error) {
	if err := opts.Context.Err(); err != nil {
		return false, err
	}
	var ownerErr error
	if validateTerminal {
		ownerErr = m.validateBlockRuntimeOwnerLocked(opts.Context, opts.TerminalID, opts.BlockID)
	} else {
		ownerErr = m.validateBlockRuntimeBlockOwnerLocked(opts.Context, opts.TerminalID, opts.BlockID)
	}
	if ownerErr != nil {
		return false, ownerErr
	}

	m.blockRuntimeMu.RLock()
	_, exists := m.blockRuntimes[key]
	_, closing := m.blockRuntimeClosing[opts.TerminalID]
	m.blockRuntimeMu.RUnlock()
	if exists {
		return false, fmt.Errorf("%w: %s/%s", ErrBlockRuntimeAlreadyExists, opts.TerminalID, opts.BlockID)
	}
	if closing {
		return false, ErrBlockRuntimeNotRunning
	}

	preparationExists, exactPreparation, cancelledPreparation := m.blockRuntimePreparationState(
		opts.TerminalID,
		opts.BlockID,
		opts.BlockToken,
	)
	if preparationExists && (!exactPreparation || cancelledPreparation) {
		return false, fmt.Errorf("%w: block %s has a different or expired runtime preparation", ErrBlockRuntimeAlreadyExists, opts.BlockID)
	}

	at, ok := m.getActive(opts.TerminalID)
	if !ok {
		return preparationExists, nil
	}
	at.inputMu.Lock()
	defer at.inputMu.Unlock()
	at.outputRecorderMu.Lock()
	defer at.outputRecorderMu.Unlock()
	recorder := at.outputRecorder
	if recorder == nil {
		return preparationExists, nil
	}
	phase, exactRearm := recorder.RearmBindingState(opts.BlockID, opts.BlockToken)
	if exactRearm {
		if phase != "prepared" {
			return false, fmt.Errorf("%w: block %s parent lifecycle is %s", ErrBlockRuntimeAlreadyExists, opts.BlockID, phase)
		}
		return preparationExists, nil
	}
	if recorder.HasLifecycleBindingForBlock(opts.BlockID) {
		return false, fmt.Errorf("%w: block %s is owned by the parent runtime", ErrBlockRuntimeAlreadyExists, opts.BlockID)
	}
	return preparationExists, nil
}

func (m *Manager) preauthorizeBlockRuntime(
	opts BlockRuntimeCreateOptions,
	key BlockTermRuntimeRouteKey,
) error {
	m.blockTermMutationMu.RLock()
	defer m.blockTermMutationMu.RUnlock()
	m.blockRuntimeAdmissionMu.Lock()
	defer m.blockRuntimeAdmissionMu.Unlock()
	_, err := m.validateBlockRuntimeAdmissionLocked(opts, key, true)
	return err
}

// CreateBlockRuntime creates and starts a runtime keyed by terminal, block and
// token. It does not create or mutate a TerminalSession row. Admission is
// serialized with durable block deletion/restart by the per-block lifecycle
// lock.
func (m *Manager) CreateBlockRuntime(opts BlockRuntimeCreateOptions) (*BlockRuntimeInfo, error) {
	if m == nil {
		return nil, ErrBlockRuntimeInvalid
	}
	// Keep the lock order aligned with restart/cancel and handler admission:
	// workspace readers precede the per-block lifecycle lock. Workspace deletion
	// takes the write lock before joining child runtimes, so reversing this order
	// would permit an ABBA deadlock.
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	unlock := m.LockBlockRuntimeLifecycle(opts.TerminalID, opts.BlockID)
	defer unlock()
	return m.createBlockRuntimeLocked(opts)
}

// CreateBlockRuntimeWithLifecycleLock is used by HTTP admission paths that
// must validate the durable owner before registering a child route. The caller
// must hold LockBlockRuntimeLifecycle for opts.BlockID until this method
// returns.
func (m *Manager) CreateBlockRuntimeWithLifecycleLock(opts BlockRuntimeCreateOptions) (*BlockRuntimeInfo, error) {
	return m.createBlockRuntimeLocked(opts)
}

func (m *Manager) createBlockRuntimeLocked(opts BlockRuntimeCreateOptions) (*BlockRuntimeInfo, error) {
	if m == nil {
		return nil, ErrBlockRuntimeInvalid
	}
	var err error
	opts, err = m.blockRuntimeDefaults(opts)
	if err != nil {
		return nil, err
	}
	m.ensureBlockRuntimeStore()
	key := BlockTermRuntimeRouteKey{TerminalID: opts.TerminalID, BlockID: opts.BlockID}
	if err := m.preauthorizeBlockRuntime(opts, key); err != nil {
		return nil, err
	}

	prepared, err := m.prepareRuntime(CreateOptions{
		Cwd:          opts.Cwd,
		Command:      opts.Command,
		Cols:         opts.Cols,
		Rows:         opts.Rows,
		RuntimeType:  opts.RuntimeType,
		SSHProfileID: opts.SSHProfileID,
		SSHAuth:      opts.SSHAuth,
		Context:      opts.Context,
	})
	if err != nil {
		return nil, err
	}
	if err := opts.Context.Err(); err != nil {
		_ = prepared.runtime.Close()
		return nil, err
	}

	bufferSize := m.historyBufferSize
	if bufferSize <= 0 {
		bufferSize = blockRuntimeDefaultBufferSize
	}
	br := &activeBlockRuntime{
		manager: m,
		key:     key,
		runtime: prepared.runtime,
		info: BlockRuntimeInfo{
			TerminalID:   opts.TerminalID,
			BlockID:      opts.BlockID,
			BlockToken:   opts.BlockToken,
			RuntimeType:  prepared.runtimeType,
			SSHProfileID: opts.SSHProfileID,
			Cwd:          prepared.cwd,
			Cols:         prepared.cols,
			Rows:         prepared.rows,
			Status:       model.StatusRunning,
			Capabilities: prepared.capabilities,
		},
		buffer:     newHistoryBuffer(bufferSize),
		bufferSize: bufferSize,
		encoder:    base64.StdEncoding,
		recorder:   newBlockTermOutputRecorder(m.db, opts.TerminalID),
		closeDone:  make(chan struct{}),
		readDone:   make(chan struct{}),
		done:       make(chan struct{}),
		waitDone:   make(chan struct{}),
	}
	br.status.Store(model.StatusRunning)

	// Route admission shares the durable mutation gate with restart/delete. An
	// old client may have prepared this exact lifecycle on the parent recorder;
	// consume that reservation atomically with route registration so its lease
	// cannot later interrupt the independently owned runtime.
	m.blockTermMutationMu.Lock()
	m.blockRuntimeAdmissionMu.Lock()
	admissionErr := func() error {
		preparationExists, err := m.validateBlockRuntimeAdmissionLocked(opts, key, false)
		if err != nil {
			return err
		}

		registerOwner := func() error {
			handle, registerErr := m.blockTermRoutes.RegisterBlock(
				opts.TerminalID,
				opts.BlockID,
				opts.BlockToken,
				prepared.runtime,
			)
			if registerErr != nil {
				if errors.Is(registerErr, ErrBlockTermRuntimeRouteDuplicate) {
					return fmt.Errorf("%w: %s/%s", ErrBlockRuntimeAlreadyExists, opts.TerminalID, opts.BlockID)
				}
				return registerErr
			}

			m.blockRuntimeMu.Lock()
			if m.blockRuntimes == nil {
				m.blockRuntimes = make(map[BlockTermRuntimeRouteKey]*activeBlockRuntime)
			}
			if _, duplicate := m.blockRuntimes[key]; duplicate {
				m.blockRuntimeMu.Unlock()
				_, _ = m.blockTermRoutes.Remove(handle)
				return ErrBlockRuntimeAlreadyExists
			}
			br.routeHandle = handle
			m.blockRuntimes[key] = br
			m.blockRuntimeMu.Unlock()
			if preparationExists && !m.consumeBlockRuntimePreparation(opts.TerminalID, opts.BlockID, opts.BlockToken) {
				m.blockRuntimeMu.Lock()
				if m.blockRuntimes[key] == br {
					delete(m.blockRuntimes, key)
				}
				m.blockRuntimeMu.Unlock()
				_, _ = m.blockTermRoutes.Remove(handle)
				return fmt.Errorf("%w: block %s runtime preparation changed", ErrBlockRuntimeAlreadyExists, opts.BlockID)
			}
			return nil
		}

		at, ok := m.getActive(opts.TerminalID)
		if !ok {
			return registerOwner()
		}
		at.inputMu.Lock()
		defer at.inputMu.Unlock()
		at.outputRecorderMu.Lock()
		defer at.outputRecorderMu.Unlock()
		recorder := at.outputRecorder
		if recorder == nil {
			return registerOwner()
		}
		phase, exactRearm := recorder.RearmBindingState(opts.BlockID, opts.BlockToken)
		if exactRearm {
			if phase != "prepared" {
				return fmt.Errorf("%w: block %s parent lifecycle is %s", ErrBlockRuntimeAlreadyExists, opts.BlockID, phase)
			}
			if cancelErr := recorder.WithCancelPreparedBlock(opts.BlockID, opts.BlockToken, registerOwner); cancelErr != nil {
				if errors.Is(cancelErr, errBlockTermRecorderBusy) {
					return fmt.Errorf("%w: block %s parent lifecycle changed", ErrBlockRuntimeAlreadyExists, opts.BlockID)
				}
				return cancelErr
			}
			m.clearBlockTermPreparedRestartLease(opts.TerminalID, opts.BlockID, opts.BlockToken)
			return nil
		}
		if recorder.HasLifecycleBindingForBlock(opts.BlockID) {
			return fmt.Errorf("%w: block %s is owned by the parent runtime", ErrBlockRuntimeAlreadyExists, opts.BlockID)
		}
		return registerOwner()
	}()
	m.blockRuntimeAdmissionMu.Unlock()
	m.blockTermMutationMu.Unlock()
	if admissionErr != nil {
		br.discardBeforeStart()
		return nil, admissionErr
	}

	go m.blockRuntimeReadLoop(br)
	go m.blockRuntimeMonitor(br)

	if len(opts.InitialInput) > 0 {
		if err := m.WriteBlockRuntime(opts.TerminalID, opts.BlockID, opts.BlockToken, opts.InitialInput); err != nil {
			_ = m.CloseBlockRuntime(opts.TerminalID, opts.BlockID, opts.BlockToken)
			return nil, err
		}
	}
	info := br.snapshot()
	return &info, nil
}

func (br *activeBlockRuntime) discardBeforeStart() {
	if br == nil {
		return
	}
	if br.runtime != nil {
		_ = br.runtime.Close()
	}
	if br.recorder != nil {
		br.recorder.CloseInput()
		_ = br.recorder.Wait()
	}
}

// OpenBlockRuntime is the context-explicit spelling used by callers that do
// not want to put a context in options.
func (m *Manager) OpenBlockRuntime(ctx context.Context, opts BlockRuntimeCreateOptions) (*BlockRuntimeInfo, error) {
	opts.Context = ctx
	return m.CreateBlockRuntime(opts)
}

func (m *Manager) CreateBlockTermRuntime(opts BlockTermRuntimeCreateOptions) (*BlockTermRuntimeInfo, error) {
	return m.CreateBlockRuntime(opts)
}

func (m *Manager) StartBlockRuntime(opts BlockRuntimeCreateOptions) (*BlockRuntimeInfo, error) {
	return m.CreateBlockRuntime(opts)
}

func (br *activeBlockRuntime) snapshot() BlockRuntimeInfo {
	if br == nil {
		return BlockRuntimeInfo{}
	}
	br.infoMu.RLock()
	info := br.info
	br.infoMu.RUnlock()
	if status, ok := br.status.Load().(string); ok {
		info.Status = status
	}
	_, info.Cursor = br.buffer.CursorRange()
	info.ExitCode = int(br.exitCode.Load())
	return info
}

func wireExitCodeValue(value int) *int {
	exitCode := value
	return &exitCode
}

func (br *activeBlockRuntime) wireDurableOutcome(info BlockRuntimeInfo) (string, string) {
	blockStatus, durableErr := br.durableOutcome()
	if blockStatus == "" && info.Status == model.StatusRunning {
		blockStatus = model.StatusRunning
	}
	return blockStatus, durableErr
}

func (br *activeBlockRuntime) wireExitCode(info BlockRuntimeInfo) *int {
	if info.Status != model.StatusExited {
		return nil
	}
	return wireExitCodeValue(info.ExitCode)
}

// GetBlockRuntime returns a value snapshot after an exact route lookup.
func (m *Manager) GetBlockRuntime(terminalID, blockID, token string) (*BlockRuntimeInfo, bool) {
	br, err := m.resolveBlockRuntime(terminalID, blockID, token)
	if err != nil {
		return nil, false
	}
	info := br.snapshot()
	return &info, true
}

func (m *Manager) resolveBlockRuntime(terminalID, blockID, token string) (*activeBlockRuntime, error) {
	if m == nil || m.blockTermRoutes == nil {
		return nil, ErrBlockRuntimeNotFound
	}
	resolution := m.blockTermRoutes.ResolveByKey(terminalID, blockID, token)
	switch resolution.Status {
	case BlockTermRuntimeRouteStatusTokenMismatch:
		return nil, ErrBlockRuntimeRouteMismatch
	case BlockTermRuntimeRouteStatusUnknownTagged:
		return nil, ErrBlockRuntimeNotFound
	case BlockTermRuntimeRouteStatusInvalid:
		return nil, ErrBlockRuntimeInvalid
	case BlockTermRuntimeRouteStatusBlock:
		// continue
	default:
		return nil, ErrBlockRuntimeNotFound
	}
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimeMu.RLock()
	br := m.blockRuntimes[key]
	m.blockRuntimeMu.RUnlock()
	if br == nil {
		return nil, ErrBlockRuntimeNotFound
	}
	// Registry and map must point at the same runtime. This check also prevents
	// a stale map entry from being used during a replace/ABA transition.
	if !sameTerminalRuntime(br.runtime, resolution.Route.Runtime) || br.infoToken() != token {
		return nil, ErrBlockRuntimeRouteMismatch
	}
	return br, nil
}

func sameTerminalRuntime(left, right TerminalRuntime) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	leftType, rightType := reflect.TypeOf(left), reflect.TypeOf(right)
	if leftType != rightType || !leftType.Comparable() {
		return false
	}
	return left == right
}

// withExactBlockRuntime acquires the per-runtime operation gate. No registry
// or manager map lock is held while fn invokes runtime methods.
func (m *Manager) withExactBlockRuntime(terminalID, blockID, token string, fn func(*activeBlockRuntime) error) error {
	br, err := m.resolveBlockRuntime(terminalID, blockID, token)
	if err != nil {
		return err
	}
	br.runtimeMu.RLock()
	defer br.runtimeMu.RUnlock()
	if status, ok := br.status.Load().(string); !ok || status != model.StatusRunning || br.finishing.Load() {
		return ErrBlockRuntimeNotRunning
	}
	return fn(br)
}

func (m *Manager) WriteBlockRuntime(terminalID, blockID, token string, data []byte) error {
	if len(data) == 0 {
		return nil
	}
	return m.withExactBlockRuntime(terminalID, blockID, token, func(br *activeBlockRuntime) error {
		br.inputMu.Lock()
		defer br.inputMu.Unlock()
		return writeTerminalRuntimeFull(br.runtime, data)
	})
}

// InputBlockRuntime and SendBlockRuntime are compatibility spellings.
func (m *Manager) InputBlockRuntime(terminalID, blockID, token string, data []byte) error {
	return m.WriteBlockRuntime(terminalID, blockID, token, data)
}

func (m *Manager) SendBlockRuntime(terminalID, blockID, token string, data []byte) error {
	return m.WriteBlockRuntime(terminalID, blockID, token, data)
}

func (m *Manager) SignalBlockRuntime(terminalID, blockID, token, signal string) error {
	return m.withExactBlockRuntime(terminalID, blockID, token, func(br *activeBlockRuntime) error {
		br.inputMu.Lock()
		defer br.inputMu.Unlock()
		return SignalTerminalRuntime(br.runtime, signal)
	})
}

func (m *Manager) ResizeBlockRuntime(terminalID, blockID, token string, cols, rows int) error {
	if m == nil {
		return ErrBlockRuntimeInvalid
	}
	if cols < blockTermRestartMinCols || cols > blockTermRestartMaxCols {
		return fmt.Errorf(
			"%w: cols must be between %d and %d",
			ErrBlockRuntimeInvalid,
			blockTermRestartMinCols,
			blockTermRestartMaxCols,
		)
	}
	if rows < blockTermRestartMinRows || rows > blockTermRestartMaxRows {
		return fmt.Errorf(
			"%w: rows must be between %d and %d",
			ErrBlockRuntimeInvalid,
			blockTermRestartMinRows,
			blockTermRestartMaxRows,
		)
	}
	// Match create/restart/delete lock ordering so the exact token owner cannot
	// be replaced between the PTY resize and its durable geometry update.
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	unlock := m.LockBlockRuntimeLifecycle(terminalID, blockID)
	defer unlock()
	return m.withExactBlockRuntime(terminalID, blockID, token, func(br *activeBlockRuntime) error {
		br.inputMu.Lock()
		defer br.inputMu.Unlock()
		if err := br.runtime.Resize(cols, rows); err != nil {
			return err
		}
		br.infoMu.Lock()
		br.info.Cols = cols
		br.info.Rows = rows
		br.infoMu.Unlock()
		return m.persistBlockRuntimeGeometry(br, cols, rows)
	})
}

func (m *Manager) persistBlockRuntimeGeometry(br *activeBlockRuntime, cols, rows int) error {
	if m == nil || m.db == nil || br == nil ||
		!m.db.Migrator().HasTable(&model.BlockTermBlock{}) ||
		!m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "term_cols") ||
		!m.db.Migrator().HasColumn(&model.BlockTermBlock{}, "term_rows") {
		return nil
	}
	var lastErr error
	for attempt := 0; attempt < blockTermRecorderMaxAttempts; attempt++ {
		lastErr = m.persistBlockRuntimeGeometryOnce(br, cols, rows)
		if lastErr == nil ||
			errors.Is(lastErr, ErrBlockRuntimeInvalid) ||
			errors.Is(lastErr, ErrBlockRuntimeNotFound) ||
			errors.Is(lastErr, ErrBlockRuntimeNotRunning) {
			return lastErr
		}
		if attempt+1 < blockTermRecorderMaxAttempts {
			time.Sleep(blockRuntimeFinalizeRetryDelay)
		}
	}
	return lastErr
}

func (m *Manager) persistBlockRuntimeGeometryOnce(br *activeBlockRuntime, cols, rows int) error {
	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	return m.db.Transaction(func(tx *gorm.DB) error {
		var block model.BlockTermBlock
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(
			&block,
			"id = ? AND terminal_id = ?",
			br.key.BlockID,
			br.key.TerminalID,
		).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrBlockRuntimeNotFound
		}
		if err != nil {
			return err
		}
		if block.Status != model.StatusRunning {
			return ErrBlockRuntimeNotRunning
		}
		if block.Kind != "command" {
			return fmt.Errorf("%w: block must be a command block", ErrBlockRuntimeInvalid)
		}
		updatedAt := time.Now().Unix()
		result := tx.Model(&model.BlockTermBlock{}).
			Where("id = ? AND terminal_id = ? AND status = ?", block.ID, br.key.TerminalID, model.StatusRunning).
			Updates(map[string]any{
				"term_cols":  cols,
				"term_rows":  rows,
				"updated_at": updatedAt,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrBlockRuntimeNotRunning
		}
		block.TermCols = cols
		block.TermRows = rows
		block.UpdatedAt = updatedAt
		return blocktermhistory.Sync(tx, block)
	})
}

// CloseBlockRuntime closes only the independently owned runtime. It does not
// touch m.terminals or the parent session's runtime/connections.
func (m *Manager) CloseBlockRuntime(terminalID, blockID, token string) error {
	br, err := m.resolveBlockRuntime(terminalID, blockID, token)
	if err != nil {
		return err
	}
	return m.closeBlockRuntimeOwner(br, model.StatusClosed)
}

func (m *Manager) StopBlockRuntime(terminalID, blockID, token string) error {
	return m.CloseBlockRuntime(terminalID, blockID, token)
}

// RemoveBlockRuntime is an alias used by lifecycle owners that model runtime
// retirement as removal. It still closes the underlying runtime first.
func (m *Manager) RemoveBlockRuntime(terminalID, blockID, token string) error {
	return m.CloseBlockRuntime(terminalID, blockID, token)
}

// CloseBlockRuntimeForBlock closes the currently admitted owner without
// requiring a client token. It is used by durable block deletion, where the
// token is intentionally not persisted. The owner pointer is captured before
// closing so a later route generation cannot be accidentally retired.
func (m *Manager) CloseBlockRuntimeForBlock(terminalID, blockID string) error {
	if m == nil || !validBlockTermRuntimeTerminalID(terminalID) ||
		!validBlockTermBlockID(blockID) {
		return nil
	}
	m.ensureBlockRuntimeStore()
	key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
	m.blockRuntimeMu.RLock()
	br := m.blockRuntimes[key]
	m.blockRuntimeMu.RUnlock()
	if br == nil {
		return nil
	}
	return m.closeBlockRuntimeOwner(br, model.StatusClosed)
}

// HasActiveBlockRuntime reports whether an admitted child owner still exists
// for this durable block. Callers serialize ownership-changing decisions with
// LockBlockRuntimeLifecycle.
func (m *Manager) HasActiveBlockRuntime(terminalID, blockID string) bool {
	return m.activeBlockRuntimeOwner(terminalID, blockID) != nil
}

// CloseBlockRuntimesForTerminal atomically detaches every independent block
// route for terminalID, then closes each runtime without holding registry or
// manager-map locks. A prepared independent restart with no admitted runtime is
// settled as interrupted after active owners have finished. It is used by
// parent terminal close/reset/natural-exit paths.
func (m *Manager) CloseBlockRuntimesForTerminal(terminalID string) error {
	if m == nil {
		return nil
	}
	// Public callers do not already own the workspace lifecycle. Deletion takes
	// the write side before removing durable rows, so keep close/settlement from
	// racing that transaction. Internal close paths call the policy helper
	// directly because they already hold the appropriate read or write side.
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	return m.closeBlockRuntimesForTerminal(terminalID, true)
}

// closeBlockRuntimesForTerminal is the lifecycle-policy variant used by
// terminal deletion. Deletion removes the durable rows in its own transaction,
// so it must not first write an interrupted state for a preparation-only block.
func (m *Manager) closeBlockRuntimesForTerminal(terminalID string, settlePrepared bool) error {
	if m == nil || !validBlockTermRuntimeTerminalID(terminalID) {
		return nil
	}
	m.ensureBlockRuntimeStore()
	// Publish the closing marker before waiting for any per-block lifecycle lock.
	// A Create that is still constructing a runtime will fail its second admission
	// check and release its lifecycle lock, avoiding an admission/lifecycle cycle.
	m.blockRuntimeAdmissionMu.Lock()
	m.blockRuntimeMu.Lock()
	m.blockRuntimeClosing[terminalID] = struct{}{}
	m.blockRuntimeMu.Unlock()
	m.blockRuntimeAdmissionMu.Unlock()

	keys := make([]BlockTermRuntimeRouteKey, 0)
	m.blockRuntimeMu.RLock()
	for key, br := range m.blockRuntimes {
		if key.TerminalID == terminalID && br != nil {
			keys = append(keys, key)
		}
	}
	m.blockRuntimeMu.RUnlock()
	sort.Slice(keys, func(i, j int) bool { return keys[i].BlockID < keys[j].BlockID })
	lifecycleUnlocks := make([]func(), 0, len(keys))
	for _, key := range keys {
		lifecycleUnlocks = append(lifecycleUnlocks, m.LockBlockRuntimeLifecycle(key.TerminalID, key.BlockID))
	}

	// No route can be admitted after the marker above. Detach the exact owners
	// only after their lifecycle locks are held, so restart cannot reset a durable
	// row until the detached owner's finalizer has completed.
	m.blockRuntimeAdmissionMu.Lock()
	removed := m.blockTermRoutes.RemoveBlocks(terminalID)

	// Route removal is the linearization point. Once it has happened, no new
	// exact operation can resolve a block, while operations that already hold a
	// runtime pointer are joined by closeBlockRuntimeOwner below.
	runtimes := make([]*activeBlockRuntime, 0, len(removed))
	ownedRuntime := make([]TerminalRuntime, 0, len(removed))
	m.blockRuntimeMu.Lock()
	for key, br := range m.blockRuntimes {
		if key.TerminalID != terminalID || br == nil {
			continue
		}
		delete(m.blockRuntimes, key)
		runtimes = append(runtimes, br)
		ownedRuntime = append(ownedRuntime, br.runtime)
	}
	m.blockRuntimeMu.Unlock()
	m.blockRuntimeAdmissionMu.Unlock()

	errs := make([]error, 0, len(runtimes))
	for _, br := range runtimes {
		if err := m.closeBlockRuntimeOwner(br, model.StatusClosed); err != nil {
			errs = append(errs, fmt.Errorf("close BlockTerm runtime %s/%s: %w", terminalID, br.key.BlockID, err))
		}
	}
	// Routes registered directly through the public registry have no owner
	// object here. Parent shutdown still closes them after the registry lock has
	// been released. De-duplicate runtimes because a caller may intentionally
	// expose one runtime through more than one route.
	for _, route := range removed {
		if route.Runtime == nil || containsTerminalRuntime(ownedRuntime, route.Runtime) {
			continue
		}
		if err := route.Runtime.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close detached BlockTerm runtime %s/%s: %w", terminalID, route.BlockID, err))
		}
		ownedRuntime = append(ownedRuntime, route.Runtime)
	}
	// Release active-owner lifecycle locks before the preparation sweep. A
	// stale preparation for the same block is legal during recovery, and the
	// second phase must be able to reacquire that lock without self-deadlocking.
	for index := len(lifecycleUnlocks) - 1; index >= 0; index-- {
		lifecycleUnlocks[index]()
	}
	activeErr := joinTerminalErrors(errs...)
	if !settlePrepared {
		return activeErr
	}
	preparedErr := m.settleBlockRuntimePreparationsForTerminal(terminalID)
	return joinTerminalErrors(activeErr, preparedErr)
}

func containsTerminalRuntime(runtimes []TerminalRuntime, candidate TerminalRuntime) bool {
	for _, runtime := range runtimes {
		if sameTerminalRuntime(runtime, candidate) {
			return true
		}
	}
	return false
}

func (m *Manager) closeBlockRuntimeOwner(br *activeBlockRuntime, status string) error {
	if br == nil {
		return nil
	}
	if status == "" {
		status = model.StatusClosed
	}
	br.closeOnce.Do(func() {
		status = br.claimFinalStatus(status)
		// Publish the non-running state before waiting for the operation gate.
		// New operations will fail their state check. Keep websocket writers alive
		// until finish has synchronously delivered the terminal state and exit
		// notification; blocked readers are closed immediately afterward.
		var closeErr error
		if br.runtime != nil {
			closeErr = br.runtime.Close()
		}
		if waitErr := br.waitRuntime(); waitErr != nil {
			closeErr = errors.Join(closeErr, waitErr)
		}
		// Runtime.Close is responsible for interrupting a potentially blocked
		// operation. Join operations that passed the running check afterward.
		br.runtimeMu.Lock()
		br.runtimeMu.Unlock()
		if br.readDone != nil {
			<-br.readDone
		}
		if br.recorder != nil {
			br.recorder.CloseInput()
			if recorderErr := br.recorder.Wait(); recorderErr != nil {
				closeErr = errors.Join(closeErr, recorderErr)
			}
		}
		br.finish(closeErr, status)
		br.closeErrMu.Lock()
		br.closeErr = errors.Join(br.closeErr, closeErr)
		br.closeErrMu.Unlock()
		if br.closeDone != nil {
			br.closeDoneOnce.Do(func() { close(br.closeDone) })
		}
	})
	if br.closeDone != nil {
		<-br.closeDone
	}
	br.closeErrMu.Lock()
	err := br.closeErr
	br.closeErrMu.Unlock()
	return err
}

func (m *Manager) blockRuntimeReadLoop(br *activeBlockRuntime) {
	if br == nil {
		return
	}
	defer func() {
		if br.recorder != nil {
			br.recorder.CloseInput()
		}
		if br.readDone != nil {
			close(br.readDone)
		}
	}()
	maxRawSize := (br.bufferSize - 1) / 4 * 3
	if maxRawSize <= 0 {
		maxRawSize = 24 * 1024
	}
	buf := make([]byte, maxRawSize)
	for {
		n, err := br.runtime.Read(buf)
		if n > 0 {
			_, startCursor := br.buffer.CursorRange()
			br.deliveryMu.Lock()
			br.bufferMu.Lock()
			_, _ = br.buffer.Write(buf[:n])
			_, end := br.buffer.CursorRange()
			br.bufferMu.Unlock()
			br.infoMu.Lock()
			br.info.Cursor = end
			br.infoMu.Unlock()
			if br.recorder != nil {
				br.recorder.WriteRawBlock(br.key.BlockID, buf[:n], startCursor)
			}
			br.broadcastLocked(WSMessage{
				Type:       MsgTypeOutput,
				Data:       br.encoder.EncodeToString(buf[:n]),
				RouteMode:  RouteModeBlock,
				BlockID:    br.key.BlockID,
				BlockToken: br.infoToken(),
				Cursor:     end,
			})
			br.deliveryMu.Unlock()
		}
		if err != nil {
			// Read owns byte draining only. Wait is the lifecycle authority for the
			// final exit code and must complete before finish publishes state.
			return
		}
	}
}

func (br *activeBlockRuntime) infoToken() string {
	br.infoMu.RLock()
	token := br.info.BlockToken
	br.infoMu.RUnlock()
	return token
}

// waitRuntime serializes calls to TerminalRuntime.Wait. A close caller and the
// monitor may join the same runtime concurrently, but the runtime itself is
// only asked to wait once.
func (br *activeBlockRuntime) waitRuntime() error {
	if br == nil {
		return nil
	}
	br.waitMu.Lock()
	if br.waitDone == nil {
		br.waitDone = make(chan struct{})
	}
	done := br.waitDone
	br.waitMu.Unlock()
	br.waitOnce.Do(func() {
		var err error
		if br.runtime != nil {
			err = br.runtime.Wait(context.Background())
		}
		br.waitMu.Lock()
		br.waitErr = err
		close(done)
		br.waitMu.Unlock()
	})
	<-done
	br.waitMu.Lock()
	err := br.waitErr
	br.waitMu.Unlock()
	return err
}

// claimFinalStatus closes the operation admission gate without publishing a
// terminal state. The public status remains running until durable finalization
// completes, so attach/get cannot observe an exited or closed state ahead of
// the database and history snapshot.
func (br *activeBlockRuntime) claimFinalStatus(status string) string {
	if br == nil {
		return status
	}
	if status == "" {
		status = model.StatusExited
	}
	br.lifecycleMu.Lock()
	defer br.lifecycleMu.Unlock()
	if br.finishStatus == "" {
		br.finishStatus = status
		br.finishing.Store(true)
	}
	return br.finishStatus
}

func (br *activeBlockRuntime) broadcastLocked(msg WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	br.connections.Range(func(_, value any) bool {
		conn, ok := value.(*terminalConnection)
		if ok && br.manager != nil {
			_ = br.manager.sendConnectionData(conn, data)
		}
		return true
	})
}

func (br *activeBlockRuntime) broadcastAndWaitLocked(msg WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	br.connections.Range(func(_, value any) bool {
		conn, ok := value.(*terminalConnection)
		if ok && br.manager != nil {
			_ = br.manager.sendConnectionDataAndWait(conn, data)
		}
		return true
	})
}

func (br *activeBlockRuntime) finish(closeErr error, status string) {
	br.finishedOnce.Do(func() {
		status = br.claimFinalStatus(status)
		if durableErr := br.finalizeDurable(status); durableErr != nil {
			closeErr = errors.Join(closeErr, durableErr)
		}
		br.status.Store(status)
		br.infoMu.Lock()
		br.info.Status = status
		br.info.ExitCode = int(br.exitCode.Load())
		br.infoMu.Unlock()
		br.notifyFinished()
		if br.manager != nil && br.manager.blockTermRoutes != nil && br.routeHandle.Valid() {
			_, _ = br.manager.blockTermRoutes.Remove(br.routeHandle)
		}
		if br.manager != nil {
			br.manager.blockRuntimeMu.Lock()
			if br.manager.blockRuntimes[br.key] == br {
				delete(br.manager.blockRuntimes, br.key)
			}
			br.manager.blockRuntimeMu.Unlock()
		}
		br.connections.Range(func(_, value any) bool {
			conn, ok := value.(*terminalConnection)
			if ok {
				if conn.Cancel != nil {
					conn.Cancel()
				}
				if conn.Master != nil {
					_ = conn.Master.Close()
				}
			}
			return true
		})
		if closeErr != nil {
			br.closeErrMu.Lock()
			if br.closeErr == nil {
				br.closeErr = closeErr
			}
			br.closeErrMu.Unlock()
		}
		br.doneOnce.Do(func() { close(br.done) })
	})
}

const (
	blockRuntimeDurableSuccess     = "success"
	blockRuntimeDurableError       = "error"
	blockRuntimeDurableInterrupted = "interrupted"
)

// finalizeDurable is the single durable completion point for an independent
// runtime. It is deliberately invoked before notifyFinished, so a client that
// receives the final websocket state can immediately read the settled block
// and its history snapshot.
func (br *activeBlockRuntime) finalizeDurable(wireStatus string) error {
	if br == nil {
		return nil
	}
	br.finalizeOnce.Do(func() {
		if br.readDone != nil {
			<-br.readDone
		}
		var recorderErr error
		if br.recorder != nil {
			br.recorder.CloseInput()
			recorderErr = br.recorder.Wait()
		}
		fallback := br.buffer.Read()
		_, fallbackCursor := br.buffer.CursorRange()
		durableStatus := blockRuntimeDurableInterrupted
		var exitCode *int
		if wireStatus == model.StatusExited {
			code := int(br.exitCode.Load())
			exitCode = &code
			if code == 0 {
				durableStatus = blockRuntimeDurableSuccess
			} else {
				durableStatus = blockRuntimeDurableError
			}
		}
		settledStatus := durableStatus
		var finalizeErr error
		if br.manager != nil {
			for attempt := 0; attempt < blockTermRecorderMaxAttempts; attempt++ {
				settledStatus, finalizeErr = br.manager.finalizeBlockRuntimeDurable(
					br,
					durableStatus,
					exitCode,
					fallback,
					fallbackCursor,
				)
				if finalizeErr == nil {
					break
				}
				if attempt+1 < blockTermRecorderMaxAttempts {
					time.Sleep(blockRuntimeFinalizeRetryDelay)
				}
			}
		}
		totalErr := errors.Join(recorderErr, finalizeErr)
		br.durableMu.Lock()
		if finalizeErr != nil {
			br.durableStatus = model.StatusRunning
		} else {
			br.durableStatus = settledStatus
		}
		if totalErr != nil {
			br.durableError = totalErr.Error()
		} else {
			br.durableError = ""
		}
		br.durableMu.Unlock()
		br.finalizeErrMu.Lock()
		br.finalizeErr = totalErr
		br.finalizeErrMu.Unlock()
	})
	br.finalizeErrMu.Lock()
	err := br.finalizeErr
	br.finalizeErrMu.Unlock()
	return err
}

// finalizeBlockRuntimeDurable fences the durable row against the exact
// terminal/block owner and only transitions a still-running lifecycle. A
// restart, delete, or another finalizer that won the race therefore remains
// untouched.
func (m *Manager) finalizeBlockRuntimeDurable(
	br *activeBlockRuntime,
	durableStatus string,
	exitCode *int,
	fallbackOutput []byte,
	fallbackCursor uint64,
) (string, error) {
	if m == nil || m.db == nil || br == nil {
		return durableStatus, nil
	}
	if !m.db.Migrator().HasTable(&model.BlockTermBlock{}) {
		return durableStatus, nil
	}
	info := br.snapshot()
	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	settledStatus := model.StatusRunning
	err := m.db.Transaction(func(tx *gorm.DB) error {
		var block model.BlockTermBlock
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(
			&block,
			"id = ? AND terminal_id = ?",
			br.key.BlockID,
			br.key.TerminalID,
		).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Deletion is itself a valid lifecycle winner. There is no row left to
			// settle, and returning an error would make an otherwise successful
			// runtime close look like a transport failure.
			settledStatus = durableStatus
			return nil
		}
		if err != nil {
			return err
		}
		if block.Status != model.StatusRunning {
			settledStatus = block.Status
			return nil
		}

		output, outputCursor, err := materializeBlockRuntimeOutput(
			tx,
			block,
			fallbackOutput,
			fallbackCursor,
		)
		if err != nil {
			return err
		}
		finishedAt := time.Now().Unix()
		updates := map[string]any{
			"status":        durableStatus,
			"output":        output,
			"output_cursor": outputCursor,
			"exit_code":     exitCode,
			"finished_at":   finishedAt,
			"updated_at":    finishedAt,
		}
		if info.Cols >= blockTermRestartMinCols &&
			info.Cols <= blockTermRestartMaxCols &&
			tx.Migrator().HasColumn(&model.BlockTermBlock{}, "term_cols") {
			updates["term_cols"] = info.Cols
		}
		if info.Rows >= blockTermRestartMinRows &&
			info.Rows <= blockTermRestartMaxRows &&
			tx.Migrator().HasColumn(&model.BlockTermBlock{}, "term_rows") {
			updates["term_rows"] = info.Rows
		}
		result := tx.Model(&model.BlockTermBlock{}).
			Where("id = ? AND terminal_id = ? AND status = ?", block.ID, br.key.TerminalID, model.StatusRunning).
			Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			settledStatus = model.StatusRunning
			return nil
		}
		settledStatus = durableStatus
		block.Status = durableStatus
		block.Output = output
		block.OutputCursor = outputCursor
		if _, ok := updates["term_cols"]; ok {
			block.TermCols = info.Cols
		}
		if _, ok := updates["term_rows"]; ok {
			block.TermRows = info.Rows
		}
		block.ExitCode = exitCode
		block.FinishedAt = &finishedAt
		block.UpdatedAt = finishedAt
		if err := blocktermhistory.Sync(tx, block); err != nil {
			return err
		}
		return blocktermhistory.SyncOutputFromSegments(tx, block)
	})
	return settledStatus, err
}

func (br *activeBlockRuntime) durableOutcome() (string, string) {
	if br == nil {
		return "", ""
	}
	br.durableMu.RLock()
	status, durableErr := br.durableStatus, br.durableError
	br.durableMu.RUnlock()
	return status, durableErr
}

func materializeBlockRuntimeOutput(
	tx *gorm.DB,
	block model.BlockTermBlock,
	fallbackOutput []byte,
	fallbackCursor uint64,
) ([]byte, *int64, error) {
	output := append([]byte(nil), fallbackOutput...)
	cursor := fallbackCursor
	if tx != nil && tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
		var segments []model.BlockTermOutputSegment
		if err := tx.Where("block_id = ? AND terminal_id = ?", block.ID, block.TerminalID).
			Order("start_cursor ASC, end_cursor ASC, id ASC").Find(&segments).Error; err != nil {
			return nil, nil, err
		}
		if len(segments) > 0 {
			maxBytes := block.TermMaxPTYSize
			if maxBytes <= 0 || maxBytes > model.BlockTermMaxPTYSize {
				maxBytes = model.BlockTermMaxPTYSize
			}
			output = make([]byte, 0, maxBytes)
			var previousEnd uint64
			for index, segment := range segments {
				if segment.EndCursor < segment.StartCursor ||
					segment.EndCursor-segment.StartCursor != uint64(len(segment.Data)) ||
					(index > 0 && segment.StartCursor < previousEnd) {
					return nil, nil, fmt.Errorf("invalid blockterm raw output segment %s", segment.ID)
				}
				output = append(output, segment.Data...)
				if len(output) > maxBytes {
					output = output[len(output)-maxBytes:]
				}
				if segment.EndCursor > cursor {
					cursor = segment.EndCursor
				}
				previousEnd = segment.EndCursor
			}
		}
	}
	if cursor > math.MaxInt64 {
		return nil, nil, fmt.Errorf("blockterm raw output cursor exceeds signed range")
	}
	outputCursor := int64(cursor)
	return output, &outputCursor, nil
}

// notifyFinished publishes the terminal state before connections are cancelled
// or the route is removed. Each critical frame is joined with the connection's
// writer so closing the websocket cannot discard an already queued final state.
func (br *activeBlockRuntime) notifyFinished() {
	if br == nil || br.manager == nil {
		return
	}
	br.deliveryMu.Lock()
	defer br.deliveryMu.Unlock()
	info := br.snapshot()
	blockStatus, durableErr := br.wireDurableOutcome(info)
	exitCode := br.wireExitCode(info)
	br.broadcastAndWaitLocked(WSMessage{
		Type:         MsgTypeState,
		RouteMode:    RouteModeBlock,
		BlockID:      br.key.BlockID,
		BlockToken:   br.infoToken(),
		Status:       info.Status,
		BlockStatus:  blockStatus,
		DurableError: durableErr,
		RuntimeType:  info.RuntimeType,
		Cols:         info.Cols,
		Rows:         info.Rows,
		Cursor:       info.Cursor,
		ExitCode:     exitCode,
		Readonly:     true,
		Capabilities: info.Capabilities,
	})
	br.broadcastAndWaitLocked(WSMessage{
		Type:         MsgTypePtyExited,
		RouteMode:    RouteModeBlock,
		BlockID:      br.key.BlockID,
		BlockToken:   br.infoToken(),
		Cursor:       info.Cursor,
		ExitCode:     exitCode,
		BlockStatus:  blockStatus,
		DurableError: durableErr,
	})
}

func (m *Manager) blockRuntimeMonitor(br *activeBlockRuntime) {
	if br == nil || br.runtime == nil {
		return
	}
	waitErr := br.waitRuntime()
	status := br.claimFinalStatus(model.StatusExited)
	// Wait can race a final Read(n > 0, err). Join the reader before publishing
	// exit so the last bytes are visible to subscribers and replay.
	if br.readDone != nil {
		<-br.readDone
	}
	if br.recorder != nil {
		br.recorder.CloseInput()
		if recorderErr := br.recorder.Wait(); recorderErr != nil {
			waitErr = errors.Join(waitErr, recorderErr)
		}
	}
	if status == model.StatusExited {
		br.exitCode.Store(int64(br.runtime.ExitCode()))
		br.finish(waitErr, status)
	}
}

func blockRuntimeConnections(br *activeBlockRuntime) []*terminalConnection {
	if br == nil {
		return nil
	}
	connections := make([]*terminalConnection, 0)
	br.connections.Range(func(_, value any) bool {
		if conn, ok := value.(*terminalConnection); ok {
			connections = append(connections, conn)
		}
		return true
	})
	return connections
}

// AttachBlockRuntime binds a websocket to one exact block route. The route is
// validated before the handshake, and all output messages are tagged with the
// bound route so a client can maintain independent cursor state.
func (m *Manager) AttachBlockRuntime(terminalID, blockID, token string, conn *websocket.Conn, opts BlockRuntimeAttachOptions) (*BlockRuntimeConnection, error) {
	br, err := m.resolveBlockRuntime(terminalID, blockID, token)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		return nil, ErrMasterClosed
	}
	if !m.reserveConnectionSlot() {
		return nil, ErrMaxConnectionsReached
	}
	m.configureWSConn(conn)
	mst := newWSMaster(conn, m.wsWriteTimeout)
	ctx, cancel := context.WithCancel(context.Background())
	tc := &terminalConnection{
		ID:     fmt.Sprintf("block-%d", time.Now().UnixNano()),
		Master: mst,
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, terminalOutboundQueueSize),
	}
	done := make(chan struct{})
	cleanupOnce := sync.Once{}
	cleanup := func() {
		cleanupOnce.Do(func() {
			br.connections.Delete(tc.ID)
			m.activeConns.Add(-1)
			cancel()
			_ = mst.Close()
			close(done)
		})
	}

	// The delivery lock makes replay and the first live output one ordered
	// stream. A stale cursor receives a reset snapshot; a cursor at the end gets
	// only replay_done/state.
	br.deliveryMu.Lock()
	if br.status.Load().(string) != model.StatusRunning || br.finishing.Load() {
		br.deliveryMu.Unlock()
		cleanup()
		return nil, ErrBlockRuntimeNotRunning
	}
	br.bufferMu.RLock()
	replay, ok, end := br.buffer.ReadFrom(opts.Cursor)
	if !ok {
		replay = br.buffer.Read()
		_, end = br.buffer.CursorRange()
	}
	reset := !ok
	if len(replay) > 0 || reset {
		if err := m.sendConnectionMessage(tc, WSMessage{
			Type:       MsgTypeReplay,
			Data:       base64.StdEncoding.EncodeToString(replay),
			Cursor:     end,
			Reset:      reset,
			RouteMode:  RouteModeBlock,
			BlockID:    blockID,
			BlockToken: token,
		}); err != nil {
			br.bufferMu.RUnlock()
			br.deliveryMu.Unlock()
			cleanup()
			return nil, err
		}
	}
	br.bufferMu.RUnlock()
	if err := m.sendConnectionMessage(tc, WSMessage{Type: MsgTypeReplayDone, RouteMode: RouteModeBlock, BlockID: blockID, BlockToken: token, Cursor: end}); err != nil {
		br.deliveryMu.Unlock()
		cleanup()
		return nil, err
	}
	info := br.snapshot()
	blockStatus, durableErr := br.wireDurableOutcome(info)
	if err := m.sendConnectionMessage(tc, WSMessage{
		Type:         MsgTypeState,
		RouteMode:    RouteModeBlock,
		BlockID:      blockID,
		BlockToken:   token,
		Status:       info.Status,
		BlockStatus:  blockStatus,
		DurableError: durableErr,
		RuntimeType:  info.RuntimeType,
		Cols:         info.Cols,
		Rows:         info.Rows,
		Cursor:       info.Cursor,
		ExitCode:     br.wireExitCode(info),
		Readonly:     info.Status != model.StatusRunning,
		Capabilities: info.Capabilities,
		CurrentCwd:   info.Cwd,
	}); err != nil {
		br.deliveryMu.Unlock()
		cleanup()
		return nil, err
	}
	if info.Status != model.StatusRunning {
		_ = m.sendConnectionMessage(tc, WSMessage{
			Type:         MsgTypePtyExited,
			RouteMode:    RouteModeBlock,
			BlockID:      blockID,
			BlockToken:   token,
			Cursor:       info.Cursor,
			ExitCode:     br.wireExitCode(info),
			BlockStatus:  blockStatus,
			DurableError: durableErr,
		})
	}
	br.connections.Store(tc.ID, tc)
	br.deliveryMu.Unlock()

	go func() {
		defer cleanup()
		_ = m.writeConnectionLoop(tc)
	}()
	go func() {
		defer cleanup()
		_ = m.readBlockRuntimeClientLoop(br, tc)
	}()
	go func() {
		if err := m.pingLoop(ctx, tc); err != nil {
			cancel()
		}
	}()
	return &BlockRuntimeConnection{Done: done}, nil
}

func (br *activeBlockRuntime) bufferEnd() uint64 {
	br.bufferMu.RLock()
	_, end := br.buffer.CursorRange()
	br.bufferMu.RUnlock()
	return end
}

func (m *Manager) readBlockRuntimeClientLoop(br *activeBlockRuntime, conn *terminalConnection) error {
	for {
		select {
		case <-conn.Ctx.Done():
			return conn.Ctx.Err()
		default:
		}
		raw, err := conn.Master.ReadMessage()
		if err != nil {
			return err
		}
		if len(raw) == 0 {
			continue
		}
		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if msg.RouteMode != "" && msg.RouteMode != RouteModeBlock {
			if err := m.sendBlockRuntimeRejected(conn, msg, InputRejectedInvalidRoute); err != nil {
				return err
			}
			continue
		}
		if msg.BlockID != br.key.BlockID || msg.BlockToken != br.infoToken() {
			reason := InputRejectedTokenMismatch
			if msg.BlockID == "" || msg.BlockToken == "" {
				reason = InputRejectedRouteRequired
			}
			if err := m.sendBlockRuntimeRejected(conn, msg, reason); err != nil {
				return err
			}
			continue
		}
		switch msg.Type {
		case MsgTypeInput:
			decoded, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil || len(decoded) == 0 {
				reason := InputRejectedInvalidEncoding
				if len(decoded) == 0 && err == nil {
					reason = InputRejectedEmptyInput
				}
				if sendErr := m.sendBlockRuntimeRejected(conn, msg, reason); sendErr != nil {
					return sendErr
				}
				continue
			}
			if err := m.WriteBlockRuntime(br.key.TerminalID, br.key.BlockID, br.infoToken(), decoded); err != nil {
				reason := InputRejectedRuntimeWriteFailed
				if errors.Is(err, ErrBlockRuntimeNotRunning) {
					reason = InputRejectedTerminalNotRunning
				}
				if sendErr := m.sendBlockRuntimeRejected(conn, msg, reason); sendErr != nil {
					return sendErr
				}
			}
		case MsgTypeSignal:
			if _, err := NormalizeTerminalSignal(msg.Signal); err != nil {
				if sendErr := m.sendBlockRuntimeRejected(conn, msg, InputRejectedInvalidSignal); sendErr != nil {
					return sendErr
				}
				continue
			}
			if err := m.SignalBlockRuntime(br.key.TerminalID, br.key.BlockID, br.infoToken(), msg.Signal); err != nil {
				reason := InputRejectedRuntimeSignalFailed
				if errors.Is(err, ErrBlockRuntimeNotRunning) {
					reason = InputRejectedTerminalNotRunning
				}
				if sendErr := m.sendBlockRuntimeRejected(conn, msg, reason); sendErr != nil {
					return sendErr
				}
			}
		case MsgTypeResize:
			if err := m.ResizeBlockRuntime(br.key.TerminalID, br.key.BlockID, br.infoToken(), msg.Cols, msg.Rows); err != nil {
				if sendErr := m.sendBlockRuntimeRejected(conn, msg, InputRejectedRuntimeWriteFailed); sendErr != nil {
					return sendErr
				}
			}
		case MsgTypeState:
			info := br.snapshot()
			blockStatus, durableErr := br.wireDurableOutcome(info)
			if err := m.sendConnectionMessage(conn, WSMessage{
				Type:         MsgTypeState,
				RouteMode:    RouteModeBlock,
				BlockID:      br.key.BlockID,
				BlockToken:   br.infoToken(),
				Status:       info.Status,
				BlockStatus:  blockStatus,
				DurableError: durableErr,
				RuntimeType:  info.RuntimeType,
				Cols:         info.Cols,
				Rows:         info.Rows,
				Cursor:       info.Cursor,
				ExitCode:     br.wireExitCode(info),
				Readonly:     info.Status != model.StatusRunning,
				Capabilities: info.Capabilities,
				CurrentCwd:   info.Cwd,
			}); err != nil {
				return err
			}
		case MsgTypeAck:
			if msg.Cursor > conn.AckCursor.Load() {
				conn.AckCursor.Store(msg.Cursor)
			}
		}
	}
}

func (m *Manager) sendBlockRuntimeRejected(conn *terminalConnection, msg WSMessage, reason InputRejectedReason) error {
	return m.sendConnectionMessage(conn, WSMessage{
		Type:       MsgTypeInputRejected,
		RouteMode:  RouteModeBlock,
		BlockID:    msg.BlockID,
		BlockToken: msg.BlockToken,
		Reason:     reason,
	})
}

// AttachBlockRuntimeWithOptions is an explicit alias for callers that prefer
// the naming used by the parent terminal attach API.
func (m *Manager) AttachBlockRuntimeWithOptions(terminalID, blockID, token string, conn *websocket.Conn, opts BlockRuntimeAttachOptions) (*BlockRuntimeConnection, error) {
	return m.AttachBlockRuntime(terminalID, blockID, token, conn, opts)
}
