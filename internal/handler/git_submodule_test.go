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

type gitSubmoduleListResponse struct {
	Submodules []GitSubmoduleEntry `json:"submodules"`
}

func TestParseSubmoduleStatusOutputPreservesPathsAndStatus(t *testing.T) {
	sha := strings.Repeat("a", 40)
	changedSHA := strings.Repeat("b", 40)
	output := " " + sha + " dir with space/sub module (heads/master)\n" +
		"-" + sha + " nested path with space\n" +
		"+" + changedSHA + " path with space (tag~1)\n"

	entries := parseSubmoduleStatusOutput(output)
	require.Len(t, entries, 3)

	require.Equal(t, GitSubmoduleEntry{
		Path:     "dir with space/sub module",
		IndexSHA: sha,
		Describe: "heads/master",
		Status: GitSubmoduleStatus{
			Initialized: true,
		},
	}, entries[0])
	require.Equal(t, GitSubmoduleEntry{
		Path:     "nested path with space",
		IndexSHA: sha,
		Status: GitSubmoduleStatus{
			Initialized: false,
		},
	}, entries[1])
	require.Equal(t, GitSubmoduleEntry{
		Path:     "path with space",
		IndexSHA: changedSHA,
		Describe: "tag~1",
		Status: GitSubmoduleStatus{
			Initialized:   true,
			CommitChanged: true,
		},
	}, entries[2])
}

func setupRealSubmoduleRepo(t *testing.T) (string, string) {
	t.Helper()
	submodule := newRealGitRepo(t)
	commitRealFile(t, submodule, "README.md", "base\n", "submodule base")

	parent := newRealGitRepo(t)
	runRealGit(t, parent, "-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor/submodule")
	runRealGit(t, parent, "commit", "-m", "add submodule")
	return parent, submodule
}

func TestGitSubmoduleListStatusAndDiff(t *testing.T) {
	parent, submodule := setupRealSubmoduleRepo(t)
	r, _ := setupRouter()

	w := postJSON(r, "/git/submodules", map[string]string{"path": parent})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var listed gitSubmoduleListResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listed))
	require.Len(t, listed.Submodules, 1)
	require.Equal(t, "vendor/submodule", listed.Submodules[0].Path)
	require.Equal(t, submodule, listed.Submodules[0].URL)
	require.True(t, listed.Submodules[0].Status.Initialized)
	require.Equal(t, listed.Submodules[0].IndexSHA, listed.Submodules[0].SHA)

	require.NoError(t, os.WriteFile(filepath.Join(parent, "vendor", "submodule", "README.md"), []byte("dirty\n"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(parent, "vendor", "submodule", "untracked.txt"), []byte("new\n"), 0600))

	w = postJSON(r, "/git/status", map[string]string{"path": parent})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var status struct {
		Files []StructuredFile `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &status))
	require.Len(t, status.Files, 1)
	require.NotNil(t, status.Files[0].Submodule)
	require.True(t, status.Files[0].Submodule.ModifiedChanges)
	require.True(t, status.Files[0].Submodule.UntrackedChanges)
	require.False(t, status.Files[0].Submodule.CommitChanged)

	w = postJSON(r, "/git/file-diff", map[string]string{"path": parent, "filePath": "vendor/submodule"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diff InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diff))
	require.Equal(t, "submodule", diff.Kind)
	require.NotNil(t, diff.Submodule)
	require.False(t, diff.Capability.LineSelectable)
	require.Contains(t, diff.Patch, "Subproject commit")
	require.Equal(t, diff.Submodule.OldSHA, diff.Submodule.NewSHA)
	require.True(t, diff.Submodule.Status.ModifiedChanges)
	require.True(t, diff.Submodule.Status.UntrackedChanges)
}

func TestGitSubmoduleCommitChangeAndReset(t *testing.T) {
	parent, submodule := setupRealSubmoduleRepo(t)
	r, _ := setupRouter()

	commitRealFile(t, filepath.Join(parent, "vendor", "submodule"), "second.txt", "second\n", "submodule second")
	newSHA := runRealGit(t, filepath.Join(parent, "vendor", "submodule"), "rev-parse", "HEAD")

	w := postJSON(r, "/git/status", map[string]string{"path": parent})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var status struct {
		Files []StructuredFile `json:"files"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &status))
	require.Len(t, status.Files, 1)
	require.True(t, status.Files[0].Submodule.CommitChanged)

	w = postJSON(r, "/git/file-diff", map[string]string{"path": parent, "filePath": "vendor/submodule"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diff InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diff))
	require.NotNil(t, diff.Submodule)
	require.NotNil(t, diff.Submodule.OldSHA)
	require.NotNil(t, diff.Submodule.NewSHA)
	require.Equal(t, newSHA, *diff.Submodule.NewSHA)
	require.NotEqual(t, *diff.Submodule.OldSHA, *diff.Submodule.NewSHA)

	// A forced reset restores the nested checkout to the parent gitlink.
	w = postJSON(r, "/git/submodules-reset", map[string]interface{}{
		"path": parent, "paths": []string{"vendor/submodule"}, "allowFileProtocol": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, strings.TrimSpace(runRealGit(t, submodule, "rev-parse", "HEAD")), strings.TrimSpace(runRealGit(t, parent+"/vendor/submodule", "rev-parse", "HEAD")))

	w = postJSON(r, "/git/status", map[string]string{"path": parent})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &status))
	require.Empty(t, status.Files)
}

func TestGitSubmoduleInitializeAndPathValidation(t *testing.T) {
	parent, _ := setupRealSubmoduleRepo(t)
	r, _ := setupRouter()
	runRealGit(t, parent, "submodule", "deinit", "-f", "--", "vendor/submodule")

	w := postJSON(r, "/git/submodules", map[string]string{"path": parent})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var listed gitSubmoduleListResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listed))
	require.Len(t, listed.Submodules, 1)
	require.False(t, listed.Submodules[0].Status.Initialized)

	w = postJSON(r, "/git/submodules-update", map[string]interface{}{
		"path": parent, "paths": []string{"vendor/submodule"}, "allowFileProtocol": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.FileExists(t, filepath.Join(parent, "vendor", "submodule", "README.md"))

	w = postJSON(r, "/git/submodules-update", map[string]interface{}{
		"path": parent, "paths": []string{"../outside"}, "allowFileProtocol": true,
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

func TestGitSubmoduleHistoricalURLHandlesQuotedSpacesAndRedactsCredentials(t *testing.T) {
	repo := newRealGitRepo(t)
	// Git emits a quoted subsection containing spaces from this config. The
	// historical lookup must split the --null --get-regexp record at its
	// key/value newline rather than at the first space.
	runRealGit(t, repo, "config", "-f", ".gitmodules", "submodule.foo bar.path", "path with space")
	runRealGit(t, repo, "config", "-f", ".gitmodules", "submodule.foo bar.url", "https://user:secret@example.com/owner/repo.git")
	runRealGit(t, repo, "add", ".gitmodules")
	runRealGit(t, repo, "commit", "-m", "gitmodules")

	got := gitSubmoduleURL(repo, "HEAD", "path with space")
	require.Equal(t, "https://example.com/owner/repo.git", got)
}
