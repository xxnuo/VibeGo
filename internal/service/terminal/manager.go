package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type terminalConnection struct {
	ID        string
	Master    master
	Ctx       context.Context
	Cancel    context.CancelFunc
	sendCh    chan terminalOutboundMessage
	AckCursor atomic.Uint64
}

type terminalOutboundMessage struct {
	data []byte
	done chan error
}

type activeTerminal struct {
	ID            string
	Runtime       TerminalRuntime
	Session       *model.TerminalSession
	Connections   sync.Map
	Done          chan struct{}
	readDone      chan struct{}
	flushDone     chan struct{}
	flushStop     chan struct{}
	flushStopOnce sync.Once
	closeOnce     sync.Once
	closeErr      error
	deliveryMu    sync.Mutex
	inputMu       sync.Mutex
	runtimeMu     sync.RWMutex
	stateMu       sync.Mutex
	sessionMu     sync.RWMutex
	historyBuffer *historyBuffer
	historyMu     sync.RWMutex
	status        atomic.Value
	flushTicker   *time.Ticker
	bufferSize    int
	encoder       *base64.Encoding
	capabilities  TerminalCapabilities
}

type terminalLifecycleLock struct {
	mu   sync.Mutex
	refs int
}

type Manager struct {
	db                     *gorm.DB
	terminals              sync.Map
	terminalLifecycleMu    sync.Mutex
	terminalLifecycleLocks map[string]*terminalLifecycleLock
	workspaceLifecycleMu   sync.RWMutex
	workspaceMutationMu    sync.Mutex
	shell                  string
	bufferSize             int
	maxConnections         int
	activeConns            atomic.Int64
	historyBufferSize      int
	historyFlushInterval   time.Duration
	historyMaxRecords      int
	historyMaxAge          time.Duration
	wsPingInterval         time.Duration
	wsReadTimeout          time.Duration
	wsWriteTimeout         time.Duration
	snapshotStore          TerminalSnapshotStore
	runtimeFactory         RuntimeFactory
}

type replaySnapshot struct {
	data   []byte
	cursor uint64
	reset  bool
}

const (
	terminalOutboundQueueSize    = 128
	terminalCriticalWriteTimeout = 10 * time.Second
)

type preparedTerminalRuntime struct {
	runtime      TerminalRuntime
	runtimeType  string
	shell        string
	cwd          string
	cols         int
	rows         int
	capabilities TerminalCapabilities
}

func NewManager(db *gorm.DB, cfg *ManagerConfig) *Manager {
	if cfg == nil {
		cfg = &ManagerConfig{}
	}
	cfg.applyDefaults()

	return &Manager{
		db:                   db,
		shell:                cfg.Shell,
		bufferSize:           cfg.BufferSize,
		maxConnections:       cfg.MaxConnections,
		historyBufferSize:    cfg.HistoryBufferSize,
		historyFlushInterval: cfg.HistoryFlushInterval,
		historyMaxRecords:    cfg.HistoryMaxRecords,
		historyMaxAge:        cfg.HistoryMaxAge,
		wsPingInterval:       cfg.WSPingInterval,
		wsReadTimeout:        cfg.WSReadTimeout,
		wsWriteTimeout:       cfg.WSWriteTimeout,
		snapshotStore:        NewDBTerminalSnapshotStore(db),
		runtimeFactory:       cfg.RuntimeFactory,
	}
}

func (m *Manager) DB() *gorm.DB {
	return m.db
}

func (m *Manager) Create(opts CreateOptions) (*TerminalInfo, error) {
	if requestedRuntimeType(opts.RuntimeType) != RuntimeTypeLocal {
		return m.createRemote(opts, false)
	}
	return m.createWithWorkspaceMutation(opts)
}

func (m *Manager) createWithWorkspaceMutation(opts CreateOptions) (*TerminalInfo, error) {
	var info *TerminalInfo
	err := m.withWorkspaceMutation(func() error {
		if err := m.validateCreateOptions(&opts); err != nil {
			return err
		}
		var err error
		info, err = m.create(opts)
		return err
	})
	return info, err
}

// CreateInWorkspace keeps the explicit HTTP call site while sharing Create's
// workspace and parent validation.
func (m *Manager) CreateInWorkspace(opts CreateOptions) (*TerminalInfo, error) {
	if requestedRuntimeType(opts.RuntimeType) != RuntimeTypeLocal {
		return m.createRemote(opts, true)
	}
	var info *TerminalInfo
	err := m.WithTerminalLifecycle(func() error {
		var err error
		info, err = m.createWithWorkspaceMutation(opts)
		return err
	})
	return info, err
}

func requestedRuntimeType(value string) string {
	runtimeType := strings.TrimSpace(value)
	if runtimeType == "" {
		return RuntimeTypeLocal
	}
	return runtimeType
}

func (m *Manager) withCreateScopeLock(withLifecycle bool, fn func() error) error {
	run := func() error {
		return m.withWorkspaceMutation(fn)
	}
	if withLifecycle {
		return m.WithTerminalLifecycle(run)
	}
	return run()
}

func (m *Manager) validateCreateOptions(opts *CreateOptions) error {
	db := m.db
	if opts.Context != nil {
		db = db.WithContext(opts.Context)
	}
	if err := m.resolveTerminalParentScope(db, opts); err != nil {
		return err
	}
	return m.validateWorkspaceSession(db, opts.WorkspaceSessionID)
}

func (m *Manager) createRemote(opts CreateOptions, withLifecycle bool) (*TerminalInfo, error) {
	if err := m.withCreateScopeLock(withLifecycle, func() error {
		return m.validateCreateOptions(&opts)
	}); err != nil {
		return nil, err
	}

	prepared, err := m.prepareRuntime(opts)
	if err != nil {
		return nil, err
	}
	if opts.Context != nil {
		if err := opts.Context.Err(); err != nil {
			_ = prepared.runtime.Close()
			return nil, err
		}
	}

	var info *TerminalInfo
	err = m.withCreateScopeLock(withLifecycle, func() error {
		if opts.Context != nil {
			if err := opts.Context.Err(); err != nil {
				return err
			}
		}
		if err := m.validateCreateOptions(&opts); err != nil {
			return err
		}
		var persistErr error
		info, persistErr = m.persistRuntime(opts, prepared)
		return persistErr
	})
	if err != nil {
		_ = prepared.runtime.Close()
		return nil, err
	}
	return info, nil
}

func (m *Manager) create(opts CreateOptions) (*TerminalInfo, error) {
	prepared, err := m.prepareRuntime(opts)
	if err != nil {
		return nil, err
	}
	info, err := m.persistRuntime(opts, prepared)
	if err != nil {
		_ = prepared.runtime.Close()
		return nil, err
	}
	return info, nil
}

func (m *Manager) prepareRuntime(opts CreateOptions) (*preparedTerminalRuntime, error) {
	runtimeType := requestedRuntimeType(opts.RuntimeType)
	cwd := opts.Cwd
	if runtimeType == RuntimeTypeLocal && cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			cwd = os.Getenv("HOME")
		}
	}
	if cwd == "" {
		cwd = "."
	}
	cols := opts.Cols
	if cols <= 0 {
		cols = 80
	}
	rows := opts.Rows
	if rows <= 0 {
		rows = 24
	}

	var runtime TerminalRuntime
	var shell string
	var err error
	switch runtimeType {
	case RuntimeTypeLocal:
		var pty *localCommand
		var args []string
		if opts.Command != "" {
			// A block command is a real child command of the selected shell. Do
			// not feed `command; exit` to an interactive shell: TUI programs can
			// consume that input and leave the runtime alive indefinitely.
			args = []string{"-c", opts.Command}
		}
		pty, err = newLocalCommand(m.shell, args, cwd, cols, rows)
		if err == nil {
			runtime = NewLocalPTYRuntime(pty)
			shell = m.shell
		}
	default:
		if m.runtimeFactory == nil {
			return nil, fmt.Errorf("%w: %s", ErrRuntimeFactoryMissing, runtimeType)
		}
		ctx := opts.Context
		if ctx == nil {
			ctx = context.Background()
		}
		runtime, err = m.runtimeFactory.CreateRuntime(ctx, RuntimeCreateRequest{
			Type:      runtimeType,
			ProfileID: opts.SSHProfileID,
			Cwd:       cwd,
			Command:   opts.Command,
			Cols:      cols,
			Rows:      rows,
			SSHAuth:   opts.SSHAuth,
		})
	}
	if err != nil {
		if runtime != nil {
			_ = runtime.Close()
		}
		return nil, err
	}
	if runtime == nil {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedRuntime, runtimeType)
	}
	runtimeType = strings.TrimSpace(runtime.Type())
	if runtimeType == "" {
		_ = runtime.Close()
		return nil, ErrUnsupportedRuntime
	}
	return &preparedTerminalRuntime{
		runtime:      runtime,
		runtimeType:  runtimeType,
		shell:        shell,
		cwd:          cwd,
		cols:         cols,
		rows:         rows,
		capabilities: runtime.Capabilities(),
	}, nil
}

