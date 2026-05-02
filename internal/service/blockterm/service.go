package blockterm

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/KennethanCeyer/ptyx"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const MaxSessionBytes = 128 << 20
const MaxCommandBytes = 1 << 20

var ErrConflict = errors.New("session is not ready or is controlled by another client")

type Session struct {
	ID         string `json:"id" gorm:"primaryKey"`
	GroupID    string `json:"group_id" gorm:"index"`
	Shell      string `json:"shell"`
	Cwd        string `json:"cwd"`
	Phase      string `json:"phase"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	Seq        uint64 `json:"seq"`
	CreatedAt  int64  `json:"created_at"`
	Error      string `json:"error,omitempty"`
	Warning    string `json:"warning,omitempty"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	ExitSignal string `json:"exit_signal,omitempty"`
}

type Block struct {
	ID             string `json:"id" gorm:"primaryKey"`
	SessionID      string `json:"session_id" gorm:"index"`
	RequestID      string `json:"request_id"`
	Command        string `json:"command"`
	Cwd            string `json:"cwd"`
	Kind           string `json:"kind"`
	Status         string `json:"status"`
	ExitCode       *int   `json:"exit_code"`
	Success        *bool  `json:"success,omitempty"`
	NativeExitCode *int   `json:"native_exit_code,omitempty"`
	ShellStatus    *int   `json:"shell_status,omitempty"`
	CreatedAt      int64  `json:"created_at"`
	StartedAt      int64  `json:"started_at"`
	FinishedAt     int64  `json:"finished_at"`
}

type Event struct {
	SessionID string `json:"session_id" gorm:"primaryKey;index:idx_blockterm_output,priority:1"`
	Seq       uint64 `json:"seq" gorm:"primaryKey;index:idx_blockterm_output,priority:4"`
	Type      string `json:"type" gorm:"index:idx_blockterm_output,priority:3"`
	BlockID   string `json:"block_id,omitempty" gorm:"index:idx_blockterm_output,priority:2"`
	Data      []byte `json:"data,omitempty"`
}

type activeSession struct {
	mu                   sync.Mutex
	writeMu              sync.Mutex
	info                 Session
	pty                  ptyx.Session
	decoder              *Decoder
	current              *Block
	background           *Block
	owner                string
	lease                time.Time
	bytes                int
	recordingStopped     bool
	hookSeq              uint64
	accepted             bool
	uncertainSubmit      string
	acceptProtocol       bool
	cancelRequested      bool
	terminationRequested atomic.Bool
	pendingOutput        []byte
	pendingFile          *os.File
	echoControls         csiFilter
	backgroundParser     *ansi.Parser
	vt                   *vt.Emulator
	gridBlock            string
	bracketedPaste       bool
	done                 chan struct{}
	temp                 string
}

type Service struct {
	db       *gorm.DB
	mu       sync.Mutex
	sessions map[string]*activeSession
	shell    string
	closed   bool
}

func Open(path, shell string) (*Service, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	if err = os.Chmod(path, 0600); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if err = db.AutoMigrate(&Session{}, &Block{}, &Event{}, &storedCheckpoint{}); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if err = recoverSessions(db); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "bash"
	}
	return &Service{db: db, sessions: make(map[string]*activeSession), shell: shell}, nil
}

func (s *Service) List(group string) ([]Session, error) {
	result := []Session{}
	err := s.db.Where("group_id = ?", group).Order("created_at DESC").Find(&result).Error
	return result, err
}

func (s *Service) Blocks(id string) ([]Block, error) {
	result := []Block{}
	err := s.db.Where("session_id = ?", id).Order("created_at, id").Find(&result).Error
	return result, err
}

func (s *Service) Output(id, block string, after uint64) ([]Event, error) {
	return s.OutputContext(context.Background(), id, block, after)
}

func (s *Service) OutputContext(ctx context.Context, id, block string, after uint64) ([]Event, error) {
	result, _, err := s.OutputPageContext(ctx, id, block, after)
	return result, err
}

