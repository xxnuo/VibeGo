package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
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
	AckCursor atomic.Uint64
}

type activeTerminal struct {
	ID            string
	Runtime       TerminalRuntime
	Session       *model.TerminalSession
	Connections   sync.Map
	Done          chan struct{}
	historyBuffer *historyBuffer
	historyMu     sync.RWMutex
	status        atomic.Value
	flushTicker   *time.Ticker
	bufferSize    int
	encoder       *base64.Encoding
	capabilities  TerminalCapabilities
}

type Manager struct {
	db                   *gorm.DB
	terminals            sync.Map
	shell                string
	bufferSize           int
	maxConnections       int
	activeConns          atomic.Int64
	historyBufferSize    int
	historyFlushInterval time.Duration
	historyMaxRecords    int
	historyMaxAge        time.Duration
	wsPingInterval       time.Duration
	wsReadTimeout        time.Duration
	wsWriteTimeout       time.Duration
	snapshotStore        TerminalSnapshotStore
}

type replaySnapshot struct {
	data   []byte
	cursor uint64
	reset  bool
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
	}
}

func (m *Manager) DB() *gorm.DB {
	return m.db
}

func (m *Manager) Create(opts CreateOptions) (*TerminalInfo, error) {
	cwd := opts.Cwd
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			cwd = os.Getenv("HOME")
		}
	}
	cols := opts.Cols
	if cols <= 0 {
		cols = 80
	}
	rows := opts.Rows
	if rows <= 0 {
		rows = 24
	}

	name := opts.Name
	if name == "" {
		var count int64
		m.db.Model(&model.TerminalSession{}).Count(&count)
		name = fmt.Sprintf("Terminal %d", count+1)
	}

	pty, err := newLocalCommand(m.shell, nil, cwd, cols, rows)
	if err != nil {
		return nil, err
	}
	runtime := NewLocalPTYRuntime(pty)
	capabilities := runtime.Capabilities()

	now := time.Now().Unix()
	session := &model.TerminalSession{
		ID:                 uuid.New().String(),
		UserID:             opts.UserID,
		WorkspaceSessionID: opts.WorkspaceSessionID,
		GroupID:            opts.GroupID,
		ParentID:           opts.ParentID,
		Name:               name,
		Shell:              m.shell,
		Cwd:                cwd,
		CurrentCwd:         cwd,
		Cols:               cols,
		Rows:               rows,
		RuntimeType:        runtime.Type(),
		Readonly:           false,
		Status:             model.StatusRunning,
		ShellIntegration:   capabilities.ShellIntegration,
		CreatedAt:          now,
		UpdatedAt:          now,
	}

	if err := m.db.Create(session).Error; err != nil {
		pty.Close()
		return nil, err
	}

	active := &activeTerminal{
		ID:            session.ID,
		Runtime:       runtime,
		Session:       session,
		Done:          make(chan struct{}),
		historyBuffer: newHistoryBuffer(m.historyBufferSize),
		flushTicker:   time.NewTicker(m.historyFlushInterval),
		bufferSize:    m.bufferSize,
		encoder:       base64.StdEncoding,
		capabilities:  capabilities,
	}
	active.status.Store(model.StatusRunning)

	m.terminals.Store(session.ID, active)

	go m.ptyReadLoop(active)
	go m.monitorRuntime(active)
	go m.flushHistory(active)

	return sessionToInfo(session), nil
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

func (m *Manager) Get(id string) (*TerminalInfo, bool) {
	at, ok := m.getActive(id)
	if !ok {
		return nil, false
	}
	return &TerminalInfo{
		ID:                  at.Session.ID,
		Name:                at.Session.Name,
		Shell:               at.Session.Shell,
		Cwd:                 at.Session.Cwd,
		CurrentCwd:          at.Session.CurrentCwd,
		Cols:                at.Session.Cols,
		Rows:                at.Session.Rows,
		RuntimeType:         at.Session.RuntimeType,
		Readonly:            at.Session.Readonly,
		Capabilities:        at.capabilities,
		Status:              at.status.Load().(string),
		WorkspaceSessionID:  at.Session.WorkspaceSessionID,
		GroupID:             at.Session.GroupID,
		ParentID:            at.Session.ParentID,
		ShellType:           at.Session.ShellType,
		ShellState:          at.Session.ShellState,
		ShellIntegration:    at.Session.ShellIntegration,
		LastCommand:         at.Session.LastCommand,
		LastCommandExitCode: at.Session.LastCommandExitCode,
		ExitCode:            at.Session.ExitCode,
		HistorySize:         at.Session.HistorySize,
		CreatedAt:           at.Session.CreatedAt,
		UpdatedAt:           at.Session.UpdatedAt,
	}, true
}

