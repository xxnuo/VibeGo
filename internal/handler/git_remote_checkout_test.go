package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func setupUnbornRemoteCheckout(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	publisher := filepath.Join(root, "publisher")
	repo := filepath.Join(root, "repo")
	runBranchManagementGit(t, root, "init", "--bare", remote)
	runBranchManagementGit(t, root, "clone", remote, publisher)
	runBranchManagementGit(t, publisher, "config", "user.name", "Publisher")
	runBranchManagementGit(t, publisher, "config", "user.email", "publisher@example.com")
	runBranchManagementGit(t, publisher, "checkout", "-b", "remote-main")
	require.NoError(t, os.WriteFile(filepath.Join(publisher, "remote.txt"), []byte("remote\n"), 0644))
	runBranchManagementGit(t, publisher, "add", "--", "remote.txt")
	runBranchManagementGit(t, publisher, "commit", "-m", "remote initial")
	runBranchManagementGit(t, publisher, "push", "-u", "origin", "remote-main")
	runBranchManagementGit(t, root, "init", repo)
	runBranchManagementGit(t, repo, "remote", "add", "origin", remote)
	runBranchManagementGit(t, repo, "fetch", "origin")
	return repo, remote
}

func TestGitCheckoutRemoteBranchFromUnbornRepository(t *testing.T) {
	t.Run("preserves non-conflicting staged and untracked files", func(t *testing.T) {
		repo, _ := setupUnbornRemoteCheckout(t)
		require.NoError(t, os.WriteFile(filepath.Join(repo, "staged.txt"), []byte("staged\n"), 0644))
		require.NoError(t, os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("untracked\n"), 0644))
		runBranchManagementGit(t, repo, "add", "--", "staged.txt")

		r, _ := setupRouter()
		response := postJSON(r, "/git/checkout-remote-branch", map[string]string{
			"path": repo, "remote": "origin", "branch": "remote-main", "localBranch": "main",
		})
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var payload struct {
			Created       bool `json:"created"`
			Stashed       bool `json:"stashed"`
			StashConflict bool `json:"stashConflict"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
		require.True(t, payload.Created)
		require.False(t, payload.Stashed)
		require.False(t, payload.StashConflict)
		require.Equal(t, "main", runBranchManagementGit(t, repo, "branch", "--show-current"))
		require.Equal(t, "staged", runBranchManagementGit(t, repo, "show", ":staged.txt"))
		require.Equal(t, "untracked\n", string(mustReadRealFile(t, filepath.Join(repo, "untracked.txt"))))
		require.Equal(t, "remote\n", string(mustReadRealFile(t, filepath.Join(repo, "remote.txt"))))
		status := runBranchManagementGit(t, repo, "status", "--short")
		require.Contains(t, status, "A  staged.txt")
		require.Contains(t, status, "?? untracked.txt")
		require.Empty(t, runBranchManagementGit(t, repo, "stash", "list"))
	})

	t.Run("rejects a conflicting untracked file without mutation", func(t *testing.T) {
		repo, remote := setupUnbornRemoteCheckout(t)
		publisher := filepath.Join(filepath.Dir(repo), "conflict-publisher")
		runBranchManagementGit(t, filepath.Dir(repo), "clone", remote, publisher)
		runBranchManagementGit(t, publisher, "config", "user.name", "Publisher")
		runBranchManagementGit(t, publisher, "config", "user.email", "publisher@example.com")
		runBranchManagementGit(t, publisher, "checkout", "remote-main")
		require.NoError(t, os.WriteFile(filepath.Join(publisher, "same.txt"), []byte("remote\n"), 0644))
		runBranchManagementGit(t, publisher, "add", "--", "same.txt")
		runBranchManagementGit(t, publisher, "commit", "-m", "remote conflict")
		runBranchManagementGit(t, publisher, "push", "origin", "remote-main")
		runBranchManagementGit(t, repo, "fetch", "origin")
		require.NoError(t, os.WriteFile(filepath.Join(repo, "same.txt"), []byte("local\n"), 0644))
		initialBranch := runBranchManagementGit(t, repo, "branch", "--show-current")

		r, _ := setupRouter()
		response := postJSON(r, "/git/checkout-remote-branch", map[string]string{
			"path": repo, "remote": "origin", "branch": "remote-main", "localBranch": "main",
		})
		require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
		require.Contains(t, strings.ToLower(response.Body.String()), "would be overwritten")
		require.Equal(t, initialBranch, runBranchManagementGit(t, repo, "branch", "--show-current"))
		require.Equal(t, "local\n", string(mustReadRealFile(t, filepath.Join(repo, "same.txt"))))
		require.False(t, branchManagementHasRef(t, repo, "refs/heads/main"))
		require.Empty(t, runBranchManagementGit(t, repo, "stash", "list"))
	})
}

func TestGitCheckoutRemoteBranchKeepsStashWhenRestoreConflicts(t *testing.T) {
	repo, remote := setupBranchManagementRemote(t)
	publisher := filepath.Join(filepath.Dir(repo), "publisher-conflict")
	runBranchManagementGit(t, filepath.Dir(repo), "clone", remote, publisher)
	runBranchManagementGit(t, publisher, "config", "user.name", "Publisher")
	runBranchManagementGit(t, publisher, "config", "user.email", "publisher@example.com")
	runBranchManagementGit(t, publisher, "checkout", "-b", "remote-conflict/nested")
	require.NoError(t, os.WriteFile(filepath.Join(publisher, "same.txt"), []byte("remote\n"), 0644))
	runBranchManagementGit(t, publisher, "add", "--", "same.txt")
	runBranchManagementGit(t, publisher, "commit", "-m", "remote conflict file")
	runBranchManagementGit(t, publisher, "push", "-u", "origin", "HEAD")
	runBranchManagementGit(t, repo, "fetch", "origin")

	// The untracked local file is stashed before checkout. The target branch
	// creates the same path, so restore must fail without dropping the stash.
	require.NoError(t, os.WriteFile(filepath.Join(repo, "same.txt"), []byte("local\n"), 0644))
	r, _ := setupRouter()
	response := postJSON(r, "/git/checkout-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "remote-conflict/nested",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		Created       bool   `json:"created"`
		Stashed       bool   `json:"stashed"`
		StashConflict bool   `json:"stashConflict"`
		StashError    string `json:"stashError"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.True(t, payload.Created)
	require.True(t, payload.Stashed)
	require.True(t, payload.StashConflict)
	require.NotEmpty(t, payload.StashError)
	require.Contains(t, payload.StashError, "same.txt")
	require.Equal(t, "remote\n", string(mustReadRealFile(t, filepath.Join(repo, "same.txt"))))
	require.Contains(t, runBranchManagementGit(t, repo, "stash", "list"), "auto-stash")
	require.Equal(t, "remote-conflict/nested", runBranchManagementGit(t, repo, "branch", "--show-current"))
	// The conflict should be represented in the structured response as well;
	// this guards the UI store's statusFilesToNodes conversion.
	var structured struct {
		Status struct {
			Files []StructuredFile `json:"files"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &structured))
	require.NotNil(t, structured.Status.Files)
}