func (s *Service) OutputPageContext(ctx context.Context, id, block string, after uint64) ([]Event, bool, error) {
	return readEventBatch(s.db.WithContext(ctx).Where("session_id = ? AND block_id = ? AND type = ? AND seq > ?", id, block, "output", after))
}

func (s *Service) OutputPageThroughContext(ctx context.Context, id, block string, after, through uint64) ([]Event, bool, error) {
	return readEventBatch(s.db.WithContext(ctx).Where("session_id = ? AND block_id = ? AND type = ? AND seq > ? AND seq <= ?", id, block, "output", after, through))
}

func (s *Service) Get(id string) (Session, error) {
	return s.GetContext(context.Background(), id)
}

func (s *Service) GetContext(ctx context.Context, id string) (Session, error) {
	var result Session
	err := s.db.WithContext(ctx).First(&result, "id = ?", id).Error
	return result, err
}

func (s *Service) Events(id string, after uint64) ([]Event, error) {
	return s.EventsContext(context.Background(), id, after)
}

func (s *Service) EventsContext(ctx context.Context, id string, after uint64) ([]Event, error) {
	result, _, err := readEventBatch(s.db.WithContext(ctx).Where("session_id = ? AND seq > ?", id, after))
	return result, err
}

func (s *Service) Create(group, cwd, shell string, cols, rows int) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Session{}, errors.New("service closed")
	}
	if shell == "" {
		shell = s.shell
	}
	resolved, err := exec.LookPath(shell)
	if err != nil {
		return Session{}, err
	}
	if cwd == "" {
		cwd, err = os.UserHomeDir()
		if err != nil {
			return Session{}, err
		}
	}
	stat, err := os.Stat(cwd)
	if err != nil {
		return Session{}, err
	}
	if !stat.IsDir() {
		return Session{}, errors.New("cwd is not a directory")
	}
	cols, rows = geometry(cols, rows)
	id, nonce := uuid.NewString(), uuid.NewString()
	dir, err := os.MkdirTemp("", "vibego-blockterm-")
	if err != nil {
		return Session{}, err
	}
	args, env, err := shellSetup(resolved, dir, nonce)
	if err != nil {
		os.RemoveAll(dir)
		return Session{}, err
	}
	p, err := ptyx.Spawn(context.Background(), ptyx.SpawnOpts{Prog: resolved, Args: args, Dir: cwd, Env: env, Cols: cols, Rows: rows})
	if err != nil {
		os.RemoveAll(dir)
		return Session{}, err
	}
	a := &activeSession{info: Session{ID: id, GroupID: group, Shell: resolved, Cwd: cwd, Phase: "initializing", Cols: cols, Rows: rows, CreatedAt: time.Now().UnixMilli()}, pty: p, decoder: NewDecoder(nonce), done: make(chan struct{}), temp: dir}
	a.vt = newEmulator(cols, rows)
	a.vt.SetCallbacks(vt.Callbacks{
		EnableMode: func(mode ansi.Mode) {
			if mode == ansi.ModeBracketedPaste {
				a.bracketedPaste = true
			}
		},
		DisableMode: func(mode ansi.Mode) {
			if mode == ansi.ModeBracketedPaste {
				a.bracketedPaste = false
			}
		},
	})
	if err = s.db.Create(&a.info).Error; err != nil {
		_ = p.Kill()
		p.Close()
		_ = p.Wait()
		_ = a.vt.Close()
		os.RemoveAll(dir)
		return Session{}, err
	}
	s.sessions[id] = a
	result := a.info
	go s.read(a)
	go func() {
		select {
		case <-a.done:
			return
		case <-time.After(5 * time.Second):
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.info.Phase == "initializing" {
			a.info.Phase = "compatible"
			a.info.Warning = "Shell 集成不可用，当前为连续终端模式"
			s.state(a)
		}
	}()
	return result, nil
}

func geometry(cols, rows int) (int, int) {
	if cols < 2 {
		cols = 80
	}
	if cols > 500 {
		cols = 500
	}
	if rows < 2 {
		rows = 24
	}
	if rows > 300 {
		rows = 300
	}
	return cols, rows
}

