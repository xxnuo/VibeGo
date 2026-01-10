package terminal

import (
	"context"
	"os"
	"sync"
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
}

func newLocalCommand(shell string, args []string, cwd string, cols, rows int, opts ...localCommandOption) (*localCommand, error) {
	env := append(os.Environ(), "TERM=xterm-256color")

	spawnOpts := ptyx.SpawnOpts{
		Prog: shell,
		Args: args,
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
		lcmd.session.Wait()
	}()

	return lcmd, nil
}

func (lc *localCommand) Read(p []byte) (int, error) {
	return lc.session.PtyReader().Read(p)
}

func (lc *localCommand) Write(p []byte) (int, error) {
	return lc.session.PtyWriter().Write(p)
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
