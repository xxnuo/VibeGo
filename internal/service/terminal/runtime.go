package terminal

import (
	"context"
	"errors"
	"io"
	"strings"
)

const (
	RuntimeTypeLocal = "local"
	RuntimeTypeSSH   = "ssh"
)

type TerminalCapabilities struct {
	Resume           bool `json:"resume"`
	Snapshot         bool `json:"snapshot"`
	ShellIntegration bool `json:"shell_integration"`
	Durable          bool `json:"durable"`
	Completion       bool `json:"completion"`
}

const (
	CompletionKindCommand = "command"
	CompletionKindFile    = "file"
)

type CompletionRequest struct {
	Cwd            string
	Prefix         string
	Kind           string
	ExecutableOnly bool
	Limit          int
}

type CompletionCandidate struct {
	Value       string
	IsDirectory bool
}

type CompletionResult struct {
	Candidates []CompletionCandidate
	HasMore    bool
}

// CompletionProvider is implemented by runtimes that can query completion
// data in their own execution environment. It is deliberately optional so a
// runtime never falls back to scanning the VibeGo host by accident.
type CompletionProvider interface {
	Complete(ctx context.Context, request CompletionRequest) (CompletionResult, error)
}

// ProfileCompletionProvider serves completion for a durable connection profile
// without requiring that profile to be the runtime currently attached to the
// parent terminal. Implementations must resolve the profile from trusted
// server-side state; callers must never use this interface to authorize an
// arbitrary browser-supplied profile.
type ProfileCompletionProvider interface {
	CompleteProfile(ctx context.Context, profileID string, request CompletionRequest) (CompletionResult, error)
}

type ShellState struct {
	CurrentCwd          string
	ShellType           string
	ShellState          string
	ShellIntegration    bool
	LastCommand         string
	LastCommandExitCode *int
}

type TerminalRuntime interface {
	Type() string
	Capabilities() TerminalCapabilities
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	Close() error
	ExitCode() int
	Wait(ctx context.Context) error
}

type TerminalSignaler interface {
	Signal(name string) error
}

var ErrTerminalSignalUnsupported = errors.New("terminal runtime does not support signals")

func NormalizeTerminalSignal(value string) (string, error) {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "SIG")
	switch value {
	case "INT", "TERM", "KILL", "HUP", "USR1", "USR2":
		return value, nil
	default:
		return "", errors.New("unsupported terminal signal")
	}
}

func SignalTerminalRuntime(runtime TerminalRuntime, signal string) error {
	normalized, err := NormalizeTerminalSignal(signal)
	if err != nil {
		return err
	}
	signaler, ok := runtime.(TerminalSignaler)
	if !ok {
		if normalized == "INT" {
			return writeTerminalRuntimeFull(runtime, []byte{3})
		}
		return ErrTerminalSignalUnsupported
	}
	return signaler.Signal(normalized)
}

func writeTerminalRuntimeFull(runtime TerminalRuntime, data []byte) error {
	for len(data) > 0 {
		n, err := runtime.Write(data)
		if n < 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

type SSHAuthSecrets struct {
	Password   string `json:"-"`
	PrivateKey string `json:"-"`
	Passphrase string `json:"-"`
}

type RuntimeCreateRequest struct {
	Type      string
	ProfileID string
	Cwd       string
	// Command selects one-shot command mode for runtimes that support it.
	// Empty keeps the long-lived interactive PTY session.
	Command string
	Cols    int
	Rows    int
	SSHAuth SSHAuthSecrets
}

type RuntimeFactory interface {
	CreateRuntime(ctx context.Context, request RuntimeCreateRequest) (TerminalRuntime, error)
}

type LocalPTYRuntime struct {
	cmd *localCommand
}

func NewLocalPTYRuntime(cmd *localCommand) *LocalPTYRuntime {
	return &LocalPTYRuntime{cmd: cmd}
}

func (r *LocalPTYRuntime) Type() string {
	return RuntimeTypeLocal
}

func (r *LocalPTYRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{
		Resume:           true,
		Snapshot:         true,
		ShellIntegration: false,
		Durable:          false,
		Completion:       true,
	}
}

func (r *LocalPTYRuntime) Read(p []byte) (int, error) {
	return r.cmd.Read(p)
}

func (r *LocalPTYRuntime) Write(p []byte) (int, error) {
	return r.cmd.Write(p)
}

func (r *LocalPTYRuntime) Signal(name string) error {
	return r.cmd.Signal(name)
}

func (r *LocalPTYRuntime) ProcessIdentity() (ProcessIdentity, error) {
	if r == nil || r.cmd == nil {
		return ProcessIdentity{}, ErrProcessIdentityUnsupported
	}
	return r.cmd.ProcessIdentity()
}

func (r *LocalPTYRuntime) Resize(cols, rows int) error {
	return r.cmd.ResizeTerminal(cols, rows)
}

func (r *LocalPTYRuntime) Close() error {
	return r.cmd.Close()
}

func (r *LocalPTYRuntime) ExitCode() int {
	return r.cmd.ExitCode()
}

func (r *LocalPTYRuntime) Wait(ctx context.Context) error {
	select {
	case <-r.cmd.ptyClosed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