func (m *Manager) persistRuntime(opts CreateOptions, prepared *preparedTerminalRuntime) (*TerminalInfo, error) {
	db := m.db
	ctx := context.Background()
	if opts.Context != nil {
		ctx = opts.Context
		db = db.WithContext(ctx)
	}

	name := opts.Name
	if name == "" {
		var count int64
		if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
			return nil, err
		}
		name = fmt.Sprintf("Terminal %d", count+1)
	}
	sshProfileID := ""
	if prepared.runtimeType == RuntimeTypeSSH {
		sshProfileID = opts.SSHProfileID
	}

	now := time.Now().Unix()
	session := &model.TerminalSession{
		ID:                 uuid.New().String(),
		UserID:             opts.UserID,
		WorkspaceSessionID: opts.WorkspaceSessionID,
		GroupID:            opts.GroupID,
		ParentID:           opts.ParentID,
		Name:               name,
		Shell:              prepared.shell,
		Cwd:                prepared.cwd,
		CurrentCwd:         prepared.cwd,
		Cols:               prepared.cols,
		Rows:               prepared.rows,
		RuntimeType:        prepared.runtimeType,
		SSHProfileID:       sshProfileID,
		Readonly:           false,
		Status:             model.StatusRunning,
		ShellIntegration:   prepared.capabilities.ShellIntegration,
		CreatedAt:          now,
		UpdatedAt:          now,
	}

	if err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(session).Error; err != nil {
			return err
		}
		return ctx.Err()
	}); err != nil {
		return nil, err
	}

	return m.activatePreparedRuntime(session, prepared, nil), nil
}

func (m *Manager) activatePreparedRuntime(
	session *model.TerminalSession,
	prepared *preparedTerminalRuntime,
	snapshot *TerminalSnapshot,
) *TerminalInfo {
	history := newHistoryBuffer(m.historyBufferSize)
	if snapshot != nil {
		history.Restore(snapshot.Data, snapshot.Cursor)
	}
	active := &activeTerminal{
		ID:            session.ID,
		Runtime:       prepared.runtime,
		Session:       session,
		Done:          make(chan struct{}),
		readDone:      make(chan struct{}),
		flushDone:     make(chan struct{}),
		flushStop:     make(chan struct{}),
		historyBuffer: history,
		flushTicker:   time.NewTicker(m.historyFlushInterval),
		bufferSize:    m.bufferSize,
		encoder:       base64.StdEncoding,
		capabilities:  prepared.capabilities,
	}
	active.status.Store(model.StatusRunning)

	info := sessionToInfo(session)
	info.Capabilities = prepared.capabilities

	m.terminals.Store(session.ID, active)
	go m.ptyReadLoop(active)
	go m.monitorRuntimeAsync(active)
	go m.flushHistory(active)

	return info
}

func (m *Manager) markClosed(id string) {
	m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"status":     model.StatusClosed,
		"updated_at": time.Now().Unix(),
	})
}

func (m *Manager) getActive(id string) (*activeTerminal, bool) {
	val, ok := m.terminals.Load(id)
	if !ok {
		return nil, false
	}
	return val.(*activeTerminal), true
}

func (m *Manager) lockTerminalLifecycle(id string) func() {
	m.terminalLifecycleMu.Lock()
	if m.terminalLifecycleLocks == nil {
		m.terminalLifecycleLocks = make(map[string]*terminalLifecycleLock)
	}
	entry := m.terminalLifecycleLocks[id]
	if entry == nil {
		entry = &terminalLifecycleLock{}
		m.terminalLifecycleLocks[id] = entry
	}
	entry.refs++
	m.terminalLifecycleMu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		m.terminalLifecycleMu.Lock()
		entry.refs--
		if entry.refs == 0 && m.terminalLifecycleLocks[id] == entry {
			delete(m.terminalLifecycleLocks, id)
		}
		m.terminalLifecycleMu.Unlock()
	}
}

func (m *Manager) Get(id string) (*TerminalInfo, bool) {
	at, ok := m.getActive(id)
	if !ok {
		return nil, false
	}
	at.sessionMu.RLock()
	session := cloneTerminalSession(at.Session)
	capabilities := at.capabilities
	status := at.status.Load().(string)
	at.sessionMu.RUnlock()
	info := sessionToInfo(&session)
	info.Capabilities = capabilities
	info.Status = status
	return info, true
}

// Complete queries the live runtime's own completion environment. The
// capability is optional; notably, an SSH runtime must use a separate remote
// exec channel rather than writing completion commands into its interactive
// PTY.
func (m *Manager) Complete(ctx context.Context, id string, request CompletionRequest) (CompletionResult, error) {
	at, ok := m.getActive(id)
	if !ok {
		return CompletionResult{}, ErrTerminalNotFound
	}
	if !at.capabilities.Completion {
		return CompletionResult{}, ErrCompletionUnsupported
	}
	provider, ok := at.Runtime.(CompletionProvider)
	if !ok {
		return CompletionResult{}, ErrCompletionUnsupported
	}
	if ctx == nil {
		ctx = context.Background()
	}

	at.runtimeMu.RLock()
	defer at.runtimeMu.RUnlock()
	at.stateMu.Lock()
	status := at.status.Load().(string)
	at.stateMu.Unlock()
	if status != model.StatusRunning {
		return CompletionResult{}, ErrTerminalNotFound
	}

	result, err := provider.Complete(ctx, request)
	if err != nil {
		return CompletionResult{}, err
	}
	if request.Limit > 0 && len(result.Candidates) > request.Limit {
		result.Candidates = result.Candidates[:request.Limit]
		result.HasMore = true
	}
	at.stateMu.Lock()
	status = at.status.Load().(string)
	at.stateMu.Unlock()
	if status != model.StatusRunning {
		return CompletionResult{}, ErrTerminalNotFound
	}
	return result, nil
}

// CompleteProfile delegates a completion query to the configured runtime
// factory for a trusted, profile-specific connection. It is intentionally
// separate from Complete: the latter is fenced to an active parent terminal,
// while a future connection may select another SSH profile.
func (m *Manager) CompleteProfile(ctx context.Context, profileID string, request CompletionRequest) (CompletionResult, error) {
	if m == nil || m.runtimeFactory == nil {
		return CompletionResult{}, ErrCompletionUnsupported
	}
	provider, ok := m.runtimeFactory.(ProfileCompletionProvider)
	if !ok {
		return CompletionResult{}, ErrCompletionUnsupported
	}
	if ctx == nil {
		ctx = context.Background()
	}
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return CompletionResult{}, ErrCompletionUnsupported
	}
	result, err := provider.CompleteProfile(ctx, profileID, request)
	if err != nil {
		return CompletionResult{}, err
	}
	if request.Limit > 0 && len(result.Candidates) > request.Limit {
		result.Candidates = result.Candidates[:request.Limit]
		result.HasMore = true
	}
	return result, nil
}

