package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitRealStagedDiscardRestoresTrackedFile(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "tracked.txt", "base\n", "initial")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("changed\n"), 0644))
	runRealGit(t, dir, "add", "--", "tracked.txt")

	r, _ := setupRouter()
	w := postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "tracked.txt", "mode": "staged", "target": "file", "action": "discard",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, "base\n", string(mustReadRealFile(t, filepath.Join(dir, "tracked.txt"))))
	assert.Equal(t, "", runRealGit(t, dir, "status", "--porcelain"))
}

func TestGitRealStagedDiscardRejectsMetadataAliasAndTrackedDirectory(t *testing.T) {
	t.Run("metadata", func(t *testing.T) {
		dir := newRealGitRepo(t)
		link := filepath.Join(dir, "metadata-link")
		if err := os.Symlink(filepath.Join(dir, ".git"), link); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		configPath := filepath.Join(dir, ".git", "config")
		before := mustReadRealFile(t, configPath)
		statusBefore := runRealGit(t, dir, "status", "--porcelain")

		r, _ := setupRouter()
		w := postJSON(r, "/git/apply-selection", map[string]interface{}{
			"path": dir, "filePath": "metadata-link/config", "mode": "staged", "target": "file", "action": "discard",
		})
		require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), "symbolic link")
		assert.Equal(t, before, mustReadRealFile(t, configPath))
		assert.Equal(t, statusBefore, runRealGit(t, dir, "status", "--porcelain"))
	})

	t.Run("tracked directory", func(t *testing.T) {
		dir := newRealGitRepo(t)
		commitRealFile(t, dir, "tracked/file.txt", "base\n", "initial")
		require.NoError(t, os.WriteFile(filepath.Join(dir, "tracked", "file.txt"), []byte("changed\n"), 0644))
		runRealGit(t, dir, "add", "--", "tracked/file.txt")
		indexBefore := runRealGit(t, dir, "ls-files", "--stage")

		r, _ := setupRouter()
		w := postJSON(r, "/git/apply-selection", map[string]interface{}{
			"path": dir, "filePath": "tracked", "mode": "staged", "target": "file", "action": "discard",
		})
		require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), "cannot discard directory containing tracked files")
		assert.Equal(t, indexBefore, runRealGit(t, dir, "ls-files", "--stage"))
		assert.Equal(t, "changed\n", string(mustReadRealFile(t, filepath.Join(dir, "tracked", "file.txt"))))
	})
}
