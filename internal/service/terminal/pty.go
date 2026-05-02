package terminal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/KennethanCeyer/ptyx"
)

const DefaultCloseTimeout = 10 * time.Second

type localCommand struct {
	command      string
	argv         []string
	cwd          string
	session      ptyx.Session
	ptyClosed    chan struct{}
	closeTimeout time.Duration
	mu           sync.Mutex
	exitCode     atomic.Int32
}

func newLocalCommand(shell string, args []string, cwd string, cols, rows int, opts ...localCommandOption) (*localCommand, error) {
	env := append(os.Environ(), "TERM=xterm-256color", "PROMPT_EOL_MARK=")
	env = prepareBlockTermShellEnvironment(shell, env)
	if !hasEnvKey(env, "LANG") {
		env = append(env, "LANG=C.UTF-8")
	}
	if !hasEnvKey(env, "LC_ALL") {
		env = append(env, "LC_ALL=C.UTF-8")
	}
	if !hasEnvKey(env, "LC_CTYPE") {
		env = append(env, "LC_CTYPE=C.UTF-8")
	}

	spawnOpts := ptyx.SpawnOpts{
		Prog: shell,
		Args: prepareBlockTermShellArgs(shell, args),
		Env:  env,
		Dir:  cwd,
		Cols: cols,
		Rows: rows,
	}

	session, err := ptyx.Spawn(context.Background(), spawnOpts)
	if err != nil {
		return nil, err
	}

	ptyClosed := make(chan struct{})

	lcmd := &localCommand{
		command:      shell,
		argv:         args,
		cwd:          cwd,
		session:      session,
		ptyClosed:    ptyClosed,
		closeTimeout: DefaultCloseTimeout,
	}

	for _, opt := range opts {
		opt(lcmd)
	}

	go func() {
		defer func() {
			lcmd.session.Close()
			close(lcmd.ptyClosed)
		}()
		err := lcmd.session.Wait()
		if err != nil {
			var exitErr *ptyx.ExitError
			if errors.As(err, &exitErr) {
				lcmd.exitCode.Store(int32(exitErr.ExitCode))
			} else {
				lcmd.exitCode.Store(1)
			}
		}
	}()

	return lcmd, nil
}

// BlockTerm wrappers begin with a space so shells that support the usual
// history-ignore option do not persist the wrapper (and its lifecycle token).
// Configure that option before the interactive shell reads its first line.
func prepareBlockTermShellEnvironment(shell string, env []string) []string {
	if shellBaseName(shell) != "bash" {
		return env
	}

	value := ""
	for _, item := range env {
		if strings.HasPrefix(item, "HISTCONTROL=") {
			value = strings.TrimPrefix(item, "HISTCONTROL=")
		}
	}
	return setEnvironmentValue(env, "HISTCONTROL", ensureBashHistoryIgnoreSpace(value))
}

func prepareBlockTermShellArgs(shell string, args []string) []string {
	if len(args) != 0 || shellBaseName(shell) != "zsh" {
		return args
	}
	return []string{"-o", "HIST_IGNORE_SPACE"}
}

func shellBaseName(shell string) string {
	return strings.ToLower(filepath.Base(strings.TrimSpace(shell)))
}

func ensureBashHistoryIgnoreSpace(value string) string {
	for _, item := range strings.Split(value, ":") {
		switch strings.TrimSpace(item) {
		case "ignorespace", "ignoreboth":
			return value
		}
	}
	if value == "" {
		return "ignorespace"
	}
	return value + ":ignorespace"
}

func setEnvironmentValue(env []string, key, value string) []string {
	prefix := key + "="
	filtered := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, prefix) {
			filtered = append(filtered, item)
		}
	}
	return append(filtered, prefix+value)
}

func (lc *localCommand) Read(p []byte) (int, error) {
	return lc.session.PtyReader().Read(p)
}

func (lc *localCommand) Write(p []byte) (int, error) {
	return lc.session.PtyWriter().Write(p)
}

func (lc *localCommand) Signal(name string) error {
	normalized, err := NormalizeTerminalSignal(name)
	if err != nil {
		return err
	}
	if normalized == "INT" {
		_, err = lc.Write([]byte{3})
		return err
	}
	return signalLocalProcess(lc.session.Pid(), normalized)
}

// ProcessIdentity reports the PID of the shell started by ptyx and, where the
// platform permits, the current foreground process-group leader.
func (lc *localCommand) ProcessIdentity() (ProcessIdentity, error) {
	if lc == nil || lc.session == nil {
		return ProcessIdentity{}, ErrProcessIdentityUnsupported
	}
	return observeProcessIdentity(lc.session.Pid())
}

func (lc *localCommand) Resize(cols, rows int) error {
	return lc.session.Resize(cols, rows)
}

func (lc *localCommand) ResizeTerminal(cols, rows int) error {
	return lc.Resize(cols, rows)
}

func (lc *localCommand) WindowTitleVariables() map[string]interface{} {
	return map[string]interface{}{
		"command": lc.command,
		"argv":    lc.argv,
		"pid":     lc.session.Pid(),
		"cwd":     lc.cwd,
	}
}

func (lc *localCommand) Close() error {
	lc.mu.Lock()
	defer lc.mu.Unlock()

	lc.session.Kill()

	select {
	case <-lc.ptyClosed:
		return nil
	case <-time.After(lc.closeTimeout):
		return nil
	}
}

func (lc *localCommand) ExitCode() int {
	return int(lc.exitCode.Load())
}

func hasEnvKey(env []string, key string) bool {
	prefix := key + "="
	for i := range env {
		if strings.HasPrefix(env[i], prefix) {
			return true
		}
	}
	return false
}