func (m *Manager) Resize(id string, cols, rows int) error {
	at, ok := m.getActive(id)
	if !ok {
		return ErrTerminalNotFound
	}

	if err := at.Runtime.Resize(cols, rows); err != nil {
		return err
	}

	at.Session.Cols = cols
	at.Session.Rows = rows
	at.Session.UpdatedAt = time.Now().Unix()

	m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"cols":       cols,
		"rows":       rows,
		"updated_at": at.Session.UpdatedAt,
	})

	return nil
}

func (m *Manager) Rename(id, name string) error {
	now := time.Now().Unix()
	result := m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"name":       name,
		"updated_at": now,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrTerminalNotFound
	}

	if at, ok := m.getActive(id); ok {
		at.Session.Name = name
		at.Session.UpdatedAt = now
	}

	return nil
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
	if update.LastCommandExitCode != nil {
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
		if update.LastCommandExitCode != nil {
			exitCode := *update.LastCommandExitCode
			at.Session.LastCommandExitCode = &exitCode
		}
		at.Session.UpdatedAt = now
	}

	return nil
}

func (m *Manager) Close(id string) error {
	val, ok := m.terminals.LoadAndDelete(id)
	if !ok {
		return nil
	}
	at := val.(*activeTerminal)

	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		conn.Cancel()
		return true
	})

	at.flushTicker.Stop()

	now := time.Now().Unix()
	at.status.Store(model.StatusClosed)
	at.Session.Status = model.StatusClosed
	at.Session.Readonly = true
	at.Session.UpdatedAt = now

	at.historyMu.Lock()
	m.flushHistoryToDB(at)
	at.historyMu.Unlock()

	_ = at.Runtime.Close()
	close(at.Done)

	m.db.Model(&model.TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"status":     model.StatusClosed,
		"readonly":   true,
		"updated_at": now,
	})

	return nil
}

func (m *Manager) collectDeleteIDs(id string) ([]string, error) {
	if id == "" {
		return nil, nil
	}

	var childIDs []string
	if err := m.db.Model(&model.TerminalSession{}).Where("parent_id = ?", id).Pluck("id", &childIDs).Error; err != nil {
		return nil, err
	}

	ids := make([]string, 0, len(childIDs)+1)
	ids = append(ids, id)
	ids = append(ids, childIDs...)
	return ids, nil
}

func (m *Manager) Delete(id string) error {
	ids, err := m.collectDeleteIDs(id)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}

	for _, terminalID := range ids {
		m.Close(terminalID)
	}

	return m.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("session_id IN ?", ids).Delete(&model.TerminalHistory{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id IN ?", ids).Delete(&model.TerminalSession{}).Error; err != nil {
			return err
		}
		return nil
	})
}

func (m *Manager) ptyReadLoop(at *activeTerminal) {
	maxRawSize := (at.bufferSize - 1) / 4 * 3
	buf := make([]byte, maxRawSize)

	for {
		select {
		case <-at.Done:
			return
		default:
		}

		n, err := at.Runtime.Read(buf)
		if err != nil {
			return
		}

		if n == 0 {
			continue
		}

		at.historyMu.Lock()
		at.historyBuffer.Write(buf[:n])
		_, endCursor := at.historyBuffer.CursorRange()
		at.historyMu.Unlock()

		msg := WSMessage{
			Type:   MsgTypeOutput,
			Data:   at.encoder.EncodeToString(buf[:n]),
			Cursor: endCursor,
		}
		m.broadcast(at, msg)
	}
}

