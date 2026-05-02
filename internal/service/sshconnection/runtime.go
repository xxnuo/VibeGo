package sshconnection

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
)

const defaultRuntimeOperationTimeout = 5 * time.Second

var (
	errRuntimeClosed           = errors.New("ssh runtime is closed")
	errRuntimeOperationTimeout = errors.New("ssh runtime operation timed out")
)

type runtimeSession interface {
	WindowChange(height, width int) error
	Close() error
	Wait() error
}

type Runtime struct {
	// client is the shared authenticated transport. Completion opens a fresh
	// session on this client and never writes into the interactive PTY.
	client *ssh.Client
	// newSession is injectable for lifecycle tests. Production runtimes leave it
	// nil and use client.NewSession directly.
	newSession func() (*ssh.Session, error)
	session    runtimeSession
	stdin      io.WriteCloser
	reader     *io.PipeReader
	writer     *io.PipeWriter
	done       chan struct{}
	closed     chan struct{}

	operationSlot      chan struct{}
	completionSlot     chan struct{}
	completionSlotOnce sync.Once
	completionTimeout  time.Duration
	operationTimeout   time.Duration
	closeTimeout       time.Duration
	transportClose     func()

	closeOnce          sync.Once
	localCloseOnce     sync.Once
	transportCloseOnce sync.Once
	exitCode           atomic.Int32
}

type runtimeResult struct {
	runtime *Runtime
	err     error
}

type runtimeOperationResult struct {
	n   int
	err error
}

type runtimeSetupCancellation struct {
	mu        sync.Mutex
	session   *ssh.Session
	cancelled bool
}

func (c *runtimeSetupCancellation) attach(session *ssh.Session) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancelled {
		return false
	}
	c.session = session
	return true
}

func (c *runtimeSetupCancellation) release() {
	c.mu.Lock()
	c.session = nil
	c.mu.Unlock()
}

func (c *runtimeSetupCancellation) cancel() {
	c.mu.Lock()
	c.cancelled = true
	session := c.session
	c.mu.Unlock()
	if session != nil {
		go func() {
			_ = session.Close()
		}()
	}
}

func newRuntime(
	ctx context.Context,
	client *ssh.Client,
	cwd string,
	cols, rows int,
	releaseSetup func(),
	transportClose func(),
	commands ...string,
) (*Runtime, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	setup := &runtimeSetupCancellation{}
	result := make(chan runtimeResult)
	go func() {
		if releaseSetup != nil {
			defer releaseSetup()
		}
		command := ""
		if len(commands) > 0 {
			command = commands[0]
		}
		runtime, err := newRuntimeBlocking(client, cwd, cols, rows, transportClose, setup, command)
		select {
		case result <- runtimeResult{runtime: runtime, err: err}:
		case <-ctx.Done():
			if runtime != nil {
				_ = runtime.Close()
			}
		}
	}()

	select {
	case completed := <-result:
		setup.release()
		return completed.runtime, completed.err
	case <-ctx.Done():
		setup.cancel()
		return nil, ctx.Err()
	}
}

func newRuntimeBlocking(
	client *ssh.Client,
	cwd string,
	cols, rows int,
	transportClose func(),
	setup *runtimeSetupCancellation,
	commands ...string,
) (*Runtime, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	if setup != nil && !setup.attach(session) {
		_ = session.Close()
		return nil, context.Canceled
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	reader, writer := io.Pipe()
	session.Stdout = writer
	session.Stderr = writer
	if err := session.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}); err != nil {
		_ = session.Close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}

	command := ""
	if len(commands) > 0 {
		command = commands[0]
	}
	if command != "" {
		err = session.Start(buildRemoteRuntimeCommand(cwd, command))
	} else if cwd == "" || cwd == "." || cwd == "~" {
		err = session.Shell()
	} else {
		command := "cd -- " + quotePOSIX(cwd) + " && exec \"${SHELL:-/bin/sh}\" -l"
		err = session.Start(command)
	}
	if err != nil {
		_ = session.Close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}

	runtime := &Runtime{
		client:            client,
		session:           session,
		stdin:             stdin,
		reader:            reader,
		writer:            writer,
		done:              make(chan struct{}),
		closed:            make(chan struct{}),
		operationSlot:     make(chan struct{}, 1),
		completionSlot:    make(chan struct{}, sshCompletionMaxConcurrent),
		completionTimeout: sshCompletionTimeout,
		operationTimeout:  defaultRuntimeOperationTimeout,
		closeTimeout:      defaultRuntimeOperationTimeout,
		transportClose:    transportClose,
	}
	go runtime.wait()
	return runtime, nil
}

