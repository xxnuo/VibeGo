package blockterm

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestZshFailingUserPreexecDoesNotHideCommandStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix Zsh fixture")
	}
	if _, err := exec.LookPath("zsh"); err != nil {
		t.Skip("zsh unavailable")
	}
	dir := t.TempDir()
	t.Setenv("ZDOTDIR", dir)
	if modules := os.Getenv("BLOCKTERM_TEST_ZSH_MODULES"); modules != "" {
		if err := os.WriteFile(filepath.Join(dir, ".zshenv"), []byte("module_path=('"+modules+"')\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, ".zshrc"), []byte(`user_preexec() { print -r -- called >> "$ZDOTDIR/user-hooks"; return 1; }
preexec_functions=(user_preexec)
`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "zsh")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("zsh-hooks", dir, "zsh", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "test"); err != nil {
		t.Fatal(err)
	}
	block, err := s.Submit(info.ID, "test", "command", "printf 'HOOK_COMMAND_OUTPUT\\n'")
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	var stored Block
	if err := s.db.First(&stored, "id = ?", block.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != "done" || stored.StartedAt == 0 || stored.ExitCode == nil || *stored.ExitCode != 0 {
		t.Fatalf("user hook hid command start: %+v", stored)
	}
	data, err := os.ReadFile(filepath.Join(dir, "user-hooks"))
	if err != nil || !strings.Contains(string(data), "called") {
		t.Fatalf("user hook lost: %q %v", data, err)
	}
}
