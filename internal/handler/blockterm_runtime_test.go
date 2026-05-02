package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

type blockRuntimeOwnerQueryContextKey struct{}

type shortBlockRuntime struct {
	waited chan struct{}
	once   sync.Once
}

func (r *shortBlockRuntime) Type() string { return terminal.RuntimeTypeSSH }

func (r *shortBlockRuntime) Capabilities() terminal.TerminalCapabilities {
	return terminal.TerminalCapabilities{}
}

func (r *shortBlockRuntime) Read([]byte) (int, error) { return 0, io.EOF }

func (r *shortBlockRuntime) Write(data []byte) (int, error) { return len(data), nil }

func (r *shortBlockRuntime) Resize(int, int) error { return nil }

func (r *shortBlockRuntime) Close() error { return nil }

func (r *shortBlockRuntime) ExitCode() int { return 0 }

func (r *shortBlockRuntime) Wait(context.Context) error {
	r.once.Do(func() { close(r.waited) })
	return nil
}

type shortBlockRuntimeFactory struct {
	created chan struct{}
	once    sync.Once
	mu      sync.Mutex
	runtime *shortBlockRuntime
	request terminal.RuntimeCreateRequest
}

func (f *shortBlockRuntimeFactory) CreateRuntime(
	_ context.Context,
	request terminal.RuntimeCreateRequest,
) (terminal.TerminalRuntime, error) {
	runtime := &shortBlockRuntime{
		waited: make(chan struct{}),
	}
	f.mu.Lock()
	f.runtime = runtime
	f.request = request
	f.mu.Unlock()
	f.once.Do(func() { close(f.created) })
	return runtime, nil
}

func (f *shortBlockRuntimeFactory) waitRuntime(timeout time.Duration) (*shortBlockRuntime, error) {
	select {
	case <-f.created:
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.runtime == nil {
			return nil, errors.New("runtime factory returned without a runtime")
		}
		return f.runtime, nil
	case <-time.After(timeout):
		return nil, errors.New("runtime factory was not called")
	}
}

func (f *shortBlockRuntimeFactory) createRequest() terminal.RuntimeCreateRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.request
}

type resizeBlockRuntime struct {
	mu        sync.Mutex
	resizes   [][2]int
	closed    chan struct{}
	closeOnce sync.Once
}

func newResizeBlockRuntime() *resizeBlockRuntime {
	return &resizeBlockRuntime{closed: make(chan struct{})}
}

func (r *resizeBlockRuntime) Type() string { return terminal.RuntimeTypeSSH }

func (r *resizeBlockRuntime) Capabilities() terminal.TerminalCapabilities {
	return terminal.TerminalCapabilities{}
}

func (r *resizeBlockRuntime) Read([]byte) (int, error) {
	<-r.closed
	return 0, io.EOF
}

func (r *resizeBlockRuntime) Write(data []byte) (int, error) { return len(data), nil }

func (r *resizeBlockRuntime) Resize(cols, rows int) error {
	r.mu.Lock()
	r.resizes = append(r.resizes, [2]int{cols, rows})
	r.mu.Unlock()
	return nil
}

func (r *resizeBlockRuntime) Close() error {
	r.closeOnce.Do(func() { close(r.closed) })
	return nil
}

func (r *resizeBlockRuntime) ExitCode() int { return 0 }

func (r *resizeBlockRuntime) Wait(context.Context) error {
	<-r.closed
	return nil
}

func (r *resizeBlockRuntime) resized() [][2]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([][2]int, len(r.resizes))
	copy(result, r.resizes)
	return result
}

type resizeBlockRuntimeFactory struct {
	runtime *resizeBlockRuntime
}

func (f *resizeBlockRuntimeFactory) CreateRuntime(
	context.Context,
	terminal.RuntimeCreateRequest,
) (terminal.TerminalRuntime, error) {
	return f.runtime, nil
}

type blockRuntimeResponseRecorder struct {
	*httptest.ResponseRecorder
	waitOnce sync.Once
	wait     func() error
	waitErr  error
}

func (w *blockRuntimeResponseRecorder) Write(data []byte) (int, error) {
	w.waitOnce.Do(func() {
		if w.wait != nil {
			w.waitErr = w.wait()
		}
	})
	if w.waitErr != nil {
		return 0, w.waitErr
	}
	return w.ResponseRecorder.Write(data)
}

func waitForBlockRuntimeRouteRemoval(
	manager *terminal.Manager,
	terminalID string,
	blockID string,
	token string,
	timeout time.Duration,
) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		resolution := manager.BlockTermRuntimeRegistry().ResolveByKey(terminalID, blockID, token)
		if resolution.Status == terminal.BlockTermRuntimeRouteStatusUnknownTagged {
			return nil
		}
		select {
		case <-deadline.C:
			return errors.New("block runtime route was not removed")
		case <-ticker.C:
		}
	}
}

func waitForBlockRuntimeStatus(db *gorm.DB, blockID, want string, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		var block model.BlockTermBlock
		err := db.Select("status").Where("id = ?", blockID).Take(&block).Error
		if err == nil && block.Status == want {
			return nil
		}
		select {
		case <-deadline.C:
			if err != nil {
				return err
			}
			return errors.New("block runtime did not reach final status")
		case <-ticker.C:
		}
	}
}

