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

func TestParseTerminalProcessGroups(t *testing.T) {
	processGroup, foregroundProcessGroup, err := parseTerminalProcessGroups(
		[]byte("123 (shell name with ) paren) S 1 123 123 34816 456 0 0"),
	)
	if err != nil {
		t.Fatalf("parse process stat: %v", err)
	}
	if processGroup != 123 || foregroundProcessGroup != 456 {
		t.Fatalf("groups = (%d, %d), want (123, 456)", processGroup, foregroundProcessGroup)
	}
}

func TestParseTerminalProcessGroupsRejectsMalformedStat(t *testing.T) {
	tests := [][]byte{
		[]byte("123 no-parentheses S 1 2 3 4 5"),
		[]byte("123 (shell) S 1 2"),
		[]byte("123 (shell) S 1 bad 3 4 5"),
		[]byte("123 (shell) S 1 2 3 4 bad"),
	}
	for _, data := range tests {
		if _, _, err := parseTerminalProcessGroups(data); !errors.Is(err, errTerminalForegroundProcessUnavailable) {
			t.Fatalf("parseTerminalProcessGroups(%q) error = %v", data, err)
		}
	}
}

func TestLocalCommandEscalationDoesNotSignalIdleShell(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", nil, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("create local command: %v", err)
	}
	defer lc.Close()

	waitForTerminalGroups(t, lc.session.Pid(), func(processGroup, foregroundProcessGroup int) bool {
		return processGroup == foregroundProcessGroup
	})
	if err := lc.Signal("TERM"); !errors.Is(err, errTerminalForegroundProcessUnavailable) {
		t.Fatalf("idle TERM error = %v, want foreground unavailable", err)
	}
	if err := syscall.Kill(lc.session.Pid(), 0); err != nil {
		t.Fatalf("persistent shell was terminated: %v", err)
	}
}

func TestLocalCommandEscalationSignalsForegroundJobOnly(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", nil, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("create local command: %v", err)
	}
	defer lc.Close()

	if _, err := lc.Write([]byte("sleep 30\n")); err != nil {
		t.Fatalf("start foreground command: %v", err)
	}
	processGroup, foregroundProcessGroup := waitForTerminalGroups(t, lc.session.Pid(), func(processGroup, foregroundProcessGroup int) bool {
		return foregroundProcessGroup > 0 && foregroundProcessGroup != processGroup
	})
	if err := lc.Signal("TERM"); err != nil {
		t.Fatalf("signal foreground command: %v", err)
	}
	waitForTerminalGroups(t, lc.session.Pid(), func(currentProcessGroup, currentForegroundProcessGroup int) bool {
		return currentProcessGroup == processGroup && currentForegroundProcessGroup == processGroup
	})
	if err := syscall.Kill(-foregroundProcessGroup, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("foreground process group %d still exists: %v", foregroundProcessGroup, err)
	}
	if err := syscall.Kill(lc.session.Pid(), 0); err != nil {
		t.Fatalf("persistent shell was terminated: %v", err)
	}
}

func waitForTerminalGroups(t *testing.T, pid int, ready func(int, int) bool) (int, int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var lastProcessGroup int
	var lastForegroundProcessGroup int
	var lastErr error
	for time.Now().Before(deadline) {
		data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err == nil {
			lastProcessGroup, lastForegroundProcessGroup, lastErr = parseTerminalProcessGroups(data)
			if lastErr == nil && ready(lastProcessGroup, lastForegroundProcessGroup) {
				return lastProcessGroup, lastForegroundProcessGroup
			}
		} else {
			lastErr = err
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf(
		"terminal groups did not reach expected state: pgrp=%d tpgid=%d err=%v",
		lastProcessGroup,
		lastForegroundProcessGroup,
		lastErr,
	)
	return 0, 0
}
