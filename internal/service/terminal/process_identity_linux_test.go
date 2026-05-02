//go:build linux

package terminal

import (
	"errors"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestLocalCommandProcessIdentityDistinguishesForegroundChild(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", nil, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("create local command: %v", err)
	}
	t.Cleanup(func() {
		// Kill any command that may still own the PTY before tearing down the
		// persistent shell. This keeps the test from leaking an orphan process.
		if identity, identityErr := lc.ProcessIdentity(); identityErr == nil && identity.ForegroundChildPID != nil {
			_ = syscall.Kill(-int(*identity.ForegroundChildPID), syscall.SIGKILL)
		}
		_ = lc.Close()
	})

	shellPID := lc.session.Pid()
	if shellPID <= 0 {
		t.Fatalf("shell pid = %d, want positive", shellPID)
	}

	if _, err := lc.Write([]byte("sleep 30\n")); err != nil {
		t.Fatalf("start foreground command: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	var identity ProcessIdentity
	for time.Now().Before(deadline) {
		identity, err = lc.ProcessIdentity()
		if err == nil && identity.ForegroundChildPID != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if identity.ForegroundChildPID == nil {
		t.Fatalf("foreground child was not observed: identity=%+v err=%v", identity, err)
	}
	if identity.ShellPID != int64(shellPID) {
		t.Fatalf("shell pid = %d, want %d", identity.ShellPID, shellPID)
	}
	if *identity.ForegroundChildPID == identity.ShellPID {
		t.Fatalf("foreground child pid reused shell pid %d", identity.ShellPID)
	}
	if identity.ShellProcessGroupID == nil || identity.ForegroundProcessGroupID == nil {
		t.Fatalf("missing process groups: %+v", identity)
	}
	if *identity.ForegroundProcessGroupID != *identity.ForegroundChildPID {
		t.Fatalf("foreground group = %d, child = %d", *identity.ForegroundProcessGroupID, *identity.ForegroundChildPID)
	}
	if *identity.ShellProcessGroupID == *identity.ForegroundChildPID {
		t.Fatalf("foreground child stayed in shell group %d", *identity.ShellProcessGroupID)
	}
	if err := syscall.Kill(int(*identity.ForegroundChildPID), 0); err != nil {
		t.Fatalf("foreground child pid %d is not alive: %v", *identity.ForegroundChildPID, err)
	}

	// The observer must return no child once the command group has exited.
	if err := syscall.Kill(-int(*identity.ForegroundChildPID), syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("stop foreground command: %v", err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, currentErr := lc.ProcessIdentity()
		if currentErr == nil && current.ForegroundChildPID == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, _ := lc.ProcessIdentity()
	t.Fatalf("foreground child remained after termination: %+v (pid %s)", current, strconv.FormatInt(*identity.ForegroundChildPID, 10))
}

func TestObserveProcessIdentityRejectsInvalidPID(t *testing.T) {
	if _, err := observeProcessIdentity(0); err == nil {
		t.Fatal("observeProcessIdentity(0) unexpectedly succeeded")
	}
}
