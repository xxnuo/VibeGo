package terminal

import (
	"context"
	"errors"
	"io"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

type completionManagerRuntime struct {
	complete  func(context.Context, CompletionRequest) (CompletionResult, error)
	closed    chan struct{}
	closeOnce sync.Once
}

func (r *completionManagerRuntime) Type() string { return RuntimeTypeSSH }

func (r *completionManagerRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{Completion: true}
}

func (r *completionManagerRuntime) Read([]byte) (int, error) { return 0, io.EOF }

func (r *completionManagerRuntime) Write(data []byte) (int, error) { return len(data), nil }

func (r *completionManagerRuntime) Resize(int, int) error { return nil }

func (r *completionManagerRuntime) Close() error {
	r.closeOnce.Do(func() { close(r.closed) })
	return nil
}

func (r *completionManagerRuntime) ExitCode() int { return 0 }

func (r *completionManagerRuntime) Wait(ctx context.Context) error {
	select {
	case <-r.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *completionManagerRuntime) Complete(ctx context.Context, request CompletionRequest) (CompletionResult, error) {
	return r.complete(ctx, request)
}

type completionUnsupportedRuntime struct {
	closed chan struct{}
	once   sync.Once
}

func (r *completionUnsupportedRuntime) Type() string { return RuntimeTypeSSH }
func (r *completionUnsupportedRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}
func (r *completionUnsupportedRuntime) Read([]byte) (int, error)       { return 0, io.EOF }
func (r *completionUnsupportedRuntime) Write(data []byte) (int, error) { return len(data), nil }
func (r *completionUnsupportedRuntime) Resize(int, int) error          { return nil }
func (r *completionUnsupportedRuntime) ExitCode() int                  { return 0 }

func (r *completionUnsupportedRuntime) Close() error {
	r.once.Do(func() { close(r.closed) })
	return nil
}

func (r *completionUnsupportedRuntime) Wait(ctx context.Context) error {
	select {
	case <-r.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func storeCompletionActive(manager *Manager, id string, runtime TerminalRuntime) *activeTerminal {
	at := &activeTerminal{
		ID:           id,
		Runtime:      runtime,
		capabilities: runtime.Capabilities(),
		Session: &model.TerminalSession{
			ID:          id,
			RuntimeType: runtime.Type(),
			Status:      model.StatusRunning,
		},
	}
	at.status.Store(model.StatusRunning)
	manager.terminals.Store(id, at)
	return at
}

func TestManagerCompleteUsesRuntimeProvider(t *testing.T) {
	wantRequest := CompletionRequest{
		Cwd:            "/remote/worktree",
		Prefix:         "vibego-",
		Kind:           CompletionKindCommand,
		ExecutableOnly: true,
		Limit:          37,
	}
	wantResult := CompletionResult{
		Candidates: []CompletionCandidate{
			{Value: "vibego-agent"},
			{Value: "vibego-tools/", IsDirectory: true},
		},
		HasMore: true,
	}
	providerCalled := false
	runtime := &completionManagerRuntime{
		closed: make(chan struct{}),
		complete: func(ctx context.Context, request CompletionRequest) (CompletionResult, error) {
			if ctx == nil {
				t.Fatal("completion context is nil")
			}
			providerCalled = true
			if request != wantRequest {
				t.Fatalf("completion request = %#v, want %#v", request, wantRequest)
			}
			return wantResult, nil
		},
	}
	manager := &Manager{}
	storeCompletionActive(manager, "completion-provider", runtime)

	result, err := manager.Complete(nil, "completion-provider", wantRequest)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if !providerCalled {
		t.Fatal("completion provider was not called")
	}
	if len(result.Candidates) != len(wantResult.Candidates) || result.HasMore != wantResult.HasMore {
		t.Fatalf("completion result = %#v, want %#v", result, wantResult)
	}
	for index := range wantResult.Candidates {
		if result.Candidates[index] != wantResult.Candidates[index] {
			t.Fatalf("completion result = %#v, want %#v", result, wantResult)
		}
	}
}

func TestManagerCompleteRejectsUnsupportedRuntime(t *testing.T) {
	manager := &Manager{}
	storeCompletionActive(manager, "completion-unsupported", &completionUnsupportedRuntime{closed: make(chan struct{})})

	_, err := manager.Complete(context.Background(), "completion-unsupported", CompletionRequest{})
	if !errors.Is(err, ErrCompletionUnsupported) {
		t.Fatalf("Complete() error = %v, want %v", err, ErrCompletionUnsupported)
	}
	_, err = manager.Complete(context.Background(), "completion-missing", CompletionRequest{})
	if !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("missing Complete() error = %v, want %v", err, ErrTerminalNotFound)
	}
}

func TestManagerCompleteRequiresAdvertisedCapability(t *testing.T) {
	runtime := &completionManagerRuntime{
		closed: make(chan struct{}),
		complete: func(context.Context, CompletionRequest) (CompletionResult, error) {
			t.Fatal("completion provider must not run when capability is disabled")
			return CompletionResult{}, nil
		},
	}
	manager := &Manager{}
	at := storeCompletionActive(manager, "completion-capability-disabled", runtime)
	at.capabilities.Completion = false

	_, err := manager.Complete(context.Background(), at.ID, CompletionRequest{})
	if !errors.Is(err, ErrCompletionUnsupported) {
		t.Fatalf("Complete() error = %v, want %v", err, ErrCompletionUnsupported)
	}
}

func TestManagerListUsesLiveCompletionCapabilityOnlyForActiveRuntime(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	activeID := "completion-list-active"
	historyID := "completion-list-history"
	for _, session := range []model.TerminalSession{
		{ID: activeID, RuntimeType: RuntimeTypeSSH, Status: model.StatusRunning},
		{ID: historyID, RuntimeType: RuntimeTypeSSH, Status: model.StatusExited},
	} {
		if err := db.Create(&session).Error; err != nil {
			t.Fatalf("create terminal %s: %v", session.ID, err)
		}
	}
	storeCompletionActive(manager, activeID, &completionManagerRuntime{
		closed: make(chan struct{}),
		complete: func(context.Context, CompletionRequest) (CompletionResult, error) {
			return CompletionResult{}, nil
		},
	})

	list, err := manager.List("", "")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	capabilities := make(map[string]bool, len(list))
	for _, info := range list {
		capabilities[info.ID] = info.Capabilities.Completion
	}
	if !capabilities[activeID] {
		t.Fatal("active SSH terminal omitted live completion capability")
	}
	if capabilities[historyID] {
		t.Fatal("history-only SSH terminal advertised live completion capability")
	}
}

func TestManagerCompleteEnforcesRequestedLimit(t *testing.T) {
	runtime := &completionManagerRuntime{
		closed: make(chan struct{}),
		complete: func(context.Context, CompletionRequest) (CompletionResult, error) {
			return CompletionResult{Candidates: []CompletionCandidate{
				{Value: "one"},
				{Value: "two"},
				{Value: "three"},
			}}, nil
		},
	}
	manager := &Manager{}
	storeCompletionActive(manager, "completion-limit", runtime)

	result, err := manager.Complete(context.Background(), "completion-limit", CompletionRequest{Limit: 2})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if !result.HasMore || len(result.Candidates) != 2 {
		t.Fatalf("limited completion result = %#v, want two candidates with has_more", result)
	}
}

func TestManagerCloseInterruptsConcurrentCompletion(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	terminalID := "completion-close-race-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := db.Create(&model.TerminalSession{
		ID:          terminalID,
		RuntimeType: RuntimeTypeSSH,
		Status:      model.StatusRunning,
	}).Error; err != nil {
		t.Fatalf("create terminal: %v", err)
	}

	started := make(chan struct{})
	providerReturned := make(chan struct{})
	runtime := &completionManagerRuntime{
		closed: make(chan struct{}),
	}
	runtime.complete = func(ctx context.Context, _ CompletionRequest) (CompletionResult, error) {
		close(started)
		select {
		case <-runtime.closed:
			close(providerReturned)
			return CompletionResult{Candidates: []CompletionCandidate{{Value: "late-result"}}}, nil
		case <-ctx.Done():
			close(providerReturned)
			return CompletionResult{}, ctx.Err()
		}
	}
	readDone := make(chan struct{})
	close(readDone)
	at := &activeTerminal{
		ID:            terminalID,
		Runtime:       runtime,
		Session:       &model.TerminalSession{ID: terminalID, RuntimeType: RuntimeTypeSSH, Status: model.StatusRunning},
		Done:          make(chan struct{}),
		readDone:      readDone,
		historyBuffer: newHistoryBuffer(128),
		capabilities:  runtime.Capabilities(),
	}
	at.status.Store(model.StatusRunning)
	manager.terminals.Store(terminalID, at)

	completeDone := make(chan error, 1)
	go func() {
		_, err := manager.Complete(context.Background(), terminalID, CompletionRequest{Kind: CompletionKindFile})
		completeDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("completion provider did not start")
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- manager.Close(terminalID) }()
	select {
	case err := <-completeDone:
		if !errors.Is(err, ErrTerminalNotFound) {
			t.Fatalf("concurrent Complete() error = %v, want %v", err, ErrTerminalNotFound)
		}
	case <-time.After(time.Second):
		t.Fatal("runtime Close did not interrupt completion")
	}
	select {
	case <-providerReturned:
	case <-time.After(time.Second):
		t.Fatal("completion provider did not observe runtime close")
	}
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not join the interrupted completion")
	}
	if _, ok := manager.Get(terminalID); ok {
		t.Fatal("closed terminal remains active")
	}
}
