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

func TestGitReflogAndRecentBranches(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	baseBranch := runGitCommand(t, dir, "branch", "--show-current")
	runGitCommand(t, dir, "checkout", "-b", "history-feature")
	runGitCommand(t, dir, "checkout", baseBranch)

	w := postJSON(r, "/git/reflog", map[string]interface{}{
		"path":  dir,
		"ref":   "HEAD",
		"limit": 20,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var reflog GitReflogResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &reflog))
	require.NotEmpty(t, reflog.Entries)
	require.Equal(t, "HEAD", reflog.Ref)
	require.Equal(t, "checkout", reflog.Entries[0].Action)
	require.Contains(t, reflog.Entries[0].Message, "history-feature")
	require.Equal(t, "HEAD@{0}", reflog.Entries[0].Selector)
	require.NotEmpty(t, reflog.Entries[0].Date)

	w = postJSON(r, "/git/reflog", map[string]interface{}{
		"path": dir,
		"ref":  "refs/heads/does-not-exist",
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())

	w = postJSON(r, "/git/reflog", map[string]interface{}{
		"path":  dir,
		"all":   true,
		"limit": 100,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var allReflog GitReflogResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &allReflog))
	seenFeatureRef := false
	for _, entry := range allReflog.Entries {
		if strings.HasPrefix(entry.Ref, "refs/heads/") && strings.Contains(entry.Ref, "history-feature") {
			seenFeatureRef = true
		}
	}
	require.True(t, seenFeatureRef, "all reflog should include branch reflogs")

	w = postJSON(r, "/git/recent-branches", map[string]interface{}{"path": dir, "limit": 5})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var recent GitRecentBranchesResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &recent))
	require.NotEmpty(t, recent.Branches)
	require.Equal(t, "history-feature", recent.Branches[0].Name)
	require.True(t, recent.Branches[0].Exists)
	require.Contains(t, recent.RecentBranches, "history-feature")

	w = postJSON(r, "/git/branches", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var branches struct {
		RecentBranches []string `json:"recentBranches"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &branches))
	require.Contains(t, branches.RecentBranches, "history-feature")
}

func TestGitUnreachableCommitsAfterReset(t *testing.T) {
	dir := setupGitRepoWithMultipleCommits(t)
	defer os.RemoveAll(dir)
	r, _ := setupRouter()

	commits := runGitCommand(t, dir, "log", "--format=%H", "--reverse")
	shaList := strings.Fields(commits)
	require.Len(t, shaList, 3)
	runGitCommand(t, dir, "reset", "--hard", shaList[0])

	w := postJSON(r, "/git/unreachable-commits", map[string]interface{}{"path": dir, "limit": 10})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var response GitUnreachableCommitsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.GreaterOrEqual(t, response.Total, 2)
	require.NotEmpty(t, response.Commits)
	seen := map[string]bool{}
	for _, commit := range response.Commits {
		seen[commit.Hash] = true
		require.NotEmpty(t, commit.Message)
		require.NotNil(t, commit.Tags)
	}
	require.True(t, seen[shaList[1]], "second commit should be recoverable")
	require.True(t, seen[shaList[2]], "third commit should be recoverable")

	w = postJSON(r, "/git/unreachable-commits", map[string]interface{}{"path": dir, "limit": 1, "skip": 1})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var page GitUnreachableCommitsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &page))
	require.Len(t, page.Commits, 1)
	require.Equal(t, response.Total, page.Total)
}

func TestGitHistoryRecoveryUnbornAndValidation(t *testing.T) {
	dir := t.TempDir()
	runGitCommand(t, dir, "init")
	r, _ := setupRouter()

	w := postJSON(r, "/git/reflog", map[string]interface{}{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var reflog GitReflogResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &reflog))
	require.Empty(t, reflog.Entries)

	w = postJSON(r, "/git/recent-branches", map[string]interface{}{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var recent GitRecentBranchesResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &recent))
	require.Empty(t, recent.Branches)

	w = postJSON(r, "/git/unreachable-commits", map[string]interface{}{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var unreachable GitUnreachableCommitsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &unreachable))
	require.Empty(t, unreachable.Commits)

	w = postJSON(r, "/git/reflog", map[string]interface{}{"path": dir, "ref": "--all"})
	require.Equal(t, http.StatusBadRequest, w.Code)
	w = postJSON(r, "/git/reflog", map[string]interface{}{"path": dir, "ref": "refs/heads/does-not-exist"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	w = postJSON(r, "/git/reflog", map[string]interface{}{"path": dir, "limit": maxGitHistoryRecoveryLimit + 1})
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestGitReflogUsesEventDateInsteadOfCommitAuthorDate(t *testing.T) {
	dir := t.TempDir()
	runGitCommand(t, dir, "init")
	runGitCommand(t, dir, "config", "user.name", "Test")
	runGitCommand(t, dir, "config", "user.email", "test@example.com")
	file := filepath.Join(dir, "file.txt")
	require.NoError(t, os.WriteFile(file, []byte("initial\n"), 0644))
	runGitCommand(t, dir, "add", "file.txt")
	commit := exec.Command("git", "commit", "-m", "initial")
	commit.Dir = dir
	commit.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2001-02-03T04:05:06+0000", "GIT_COMMITTER_DATE=2001-02-03T04:05:06+0000")
	output, err := commit.CombinedOutput()
	require.NoError(t, err, string(output))

	checkout := exec.Command("git", "checkout", "-b", "history-event")
	checkout.Dir = dir
	checkout.Env = append(os.Environ(), "GIT_COMMITTER_DATE=2030-04-05T06:07:08+0000")
	output, err = checkout.CombinedOutput()
	require.NoError(t, err, string(output))

	r, _ := setupRouter()
	w := postJSON(r, "/git/reflog", map[string]interface{}{"path": dir, "limit": 10})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var response GitReflogResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.NotEmpty(t, response.Entries)
	// The checkout points at the old commit, so `%aI` would be 2001-02-03;
	// the event timestamp must come from the reflog committer date instead.
	require.Equal(t, "2030-04-05T06:07:08Z", response.Entries[0].Date)
	require.NotContains(t, response.Entries[0].Date, "2001-02-03")

	// The recent-branches compatibility view uses the same event timestamp.
	checkoutBack := exec.Command("git", "checkout", "--detach", "HEAD")
	checkoutBack.Dir = dir
	checkoutBack.Env = append(os.Environ(), "GIT_COMMITTER_DATE=2031-05-06T07:08:09+0000")
	output, err = checkoutBack.CombinedOutput()
	require.NoError(t, err, string(output))
	w = postJSON(r, "/git/recent-branches", map[string]interface{}{"path": dir, "limit": 5})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var recent GitRecentBranchesResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &recent))
	require.NotEmpty(t, recent.Branches)
	require.Equal(t, "history-event", recent.Branches[0].Name)
	require.Equal(t, "2030-04-05T06:07:08Z", recent.Branches[0].LastCheckout)
}