// ProcessIdentity returns the live process identity for a runtime that can
// observe it. The capability is optional: remote runtimes must not fabricate a
// local PID, and an inactive terminal has no usable execution identity.
func (m *Manager) ProcessIdentity(id string) (ProcessIdentity, error) {
	at, ok := m.getActive(id)
	if !ok {
		return ProcessIdentity{}, ErrTerminalNotFound
	}

	provider, ok := at.Runtime.(ProcessIdentityProvider)
	if !ok {
		return ProcessIdentity{}, ErrProcessIdentityUnsupported
	}
	at.runtimeMu.RLock()
	defer at.runtimeMu.RUnlock()

	at.stateMu.Lock()
	status := at.status.Load().(string)
	at.stateMu.Unlock()
	if status != model.StatusRunning {
		return ProcessIdentity{}, ErrTerminalNotFound
	}

	identity, err := provider.ProcessIdentity()
	if err != nil {
		return ProcessIdentity{}, err
	}
	at.stateMu.Lock()
	status = at.status.Load().(string)
	at.stateMu.Unlock()
	if status != model.StatusRunning {
		return ProcessIdentity{}, ErrTerminalNotFound
	}
	return identity, nil
}

func (m *Manager) Resize(id string, cols, rows int) error {
	at, ok := m.getActive(id)
	if !ok {
		return ErrTerminalNotFound
	}

	// Hold a read gate for the duration of the runtime operation. Close takes
	// the write side only after calling Runtime.Close, so a blocked operation can
	// still be interrupted by the runtime itself.
	at.runtimeMu.RLock()
	defer at.runtimeMu.RUnlock()
	at.stateMu.Lock()
	if at.status.Load().(string) != model.StatusRunning {
		at.stateMu.Unlock()
		return ErrTerminalNotFound
	}
	at.stateMu.Unlock()
	if err := at.Runtime.Resize(cols, rows); err != nil {
		return err
	}

	at.stateMu.Lock()
	defer at.stateMu.Unlock()
	if at.status.Load().(string) != model.StatusRunning {
		return ErrTerminalNotFound
	}
	at.sessionMu.Lock()
	at.Session.Cols = cols
	at.Session.Rows = rows
	at.Session.UpdatedAt = time.Now().Unix()
	updatedAt := at.Session.UpdatedAt
	at.sessionMu.Unlock()

	m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"cols":       cols,
		"rows":       rows,
		"updated_at": updatedAt,
	})

	return nil
}

func (m *Manager) Rename(id, name string) error {
	return m.UpdateSettings(id, SettingsUpdate{Name: &name})
}

func (m *Manager) UpdateSettings(id string, update SettingsUpdate) error {
	normalized, err := normalizeSettingsUpdate(update)
	if err != nil {
		return err
	}

	for attempt := 0; attempt < 3; attempt++ {
		var scope model.TerminalSession
		if err := m.db.Select("id", "workspace_session_id").First(&scope, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTerminalNotFound
			}
			return err
		}

		if scope.WorkspaceSessionID == "" {
			err = m.updateUnscopedTerminalSettings(id, normalized)
		} else {
			err = m.updateWorkspaceTerminalSettings(scope.WorkspaceSessionID, id, normalized)
		}
		if errors.Is(err, errTerminalWorkspaceChanged) {
			continue
		}
		return err
	}
	return ErrTerminalScopeMismatch
}

var errTerminalWorkspaceChanged = errors.New("terminal workspace changed")

func (m *Manager) updateUnscopedTerminalSettings(id string, update SettingsUpdate) error {
	return m.withWorkspaceMutation(func() error {
		var updated model.TerminalSession
		if err := m.db.Transaction(func(tx *gorm.DB) error {
			var session model.TerminalSession
			if err := tx.First(&session, "id = ?", id).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrTerminalNotFound
				}
				return err
			}
			if session.WorkspaceSessionID != "" {
				return errTerminalWorkspaceChanged
			}
			return applyTerminalSettings(tx, &session, update, &updated)
		}); err != nil {
			return err
		}
		m.publishTerminalSettings(updated)
		return nil
	})
}

func (m *Manager) updateWorkspaceTerminalSettings(workspaceSessionID, id string, update SettingsUpdate) error {
	var updated model.TerminalSession
	return m.mutateWorkspace(workspaceSessionID, func(tx *gorm.DB) error {
		var session model.TerminalSession
		if err := tx.First(&session, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTerminalNotFound
			}
			return err
		}
		if session.WorkspaceSessionID != workspaceSessionID {
			return errTerminalWorkspaceChanged
		}
		if err := applyTerminalSettings(tx, &session, update, &updated); err != nil {
			return err
		}

		var workspace model.UserSession
		if err := tx.First(&workspace, "id = ?", workspaceSessionID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrWorkspaceNotFound
			}
			return err
		}
		rawState, err := updateWorkspaceTerminalSettingsState(workspace.State, updated)
		if err != nil {
			return err
		}
		now := updated.UpdatedAt
		return tx.Model(&model.UserSession{}).Where("id = ?", workspaceSessionID).Updates(map[string]any{
			"state":          rawState,
			"updated_at":     now,
			"last_active_at": now,
		}).Error
	}, func() {
		m.publishTerminalSettings(updated)
	})
}

func applyTerminalSettings(tx *gorm.DB, session *model.TerminalSession, update SettingsUpdate, updated *model.TerminalSession) error {
	now := time.Now().Unix()
	updates := map[string]any{"updated_at": now}
	if update.Name != nil {
		updates["name"] = *update.Name
		session.Name = *update.Name
	}
	if update.TabColor != nil {
		updates["tab_color"] = *update.TabColor
		session.TabColor = *update.TabColor
	}
	if update.TabIcon != nil {
		updates["tab_icon"] = *update.TabIcon
		session.TabIcon = *update.TabIcon
	}
	session.UpdatedAt = now
	result := tx.Model(&model.TerminalSession{}).Where("id = ?", session.ID).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrTerminalNotFound
	}
	*updated = *session
	return nil
}

func (m *Manager) publishTerminalSettings(session model.TerminalSession) {
	if at, ok := m.getActive(session.ID); ok {
		at.sessionMu.Lock()
		at.Session.Name = session.Name
		at.Session.TabColor = session.TabColor
		at.Session.TabIcon = session.TabIcon
		at.Session.UpdatedAt = session.UpdatedAt
		at.sessionMu.Unlock()
	}
}

func (m *Manager) UpdateShellMetadata(id string, update ShellMetadataUpdate) error {
	now := time.Now().Unix()
	updates := map[string]any{
		"updated_at": now,
	}

	if update.CurrentCwd != nil {
		updates["current_cwd"] = *update.CurrentCwd
	}
	if update.ShellType != nil {
		updates["shell_type"] = *update.ShellType
	}
	if update.ShellState != nil {
		updates["shell_state"] = *update.ShellState
	}
	if update.ShellIntegration != nil {
		updates["shell_integration"] = *update.ShellIntegration
	}
	if update.LastCommand != nil {
		updates["last_command"] = *update.LastCommand
	}
	if update.LastCommandExitCodeSet && update.LastCommandExitCode == nil {
		updates["last_command_exit_code"] = nil
	} else if update.LastCommandExitCode != nil {
		updates["last_command_exit_code"] = *update.LastCommandExitCode
	}

	result := m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrTerminalNotFound
	}

	if at, ok := m.getActive(id); ok {
		at.sessionMu.Lock()
		if update.CurrentCwd != nil {
			at.Session.CurrentCwd = *update.CurrentCwd
		}
		if update.ShellType != nil {
			at.Session.ShellType = *update.ShellType
		}
		if update.ShellState != nil {
			at.Session.ShellState = *update.ShellState
		}
		if update.ShellIntegration != nil {
			at.Session.ShellIntegration = *update.ShellIntegration
			at.capabilities.ShellIntegration = *update.ShellIntegration
		}
		if update.LastCommand != nil {
			at.Session.LastCommand = *update.LastCommand
		}
		if update.LastCommandExitCodeSet && update.LastCommandExitCode == nil {
			at.Session.LastCommandExitCode = nil
		} else if update.LastCommandExitCode != nil {
			exitCode := *update.LastCommandExitCode
			at.Session.LastCommandExitCode = &exitCode
		}
		at.Session.UpdatedAt = now
		at.sessionMu.Unlock()
	}

	return nil
}