func (s *Service) active(id string) (*activeSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrConflict
	}
	a := s.sessions[id]
	if a == nil {
		return nil, gorm.ErrRecordNotFound
	}
	return a, nil
}

func (s *Service) append(a *activeSession, kind, block string, data []byte) error {
	// Deferred pre-execution output can be much larger than a PTY read. Keep
	// byte-stream events bounded without splitting structured metadata events.
	if (kind == "output" || kind == "terminal") && len(data) > maxStreamEventBytes {
		for len(data) > 0 {
			n := min(len(data), maxStreamEventBytes)
			if err := s.append(a, kind, block, data[:n]); err != nil {
				return err
			}
			data = data[n:]
		}
		return nil
	}
	e := Event{SessionID: a.info.ID, Seq: a.info.Seq + 1, Type: kind, BlockID: block, Data: append([]byte(nil), data...)}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&e).Error; err != nil {
			return err
		}
		next := a.info
		next.Seq = e.Seq
		return tx.Save(&next).Error
	}); err != nil {
		a.info.Error = "持久化失败: " + err.Error()
		a.recordingStopped = true
		return err
	}
	a.info.Seq = e.Seq
	return nil
}

func (s *Service) blockEvent(a *activeSession, b *Block) error {
	return s.blockEvents(a, b, false)
}

func (s *Service) blockEvents(a *activeSession, b *Block, withState bool) error {
	data, _ := json.Marshal(b)
	e := Event{SessionID: a.info.ID, Seq: a.info.Seq + 1, Type: "block", BlockID: b.ID, Data: data}
	last := e.Seq
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Save(b).Error; err != nil {
			return err
		}
		if err := tx.Create(&e).Error; err != nil {
			return err
		}
		next := a.info
		next.Seq = e.Seq
		if withState {
			data, _ := json.Marshal(next)
			state := Event{SessionID: a.info.ID, Seq: e.Seq + 1, Type: "state", Data: data}
			if err := tx.Create(&state).Error; err != nil {
				return err
			}
			next.Seq = state.Seq
			last = state.Seq
		}
		return tx.Save(&next).Error
	})
	if err != nil {
		a.info.Error = "持久化失败: " + err.Error()
		a.recordingStopped = true
		return err
	}
	a.info.Seq = last
	return nil
}

func (s *Service) state(a *activeSession) {
	data, _ := json.Marshal(a.info)
	_ = s.append(a, "state", "", data)
}

func (s *Service) output(a *activeSession, data []byte) {
	if len(data) == 0 {
		return
	}
	if a.recordingStopped {
		// Recording failures must not prevent terminal query replies to the running program.
		_, _ = a.vt.Write(data)
		return
	}
	// Preserve the exact retained prefix regardless of PTY read chunk boundaries.
	// Feed the remainder through the same parser so split control sequences still work.
	if remaining := MaxSessionBytes - a.bytes; remaining > 0 && len(data) > remaining {
		s.output(a, data[:remaining])
		s.output(a, data[remaining:])
		return
	}
	a.bytes += len(data)
	if a.bytes > MaxSessionBytes {
		_, _ = a.vt.Write(data)
		// Accepted pre-execution output must precede the gap in replay. Once
		// recording stops, it cannot remain speculative until command cleanup.
		if a.current != nil {
			if err := s.flushPending(a); err != nil {
				a.info.Error = "暂存输出写入失败: " + err.Error()
				a.recordingStopped = true
				return
			}
		}
		a.info.Error = "会话输出达到 128 MiB 上限，后续输出不再记录，请新建会话"
		a.recordingStopped = true
		_ = s.append(a, "gap", "", []byte(a.info.Error))
		return
	}
	if a.info.Phase == "editing" {
		_, _ = a.vt.Write(data)
		_ = s.append(a, "terminal", "", data)
		return
	}
	b := a.current
	if b == nil {
		if a.background == nil {
			start := a.backgroundTextStart(data)
			if start != 0 {
				prefix := data
				if start > 0 {
					prefix = data[:start]
				}
				_, _ = a.vt.Write(prefix)
				if s.append(a, "terminal", "", prefix) != nil {
					if start > 0 {
						_, _ = a.vt.Write(data[start:])
					}
					return
				}
				if start < 0 {
					return
				}
				data = data[start:]
			}
			a.background = &Block{ID: uuid.NewString(), SessionID: a.info.ID, Kind: "background", Status: "done", Cwd: a.info.Cwd, CreatedAt: time.Now().UnixMilli()}
			if s.blockEvent(a, a.background) != nil {
				// Persistence must not swallow terminal queries in the first failed chunk.
				_, _ = a.vt.Write(data)
				return
			}
		}
		b = a.background
	}
	// Shell echo precedes Preexec and is represented by the command header.
	if a.info.Phase == "submitted" {
		if a.accepted {
			if err := a.bufferPending(data); err != nil {
				a.clearPending()
				a.info.Error = "暂存输出失败: " + err.Error()
				a.recordingStopped = true
				_, _ = a.vt.Write(data)
				_ = s.append(a, "gap", "", []byte(a.info.Error))
				return
			}
		}
		_, _ = a.vt.Write(data)
		controls := a.echoControls.feed(data)
		if len(controls) > 0 {
			_ = s.append(a, "terminal", "", controls)
		}
		return
	}
	s.selectGrid(a, b.ID)
	_, _ = a.vt.Write(data)
	_ = s.append(a, "output", b.ID, data)
}