func (r *Runtime) Type() string {
	return terminal.RuntimeTypeSSH
}

func (r *Runtime) Capabilities() terminal.TerminalCapabilities {
	return terminal.TerminalCapabilities{
		Resume:           true,
		Snapshot:         true,
		ShellIntegration: false,
		Durable:          false,
		Completion:       true,
	}
}

func (r *Runtime) Read(p []byte) (int, error) {
	return r.reader.Read(p)
}

func (r *Runtime) Write(p []byte) (int, error) {
	data := append([]byte(nil), p...)
	return r.runOperation(func() (int, error) {
		return r.stdin.Write(data)
	})
}

// Signal interrupts the foreground job through the remote PTY. SSH signal
// requests target the whole session process group on OpenSSH and can kill the
// persistent shell, so escalation signals are intentionally unsupported.
func (r *Runtime) Signal(name string) error {
	normalized, err := terminal.NormalizeTerminalSignal(name)
	if err != nil {
		return err
	}
	if normalized != "INT" {
		return terminal.ErrTerminalSignalUnsupported
	}
	_, err = r.runOperation(func() (int, error) {
		return r.stdin.Write([]byte{3})
	})
	return err
}

func (r *Runtime) Resize(cols, rows int) error {
	_, err := r.runOperation(func() (int, error) {
		return 0, r.session.WindowChange(rows, cols)
	})
	return err
}

func (r *Runtime) Close() error {
	r.closeOnce.Do(func() {
		r.closeLocal()
		go func() {
			_ = r.stdin.Close()
		}()
		go func() {
			_ = r.session.Close()
		}()
		go r.closeTransportAfterTimeout()
	})
	return nil
}

func (r *Runtime) ExitCode() int {
	return int(r.exitCode.Load())
}

func (r *Runtime) Wait(ctx context.Context) error {
	select {
	case <-r.done:
		return nil
	case <-r.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Runtime) runOperation(operation func() (int, error)) (int, error) {
	timeout := r.operationTimeout
	if timeout <= 0 {
		timeout = defaultRuntimeOperationTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case r.operationSlot <- struct{}{}:
	case <-r.closed:
		return 0, errRuntimeClosed
	case <-timer.C:
		r.failOperation()
		return 0, errRuntimeOperationTimeout
	}
	select {
	case <-r.closed:
		<-r.operationSlot
		return 0, errRuntimeClosed
	default:
	}

	result := make(chan runtimeOperationResult, 1)
	go func() {
		defer func() { <-r.operationSlot }()
		n, err := operation()
		result <- runtimeOperationResult{n: n, err: err}
	}()

	select {
	case completed := <-result:
		return completed.n, completed.err
	case <-r.closed:
		return 0, errRuntimeClosed
	case <-timer.C:
		select {
		case completed := <-result:
			return completed.n, completed.err
		default:
			r.failOperation()
			return 0, errRuntimeOperationTimeout
		}
	}
}

func (r *Runtime) failOperation() {
	r.closeLocal()
	r.closeTransport()
}

func (r *Runtime) closeLocal() {
	r.localCloseOnce.Do(func() {
		close(r.closed)
		_ = r.reader.CloseWithError(errRuntimeClosed)
		_ = r.writer.CloseWithError(errRuntimeClosed)
	})
}

func (r *Runtime) closeTransport() {
	if r.transportClose == nil {
		return
	}
	r.transportCloseOnce.Do(func() {
		go r.transportClose()
	})
}

func (r *Runtime) closeTransportAfterTimeout() {
	timeout := r.closeTimeout
	if timeout <= 0 {
		timeout = defaultRuntimeOperationTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-r.done:
	case <-timer.C:
		r.closeTransport()
	}
}

func (r *Runtime) wait() {
	err := r.session.Wait()
	exitCode := int32(0)
	if err != nil {
		exitCode = 255
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			exitCode = int32(exitErr.ExitStatus())
		}
	}
	r.exitCode.Store(exitCode)
	_ = r.writer.Close()
	close(r.done)
}

func quotePOSIX(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// buildRemoteRuntimeCommand returns a shell command that keeps the SSH PTY
// attached to a one-shot command. The command is executed by the user's
// remote shell, so stdin, resize and PTY interrupt semantics remain intact;
// the explicit exec makes session.Wait observe the command's real exit status.
func buildRemoteRuntimeCommand(cwd, command string) string {
	inner := "exec \"${SHELL:-/bin/sh}\" -c " + quotePOSIX(command)
	if cwd == "" || cwd == "." || cwd == "~" {
		return inner
	}
	return "cd -- " + quotePOSIX(cwd) + " && " + inner
}