func (m *Manager) Close(id string) error {
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	unlock := m.lockTerminalLifecycle(id)
	defer unlock()
	return m.close(id)
}

// Reset replaces a live local runtime while preserving the terminal identity
// and history. Remote runtimes are intentionally excluded because VibeGo does
// not persist the authentication material needed to recreate them safely.
func (m *Manager) Reset(id string) (*TerminalInfo, error) {
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	unlock := m.lockTerminalLifecycle(id)
	defer unlock()

	at, ok := m.getActive(id)
	if !ok {
		return nil, ErrTerminalNotFound
	}

	at.stateMu.Lock()
	running := at.status.Load().(string) == model.StatusRunning
	at.sessionMu.RLock()
	session := cloneTerminalSession(at.Session)
	at.sessionMu.RUnlock()
	at.stateMu.Unlock()
	if !running || session.Readonly {
		return nil, ErrTerminalNotFound
	}
	if session.RuntimeType != RuntimeTypeLocal {
		return nil, ErrTerminalResetUnsupported
	}

	cwd := session.CurrentCwd
	if cwd == "" {
		cwd = session.Cwd
	}
	prepared, err := m.prepareRuntime(CreateOptions{
		Cwd:         cwd,
		Cols:        session.Cols,
		Rows:        session.Rows,
		RuntimeType: RuntimeTypeLocal,
	})
	if err != nil {
		return nil, err
	}
	at.stateMu.Lock()
	stillRunning := at.status.Load().(string) == model.StatusRunning
	at.stateMu.Unlock()
	if !stillRunning {
		_ = prepared.runtime.Close()
		return nil, ErrTerminalNotFound
	}

	at.stateMu.Lock()
	at.sessionMu.Lock()
	at.Session.Status = model.StatusClosed
	at.Session.Readonly = true
	at.status.Store(model.StatusClosed)
	at.sessionMu.Unlock()
	at.stateMu.Unlock()

	if err := m.close(id); err != nil {
		_ = prepared.runtime.Close()
		return nil, err
	}

	snapshot, err := m.loadSnapshot(id)
	if err != nil {
		_ = prepared.runtime.Close()
		return nil, err
	}
	now := time.Now().Unix()
	session.Shell = prepared.shell
	session.CurrentCwd = prepared.cwd
	session.Cols = prepared.cols
	session.Rows = prepared.rows
	session.RuntimeType = prepared.runtimeType
	session.Readonly = false
	session.Status = model.StatusRunning
	session.ExitCode = 0
	session.ShellType = ""
	session.ShellState = ""
	session.ShellIntegration = prepared.capabilities.ShellIntegration
	session.LastCommand = ""
	session.LastCommandExitCode = nil
	if snapshot != nil {
		session.HistorySize = int64(len(snapshot.Data))
	}
	session.UpdatedAt = now

	updates := map[string]any{
		"shell":                  session.Shell,
		"current_cwd":            session.CurrentCwd,
		"cols":                   session.Cols,
		"rows":                   session.Rows,
		"runtime_type":           session.RuntimeType,
		"readonly":               session.Readonly,
		"status":                 session.Status,
		"exit_code":              session.ExitCode,
		"history_size":           session.HistorySize,
		"shell_type":             session.ShellType,
		"shell_state":            session.ShellState,
		"shell_integration":      session.ShellIntegration,
		"last_command":           session.LastCommand,
		"last_command_exit_code": nil,
		"updated_at":             session.UpdatedAt,
	}
	result := m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(updates)
	if result.Error != nil || result.RowsAffected == 0 {
		_ = prepared.runtime.Close()
		if result.Error != nil {
			return nil, result.Error
		}
		return nil, ErrTerminalNotFound
	}

	return m.activatePreparedRuntime(&session, prepared, snapshot), nil
}

// close performs terminal shutdown while the caller owns the workspace
// lifecycle lock. Delete and DeleteWorkspace already hold the write lock and
// must use this helper instead of reacquiring it.
func (m *Manager) close(id string) error {
	return m.closeWithPreparedSettlement(id, true)
}

// closeForDelete tears down runtime resources without settling preparation-only
// blocks. The delete transaction removes those durable rows; its post-commit
// cleanup retires the in-memory markers.
func (m *Manager) closeForDelete(id string) error {
	return m.closeWithPreparedSettlement(id, false)
}

func (m *Manager) closeWithPreparedSettlement(id string, settlePrepared bool) error {
	val, ok := m.terminals.Load(id)
	if !ok {
		return nil
	}
	at := val.(*activeTerminal)
	at.closeOnce.Do(func() {
		at.closeErr = m.closeActive(id, at)
		m.terminals.CompareAndDelete(id, at)
	})
	return at.closeErr
}

func (m *Manager) closeActive(id string, at *activeTerminal) error {
	now := time.Now().Unix()
	// Publish closed before asking the runtime to stop. Runtime operations that
	// already passed the running check may be in flight; Runtime.Close below
	// interrupts them, and the write gate is joined before Close returns.
	at.stateMu.Lock()
	at.sessionMu.Lock()
	at.Session.Status = model.StatusClosed
	at.Session.Readonly = true
	at.Session.UpdatedAt = now
	at.status.Store(model.StatusClosed)
	at.sessionMu.Unlock()
	// Stop the ticker before publishing Done so no new periodic flushes are
	// scheduled after shutdown starts. A tick already queued is drained by the
	// flush goroutine; wait for that goroutine before the final snapshot below.
	at.stopHistoryFlush()
	close(at.Done)
	at.stateMu.Unlock()

	// Cancel writers before waiting on deliveryMu. Network writes run outside
	// that mutex, but closing each connection promptly interrupts any blocked
	// writer and keeps shutdown independent of websocket write latency.
	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		conn.Cancel()
		_ = conn.Master.Close()
		return true
	})
	var runtimeErr error
	if at.Runtime != nil {
		runtimeErr = at.Runtime.Close()
	}
	at.runtimeMu.Lock()
	at.runtimeMu.Unlock()
	// Runtime.Close unblocks the PTY reader, but it can return before the
	// reader has consumed a final (n > 0, err != nil) chunk. Wait for the loop
	// before taking the final history snapshot so that tail bytes are durable.
	if at.readDone != nil {
		<-at.readDone
	}
	if at.flushDone != nil {
		<-at.flushDone
	}

	// Serialize the final connection sweep with the attach handshake. An attach
	// that was already in progress either completes before this lock and is
	// cancelled by the sweep, or observes StatusClosed and cannot register.
	at.deliveryMu.Lock()
	// monitorRuntime may have entered its critical section just before the
	// explicit close published the first status update. Re-publish closed while
	// holding the same lock so it cannot win the final in-memory state.
	at.sessionMu.Lock()
	at.Session.Status = model.StatusClosed
	at.Session.Readonly = true
	at.Session.UpdatedAt = now
	at.status.Store(model.StatusClosed)
	at.sessionMu.Unlock()
	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		conn.Cancel()
		_ = conn.Master.Close()
		return true
	})

	at.deliveryMu.Unlock()

	at.historyMu.Lock()
	flushErr := m.flushHistoryToDB(at)
	at.historyMu.Unlock()

	at.stateMu.Lock()
	dbErr := m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"status":     model.StatusClosed,
		"readonly":   true,
		"updated_at": now,
	}).Error
	at.stateMu.Unlock()

	return joinTerminalErrors(flushErr, runtimeErr, dbErr)
}

// joinTerminalErrors preserves the existing single-error behavior while
// retaining every shutdown failure when multiple persistence/runtime steps
// fail during the same close operation.
func joinTerminalErrors(errs ...error) error {
	nonNil := make([]error, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			nonNil = append(nonNil, err)
		}
	}
	switch len(nonNil) {
	case 0:
		return nil
	case 1:
		return nonNil[0]
	default:
		return errors.Join(nonNil...)
	}
}

