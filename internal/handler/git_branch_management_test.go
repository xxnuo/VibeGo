package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func runBranchManagementGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	return strings.TrimSpace(string(out))
}

func setupBranchManagementRemote(t *testing.T) (repo, remote string) {
	t.Helper()
	root := t.TempDir()
	remote = filepath.Join(root, "origin.git")
	repo = filepath.Join(root, "repo")
	runBranchManagementGit(t, root, "init", "--bare", remote)
	runBranchManagementGit(t, root, "init", repo)
	runBranchManagementGit(t, repo, "config", "user.name", "VibeGo Test")
	runBranchManagementGit(t, repo, "config", "user.email", "vibego-test@example.com")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "README.md"), []byte("base\n"), 0644))
	runBranchManagementGit(t, repo, "add", "--", "README.md")
	runBranchManagementGit(t, repo, "commit", "-m", "initial")
	runBranchManagementGit(t, repo, "remote", "add", "origin", remote)
	runBranchManagementGit(t, repo, "push", "-u", "origin", "HEAD")
	return repo, remote
}

func branchManagementHasRef(t *testing.T, dir, ref string) bool {
	t.Helper()
	cmd := exec.Command("git", "show-ref", "--verify", "--quiet", ref)
	cmd.Dir = dir
	return cmd.Run() == nil
}

func setupNestedRemoteBranch(t *testing.T) (repo, remote string) {
	t.Helper()
	repo, remote = setupBranchManagementRemote(t)
	publisher := filepath.Join(filepath.Dir(repo), "nested-branch-publisher")
	runBranchManagementGit(t, filepath.Dir(repo), "clone", remote, publisher)
	runBranchManagementGit(t, publisher, "config", "user.name", "Publisher")
	runBranchManagementGit(t, publisher, "config", "user.email", "publisher@example.com")

	runBranchManagementGit(t, publisher, "checkout", "-b", "feature")
	require.NoError(t, os.WriteFile(filepath.Join(publisher, "plain-feature.txt"), []byte("plain\n"), 0644))
	runBranchManagementGit(t, publisher, "add", "--", "plain-feature.txt")
	runBranchManagementGit(t, publisher, "commit", "-m", "plain feature")
	runBranchManagementGit(t, publisher, "push", "-u", "origin", "HEAD")

	runBranchManagementGit(t, publisher, "checkout", "-b", "origin/feature")
	require.NoError(t, os.WriteFile(filepath.Join(publisher, "nested-feature.txt"), []byte("nested\n"), 0644))
	runBranchManagementGit(t, publisher, "add", "--", "nested-feature.txt")
	runBranchManagementGit(t, publisher, "commit", "-m", "nested feature")
	runBranchManagementGit(t, publisher, "push", "-u", "origin", "HEAD")
	runBranchManagementGit(t, repo, "fetch", "origin")

	require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/feature"))
	require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/origin/feature"))
	return repo, remote
}

