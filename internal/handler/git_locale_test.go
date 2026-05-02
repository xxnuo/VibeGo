package handler

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewGitCommandForcesCLocale(t *testing.T) {
	t.Setenv("LC_ALL", "zh_CN.UTF-8")
	t.Setenv("LANG", "zh_CN.UTF-8")
	t.Setenv("LANGUAGE", "zh_CN:zh")

	cmd := newGitCommand("rev-parse", "--show-toplevel")
	cmd.Dir = t.TempDir()

	output, err := cmd.CombinedOutput()
	require.Error(t, err)
	assert.Contains(t, string(output), "not a git repository")
}

func TestNewGitCommandUsesShellEnvironment(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	require.NoError(t, err)

	binDir := t.TempDir()
	require.NoError(t, os.Symlink(gitPath, filepath.Join(binDir, "git")))

	argsFile := filepath.Join(t.TempDir(), "args")
	shell := filepath.Join(t.TempDir(), "shell")
	require.NoError(t, os.WriteFile(shell, []byte("#!/bin/sh\nprintf '%s\\n' \"$1\" > "+argsFile+"\nprintf 'PATH="+binDir+"\\0'\n"), 0755))

	t.Setenv("SHELL", shell)
	t.Setenv("PATH", t.TempDir())
	resetGitShellEnvCache()
	t.Cleanup(resetGitShellEnvCache)

	cmd := newGitCommand("version")
	output, err := cmd.Output()
	require.NoError(t, err)
	assert.Contains(t, string(output), "git version")
	assert.Equal(t, filepath.Join(binDir, "git"), cmd.Path)
	assert.Contains(t, filepath.SplitList(envValue(cmd.Env, "PATH")), binDir)
	usedArgs, err := os.ReadFile(argsFile)
	require.NoError(t, err)
	assert.Equal(t, "-lc\n", string(usedArgs))
}

func resetGitShellEnvCache() {
	gitShellEnvCache = struct {
		sync.Once
		env []string
	}{}
}