func (s *Service) selectGrid(a *activeSession, id string) {
	if a.gridBlock == id {
		return
	}
	if a.vt.IsAltScreen() {
		_, _ = a.vt.WriteString("\x1b[?1049l")
	}
	_, _ = a.vt.WriteString("\x1b[2J\x1b[H\x1b[3J")
	a.gridBlock = id
}

func (s *Service) BeginNative(id, owner, draft string) error {
	if len(draft) > MaxCommandBytes || strings.ContainsRune(draft, 0) {
		return errors.New("invalid input")
	}
	a, err := s.active(id)
	if err != nil {
		return err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.mu.Lock()
	if !controls(a, owner) || a.info.Phase != "ready" || a.info.Error != "" {
		a.mu.Unlock()
		return ErrConflict
	}
	data, err := prepareInput(a, draft, false)
	if err != nil {
		a.mu.Unlock()
		return err
	}
	a.info.Phase = "editing"
	s.state(a)
	if a.info.Error != "" {
		a.info.Phase = "ready"
		err = errors.New(a.info.Error)
		a.mu.Unlock()
		return err
	}
	s.selectGrid(a, "input")
	a.mu.Unlock()
	err = writePTYInput(a.pty.PtyWriter(), []byte(data))
	if err != nil {
		a.mu.Lock()
		a.info.Error = "原生输入启动结果不确定，请检查会话"
		s.state(a)
		a.mu.Unlock()
	}
	return err
}

// Never retry a partially accepted terminal input: replay could execute it twice.
func writePTYInput(writer io.Writer, data []byte) error {
	n, err := writer.Write(data)
	if err == nil && n != len(data) {
		return io.ErrShortWrite
	}
	return err
}

func (s *Service) Release(id, owner string) {
	a, err := s.active(id)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.owner == owner {
		a.owner = ""
		a.lease = time.Time{}
	}
}

func (s *Service) hook(a *activeSession, value string) {
	parts := strings.Split(value, ";")
	switch parts[0] {
	case "capabilities":
		if len(parts) == 2 && parts[1] == "accept" && (a.info.Phase == "initializing" || a.info.Phase == "compatible") {
			a.acceptProtocol = true
		}
	case "accept":
		if len(parts) != 3 || a.info.Phase == "running" || a.info.Phase == "exited" {
			return
		}
		sequence, err := strconv.ParseUint(parts[2], 10, 64)
		command, decodeErr := base64.StdEncoding.DecodeString(parts[1])
		if err != nil || decodeErr != nil || sequence < a.hookSeq || (sequence == a.hookSeq && !a.accepted) {
			return
		}
		if !a.accepted {
			a.clearPending()
		}
		a.acceptProtocol, a.accepted, a.hookSeq = true, true, sequence
		if a.current == nil {
			a.current = &Block{ID: uuid.NewString(), SessionID: a.info.ID, Kind: "command", Status: "submitted", Cwd: a.info.Cwd, CreatedAt: time.Now().UnixMilli()}
		}
		if a.current.RequestID == "" {
			a.current.Command = string(command)
		}
		a.info.Phase = "submitted"
		_ = s.blockEvents(a, a.current, true)
	case "start":
		if len(parts) != 3 {
			return
		}
		sequence, err := strconv.ParseUint(parts[2], 10, 64)
		if err != nil || sequence < a.hookSeq || (sequence == a.hookSeq && !a.accepted) {
			return
		}
		if a.info.Phase == "running" || a.info.Phase == "exited" {
			return
		}
		command, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return
		}
		a.background = nil
		if a.current == nil {
			a.current = &Block{ID: uuid.NewString(), SessionID: a.info.ID, Kind: "command", Cwd: a.info.Cwd, CreatedAt: time.Now().UnixMilli()}
			a.current.Command = string(command)
		}
		if a.current.RequestID == "" {
			a.current.Command = string(command)
		}
		a.hookSeq = sequence
		a.accepted = false
		a.cancelRequested = false
		a.clearPending()
		_ = os.Remove(filepath.Join(a.temp, "input"))
		a.echoControls.reset()
		a.backgroundParser = nil
		s.selectGrid(a, a.current.ID)
		a.current.Status = "running"
		a.current.StartedAt = time.Now().UnixMilli()
		a.info.Phase = "running"
		_ = s.blockEvents(a, a.current, true)
	case "end":
		if len(parts) != 6 || a.info.Phase == "exited" {
			return
		}
		sequence, err := strconv.ParseUint(parts[5], 10, 64)
		if err != nil || sequence != a.hookSeq {
			return
		}
		if a.acceptProtocol && ((a.info.Phase == "submitted" && !a.accepted && !a.cancelRequested) || a.info.Phase == "ready") {
			return
		}
		code, err := strconv.Atoi(parts[1])
		if err != nil {
			return
		}
		cwd, err := base64.StdEncoding.DecodeString(parts[2])
		if err != nil {
			return
		}
		var success *bool
		if parts[3] != "" {
			value, err := strconv.ParseBool(parts[3])
			if err != nil {
				return
			}
			success = &value
		}
		var native *int
		if parts[4] != "" {
			value, err := strconv.Atoi(parts[4])
			if err != nil {
				return
			}
			native = &value
		}
		var finished *Block
		if a.current != nil {
			beforeExecution := (a.accepted || a.cancelRequested) && a.current.Status == "submitted"
			if beforeExecution {
				if err := s.flushPending(a); err != nil {
					a.info.Error = "暂存输出写入失败: " + err.Error()
					a.recordingStopped = true
				}
			}
			if a.vt.IsAltScreen() {
				_, _ = a.vt.WriteString("\x1b[?1049l")
			}
			_, _ = a.vt.WriteString("\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l")
			a.current.Success = success
			a.current.NativeExitCode = native
			a.current.Status = "done"
			a.current.ExitCode = &code
			if beforeExecution {
				a.current.Status = "not_executed"
				a.current.ExitCode = nil
				a.current.ShellStatus = &code
				if a.cancelRequested {
					a.current.Status = "interrupted"
				}
			}
			a.current.FinishedAt = time.Now().UnixMilli()
			finished = a.current
			a.current = nil
		}
		a.accepted = false
		a.cancelRequested = false
		a.clearPending()
		_ = os.Remove(filepath.Join(a.temp, "input"))
		a.echoControls.reset()
		a.backgroundParser = nil
		a.info.Cwd = string(cwd)
		a.background = nil
		a.info.Phase = "ready"
		a.info.Warning = ""
		if finished != nil {
			_ = s.blockEvents(a, finished, true)
		} else {
			s.state(a)
		}
	}
}

