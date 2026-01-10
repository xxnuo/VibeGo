package terminal

import (
	"context"
	"encoding/base64"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
)

type webTTYInstance struct {
	ID     string
	WebTTY *webTTY
	Master master
	Ctx    context.Context
	Cancel context.CancelFunc
}

type activeTerminal struct {
	ID            string
	PTY           slave
	Session       *TerminalSession
	WebTTYs       sync.Map
	Done          chan struct{}
	historyBuffer *historyBuffer
	historyMu     sync.RWMutex
	ptyStatus     atomic.Value
	flushTicker   *time.Ticker
	bufferSize    int
	encoder       *base64.Encoding
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
	}
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

	pty, err := newLocalCommand(m.shell, nil, cwd, cols, rows)
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	session := &TerminalSession{
		ID:        uuid.New().String(),
		Name:      opts.Name,
		Shell:     m.shell,
		Cwd:       cwd,
		Cols:      cols,
		Rows:      rows,
		Status:    StatusActive,
		PTYStatus: PTYStatusRunning,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := m.db.Create(session).Error; err != nil {
		pty.Close()
		return nil, err
	}

	active := &activeTerminal{
		ID:            session.ID,
		PTY:           pty,
		Session:       session,
		Done:          make(chan struct{}),
		historyBuffer: newHistoryBuffer(m.historyBufferSize),
		flushTicker:   time.NewTicker(m.historyFlushInterval),
		bufferSize:    m.bufferSize,
		encoder:       base64.StdEncoding,
	}
	active.ptyStatus.Store(PTYStatusRunning)

	m.terminals.Store(session.ID, active)

	go m.ptyReadLoop(active)
	go m.monitorPTY(active, pty)
	go m.flushHistory(active)

	return sessionToInfo(session), nil
}

func (m *Manager) markClosed(id string) {
	m.db.Model(&TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"status":     StatusClosed,
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
		ID:        at.Session.ID,
		Name:      at.Session.Name,
		Shell:     at.Session.Shell,
		Cwd:       at.Session.Cwd,
		Cols:      at.Session.Cols,
		Rows:      at.Session.Rows,
		Status:    at.Session.Status,
		PTYStatus: at.ptyStatus.Load().(string),
		CreatedAt: at.Session.CreatedAt,
		UpdatedAt: at.Session.UpdatedAt,
	}, true
}

func (m *Manager) Resize(id string, cols, rows int) error {
	at, ok := m.getActive(id)
	if !ok {
		return ErrTerminalNotFound
	}

	if err := at.PTY.ResizeTerminal(cols, rows); err != nil {
		return err
	}

	m.db.Model(&TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"cols":       cols,
		"rows":       rows,
		"updated_at": time.Now().Unix(),
	})

	return nil
}

func (m *Manager) Close(id string) error {
	val, ok := m.terminals.LoadAndDelete(id)
	if !ok {
		return nil
	}
	at := val.(*activeTerminal)

	at.WebTTYs.Range(func(key, value any) bool {
		instance := value.(*webTTYInstance)
		instance.Cancel()
		return true
	})

	at.flushTicker.Stop()

	at.historyMu.Lock()
	m.flushHistoryToDB(at)
	at.historyMu.Unlock()

	at.PTY.Close()
	close(at.Done)

	m.db.Model(&TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"status":     StatusClosed,
		"pty_status": PTYStatusExited,
		"updated_at": time.Now().Unix(),
	})

	return nil
}

func (m *Manager) Delete(id string) error {
	m.Close(id)
	m.db.Where("session_id = ?", id).Delete(&TerminalHistory{})
	m.db.Where("id = ?", id).Delete(&TerminalSession{})
	return nil
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

		n, err := at.PTY.Read(buf)
		if err != nil {
			return
		}

		if n > 0 {
			at.historyMu.Lock()
			at.historyBuffer.Write(buf[:n])
			at.historyMu.Unlock()

			encoded := at.encoder.EncodeToString(buf[:n])
			msg := append([]byte{MsgOutput}, []byte(encoded)...)

			at.WebTTYs.Range(func(key, value any) bool {
				instance := value.(*webTTYInstance)
				instance.Master.Write(msg)
				return true
			})
		}
	}
}

func (m *Manager) monitorPTY(at *activeTerminal, pty *localCommand) {
	<-pty.ptyClosed

	at.ptyStatus.Store(PTYStatusExited)

	m.db.Model(&TerminalSession{}).Where("id = ?", at.ID).Updates(map[string]any{
		"pty_status": PTYStatusExited,
		"updated_at": time.Now().Unix(),
	})

	at.historyMu.Lock()
	m.flushHistoryToDB(at)
	at.historyMu.Unlock()
}