func (m *Manager) collectDeleteIDs(id string) ([]string, error) {
	if id == "" {
		return nil, nil
	}

	var root model.TerminalSession
	if err := m.db.Select("id", "workspace_session_id", "group_id").First(&root, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}

	ids := []string{id}
	seen := map[string]struct{}{id: {}}
	parents := []string{id}
	for len(parents) > 0 {
		var childIDs []string
		if err := m.db.Model(&model.TerminalSession{}).
			Where("parent_id IN ? AND workspace_session_id = ? AND group_id = ?", parents, root.WorkspaceSessionID, root.GroupID).
			Pluck("id", &childIDs).Error; err != nil {
			return nil, err
		}

		nextParents := make([]string, 0, len(childIDs))
		for _, childID := range childIDs {
			if _, ok := seen[childID]; ok {
				continue
			}
			seen[childID] = struct{}{}
			ids = append(ids, childID)
			nextParents = append(nextParents, childID)
		}
		parents = nextParents
	}
	return ids, nil
}

func (m *Manager) Delete(id string) error {
	m.workspaceLifecycleMu.Lock()
	defer m.workspaceLifecycleMu.Unlock()
	m.workspaceMutationMu.Lock()
	defer m.workspaceMutationMu.Unlock()

	ids, err := m.collectDeleteIDs(id)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}

	for _, terminalID := range ids {
		unlock := m.lockTerminalLifecycle(terminalID)
		err := m.closeForDelete(terminalID)
		unlock()
		if err != nil {
			return fmt.Errorf("close terminal %s: %w", terminalID, err)
		}
	}

	err = m.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("session_id IN ?", ids).Delete(&model.TerminalHistory{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id IN ?", ids).Delete(&model.TerminalSession{}).Error; err != nil {
			return err
		}
		return nil
	})
	return err
}

func (m *Manager) ptyReadLoop(at *activeTerminal) {
	if at.readDone != nil {
		defer close(at.readDone)
	}
	maxRawSize := (at.bufferSize - 1) / 4 * 3
	buf := make([]byte, maxRawSize)

	for {
		n, err := at.Runtime.Read(buf)
		// A PTY is allowed to return both data and its terminal error. Handle the
		// data first; otherwise bytes already read at process shutdown disappear.
		if n > 0 {
			at.deliveryMu.Lock()
			at.historyMu.Lock()
			at.historyBuffer.Write(buf[:n])
			_, endCursor := at.historyBuffer.CursorRange()
			at.historyMu.Unlock()

			// Close cancels all clients before waiting for this loop. Retain the
			// bytes for replay, but avoid writing to connections after closure.
			if at.status.Load().(string) != model.StatusClosed {
				msg := WSMessage{
					Type:   MsgTypeOutput,
					Data:   at.encoder.EncodeToString(buf[:n]),
					Cursor: endCursor,
				}
				m.broadcastLocked(at, msg)
			}
			at.deliveryMu.Unlock()
		}

		if err != nil {
			return
		}
	}
}

// monitorRuntimeAsync is the fire-and-forget entrypoint used by newly created
// terminals. Lifecycle monitoring cannot return an error to its creator after
// Create has completed, so retain observability by logging the complete
// aggregated failure here.
func (m *Manager) monitorRuntimeAsync(at *activeTerminal) {
	if err := m.monitorRuntime(at); err != nil {
		log.Printf("terminal runtime monitor failed for terminal %s: %v", at.ID, err)
	}
}

func (m *Manager) monitorRuntime(at *activeTerminal) error {
	waitErr := at.Runtime.Wait(context.Background())
	if waitErr != nil {
		// A runtime may be unable to report a clean wait even though its process
		// has stopped. Preserve the error for the caller and logs instead of
		// silently presenting a potentially incomplete lifecycle transition as
		// successful.
		log.Printf("terminal runtime wait failed for terminal %s: %v", at.ID, waitErr)
	}
	// Publish exited as soon as Wait returns. The reader may still be draining a
	// final (n > 0, err != nil) chunk, but input and resize must be rejected once
	// the process itself is gone. The history snapshot is delayed until the
	// reader and periodic flusher have both finished below.
	at.stateMu.Lock()
	if at.status.Load().(string) == model.StatusClosed {
		at.stateMu.Unlock()
		return waitErr
	}

	exitCode := at.Runtime.ExitCode()
	now := time.Now().Unix()

	at.sessionMu.Lock()
	at.Session.Status = model.StatusExited
	at.Session.Readonly = true
	at.Session.ExitCode = exitCode
	at.Session.UpdatedAt = now
	at.status.Store(model.StatusExited)
	at.sessionMu.Unlock()

	dbErr := m.db.Model(&model.TerminalSession{}).Where("id = ?", at.ID).Updates(map[string]any{
		"status":     model.StatusExited,
		"readonly":   true,
		"exit_code":  exitCode,
		"updated_at": now,
	}).Error
	if dbErr != nil {
		log.Printf("terminal exit state update failed for terminal %s: %v", at.ID, dbErr)
	}
	at.stateMu.Unlock()

	// Stop periodic snapshots immediately after exit. A tick already in flight
	// is allowed to finish; the final snapshot below runs after the reader tail.
	at.stopHistoryFlush()
	if at.readDone != nil {
		<-at.readDone
	}
	if at.flushDone != nil {
		<-at.flushDone
	}
	at.stopHistoryFlush()

	at.deliveryMu.Lock()
	if at.status.Load().(string) == model.StatusClosed {
		at.deliveryMu.Unlock()
		return joinTerminalErrors(waitErr, dbErr)
	}

	notifyErr := m.notifyTerminalExited(at)
	at.deliveryMu.Unlock()

	at.historyMu.Lock()
	flushErr := m.flushHistoryToDB(at)
	at.historyMu.Unlock()
	if flushErr != nil {
		log.Printf("terminal history final flush failed for terminal %s: %v", at.ID, flushErr)
	}
	return joinTerminalErrors(waitErr, dbErr, notifyErr, flushErr)
}

func (m *Manager) notifyTerminalExited(at *activeTerminal) error {
	var notifyErrs []error
	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		if err := m.sendTerminalState(at, conn); err != nil {
			if conn.Cancel != nil {
				conn.Cancel()
			}
			notifyErrs = append(notifyErrs, fmt.Errorf("send exited terminal state to connection %s: %w", conn.ID, err))
			return true
		}
		if err := m.sendConnectionMessage(conn, WSMessage{Type: MsgTypePtyExited}); err != nil {
			if conn.Cancel != nil {
				conn.Cancel()
			}
			notifyErrs = append(notifyErrs, fmt.Errorf("send terminal exit to connection %s: %w", conn.ID, err))
		}
		return true
	})
	return joinTerminalErrors(notifyErrs...)
}

func (at *activeTerminal) stopHistoryFlush() {
	if at.flushTicker != nil {
		at.flushTicker.Stop()
	}
	if at.flushStop != nil {
		at.flushStopOnce.Do(func() { close(at.flushStop) })
	}
}

func (m *Manager) List(workspaceSessionID string, groupID string) ([]TerminalInfo, error) {
	var sessions []model.TerminalSession
	query := m.db.Order("updated_at DESC")
	if workspaceSessionID != "" {
		query = query.Where("workspace_session_id = ?", workspaceSessionID)
	}
	if groupID != "" {
		query = query.Where("group_id = ?", groupID)
	}
	if err := query.Find(&sessions).Error; err != nil {
		return nil, err
	}
	result := make([]TerminalInfo, len(sessions))
	for i, s := range sessions {
		if active, ok := m.Get(s.ID); ok {
			result[i] = *active
			continue
		}
		result[i] = *sessionToInfo(&s)
	}
	return result, nil
}

func (m *Manager) SyncWorkspaceMetadata(workspaceSessionID string, assignments []WorkspaceTerminalAssignment) error {
	return m.SyncWorkspaceMetadataWithTransaction(workspaceSessionID, assignments, nil)
}

