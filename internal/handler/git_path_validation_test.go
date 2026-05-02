package handler

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateRepoRelativePathRejectsPathspecMagicAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	repoRoot := filepath.Join(root, "repo")
	outside := filepath.Join(root, "outside")
	require.NoError(t, os.MkdirAll(repoRoot, 0755))
	require.NoError(t, os.MkdirAll(outside, 0755))

	require.Error(t, validateRepoRelativePath(repoRoot, ":(top,glob)**"))
	require.Error(t, validateRepoRelativePath(repoRoot, "../outside/file.txt"))
	require.NoError(t, validateRepoRelativePath(repoRoot, "nested/new-file.txt"))

	link := filepath.Join(repoRoot, "outside-link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	require.Error(t, validateRepoRelativePath(repoRoot, "outside-link/secret.txt"))
}

func TestValidateRepoRelativePathRejectsForeignWindowsDrivePaths(t *testing.T) {
	repoRoot := t.TempDir()
	for _, path := range []string{
		"C:/outside.txt",
		"C:\\outside.txt",
		"c:relative.txt",
	} {
		require.Error(t, validateRepoRelativePath(repoRoot, path), path)
	}
	require.NoError(t, validateRepoRelativePath(repoRoot, "name:part.txt"))
}
