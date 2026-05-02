package terminal

import (
	"bytes"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPrepareBlockTermShellEnvironment(t *testing.T) {
	tests := []struct {
		name  string
		shell string
		env   []string
		want  []string
	}{
		{
			name:  "bash adds ignorespace",
			shell: "/bin/bash",
			env:   []string{"PATH=/bin", "HISTCONTROL=ignoredups"},
			want:  []string{"PATH=/bin", "HISTCONTROL=ignoredups:ignorespace"},
		},
		{
			name:  "bash preserves ignoreboth",
			shell: "/usr/bin/bash",
			env:   []string{"HISTCONTROL=ignoreboth", "PATH=/bin"},
			want:  []string{"PATH=/bin", "HISTCONTROL=ignoreboth"},
		},
		{
			name:  "other shell remains unchanged",
			shell: "/bin/zsh",
			env:   []string{"PATH=/bin", "HISTCONTROL=ignoredups"},
			want:  []string{"PATH=/bin", "HISTCONTROL=ignoredups"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := prepareBlockTermShellEnvironment(tt.shell, append([]string(nil), tt.env...))
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("environment = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestPrepareBlockTermShellArgs(t *testing.T) {
	if got := prepareBlockTermShellArgs("/bin/zsh", nil); !reflect.DeepEqual(got, []string{"-o", "HIST_IGNORE_SPACE"}) {
		t.Fatalf("zsh args = %#v", got)
	}
	args := []string{"-f"}
	if got := prepareBlockTermShellArgs("/bin/zsh", args); !reflect.DeepEqual(got, args) {
		t.Fatalf("explicit zsh args = %#v, want %#v", got, args)
	}
	if got := prepareBlockTermShellArgs("/bin/bash", nil); got != nil {
		t.Fatalf("bash args = %#v, want nil", got)
	}
}

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

func TestLocalCommand_ExitCodeConcurrentRead(t *testing.T) {
	lc, err := newLocalCommand("/bin/sh", []string{"-c", "sleep 0.05; exit 7"}, os.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("failed to create LocalCommand: %v", err)
	}

	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-lc.ptyClosed:
					return
				default:
					_ = lc.ExitCode()
				}
			}
		}()
	}

	<-lc.ptyClosed
	readers.Wait()
	if got := lc.ExitCode(); got != 7 {
		t.Fatalf("exit code = %d, want 7", got)
	}
}

func TestLocalCommand_CommandModeRunsToExitWithStdinAndExitCode(t *testing.T) {
	// Command mode must be a real `sh -c` PTY process. In particular, the
	// command must not be followed by an injected `exit` line on the
	// interactive shell, which can be consumed by a TUI or stdin reader.
	lc, err := newLocalCommand(
		"/bin/sh",
		[]string{"-c", "printf 'ready\\n'; read value; printf 'received=%s\\n' \"$value\"; exit 7"},
		os.TempDir(),
		80,
		24,
	)
	if err != nil {
		t.Fatalf("create command runtime: %v", err)
	}

	if _, err := lc.Write([]byte("input-line\n")); err != nil {
		_ = lc.Close()
		t.Fatalf("write command stdin: %v", err)
	}

	var output bytes.Buffer
	buf := make([]byte, 256)
	for {
		n, readErr := lc.Read(buf)
		if n > 0 {
			_, _ = output.Write(buf[:n])
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				// ptyx commonly reports EIO after the slave exits; the process
				// exit/close signal below is the authoritative lifecycle event.
				if !strings.Contains(strings.ToLower(readErr.Error()), "input/output") {
					t.Fatalf("read command output: %v", readErr)
				}
			}
			break
		}
	}
	select {
	case <-lc.ptyClosed:
	case <-time.After(2 * time.Second):
		t.Fatal("command PTY did not exit")
	}
	if got := lc.ExitCode(); got != 7 {
		t.Fatalf("command exit code = %d, want 7 (output %q)", got, output.String())
	}
	if !strings.Contains(output.String(), "ready") || !strings.Contains(output.String(), "received=input-line") {
		t.Fatalf("command output = %q, want ready and received marker", output.String())
	}
}