func (m *Manager) monitorRuntime(at *activeTerminal) {
	_ = at.Runtime.Wait(context.Background())

	if at.status.Load().(string) == model.StatusClosed {
		return
	}

	exitCode := at.Runtime.ExitCode()
	now := time.Now().Unix()

	at.status.Store(model.StatusExited)
	at.Session.Status = model.StatusExited
	at.Session.Readonly = true
	at.Session.ExitCode = exitCode
	at.Session.UpdatedAt = now

	m.db.Model(&model.TerminalSession{}).Where("id = ?", at.ID).Updates(map[string]any{
		"status":     model.StatusExited,
		"readonly":   true,
		"exit_code":  exitCode,
		"updated_at": now,
	})

	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		m.sendTerminalState(at, conn.Master)
		m.sendMessage(conn.Master, WSMessage{Type: MsgTypePtyExited})
		return true
	})

	at.historyMu.Lock()
	m.flushHistoryToDB(at)
	at.historyMu.Unlock()
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
		result[i] = *sessionToInfo(&s)
	}
	return result, nil
}

func (m *Manager) SyncWorkspaceMetadata(workspaceSessionID string, assignments []WorkspaceTerminalAssignment) error {
	if workspaceSessionID == "" {
		return nil
	}

	return m.db.Transaction(func(tx *gorm.DB) error {
		assignedIDs := make([]string, 0, len(assignments))
		for _, assignment := range assignments {
			if assignment.ID == "" {
				continue
			}
			assignedIDs = append(assignedIDs, assignment.ID)
			updates := map[string]any{
				"workspace_session_id": workspaceSessionID,
				"group_id":             assignment.GroupID,
				"parent_id":            assignment.ParentID,
			}
			if err := tx.Model(&model.TerminalSession{}).Where("id = ?", assignment.ID).Updates(updates).Error; err != nil {
				return err
			}
			if at, ok := m.getActive(assignment.ID); ok {
				at.Session.WorkspaceSessionID = workspaceSessionID
				at.Session.GroupID = assignment.GroupID
				at.Session.ParentID = assignment.ParentID
			}
		}

		clearQuery := tx.Model(&model.TerminalSession{}).Where("workspace_session_id = ?", workspaceSessionID)
		if len(assignedIDs) > 0 {
			clearQuery = clearQuery.Where("id NOT IN ?", assignedIDs)
		}
		if err := clearQuery.Updates(map[string]any{
			"workspace_session_id": "",
			"group_id":             "",
		}).Error; err != nil {
			return err
		}

		m.terminals.Range(func(_, value any) bool {
			at := value.(*activeTerminal)
			if at.Session.WorkspaceSessionID != workspaceSessionID {
				return true
			}
			found := false
			for _, assignment := range assignments {
				if assignment.ID == at.Session.ID {
					found = true
					break
				}
			}
			if !found {
				at.Session.WorkspaceSessionID = ""
				at.Session.GroupID = ""
			}
			return true
		})

		return nil
	})
}

func (m *Manager) Attach(id string, conn *websocket.Conn) (*Connection, error) {
	return m.AttachWithOptions(id, conn, AttachOptions{})
}

func (m *Manager) AttachWithOptions(id string, conn *websocket.Conn, opts AttachOptions) (*Connection, error) {
	at, ok := m.getActive(id)
	if !ok {
		return m.sendHistoryOnly(id, conn)
	}

	if m.maxConnections > 0 && int(m.activeConns.Load()) >= m.maxConnections {
		return nil, ErrMaxConnectionsReached
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
	}
	tc.AckCursor.Store(opts.Cursor)

	at.Connections.Store(clientID, tc)
	m.activeConns.Add(1)

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

	if err := m.replayHistory(at, mst, opts.Cursor); err != nil {
		cleanup()
		return nil, err
	}
	if err := m.sendReplayDone(mst); err != nil {
		cleanup()
		return nil, err
	}
	if err := m.sendTerminalState(at, mst); err != nil {
		cleanup()
		return nil, err
	}
	if at.status.Load().(string) != model.StatusRunning {
		if err := m.sendMessage(mst, WSMessage{Type: MsgTypePtyExited}); err != nil {
			cleanup()
			return nil, err
		}
	}

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
	cursor := uint64(0)
	if snapshot != nil {
		cursor = snapshot.Cursor
	}

	if snapshot != nil && len(snapshot.Data) > 0 {
		m.sendMessage(mst, WSMessage{
			Type:   MsgTypeReplay,
			Data:   base64.StdEncoding.EncodeToString(snapshot.Data),
			Cursor: cursor,
			Reset:  true,
		})
	}
	m.sendReplayDone(mst)
	m.sendMessage(mst, WSMessage{
		Type:        MsgTypeState,
		Status:      session.Status,
		Cols:        session.Cols,
		Rows:        session.Rows,
		Cursor:      cursor,
		ExitCode:    session.ExitCode,
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
	})
	if session.Status != model.StatusRunning {
		m.sendMessage(mst, WSMessage{Type: MsgTypePtyExited})
	}
	mst.Close()

	doneCh := make(chan struct{})
	close(doneCh)
	return &Connection{Done: doneCh}, nil
}