func TestCreateRuntimeReturnsCreatedAfterShortCommandFinalizes(t *testing.T) {
	const (
		terminalID   = "runtime-short-terminal"
		blockID      = "runtime-short-block"
		blockToken   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		command      = "printf done"
		durableState = "success"
	)

	env := setupBlockTermHandler(t)
	require.NoError(t, env.db.Create(&model.TerminalSession{
		ID:       terminalID,
		Name:     "short command",
		Status:   model.StatusRunning,
		Readonly: false,
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         blockID,
		TerminalID: terminalID,
		LineNum:    0,
		Kind:       blockTermKindCommand,
		Command:    command,
		Status:     model.StatusRunning,
		CreatedAt:  time.Now().Unix(),
		UpdatedAt:  time.Now().Unix(),
	}).Error)

	factory := &shortBlockRuntimeFactory{
		created: make(chan struct{}),
	}
	manager := terminal.NewManager(env.db, &terminal.ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: factory,
	})
	router := gin.New()
	NewBlockTermHandler(manager).Register(router.Group("/api"))

	var terminalQueries atomic.Int32
	requestMarker := &struct{}{}
	requestContext := context.WithValue(context.Background(), blockRuntimeOwnerQueryContextKey{}, requestMarker)
	const callbackName = "test:block_runtime_short_command_owner_query"
	require.NoError(t, env.db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.TerminalSession{}).TableName() {
			return
		}
		if tx.Statement.Context.Value(blockRuntimeOwnerQueryContextKey{}) != requestMarker {
			return
		}
		terminalQueries.Add(1)
	}))
	t.Cleanup(func() { _ = env.db.Callback().Query().Remove(callbackName) })

	payload, err := json.Marshal(map[string]any{
		"terminal_id":    terminalID,
		"block_id":       blockID,
		"block_token":    blockToken,
		"runtime_type":   terminal.RuntimeTypeSSH,
		"ssh_profile_id": "short-profile",
		"command":        command,
	})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/blockterm/runtime", bytes.NewReader(payload))
	request = request.WithContext(requestContext)
	request.Header.Set("Content-Type", "application/json")
	response := &blockRuntimeResponseRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		wait: func() error {
			runtime, waitErr := factory.waitRuntime(3 * time.Second)
			if waitErr != nil {
				return waitErr
			}
			select {
			case <-runtime.waited:
			case <-time.After(3 * time.Second):
				return errors.New("short command was not waited before response")
			}
			if err := waitForBlockRuntimeStatus(env.db, blockID, durableState, 3*time.Second); err != nil {
				return err
			}
			return waitForBlockRuntimeRouteRemoval(manager, terminalID, blockID, blockToken, 3*time.Second)
		},
	}

	router.ServeHTTP(response, request)
	require.NoError(t, response.waitErr)
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	require.Equal(t, int32(1), terminalQueries.Load(), "terminal owner admission must not be repeated after runtime construction")
	require.Equal(t, command, factory.createRequest().Command)

	var body struct {
		OK      bool                      `json:"ok"`
		Runtime terminal.BlockRuntimeInfo `json:"runtime"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.OK)
	require.Equal(t, terminalID, body.Runtime.TerminalID)
	require.Equal(t, blockID, body.Runtime.BlockID)
	require.Equal(t, blockToken, body.Runtime.BlockToken)
	require.Contains(t, []string{model.StatusRunning, model.StatusExited}, body.Runtime.Status)

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, durableState, block.Status)
	require.NotNil(t, block.ExitCode)
	require.Zero(t, *block.ExitCode)
	require.Equal(t, terminal.BlockTermRuntimeRouteStatusUnknownTagged,
		manager.BlockTermRuntimeRegistry().ResolveByKey(terminalID, blockID, blockToken).Status)
}

func TestResizeRuntimePersistsExactChildGeometry(t *testing.T) {
	const (
		terminalID = "runtime-resize-terminal"
		blockID    = "runtime-resize-block"
		blockToken = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	)
	env := setupBlockTermHandler(t)
	createdAt := time.Now().Unix()
	require.NoError(t, env.db.Create(&model.TerminalSession{
		ID: terminalID, Name: "resize command", Status: model.StatusRunning,
		RuntimeType: terminal.RuntimeTypeLocal, Cols: 80, Rows: 24,
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0,
		Kind: blockTermKindCommand, Command: "sleep", Status: model.StatusRunning,
		RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: "resize-profile",
		TermCols: 80, TermRows: 24, CreatedAt: createdAt, UpdatedAt: createdAt,
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermCommandHistory{
		ID: blockID, TerminalID: terminalID, LineNum: 0,
		Kind: blockTermKindCommand, Command: "sleep", Status: model.StatusRunning,
		RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: "resize-profile",
		TermCols: 80, TermRows: 24, CreatedAt: createdAt, SnapshotUpdatedAt: createdAt,
	}).Error)

	runtime := newResizeBlockRuntime()
	manager := terminal.NewManager(env.db, &terminal.ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: &resizeBlockRuntimeFactory{runtime: runtime},
	})
	_, err := manager.CreateBlockRuntime(terminal.BlockRuntimeCreateOptions{
		TerminalID:   terminalID,
		BlockID:      blockID,
		BlockToken:   blockToken,
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: "resize-profile",
		Cols:         80,
		Rows:         24,
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		err := manager.CloseBlockRuntime(terminalID, blockID, blockToken)
		if err != nil && !errors.Is(err, terminal.ErrBlockRuntimeNotFound) {
			t.Errorf("close resized runtime: %v", err)
		}
	})

	router := gin.New()
	NewBlockTermHandler(manager).Register(router.Group("/api"))
	payload, err := json.Marshal(map[string]any{
		"block_token": blockToken,
		"cols":        132,
		"rows":        43,
	})
	require.NoError(t, err)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/blockterm/runtime/"+terminalID+"/"+blockID+"/resize",
		bytes.NewReader(payload),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, [][2]int{{132, 43}}, runtime.resized())

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, 132, block.TermCols)
	require.Equal(t, 43, block.TermRows)
	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, 132, history.TermCols)
	require.Equal(t, 43, history.TermRows)
}