// SyncWorkspaceMetadataWithTransaction updates terminal ownership and an
// optional caller-owned workspace record atomically. Active terminal metadata
// is published only after the database transaction commits.
func (m *Manager) SyncWorkspaceMetadataWithTransaction(
	workspaceSessionID string,
	assignments []WorkspaceTerminalAssignment,
	updateWorkspaceState func(*gorm.DB) error,
) error {
	if workspaceSessionID == "" {
		return ErrWorkspaceNotFound
	}

	assignedIDs := make([]string, 0, len(assignments))
	assigned := make(map[string]WorkspaceTerminalAssignment, len(assignments))
	for _, assignment := range assignments {
		if assignment.ID == "" {
			return fmt.Errorf("%w: terminal id is required", ErrInvalidTerminalParent)
		}
		if _, exists := assigned[assignment.ID]; exists {
			return fmt.Errorf("%w: duplicate terminal %s", ErrInvalidTerminalParent, assignment.ID)
		}
		assignedIDs = append(assignedIDs, assignment.ID)
		assigned[assignment.ID] = assignment
	}

	if err := validateWorkspaceAssignments(assigned); err != nil {
		return err
	}

	return m.mutateWorkspace(workspaceSessionID, func(tx *gorm.DB) error {
		if err := validateWorkspaceAssignmentTerminals(tx, workspaceSessionID, assignedIDs); err != nil {
			return err
		}

		for _, assignment := range assigned {
			if err := tx.Model(&model.TerminalSession{}).Where("id = ?", assignment.ID).Updates(map[string]any{
				"workspace_session_id": workspaceSessionID,
				"group_id":             assignment.GroupID,
				"parent_id":            assignment.ParentID,
			}).Error; err != nil {
				return err
			}
		}

		clearQuery := tx.Model(&model.TerminalSession{}).Where("workspace_session_id = ?", workspaceSessionID)
		if len(assignedIDs) > 0 {
			clearQuery = clearQuery.Where("id NOT IN ?", assignedIDs)
		}
		if err := clearQuery.Updates(map[string]any{
			"workspace_session_id": "",
			"group_id":             "",
			"parent_id":            "",
		}).Error; err != nil {
			return err
		}

		if updateWorkspaceState != nil {
			if err := updateWorkspaceState(tx); err != nil {
				return err
			}
		}

		return nil
	}, func() {
		// Publish only after the transaction commits, while the mutation gate is
		// still held so a concurrent workspace deletion cannot observe stale
		// in-memory ownership.
		m.publishWorkspaceMetadata(workspaceSessionID, assigned)
	})
}

func validateWorkspaceAssignments(assignments map[string]WorkspaceTerminalAssignment) error {
	for id, assignment := range assignments {
		if assignment.ParentID == "" {
			continue
		}
		if assignment.ParentID == id {
			return fmt.Errorf("%w: terminal %s cannot be its own parent", ErrInvalidTerminalParent, id)
		}
		parent, exists := assignments[assignment.ParentID]
		if !exists {
			return fmt.Errorf("%w: parent terminal %s is not in the workspace assignment", ErrInvalidTerminalParent, assignment.ParentID)
		}
		if parent.GroupID != assignment.GroupID {
			return fmt.Errorf("%w: parent %s and child %s belong to different groups", ErrTerminalScopeMismatch, assignment.ParentID, id)
		}
	}

	visitState := make(map[string]uint8, len(assignments))
	var visit func(string) error
	visit = func(id string) error {
		switch visitState[id] {
		case 1:
			return fmt.Errorf("%w: terminal parent cycle includes %s", ErrInvalidTerminalParent, id)
		case 2:
			return nil
		}
		visitState[id] = 1
		if parentID := assignments[id].ParentID; parentID != "" {
			if err := visit(parentID); err != nil {
				return err
			}
		}
		visitState[id] = 2
		return nil
	}
	for id := range assignments {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

func validateWorkspaceAssignmentTerminals(
	tx *gorm.DB,
	workspaceSessionID string,
	assignedIDs []string,
) error {
	if len(assignedIDs) == 0 {
		return nil
	}

	var sessions []model.TerminalSession
	if err := tx.Select("id", "workspace_session_id").Where("id IN ?", assignedIDs).Find(&sessions).Error; err != nil {
		return err
	}
	found := make(map[string]model.TerminalSession, len(sessions))
	for _, session := range sessions {
		found[session.ID] = session
		if session.WorkspaceSessionID != "" && session.WorkspaceSessionID != workspaceSessionID {
			return fmt.Errorf(
				"%w: terminal %s belongs to workspace %q",
				ErrTerminalScopeMismatch,
				session.ID,
				session.WorkspaceSessionID,
			)
		}
	}
	for _, id := range assignedIDs {
		if _, exists := found[id]; !exists {
			return fmt.Errorf("%w: terminal %s", ErrTerminalNotFound, id)
		}
	}
	return nil
}

func (m *Manager) publishWorkspaceMetadata(
	workspaceSessionID string,
	assignments map[string]WorkspaceTerminalAssignment,
) {
	for id, assignment := range assignments {
		if at, ok := m.getActive(id); ok {
			at.sessionMu.Lock()
			at.Session.WorkspaceSessionID = workspaceSessionID
			at.Session.GroupID = assignment.GroupID
			at.Session.ParentID = assignment.ParentID
			at.sessionMu.Unlock()
		}
	}
	m.terminals.Range(func(_, value any) bool {
		at := value.(*activeTerminal)
		at.sessionMu.RLock()
		terminalWorkspaceSessionID := at.Session.WorkspaceSessionID
		terminalID := at.Session.ID
		at.sessionMu.RUnlock()
		if terminalWorkspaceSessionID != workspaceSessionID {
			return true
		}
		if _, found := assignments[terminalID]; found {
			return true
		}
		at.sessionMu.Lock()
		at.Session.WorkspaceSessionID = ""
		at.Session.GroupID = ""
		at.Session.ParentID = ""
		at.sessionMu.Unlock()
		return true
	})
}

func (m *Manager) Attach(id string, conn *websocket.Conn) (*Connection, error) {
	return m.AttachWithOptions(id, conn, AttachOptions{})
}

// reserveConnectionSlot atomically accounts for an active websocket before
// the attach handshake starts. A separate load followed by Add would let
// concurrent handshakes all pass the limit.
func (m *Manager) reserveConnectionSlot() bool {
	if m.maxConnections <= 0 {
		m.activeConns.Add(1)
		return true
	}

	limit := int64(m.maxConnections)
	for {
		current := m.activeConns.Load()
		if current >= limit {
			return false
		}
		if m.activeConns.CompareAndSwap(current, current+1) {
			return true
		}
	}
}

func (m *Manager) AttachWithOptions(id string, conn *websocket.Conn, opts AttachOptions) (*Connection, error) {
	if !m.reserveConnectionSlot() {
		return nil, ErrMaxConnectionsReached
	}

	at, ok := m.getActive(id)
	if !ok {
		defer m.activeConns.Add(-1)
		return m.sendHistoryOnly(id, conn)
	}

	m.configureWSConn(conn)

	clientID := uuid.New().String()
	mst := newWSMaster(conn, m.wsWriteTimeout)
	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})

	tc := &terminalConnection{
		ID:     clientID,
		Master: mst,
		Ctx:    ctx,
		Cancel: cancel,
		sendCh: make(chan terminalOutboundMessage, terminalOutboundQueueSize),
	}
	tc.AckCursor.Store(opts.Cursor)

	cleanupOnce := sync.Once{}
	cleanup := func() {
		cleanupOnce.Do(func() {
			at.Connections.Delete(clientID)
			m.activeConns.Add(-1)
			cancel()
			mst.Close()
			close(doneCh)
		})
	}
	go watchConnectionShutdown(at.Done, ctx, mst)

	if err := m.initializeConnection(at, tc, opts.Cursor); err != nil {
		cleanup()
		return nil, err
	}

	go func() {
		defer cleanup()
		_ = m.writeConnectionLoop(tc)
	}()

	go func() {
		<-ctx.Done()
		cleanup()
	}()

	go func() {
		defer cleanup()
		_ = m.readClientLoop(at, tc)
	}()

	go func() {
		if err := m.pingLoop(ctx, tc); err != nil {
			cancel()
		}
	}()

	return &Connection{Done: doneCh}, nil
}