func (s *Service) read(a *activeSession) {
	defer close(a.done)
	defer func() { s.mu.Lock(); delete(s.sessions, a.info.ID); s.mu.Unlock() }()
	defer os.RemoveAll(a.temp)
	replies := make(chan []byte, 128)
	var replyOverflow atomic.Bool
	replyReaderDone := make(chan struct{})
	go func() {
		defer close(replyReaderDone)
		defer close(replies)
		buffer := make([]byte, 4096)
		for {
			n, err := a.vt.Read(buffer)
			if n > 0 {
				select {
				case replies <- append([]byte(nil), buffer[:n]...):
				default:
					replyOverflow.Store(true)
					a.terminationRequested.Store(true)
					_ = a.pty.Kill()
					_ = a.pty.Close()
					if pipe, ok := a.vt.InputPipe().(io.Closer); ok {
						_ = pipe.Close()
					}
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	replyWriterDone := make(chan struct{})
	go func() {
		defer close(replyWriterDone)
		for reply := range replies {
			a.writeMu.Lock()
			err := writePTYInput(a.pty.PtyWriter(), reply)
			a.writeMu.Unlock()
			if err != nil {
				a.mu.Lock()
				warning := "终端查询回复失败，程序可能等待响应: " + err.Error()
				if a.info.Warning != warning {
					a.info.Warning = warning
					if a.info.Phase != "exited" {
						s.state(a)
					}
				}
				a.mu.Unlock()
				continue
			}
		}
	}()
	defer func() {
		if pipe, ok := a.vt.InputPipe().(io.Closer); ok {
			_ = pipe.Close()
		}
		<-replyReaderDone
		<-replyWriterDone
		a.mu.Lock()
		if replyOverflow.Load() {
			if a.info.Error != "" {
				a.info.Error += "\n"
			}
			a.info.Error += "终端查询回复队列已满，会话已停止"
		}
		s.finishRead(a)
		a.mu.Unlock()
		_ = a.vt.Close()
	}()
	buffer := make([]byte, 32768)
	var readErr error
	for {
		n, err := a.pty.PtyReader().Read(buffer)
		a.mu.Lock()
		a.decoder.Feed(buffer[:n], func(b []byte) { s.output(a, b) }, func(v string) { s.hook(a, v) })
		a.mu.Unlock()
		if err != nil {
			readErr = err
			break
		}
	}
	a.mu.Lock()
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, os.ErrClosed) && !errors.Is(readErr, io.ErrClosedPipe) && !errors.Is(readErr, syscall.EIO) {
		if a.info.Error != "" {
			a.info.Error += "\n"
		}
		a.info.Error += "终端读取失败: " + readErr.Error()
	}
	a.decoder.Flush(func(b []byte) { s.output(a, b) })
	// Reject new controls immediately, but publish exited only after reply cleanup.
	a.info.Phase = "exited"
	a.mu.Unlock()
	a.pty.Close()
	waitErr := a.pty.Wait()
	a.mu.Lock()
	var exitErr *ptyx.ExitError
	if waitErr == nil {
		code := 0
		a.info.ExitCode = &code
	} else if errors.As(waitErr, &exitErr) {
		if status, ok := exitErr.Sys().(interface {
			Signaled() bool
			Signal() syscall.Signal
		}); ok && status.Signaled() {
			a.info.ExitSignal = status.Signal().String()
		}
		if exitErr.ExitCode >= 0 {
			code := exitErr.ExitCode
			a.info.ExitCode = &code
		}
	} else {
		if a.info.Error != "" {
			a.info.Error += "\n"
		}
		a.info.Error += "等待终端进程失败: " + waitErr.Error()
	}
	a.mu.Unlock()
}

// finishRead runs with a.mu held after the PTY reader stops.
func (s *Service) finishRead(a *activeSession) {
	a.decoder.Flush(func(b []byte) { s.output(a, b) })
	var finished *Block
	if a.current != nil {
		if a.accepted {
			if err := s.flushPending(a); err != nil {
				a.info.Error = "暂存输出写入失败: " + err.Error()
				a.recordingStopped = true
			}
		}
		if a.current.Status == "running" && a.current.StartedAt > 0 && a.info.ExitCode != nil && a.info.Error == "" && !a.cancelRequested && !a.terminationRequested.Load() {
			a.current.Status = "done"
			code := *a.info.ExitCode
			a.current.ExitCode = &code
		} else {
			a.current.Status = "interrupted"
		}
		a.current.FinishedAt = time.Now().UnixMilli()
		finished = a.current
		a.current = nil
	}
	a.clearPending()
	a.accepted = false
	a.info.Phase = "exited"
	if finished != nil {
		_ = s.blockEvents(a, finished, true)
	} else {
		s.state(a)
	}
}

func (s *Service) Claim(id, owner string) error {
	if owner == "" || len(owner) > 128 {
		return ErrConflict
	}
	a, err := s.active(id)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.info.Phase == "exited" || (a.owner != "" && a.owner != owner && time.Now().Before(a.lease)) {
		return ErrConflict
	}
	a.owner = owner
	a.lease = time.Now().Add(15 * time.Second)
	return nil
}

func controls(a *activeSession, owner string) bool {
	return owner != "" && a.owner == owner && time.Now().Before(a.lease) && a.info.Phase != "exited"
}

func (s *Service) Submit(id, owner, requestID, command string) (Block, error) {
	if requestID == "" || len(requestID) > 128 || strings.TrimSpace(command) == "" || len(command) > MaxCommandBytes || strings.ContainsAny(command, "\x00\x1b") {
		return Block{}, errors.New("invalid command request")
	}
	a, err := s.active(id)
	if err != nil {
		return Block{}, err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.mu.Lock()
	locked := true
	defer func() {
		if locked {
			a.mu.Unlock()
		}
	}()
	if !controls(a, owner) {
		return Block{}, ErrConflict
	}
	var old Block
	if err = s.db.Where("session_id = ? AND request_id = ?", id, requestID).First(&old).Error; err == nil {
		if old.Command != command {
			return Block{}, ErrConflict
		}
		if a.uncertainSubmit == requestID {
			return old, errors.New("命令提交结果不确定，请检查会话")
		}
		return old, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return Block{}, err
	}
	if a.info.Phase != "ready" || a.info.Error != "" {
		return Block{}, ErrConflict
	}
	data, err := prepareInput(a, command, true)
	if err != nil {
		return Block{}, fmt.Errorf("输入准备失败: %w", err)
	}
	b := Block{ID: uuid.NewString(), SessionID: id, RequestID: requestID, Command: command, Cwd: a.info.Cwd, Kind: "command", Status: "submitted", CreatedAt: time.Now().UnixMilli()}
	a.current = &b
	a.accepted = false
	a.cancelRequested = false
	a.clearPending()
	a.background = nil
	a.info.Phase = "submitted"
	if err = s.blockEvents(a, &b, true); err != nil {
		a.current = nil
		a.info.Phase = "ready"
		return Block{}, err
	}
	a.mu.Unlock()
	locked = false
	// Pasting through the shell's own line editor preserves shell parsing and state.
	err = writePTYInput(a.pty.PtyWriter(), []byte(data))
	if err != nil {
		a.mu.Lock()
		a.uncertainSubmit = requestID
		a.info.Error = "命令提交结果不确定，请检查会话"
		s.state(a)
		a.mu.Unlock()
	}
	var result Block
	if queryErr := s.db.First(&result, "id = ?", b.ID).Error; err == nil {
		err = queryErr
	}
	return result, err
}

func prepareInput(a *activeSession, command string, execute bool) (string, error) {
	if strings.ContainsRune(command, 27) {
		return "", errors.New("literal escape characters are not accepted in the command editor")
	}
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(a.info.Shell)), ".exe")
	if name == "bash" || name == "zsh" || name == "fish" || name == "pwsh" || name == "powershell" {
		if err := os.WriteFile(filepath.Join(a.temp, "input"), []byte(command), 0600); err != nil {
			return "", err
		}
		if execute {
			return "\x1b[24~", nil
		}
		return "\x1b[23~\t", nil
	}
	if a.bracketedPaste && command != "" {
		command = "\x1b[200~" + command + "\x1b[201~"
	}
	if execute {
		return command + "\r", nil
	}
	return command + "\t", nil
}

func (s *Service) Input(id, owner string, data []byte) error {
	if len(data) > 1<<20 {
		return errors.New("input too large")
	}
	a, err := s.active(id)
	if err != nil {
		return err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.mu.Lock()
	permitted := controls(a, owner)
	// Once output is unobservable, do not let ordinary input execute blind.
	// A standalone interrupt remains available, but a mixed paste containing
	// Ctrl-C must not smuggle additional input through the recovery path.
	if permitted && a.recordingStopped && !bytes.Equal(data, []byte{3}) {
		a.mu.Unlock()
		return errors.New("输出记录已停止，无法继续输入；请按 Ctrl-C 中断程序或关闭会话")
	}
	if permitted && a.info.Phase == "submitted" && bytes.Contains(data, []byte{3}) {
		a.cancelRequested = true
	}
	a.mu.Unlock()
	if !permitted {
		return ErrConflict
	}
	return writePTYInput(a.pty.PtyWriter(), data)
}

func recoverSessions(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var sessions []Session
		if err := tx.Where("phase <> ?", "exited").Find(&sessions).Error; err != nil {
			return err
		}
		for _, session := range sessions {
			var blocks []Block
			if err := tx.Where("session_id = ? AND status IN ?", session.ID, []string{"submitted", "running"}).Find(&blocks).Error; err != nil {
				return err
			}
			for _, block := range blocks {
				block.Status = "interrupted"
				block.FinishedAt = time.Now().UnixMilli()
				if err := tx.Save(&block).Error; err != nil {
					return err
				}
				session.Seq++
				data, _ := json.Marshal(block)
				if err := tx.Create(&Event{SessionID: session.ID, Seq: session.Seq, Type: "block", BlockID: block.ID, Data: data}).Error; err != nil {
					return err
				}
			}
			session.Phase = "exited"
			if session.Error != "" {
				session.Error += "\n"
			}
			session.Error += "服务已重启，会话已结束"
			session.Seq++
			data, _ := json.Marshal(session)
			if err := tx.Create(&Event{SessionID: session.ID, Seq: session.Seq, Type: "state", Data: data}).Error; err != nil {
				return err
			}
			if err := tx.Save(&session).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Service) Resize(id, owner string, cols, rows int) error {
	a, err := s.active(id)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !controls(a, owner) {
		return ErrConflict
	}
	cols, rows = geometry(cols, rows)
	if cols == a.info.Cols && rows == a.info.Rows {
		return nil
	}
	if err = a.pty.Resize(cols, rows); err != nil {
		return err
	}
	a.vt.Resize(cols, rows)
	a.info.Cols = cols
	a.info.Rows = rows
	data, _ := json.Marshal(map[string]int{"cols": cols, "rows": rows})
	return s.append(a, "resize", "", data)
}

func (s *Service) CloseSession(id, owner string) error {
	a, err := s.active(id)
	if err != nil {
		return err
	}
	a.mu.Lock()
	permitted := controls(a, owner)
	a.mu.Unlock()
	if !permitted {
		return ErrConflict
	}
	a.terminationRequested.Store(true)
	return terminatePTY(a.pty)
}

func terminatePTY(pty ptyx.Session) error {
	killErr := pty.Kill()
	closeErr := pty.Close()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	if errors.Is(closeErr, os.ErrClosed) {
		closeErr = nil
	}
	return errors.Join(killErr, closeErr)
}

func (s *Service) Close() error {
	s.mu.Lock()
	s.closed = true
	all := make([]*activeSession, 0, len(s.sessions))
	for _, a := range s.sessions {
		all = append(all, a)
	}
	s.mu.Unlock()
	var cleanupErr error
	for _, a := range all {
		a.terminationRequested.Store(true)
		if err := terminatePTY(a.pty); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("PTY %s: %w", a.info.ID, err))
		}
	}
	for _, a := range all {
		select {
		case <-a.done:
		case <-time.After(5 * time.Second):
			return errors.Join(cleanupErr, fmt.Errorf("PTY %s did not stop", a.info.ID))
		}
	}
	db, err := s.db.DB()
	if err != nil {
		return errors.Join(cleanupErr, err)
	}
	return errors.Join(cleanupErr, db.Close())
}
