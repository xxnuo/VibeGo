//go:build !windows

package terminal

import (
	"errors"
	"fmt"
	"syscall"
)

var errTerminalForegroundProcessUnavailable = errors.New("terminal foreground process group is unavailable")

func signalLocalProcess(pid int, name string) error {
	normalized, err := NormalizeTerminalSignal(name)
	if err != nil {
		return err
	}
	signal := map[string]syscall.Signal{
		"INT":  syscall.SIGINT,
		"TERM": syscall.SIGTERM,
		"KILL": syscall.SIGKILL,
		"HUP":  syscall.SIGHUP,
		"USR1": syscall.SIGUSR1,
		"USR2": syscall.SIGUSR2,
	}[normalized]
	if pid <= 0 {
		return fmt.Errorf("invalid terminal process id")
	}
	// Escalation must only target a foreground job group distinct from the
	// persistent shell. Falling back to the shell PID can destroy the terminal
	// when a command exits between INT and the later TERM/KILL timer.
	processGroup, err := terminalForegroundProcessGroup(pid)
	if err != nil {
		return err
	}
	return syscall.Kill(-processGroup, signal)
}