func watchConnectionShutdown(terminalDone <-chan struct{}, ctx context.Context, mst master) {
	select {
	case <-terminalDone:
		_ = mst.Close()
	case <-ctx.Done():
	}
}

func (m *Manager) initializeConnection(at *activeTerminal, conn *terminalConnection, cursor uint64) error {
	at.deliveryMu.Lock()
	defer at.deliveryMu.Unlock()
	if at.status.Load().(string) == model.StatusClosed {
		return ErrTerminalNotFound
	}

	if err := m.replayHistory(at, conn, cursor); err != nil {
		return err
	}
	if err := m.sendReplayDone(conn); err != nil {
		return err
	}
	if err := m.sendTerminalState(at, conn); err != nil {
		return err
	}
	if at.status.Load().(string) != model.StatusRunning {
		if err := m.sendConnectionMessage(conn, WSMessage{Type: MsgTypePtyExited}); err != nil {
			return err
		}
	}

	// Register only after the complete handshake has been queued. Output read
	// concurrently is blocked by deliveryMu and will be queued after this Store,
	// so no bytes can overtake replay or be lost between the snapshot and Store.
	at.Connections.Store(conn.ID, conn)
	return nil
}

func (m *Manager) sendHistoryOnly(id string, conn *websocket.Conn) (*Connection, error) {
	var session model.TerminalSession
	if err := m.db.Where("id = ?", id).First(&session).Error; err != nil {
		return nil, ErrTerminalNotFound
	}

	snapshot, err := m.loadSnapshot(id)
	if err != nil {
		return nil, ErrTerminalNotFound
	}

	m.configureWSConn(conn)
	mst := newWSMaster(conn, m.wsWriteTimeout)
	defer mst.Close()
	if err := m.sendHistoryOnlyHandshake(mst, session, snapshot); err != nil {
		return nil, err
	}

	doneCh := make(chan struct{})
	close(doneCh)
	return &Connection{Done: doneCh}, nil
}

func terminalWireExitCode(status string, exitCode int) *int {
	if status != model.StatusExited {
		return nil
	}
	value := exitCode
	return &value
}

func (m *Manager) sendHistoryOnlyHandshake(mst master, session model.TerminalSession, snapshot *TerminalSnapshot) error {
	cursor := uint64(0)
	if snapshot != nil {
		cursor = snapshot.Cursor
	}

	if snapshot != nil && len(snapshot.Data) > 0 {
		if err := m.sendMessage(mst, WSMessage{
			Type:   MsgTypeReplay,
			Data:   base64.StdEncoding.EncodeToString(snapshot.Data),
			Cursor: cursor,
			Reset:  true,
		}); err != nil {
			return err
		}
	}
	if err := m.sendMessage(mst, WSMessage{Type: MsgTypeReplayDone}); err != nil {
		return err
	}
	if err := m.sendMessage(mst, WSMessage{
		Type:        MsgTypeState,
		Status:      session.Status,
		Cols:        session.Cols,
		Rows:        session.Rows,
		Cursor:      cursor,
		ExitCode:    terminalWireExitCode(session.Status, session.ExitCode),
		RuntimeType: session.RuntimeType,
		Readonly:    session.Readonly,
		Capabilities: TerminalCapabilities{
			Resume:           true,
			Snapshot:         true,
			ShellIntegration: session.ShellIntegration,
			Durable:          false,
		},
		CurrentCwd:          session.CurrentCwd,
		ShellType:           session.ShellType,
		ShellState:          session.ShellState,
		ShellIntegration:    session.ShellIntegration,
		LastCommand:         session.LastCommand,
		LastCommandExitCode: session.LastCommandExitCode,
	}); err != nil {
		return err
	}
	if session.Status != model.StatusRunning {
		if err := m.sendMessage(mst, WSMessage{Type: MsgTypePtyExited}); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) replayHistory(at *activeTerminal, conn *terminalConnection, cursor uint64) error {
	snapshot := m.getReplaySnapshot(at, cursor)
	if len(snapshot.data) == 0 && !snapshot.reset {
		return nil
	}
	msg := WSMessage{
		Type:   MsgTypeReplay,
		Data:   base64.StdEncoding.EncodeToString(snapshot.data),
		Cursor: snapshot.cursor,
		Reset:  snapshot.reset,
	}
	return m.sendConnectionMessage(conn, msg)
}

func (m *Manager) getReplaySnapshot(at *activeTerminal, cursor uint64) replaySnapshot {
	at.historyMu.RLock()
	data, ok, endCursor := at.historyBuffer.ReadFrom(cursor)
	if ok {
		at.historyMu.RUnlock()
		return replaySnapshot{
			data:   data,
			cursor: endCursor,
			reset:  false,
		}
	}
	historyData := at.historyBuffer.Read()
	_, endCursor = at.historyBuffer.CursorRange()
	at.historyMu.RUnlock()
	// The database snapshot is periodic and can only lag the live ring. Using
	// it here would send an older cursor, then state would advertise the newer
	// ring end, causing clients to skip the bytes between the two. For an active
	// terminal the ring is the sole authoritative reset snapshot; DB history is
	// reserved for sendHistoryOnly after the runtime is gone.
	return replaySnapshot{
		data:   historyData,
		cursor: endCursor,
		reset:  true,
	}
}

func (m *Manager) loadSnapshot(sessionID string) (*TerminalSnapshot, error) {
	if m.snapshotStore == nil {
		return nil, nil
	}
	return m.snapshotStore.Load(sessionID)
}

func (m *Manager) saveSnapshot(snapshot *TerminalSnapshot) error {
	if m.snapshotStore == nil {
		return nil
	}
	return m.snapshotStore.Save(snapshot)
}

func (m *Manager) deleteSnapshot(sessionID string) error {
	if m.snapshotStore == nil {
		return nil
	}
	return m.snapshotStore.Delete(sessionID)
}

func (m *Manager) sendReplayDone(conn *terminalConnection) error {
	return m.sendConnectionMessage(conn, WSMessage{Type: MsgTypeReplayDone})
}

func (m *Manager) sendTerminalState(at *activeTerminal, conn *terminalConnection) error {
	at.historyMu.RLock()
	_, cursor := at.historyBuffer.CursorRange()
	at.historyMu.RUnlock()
	at.sessionMu.RLock()
	session := cloneTerminalSession(at.Session)
	capabilities := at.capabilities
	status := at.status.Load().(string)
	at.sessionMu.RUnlock()
	msg := WSMessage{
		Type:                MsgTypeState,
		Status:              status,
		Cols:                session.Cols,
		Rows:                session.Rows,
		Cursor:              cursor,
		ExitCode:            terminalWireExitCode(status, session.ExitCode),
		RuntimeType:         session.RuntimeType,
		Readonly:            session.Readonly,
		Capabilities:        capabilities,
		CurrentCwd:          session.CurrentCwd,
		ShellType:           session.ShellType,
		ShellState:          session.ShellState,
		ShellIntegration:    session.ShellIntegration,
		LastCommand:         session.LastCommand,
		LastCommandExitCode: session.LastCommandExitCode,
	}
	return m.sendConnectionMessage(conn, msg)
}

func (m *Manager) sendMessage(mst master, msg WSMessage) error {
	msgData, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = mst.Write(msgData)
	return err
}

func (m *Manager) sendConnectionMessage(conn *terminalConnection, msg WSMessage) error {
	msgData, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return m.sendConnectionData(conn, msgData)
}

func (m *Manager) sendConnectionMessageAndWait(conn *terminalConnection, msg WSMessage) error {
	msgData, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return m.sendConnectionDataAndWait(conn, msgData)
}

func (m *Manager) sendConnectionData(conn *terminalConnection, data []byte) error {
	if conn == nil || conn.Master == nil {
		return ErrMasterClosed
	}
	// Tests and small internal call sites may use a connection without a writer
	// queue. Preserve their direct behavior while every real attached websocket
	// uses the bounded queue created by AttachWithOptions.
	if conn.sendCh == nil {
		_, err := conn.Master.Write(data)
		if err != nil && conn.Cancel != nil {
			conn.Cancel()
		}
		return err
	}
	if conn.Ctx != nil {
		select {
		case <-conn.Ctx.Done():
			return conn.Ctx.Err()
		default:
		}
	}
	select {
	case conn.sendCh <- terminalOutboundMessage{data: data}:
		return nil
	default:
		if conn.Cancel != nil {
			conn.Cancel()
		}
		return ErrOutboundQueueFull
	}
}

func (m *Manager) sendConnectionDataAndWait(conn *terminalConnection, data []byte) error {
	if conn == nil || conn.Master == nil {
		return ErrMasterClosed
	}
	if conn.sendCh == nil {
		_, err := conn.Master.Write(data)
		if err != nil && conn.Cancel != nil {
			conn.Cancel()
		}
		return err
	}
	ctx := conn.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	done := make(chan error, 1)
	select {
	case conn.sendCh <- terminalOutboundMessage{data: data, done: done}:
	default:
		if conn.Cancel != nil {
			conn.Cancel()
		}
		return ErrOutboundQueueFull
	}

	timeout := m.wsWriteTimeout
	if timeout <= 0 {
		timeout = terminalCriticalWriteTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		if conn.Cancel != nil {
			conn.Cancel()
		}
		return context.DeadlineExceeded
	}
}

func completeTerminalOutboundMessage(message terminalOutboundMessage, err error) {
	if message.done != nil {
		message.done <- err
	}
}

func failPendingTerminalOutboundMessages(conn *terminalConnection, err error) {
	if conn == nil || conn.sendCh == nil {
		return
	}
	for {
		select {
		case message := <-conn.sendCh:
			completeTerminalOutboundMessage(message, err)
		default:
			return
		}
	}
}

func (m *Manager) writeConnectionLoop(conn *terminalConnection) (err error) {
	if conn == nil || conn.Master == nil || conn.sendCh == nil {
		return ErrMasterClosed
	}
	ctx := conn.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	defer func() {
		if err == nil {
			err = ctx.Err()
		}
		if err == nil {
			err = ErrMasterClosed
		}
		failPendingTerminalOutboundMessages(conn, err)
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case message := <-conn.sendCh:
			_, writeErr := conn.Master.Write(message.data)
			completeTerminalOutboundMessage(message, writeErr)
			if writeErr != nil {
				return writeErr
			}
		}
	}
}

