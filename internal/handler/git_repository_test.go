package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func runRepositoryGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, string(out))
	return string(out)
}

func TestGitRepositorySettingsAndMutationRoutes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := newRealGitRepo(t)
	r, _ := setupRouter()

	w := postJSON(r, "/git/repository-settings", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var initial GitRepositorySettings
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &initial))
	require.Empty(t, initial.Remotes)

	w = postJSON(r, "/git/config", map[string]string{
		"path": dir, "scope": "local", "name": "Desktop User", "email": "desktop@example.com",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var configured GitRepositorySettings
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &configured))
	require.Equal(t, "Desktop User", configured.Config.LocalUserName)
	require.Equal(t, "desktop@example.com", configured.Config.EffectiveEmail)

	w = postJSON(r, "/git/remote-add", map[string]string{"path": dir, "name": "origin", "url": "https://example.invalid/repo.git"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "origin")

	w = postJSON(r, "/git/remote-set", map[string]string{
		"path": dir, "name": "origin", "url": "https://example.invalid/updated.git", "pushUrl": "ssh://example.invalid/repo.git",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var remotes struct {
		Remotes []GitRepositoryRemote `json:"remotes"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &remotes))
	require.Len(t, remotes.Remotes, 1)
	require.Equal(t, "https://example.invalid/updated.git", remotes.Remotes[0].FetchURL)
	require.Equal(t, []string{"ssh://example.invalid/repo.git"}, remotes.Remotes[0].PushURLs)

	// An omitted pushUrl preserves the configured push URL, while an explicit
	// empty value clears all local pushurl entries.
	w = postJSON(r, "/git/remote-set", map[string]string{
		"path": dir, "name": "origin", "url": "https://example.invalid/updated-again.git",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &remotes))
	require.Equal(t, []string{"ssh://example.invalid/repo.git"}, remotes.Remotes[0].PushURLs)

	w = postJSON(r, "/git/remote-set", map[string]string{
		"path": dir, "name": "origin", "url": "https://example.invalid/updated-final.git", "pushUrl": "",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &remotes))
	require.Empty(t, remotes.Remotes[0].PushURLs)

	w = postJSON(r, "/git/gitignore", map[string]string{"path": dir, "content": "*.tmp\n"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	content, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	require.NoError(t, err)
	require.Equal(t, "*.tmp\n", string(content))

	w = postJSON(r, "/git/remote-delete", map[string]string{"path": dir, "name": "origin"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "origin")
}

func TestGitRepositorySettingsRedactsRemoteCredentials(t *testing.T) {
	dir := newRealGitRepo(t)
	runRepositoryGit(t, dir, "remote", "add", "origin", "https://user:secret@example.com/owner/repo.git")
	r, _ := setupRouter()
	w := postJSON(r, "/git/repository-settings", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "secret")
	require.NotContains(t, w.Body.String(), "user@")
}

func TestGitWorktreeRoutes(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "base")
	r, _ := setupRouter()
	worktreePath := filepath.Join(t.TempDir(), "linked")

	w := postJSON(r, "/git/worktrees", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var listed GitWorktreeListResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listed))
	require.Len(t, listed.Worktrees, 1)
	require.True(t, listed.Worktrees[0].Main)

	w = postJSON(r, "/git/worktree-add", map[string]interface{}{
		"path": dir, "worktreePath": worktreePath, "branch": "feature/worktree", "createBranch": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.DirExists(t, worktreePath)

	w = postJSON(r, "/git/worktrees", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listed))
	require.Len(t, listed.Worktrees, 2)
	found := false
	for _, entry := range listed.Worktrees {
		if filepath.Clean(entry.Path) == filepath.Clean(worktreePath) {
			found = true
			require.Equal(t, "feature/worktree", entry.Branch)
		}
	}
	require.True(t, found)

	w = postJSON(r, "/git/worktree-remove", map[string]interface{}{"path": dir, "worktreePath": worktreePath})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoDirExists(t, worktreePath)
}