func (m *Manager) List() ([]TerminalInfo, error) {
	var sessions []TerminalSession
	if err := m.db.Order("updated_at DESC").Find(&sessions).Error; err != nil {
		return nil, err
	}
	result := make([]TerminalInfo, len(sessions))
	for i, s := range sessions {
		result[i] = *sessionToInfo(&s)
	}
	return result, nil
}

func (m *Manager) Attach(id string, conn *websocket.Conn, opts AttachOptions) (*Connection, error) {
	at, ok := m.getActive(id)
	if !ok {
		if !opts.Reactivate {
			return m.sendHistoryOnly(id, conn)
		}
		var err error
		at, err = m.reactivateSession(id)
		if err != nil {
			return nil, ErrTerminalNotFound
		}
	}

	if m.maxConnections > 0 && int(m.activeConns.Load()) >= m.maxConnections {
		return nil, ErrMaxConnectionsReached
	}

	clientID := uuid.New().String()
	mst := newWSMaster(conn)

	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})

	instance := &webTTYInstance{
		ID:     clientID,
		Master: mst,
		Ctx:    ctx,
		Cancel: cancel,
	}

	wt := newWebTTY(
		mst,
		at.PTY,
		withBufferSize(m.bufferSize),
		withSkipSlaveReadLoop(true),
		withOnReady(func() {
			m.replayHistory(at, mst)
			at.WebTTYs.Store(clientID, instance)
			m.activeConns.Add(1)
		}),
		withOnClosed(func() {
			at.WebTTYs.Delete(clientID)
			m.activeConns.Add(-1)
			conn.Close()
			close(doneCh)
		}),
	)

	instance.WebTTY = wt

	go func() {
		if err := wt.Run(ctx); err != nil {
			cancel()
		}
	}()

	return &Connection{Done: doneCh}, nil
}

func (m *Manager) reactivateSession(id string) (*activeTerminal, error) {
	var session TerminalSession
	if err := m.db.Where("id = ?", id).First(&session).Error; err != nil {
		return nil, err
	}

	pty, err := newLocalCommand(m.shell, nil, session.Cwd, session.Cols, session.Rows)
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	m.db.Model(&TerminalSession{}).Where("id = ?", id).Updates(map[string]any{
		"status":     StatusActive,
		"pty_status": PTYStatusRunning,
		"updated_at": now,
	})

	active := &activeTerminal{
		ID:            session.ID,
		PTY:           pty,
		Session:       &session,
		Done:          make(chan struct{}),
		historyBuffer: newHistoryBuffer(m.historyBufferSize),
		flushTicker:   time.NewTicker(m.historyFlushInterval),
		bufferSize:    m.bufferSize,
		encoder:       base64.StdEncoding,
	}
	active.ptyStatus.Store(PTYStatusRunning)

	m.terminals.Store(session.ID, active)

	go m.ptyReadLoop(active)
	go m.monitorPTY(active, pty)
	go m.flushHistory(active)

	return active, nil
}

func (m *Manager) sendHistoryOnly(id string, conn *websocket.Conn) (*Connection, error) {
	historyData, err := m.loadHistoryFromDB(id)
	if err != nil {
		return nil, err
	}

	mst := newWSMaster(conn)

	if len(historyData) > 0 {
		encoded := base64.StdEncoding.EncodeToString(historyData)
		msg := append([]byte{MsgOutput}, []byte(encoded)...)
		mst.Write(msg)
	}

	doneCh := make(chan struct{})
	close(doneCh)
	return &Connection{Done: doneCh}, nil
}

func (m *Manager) replayHistory(at *activeTerminal, mst master) error {
	at.historyMu.RLock()
	historyData := at.historyBuffer.Read()
	at.historyMu.RUnlock()

	if len(historyData) == 0 {
		dbData, err := m.loadHistoryFromDB(at.ID)
		if err == nil && len(dbData) > 0 {
			historyData = dbData
		}
	}

	if len(historyData) > 0 {
		encoded := base64.StdEncoding.EncodeToString(historyData)
		msg := append([]byte{MsgOutput}, []byte(encoded)...)
		mst.Write(msg)
	}

	return nil
}

func (m *Manager) CleanupOnStart() {
	m.db.Model(&TerminalSession{}).Where("pty_status = ?", PTYStatusRunning).Updates(map[string]any{
		"status":     StatusClosed,
		"pty_status": PTYStatusExited,
		"updated_at": time.Now().Unix(),
	})
}