func TestGitBranchManagementRenameValidatesAndPreservesUpstream(t *testing.T) {
	repo, _ := setupBranchManagementRemote(t)
	runBranchManagementGit(t, repo, "checkout", "-b", "feature/old")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "feature.txt"), []byte("feature\n"), 0644))
	runBranchManagementGit(t, repo, "add", "--", "feature.txt")
	runBranchManagementGit(t, repo, "commit", "-m", "feature")
	runBranchManagementGit(t, repo, "push", "-u", "origin", "HEAD")

	r, _ := setupRouter()
	response := postJSON(r, "/git/rename-branch", map[string]string{
		"path": repo, "branch": "feature/old", "newBranch": "feature/new",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		OK            bool   `json:"ok"`
		OldBranch     string `json:"oldBranch"`
		Branch        string `json:"branch"`
		CurrentBranch string `json:"currentBranch"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.True(t, payload.OK)
	require.Equal(t, "feature/old", payload.OldBranch)
	require.Equal(t, "feature/new", payload.Branch)
	require.Equal(t, "feature/new", payload.CurrentBranch)
	require.False(t, branchManagementHasRef(t, repo, "refs/heads/feature/old"))
	require.True(t, branchManagementHasRef(t, repo, "refs/heads/feature/new"))
	require.Equal(t, "origin", runBranchManagementGit(t, repo, "config", "--get", "branch.feature/new.remote"))
	require.Equal(t, "refs/heads/feature/old", runBranchManagementGit(t, repo, "config", "--get", "branch.feature/new.merge"))

	// Existing targets and option-looking names are rejected before Git runs.
	runBranchManagementGit(t, repo, "branch", "already-there")
	response = postJSON(r, "/git/rename-branch", map[string]string{
		"path": repo, "oldBranch": "feature/new", "newName": "already-there",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	response = postJSON(r, "/git/rename-branch", map[string]string{
		"path": repo, "oldBranch": "feature/new", "newName": "--force",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	require.True(t, branchManagementHasRef(t, repo, "refs/heads/feature/new"))
}

func TestGitBranchManagementRenameCurrentUnbornBranch(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "repo")
	runBranchManagementGit(t, filepath.Dir(repo), "init", repo)
	currentBranch := runBranchManagementGit(t, repo, "branch", "--show-current")
	require.NotEmpty(t, currentBranch)
	require.NoError(t, os.WriteFile(filepath.Join(repo, "staged.txt"), []byte("staged\n"), 0644))
	runBranchManagementGit(t, repo, "add", "--", "staged.txt")

	r, _ := setupRouter()
	response := postJSON(r, "/git/rename-branch", map[string]string{
		"path": repo, "oldBranch": currentBranch, "newBranch": "renamed",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		Branch        string `json:"branch"`
		CurrentBranch string `json:"currentBranch"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, "renamed", payload.Branch)
	require.Equal(t, "renamed", payload.CurrentBranch)
	require.Equal(t, "renamed", runBranchManagementGit(t, repo, "branch", "--show-current"))
	require.Equal(t, "staged", runBranchManagementGit(t, repo, "show", ":staged.txt"))

	headCmd := exec.Command("git", "rev-parse", "--verify", "HEAD")
	headCmd.Dir = repo
	require.Error(t, headCmd.Run(), "renaming must not create an initial commit")
	response = postJSON(r, "/git/rename-branch", map[string]string{
		"path": repo, "oldBranch": "missing", "newBranch": "other",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
}

func TestGitBranchManagementListsAmbiguousNamesWithoutDisambiguationPrefixes(t *testing.T) {
	repo, _ := setupBranchManagementRemote(t)
	runBranchManagementGit(t, repo, "push", "origin", "HEAD:refs/heads/main")
	runBranchManagementGit(t, repo, "fetch", "origin")
	runBranchManagementGit(t, repo, "branch", "origin/main")

	r, _ := setupRouter()
	response := postJSON(r, "/git/branches", map[string]string{"path": repo})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		Branches       []BranchInfo `json:"branches"`
		RemoteBranches []string     `json:"remoteBranches"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	var localNames []string
	for _, branch := range payload.Branches {
		localNames = append(localNames, branch.Name)
	}
	require.Contains(t, localNames, "origin/main")
	require.NotContains(t, localNames, "heads/origin/main")
	require.Contains(t, payload.RemoteBranches, "origin/main")
	require.NotContains(t, payload.RemoteBranches, "remotes/origin/main")

	snapshot := collectBranchesSnapshot(repo)
	require.Contains(t, snapshot.Branches, "origin/main")
	require.Contains(t, snapshot.RemoteBranches, "origin/main")
}

func TestGitBranchManagementPreservesRemotePrefixInLiteralBranchName(t *testing.T) {
	t.Run("checkout", func(t *testing.T) {
		repo, _ := setupNestedRemoteBranch(t)
		r, _ := setupRouter()
		response := postJSON(r, "/git/checkout-remote-branch", map[string]string{
			"path": repo, "remote": "origin", "branch": "origin/feature",
		})
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var payload struct {
			Branch       string `json:"branch"`
			RemoteBranch string `json:"remoteBranch"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
		require.Equal(t, "origin/feature", payload.Branch)
		require.Equal(t, "origin/feature", payload.RemoteBranch)
		require.Equal(t, "origin/feature", runBranchManagementGit(t, repo, "branch", "--show-current"))
		require.Equal(t, "nested\n", string(mustReadRealFile(t, filepath.Join(repo, "nested-feature.txt"))))
	})

	t.Run("delete", func(t *testing.T) {
		repo, remote := setupNestedRemoteBranch(t)
		r, _ := setupRouter()
		response := postJSON(r, "/git/delete-remote-branch", map[string]string{
			"path": repo, "remote": "origin", "branch": "origin/feature",
		})
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var payload struct {
			Branch string `json:"branch"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
		require.Equal(t, "origin/feature", payload.Branch)
		require.False(t, branchManagementHasRef(t, remote, "refs/heads/origin/feature"))
		require.True(t, branchManagementHasRef(t, remote, "refs/heads/feature"))
		require.False(t, branchManagementHasRef(t, repo, "refs/remotes/origin/origin/feature"))
		require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/feature"))
	})
}

func TestGitBranchManagementDeleteRemoteAndPrune(t *testing.T) {
	repo, remote := setupBranchManagementRemote(t)
	baseBranch := runBranchManagementGit(t, repo, "branch", "--show-current")
	runBranchManagementGit(t, repo, "checkout", "-b", "published")
	runBranchManagementGit(t, repo, "push", "-u", "origin", "HEAD")
	runBranchManagementGit(t, repo, "tag", "published")
	runBranchManagementGit(t, repo, "push", "origin", "refs/tags/published")
	runBranchManagementGit(t, repo, "checkout", "-b", "stale")
	runBranchManagementGit(t, repo, "push", "-u", "origin", "HEAD")
	runBranchManagementGit(t, repo, "checkout", baseBranch)
	// Delete the server ref behind the local clone's back, leaving a stale
	// refs/remotes entry for the prune endpoint to remove.
	runBranchManagementGit(t, remote, "update-ref", "-d", "refs/heads/stale")
	require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/stale"))

	r, _ := setupRouter()
	response := postJSON(r, "/git/prune-remote", map[string]interface{}{
		"path": repo, "remote": "origin", "dryRun": true,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var dryRun struct {
		Removed []string `json:"removed"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &dryRun))
	require.Contains(t, dryRun.Removed, "origin/stale")
	require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/stale"), "dry-run must not mutate refs")
	response = postJSON(r, "/git/prune", map[string]string{"path": repo, "remote": "origin"})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var prune struct {
		Removed []string `json:"removed"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &prune))
	require.Contains(t, prune.Removed, "origin/stale")
	require.False(t, branchManagementHasRef(t, repo, "refs/remotes/origin/stale"))

	response = postJSON(r, "/git/delete-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "published",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.False(t, branchManagementHasRef(t, remote, "refs/heads/published"))
	require.True(t, branchManagementHasRef(t, remote, "refs/tags/published"), "remote branch deletion must preserve a same-named tag")
	require.False(t, branchManagementHasRef(t, repo, "refs/remotes/origin/published"))

	// Remote and branch values are validated before any network/ref mutation.
	response = postJSON(r, "/git/delete-remote-branch", map[string]string{
		"path": repo, "remote": "--all", "branch": "published",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	response = postJSON(r, "/git/delete-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "--all",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
}

func TestGitBranchManagementCheckoutRemoteCreatesTrackingBranchAndRestoresDirtyTree(t *testing.T) {
	repo, remote := setupBranchManagementRemote(t)
	baseBranch := runBranchManagementGit(t, repo, "branch", "--show-current")
	publisher := filepath.Join(filepath.Dir(repo), "publisher")
	runBranchManagementGit(t, filepath.Dir(repo), "clone", remote, publisher)
	runBranchManagementGit(t, publisher, "config", "user.name", "Publisher")
	runBranchManagementGit(t, publisher, "config", "user.email", "publisher@example.com")
	runBranchManagementGit(t, publisher, "checkout", "-b", "remote-only")
	require.NoError(t, os.WriteFile(filepath.Join(publisher, "remote.txt"), []byte("remote\n"), 0644))
	runBranchManagementGit(t, publisher, "add", "--", "remote.txt")
	runBranchManagementGit(t, publisher, "commit", "-m", "remote branch")
	runBranchManagementGit(t, publisher, "push", "-u", "origin", "HEAD")
	runBranchManagementGit(t, repo, "fetch", "origin")

	// The local branch is intentionally absent; only its remote-tracking ref
	// should be available to the endpoint.
	require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/remote-only"))
	require.False(t, branchManagementHasRef(t, repo, "refs/heads/remote-only"))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "keep-dirty.txt"), []byte("keep\n"), 0644))
	r, _ := setupRouter()
	response := postJSON(r, "/git/checkout-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "remote-only",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		OK            bool   `json:"ok"`
		Branch        string `json:"branch"`
		RemoteBranch  string `json:"remoteBranch"`
		Created       bool   `json:"created"`
		Stashed       bool   `json:"stashed"`
		StashConflict bool   `json:"stashConflict"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.True(t, payload.OK)
	require.Equal(t, "remote-only", payload.Branch)
	require.Equal(t, "remote-only", payload.RemoteBranch)
	require.True(t, payload.Created)
	require.True(t, payload.Stashed)
	require.False(t, payload.StashConflict)
	require.Equal(t, "origin", runBranchManagementGit(t, repo, "config", "--get", "branch.remote-only.remote"))
	require.Equal(t, "refs/heads/remote-only", runBranchManagementGit(t, repo, "config", "--get", "branch.remote-only.merge"))
	require.FileExists(t, filepath.Join(repo, "keep-dirty.txt"))
	require.Equal(t, "remote-only", runBranchManagementGit(t, repo, "branch", "--show-current"))

	// Existing local branches use the same endpoint and switch without making
	// a duplicate branch.
	runBranchManagementGit(t, repo, "checkout", baseBranch)
	response = postJSON(r, "/git/switch-remote-branch", map[string]string{
		"path": repo, "remoteBranch": "origin/remote-only",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	branches := runBranchManagementGit(t, repo, "branch", "--format=%(refname:short)")
	require.Equal(t, 1, strings.Count(branches, "remote-only"))
	require.Equal(t, "remote-only", runBranchManagementGit(t, repo, "branch", "--show-current"))

	// Missing refs and option-looking values are rejected before checkout or
	// stash mutation.
	runBranchManagementGit(t, repo, "checkout", baseBranch)
	response = postJSON(r, "/git/checkout-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "missing-remote",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	response = postJSON(r, "/git/checkout-remote-branch", map[string]string{
		"path": repo, "remote": "--all", "branch": "remote-only",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	response = postJSON(r, "/git/checkout-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "--detach",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
}

func TestGitBranchManagementCheckoutRemotePreservesStagedAndUnstagedChanges(t *testing.T) {
	repo, remote := setupBranchManagementRemote(t)
	require.NoError(t, os.WriteFile(filepath.Join(repo, "staged.txt"), []byte("base staged\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "unstaged.txt"), []byte("base unstaged\n"), 0644))
	runBranchManagementGit(t, repo, "add", "--", "staged.txt", "unstaged.txt")
	runBranchManagementGit(t, repo, "commit", "-m", "add status fixtures")
	runBranchManagementGit(t, repo, "push", "origin", "HEAD")

	publisher := filepath.Join(filepath.Dir(repo), "publisher-index")
	runBranchManagementGit(t, filepath.Dir(repo), "clone", remote, publisher)
	runBranchManagementGit(t, publisher, "config", "user.name", "Publisher")
	runBranchManagementGit(t, publisher, "config", "user.email", "publisher@example.com")
	runBranchManagementGit(t, publisher, "checkout", "-b", "remote-index")
	require.NoError(t, os.WriteFile(filepath.Join(publisher, "remote.txt"), []byte("remote\n"), 0644))
	runBranchManagementGit(t, publisher, "add", "--", "remote.txt")
	runBranchManagementGit(t, publisher, "commit", "-m", "remote index branch")
	runBranchManagementGit(t, publisher, "push", "-u", "origin", "HEAD")
	runBranchManagementGit(t, repo, "fetch", "origin")

	require.NoError(t, os.WriteFile(filepath.Join(repo, "staged.txt"), []byte("staged change\n"), 0644))
	runBranchManagementGit(t, repo, "add", "--", "staged.txt")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "unstaged.txt"), []byte("unstaged change\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("untracked change\n"), 0644))

	r, _ := setupRouter()
	response := postJSON(r, "/git/checkout-remote-branch", map[string]string{
		"path": repo, "remote": "origin", "branch": "remote-index",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		Branch        string `json:"branch"`
		Created       bool   `json:"created"`
		Stashed       bool   `json:"stashed"`
		StashConflict bool   `json:"stashConflict"`
		StashError    string `json:"stashError"`
		Status        struct {
			Files   []StructuredFile `json:"files"`
			Summary StatusSummary    `json:"summary"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, "remote-index", payload.Branch)
	require.True(t, payload.Created)
	require.True(t, payload.Stashed)
	require.False(t, payload.StashConflict)
	require.Empty(t, payload.StashError)
	require.Equal(t, StatusSummary{Changed: 3, Staged: 1, Unstaged: 2, Included: 3}, payload.Status.Summary)
	require.Len(t, payload.Status.Files, 3)

	require.Equal(t, "remote-index", runBranchManagementGit(t, repo, "branch", "--show-current"))
	require.Equal(t, "origin", runBranchManagementGit(t, repo, "config", "--get", "branch.remote-index.remote"))
	require.Equal(t, "refs/heads/remote-index", runBranchManagementGit(t, repo, "config", "--get", "branch.remote-index.merge"))
	require.Equal(t, "staged.txt", runBranchManagementGit(t, repo, "diff", "--cached", "--name-only"))
	require.Equal(t, "unstaged.txt", runBranchManagementGit(t, repo, "diff", "--name-only"))
	require.Equal(t, "untracked.txt", runBranchManagementGit(t, repo, "ls-files", "--others", "--exclude-standard"))
	require.Empty(t, runBranchManagementGit(t, repo, "stash", "list"))
}

func TestGitBranchManagementForceDeleteUnmergedBranch(t *testing.T) {
	repo := newRealGitRepo(t)
	commitRealFile(t, repo, "base.txt", "base\n", "base")
	baseBranch := runBranchManagementGit(t, repo, "branch", "--show-current")
	runBranchManagementGit(t, repo, "checkout", "-b", "unmerged")
	commitRealFile(t, repo, "unmerged.txt", "unmerged\n", "unmerged")
	runBranchManagementGit(t, repo, "checkout", baseBranch)

	r, _ := setupRouter()
	response := postJSON(r, "/git/delete-branch", map[string]interface{}{
		"path": repo, "branch": "unmerged",
	})
	require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
	require.True(t, branchManagementHasRef(t, repo, "refs/heads/unmerged"))
	response = postJSON(r, "/git/delete-branch", map[string]interface{}{
		"path": repo, "branch": "unmerged", "force": true,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.False(t, branchManagementHasRef(t, repo, "refs/heads/unmerged"))
	response = postJSON(r, "/git/delete-branch", map[string]interface{}{
		"path": repo, "branch": baseBranch, "force": true,
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
}

func TestGitBranchManagementParsesLongestConfiguredRemoteName(t *testing.T) {
	repo := newRealGitRepo(t)
	commitRealFile(t, repo, "base.txt", "base\n", "base")
	remote := filepath.Join(t.TempDir(), "remote.git")
	runBranchManagementGit(t, filepath.Dir(remote), "init", "--bare", remote)
	runBranchManagementGit(t, repo, "remote", "add", "upstream", remote)
	runBranchManagementGit(t, repo, "remote", "add", "team/origin", remote)

	remoteName, branch, ok := splitConfiguredRemoteBranch(repo, "team/origin/feature/topic")
	require.True(t, ok)
	require.Equal(t, "team/origin", remoteName)
	require.Equal(t, "feature/topic", branch)

	remoteName, branch, err := deleteRemoteBranchInputs(repo, DeleteRemoteBranchRequest{
		RemoteBranch: "team/origin/feature/topic",
	})
	require.NoError(t, err)
	require.Equal(t, "team/origin", remoteName)
	require.Equal(t, "feature/topic", branch)
}
