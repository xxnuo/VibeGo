package terminal

import (
	"os"
	"testing"
	"time"
)

func TestLocalCommand_WindowTitleVariables(t *testing.T) {
	tmpDir := os.TempDir()
	lc, err := newLocalCommand("/bin/sh", []string{"-c", "echo test"}, tmpDir, 80, 24)
	if err != nil {
		t.Fatalf("failed to create LocalCommand: %v", err)
	}
	defer lc.Close()

	vars := lc.WindowTitleVariables()

	if vars["command"] != "/bin/sh" {
		t.Errorf("expected command '/bin/sh', got %v", vars["command"])
	}

	if vars["cwd"] != tmpDir {
		t.Errorf("expected cwd %s, got %v", tmpDir, vars["cwd"])
	}

	if _, ok := vars["pid"]; !ok {
		t.Error("expected pid in variables")
	}
}

func TestLocalCommand_ReadWrite(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", nil, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("failed to create LocalCommand: %v", err)
	}
	defer lc.Close()

	input := []byte("echo hello\n")
	n, err := lc.Write(input)
	if err != nil {
		t.Errorf("failed to write: %v", err)
	}
	if n != len(input) {
		t.Errorf("expected to write %d bytes, wrote %d", len(input), n)
	}

	time.Sleep(100 * time.Millisecond)

	buf := make([]byte, 1024)
	n, err = lc.Read(buf)
	if err != nil {
		t.Errorf("failed to read: %v", err)
	}
	if n == 0 {
		t.Error("expected to read data")
	}
}

func TestLocalCommand_Resize(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", nil, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("failed to create LocalCommand: %v", err)
	}
	defer lc.Close()

	err = lc.ResizeTerminal(100, 30)
	if err != nil {
		t.Errorf("failed to resize: %v", err)
	}
}

func TestLocalCommand_CloseTimeout(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", nil, os.TempDir(), 80, 24, withCloseTimeout(100*time.Millisecond))
	if err != nil {
		t.Fatalf("failed to create LocalCommand: %v", err)
	}

	start := time.Now()
	err = lc.Close()
	duration := time.Since(start)

	if err != nil {
		t.Errorf("Close returned error: %v", err)
	}

	if duration > 200*time.Millisecond {
		t.Errorf("Close took too long: %v", duration)
	}
}

func TestLocalCommand_ProcessExit(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", []string{"-c", "exit 0"}, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("failed to create LocalCommand: %v", err)
	}

	time.Sleep(200 * time.Millisecond)

	buf := make([]byte, 1024)
	_, err = lc.Read(buf)
	if err == nil {
		t.Error("expected error when reading from closed PTY")
	}
}
