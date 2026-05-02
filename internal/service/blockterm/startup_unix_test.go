//go:build !windows

package blockterm

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestDatabaseFailureReapsStartedShell(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pid")
	t.Setenv("VG_FAILURE_PID", pidFile)
	t.Setenv("TMPDIR", dir)
	shell := filepath.Join(dir, "test-shell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nprintf '%s' \"$$\" > \"$VG_FAILURE_PID\"\nexec sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(dir, "core.sqlite"), shell)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	injected := errors.New("injected session insert failure")
	var pid int
	if err := s.db.Callback().Create().Before("gorm:create").Register("test:fail-session", func(tx *gorm.DB) {
		if tx.Statement.Table != "sessions" {
			return
		}
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if data, err := os.ReadFile(pidFile); err == nil {
				pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
				if pid > 0 {
					break
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		tx.AddError(injected)
	}); err != nil {
		t.Fatal(err)
	}
	_, err = s.Create("failure", dir, shell, 80, 24)
	if !errors.Is(err, injected) {
		t.Fatalf("unexpected create result: %v", err)
	}
	if pid <= 0 {
		t.Fatal("test shell did not start")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child %d not reaped: %v", pid, err)
	}
	if len(s.sessions) != 0 {
		t.Fatal("failed session remains active")
	}
	dirs, err := filepath.Glob(filepath.Join(dir, "vibego-blockterm-*"))
	if err != nil || len(dirs) != 0 {
		t.Fatalf("integration directories remain: %v %v", dirs, err)
	}
}
