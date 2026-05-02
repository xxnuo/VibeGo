package terminal

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/xxnuo/vibego/internal/model"
)

type processIdentityRuntime struct{}

func (*processIdentityRuntime) Type() string                       { return RuntimeTypeSSH }
func (*processIdentityRuntime) Capabilities() TerminalCapabilities { return TerminalCapabilities{} }
func (*processIdentityRuntime) Read([]byte) (int, error)           { return 0, nil }
func (*processIdentityRuntime) Write(data []byte) (int, error)     { return len(data), nil }
func (*processIdentityRuntime) Resize(int, int) error              { return nil }
func (*processIdentityRuntime) Close() error                       { return nil }
func (*processIdentityRuntime) ExitCode() int                      { return 0 }
func (*processIdentityRuntime) Wait(_ context.Context) error       { return nil }

type blockingProcessIdentityRuntime struct {
	processIdentityRuntime
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *blockingProcessIdentityRuntime) ProcessIdentity() (ProcessIdentity, error) {
	r.once.Do(func() { close(r.started) })
	<-r.release
	return ProcessIdentity{ShellPID: 123}, nil
}

func TestManagerProcessIdentityRejectsUnsupportedAndMissingRuntimes(t *testing.T) {
	runtime := &processIdentityRuntime{}
	manager := &Manager{}
	active := &activeTerminal{Runtime: runtime}
	active.status.Store(model.StatusRunning)
	manager.terminals.Store("remote", active)

	if _, err := manager.ProcessIdentity("remote"); !errors.Is(err, ErrProcessIdentityUnsupported) {
		t.Fatalf("unsupported runtime error = %v", err)
	}
	if _, err := manager.ProcessIdentity("missing"); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("missing runtime error = %v", err)
	}
}

func TestManagerProcessIdentityDoesNotReturnAfterRuntimeStops(t *testing.T) {
	runtime := &blockingProcessIdentityRuntime{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	manager := &Manager{}
	active := &activeTerminal{Runtime: runtime}
	active.status.Store(model.StatusRunning)
	manager.terminals.Store("closing", active)

	errCh := make(chan error, 1)
	go func() {
		_, err := manager.ProcessIdentity("closing")
		errCh <- err
	}()
	<-runtime.started

	active.stateMu.Lock()
	active.status.Store(model.StatusClosed)
	active.stateMu.Unlock()
	close(runtime.release)

	if err := <-errCh; !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("identity close race error = %v, want terminal not found", err)
	}
}