func (m *Manager) broadcast(at *activeTerminal, msg WSMessage) {
	at.deliveryMu.Lock()
	defer at.deliveryMu.Unlock()
	m.broadcastLocked(at, msg)
}

func (m *Manager) broadcastLocked(at *activeTerminal, msg WSMessage) {
	msgData, err := json.Marshal(msg)
	if err != nil {
		return
	}

	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		_ = m.sendConnectionData(conn, msgData)
		return true
	})
}

func (m *Manager) readClientLoop(at *activeTerminal, conn *terminalConnection) error {
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

		switch msg.Type {
		case MsgTypeInput:
			if msg.Data == "" {
				continue
			}
			decoded, err := at.encoder.DecodeString(msg.Data)
			if err != nil || len(decoded) == 0 {
				continue
			}
			at.runtimeMu.RLock()
			at.inputMu.Lock()
			at.stateMu.Lock()
			running := at.status.Load().(string) == model.StatusRunning
			at.stateMu.Unlock()
			if !running {
				at.inputMu.Unlock()
				at.runtimeMu.RUnlock()
				continue
			}
			writeErr := writeTerminalRuntimeFull(at.Runtime, decoded)
			at.inputMu.Unlock()
			at.runtimeMu.RUnlock()
			if writeErr != nil {
				return writeErr
			}
		case MsgTypeResize:
			if msg.Cols <= 0 || msg.Rows <= 0 {
				continue
			}
			at.runtimeMu.RLock()
			at.stateMu.Lock()
			if at.status.Load().(string) != model.StatusRunning {
				at.stateMu.Unlock()
				at.runtimeMu.RUnlock()
				continue
			}
			at.stateMu.Unlock()
			if err := at.Runtime.Resize(msg.Cols, msg.Rows); err != nil {
				at.runtimeMu.RUnlock()
				continue
			}
			now := time.Now().Unix()
			at.stateMu.Lock()
			if at.status.Load().(string) != model.StatusRunning {
				at.stateMu.Unlock()
				at.runtimeMu.RUnlock()
				continue
			}
			at.sessionMu.Lock()
			at.Session.Cols = msg.Cols
			at.Session.Rows = msg.Rows
			at.Session.UpdatedAt = now
			at.sessionMu.Unlock()
			_ = m.db.Model(&model.TerminalSession{}).Where("id = ?", at.ID).Updates(map[string]any{
				"cols":       msg.Cols,
				"rows":       msg.Rows,
				"updated_at": now,
			}).Error
			at.stateMu.Unlock()
			at.runtimeMu.RUnlock()
		case MsgTypeSignal:
			signal, err := NormalizeTerminalSignal(msg.Signal)
			if err != nil {
				continue
			}
			at.runtimeMu.RLock()
			at.inputMu.Lock()
			at.stateMu.Lock()
			running := at.status.Load().(string) == model.StatusRunning
			at.stateMu.Unlock()
			if !running {
				at.inputMu.Unlock()
				at.runtimeMu.RUnlock()
				continue
			}
			signalErr := SignalTerminalRuntime(at.Runtime, signal)
			at.inputMu.Unlock()
			at.runtimeMu.RUnlock()
			if signalErr != nil {
				return signalErr
			}
		case MsgTypeState:
			at.deliveryMu.Lock()
			stateErr := m.sendTerminalState(at, conn)
			at.deliveryMu.Unlock()
			if stateErr != nil {
				return stateErr
			}
		case MsgTypeAck:
			if msg.Cursor > conn.AckCursor.Load() {
				conn.AckCursor.Store(msg.Cursor)
			}
		}
	}
}

func (m *Manager) pingLoop(ctx context.Context, conn *terminalConnection) error {
	if m.wsPingInterval <= 0 {
		<-ctx.Done()
		return nil
	}

	ticker := time.NewTicker(m.wsPingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := conn.Master.Ping(); err != nil {
				return err
			}
		}
	}
}

func (m *Manager) configureWSConn(conn *websocket.Conn) {
	if m.bufferSize > 0 {
		conn.SetReadLimit(int64(m.bufferSize * 16))
	}
	if m.wsReadTimeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(m.wsReadTimeout))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(m.wsReadTimeout))
		})
	}
}

func (m *Manager) CleanupOnStart() {
	if err := m.cleanupStaleTerminalState(); err != nil {
		log.Printf("terminal startup state cleanup failed: %v", err)
	}
}

// cleanupStaleTerminalState closes the in-memory runtime boundary left by a
// previous server process. A PTY master cannot be recovered after process
// restart, so persisted running sessions are historical exits.
//
// The helper is kept separate from CleanupOnStart so tests can assert database
// errors and transaction rollback without relying on log output.
func (m *Manager) cleanupStaleTerminalState() error {
	if m == nil || m.db == nil {
		return nil
	}

	now := time.Now().Unix()
	return m.db.Transaction(func(tx *gorm.DB) error {
		var staleIDs []string
		if err := tx.Model(&model.TerminalSession{}).
			Where("status = ?", model.StatusRunning).
			Pluck("id", &staleIDs).Error; err != nil {
			return err
		}
		if len(staleIDs) == 0 {
			return nil
		}

		return tx.Model(&model.TerminalSession{}).
			Where("id IN ? AND status = ?", staleIDs, model.StatusRunning).
			Updates(map[string]any{
				"status":     model.StatusExited,
				"readonly":   true,
				"updated_at": now,
			}).Error
	})
}