func (m *Manager) replayHistory(at *activeTerminal, mst master, cursor uint64) error {
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
	return m.sendMessage(mst, msg)
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

	if m.snapshotStore != nil {
		if snapshot, err := m.snapshotStore.Load(at.ID); err == nil && snapshot != nil && len(snapshot.Data) > 0 {
			return replaySnapshot{
				data:   snapshot.Data,
				cursor: snapshot.Cursor,
				reset:  true,
			}
		}
	}

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

func (m *Manager) sendReplayDone(mst master) error {
	return m.sendMessage(mst, WSMessage{Type: MsgTypeReplayDone})
}

func (m *Manager) sendTerminalState(at *activeTerminal, mst master) error {
	_, cursor := at.historyBuffer.CursorRange()
	msg := WSMessage{
		Type:                MsgTypeState,
		Status:              at.status.Load().(string),
		Cols:                at.Session.Cols,
		Rows:                at.Session.Rows,
		Cursor:              cursor,
		ExitCode:            at.Session.ExitCode,
		RuntimeType:         at.Session.RuntimeType,
		Readonly:            at.Session.Readonly,
		Capabilities:        at.capabilities,
		CurrentCwd:          at.Session.CurrentCwd,
		ShellType:           at.Session.ShellType,
		ShellState:          at.Session.ShellState,
		ShellIntegration:    at.Session.ShellIntegration,
		LastCommand:         at.Session.LastCommand,
		LastCommandExitCode: at.Session.LastCommandExitCode,
	}
	return m.sendMessage(mst, msg)
}

func (m *Manager) sendMessage(mst master, msg WSMessage) error {
	msgData, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = mst.Write(msgData)
	return err
}

func (m *Manager) broadcast(at *activeTerminal, msg WSMessage) {
	msgData, err := json.Marshal(msg)
	if err != nil {
		return
	}

	at.Connections.Range(func(key, value any) bool {
		conn := value.(*terminalConnection)
		if _, writeErr := conn.Master.Write(msgData); writeErr != nil {
			conn.Cancel()
		}
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
			if at.status.Load().(string) != model.StatusRunning {
				continue
			}
			if msg.Data == "" {
				continue
			}
			decoded, err := at.encoder.DecodeString(msg.Data)
			if err != nil || len(decoded) == 0 {
				continue
			}
			if _, err := at.Runtime.Write(decoded); err != nil {
				return err
			}
		case MsgTypeResize:
			if msg.Cols <= 0 || msg.Rows <= 0 {
				continue
			}
			if err := at.Runtime.Resize(msg.Cols, msg.Rows); err != nil {
				continue
			}
			now := time.Now().Unix()
			at.Session.Cols = msg.Cols
			at.Session.Rows = msg.Rows
			at.Session.UpdatedAt = now
			m.db.Model(&model.TerminalSession{}).Where("id = ?", at.ID).Updates(map[string]any{
				"cols":       msg.Cols,
				"rows":       msg.Rows,
				"updated_at": now,
			})
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
	m.db.Model(&model.TerminalSession{}).Where("status = ?", model.StatusRunning).Updates(map[string]any{
		"status":     model.StatusExited,
		"updated_at": time.Now().Unix(),
	})
}
