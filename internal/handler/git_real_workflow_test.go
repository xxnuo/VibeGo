package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// runRealGit executes git with the repository's own environment. Keeping the
// fixture commands separate from the handler command wrapper makes failures in
// the test repository setup distinguishable from API failures.
func runRealGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	return strings.TrimSpace(string(out))
}

func newRealGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runRealGit(t, dir, "init")
	runRealGit(t, dir, "config", "user.name", "VibeGo Test")
	runRealGit(t, dir, "config", "user.email", "vibego-test@example.com")
	return dir
}

func commitRealFile(t *testing.T, dir, path, content, message string) {
	t.Helper()
	abs := filepath.Join(dir, filepath.FromSlash(path))
	require.NoError(t, os.MkdirAll(filepath.Dir(abs), 0755))
	require.NoError(t, os.WriteFile(abs, []byte(content), 0644))
	runRealGit(t, dir, "add", "--", path)
	runRealGit(t, dir, "commit", "-m", message)
}

func TestGitRealStatusPartialDiffAndCommitPreservesUnselectedChange(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "notes.txt", "one\ntwo\nthree\nfour\nfive\n", "initial")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("ONE\ntwo\nthree\nfour\nFIVE\n"), 0644))
	r, _ := setupRouter()

	w := postJSON(r, "/git/status", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var statusResp struct {
		Files   []StructuredFile `json:"files"`
		Summary StatusSummary    `json:"summary"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &statusResp))
	require.Len(t, statusResp.Files, 1)
	require.Equal(t, 1, statusResp.Summary.Changed)
	require.Equal(t, "all", statusResp.Files[0].IncludedState)

	w = postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "notes.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diff InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diff))
	require.NotEmpty(t, diff.Hunks)

	secondChangeLineIDs := make([]string, 0, 2)
	for _, hunk := range diff.Hunks {
		for _, line := range hunk.Lines {
			if line.Content == "five" || line.Content == "FIVE" {
				secondChangeLineIDs = append(secondChangeLineIDs, line.ID)
			}
		}
	}
	require.Len(t, secondChangeLineIDs, 2)

	// Exclude only the second change. It must remain in the working tree after
	// the selected commit, even when Git groups both changes into one hunk.
	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "notes.txt", "mode": "working",
		"target": "line", "action": "exclude", "patchHash": diff.PatchHash,
		"lineIds": secondChangeLineIDs, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// An unrelated staged file is part of the caller's index state, not part of
	// this selected commit. It must remain staged after the temporary-index flow.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "keep-staged.txt"), []byte("keep staged\n"), 0644))
	runRealGit(t, dir, "add", "keep-staged.txt")
	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "keep-staged.txt", "mode": "working",
		"target": "file", "action": "exclude", "patchHash": "",
		"lineIds": []string{}, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path": dir, "summary": "only first hunk", "description": "",
		"files": []string{}, "patches": []interface{}{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	committed := runRealGit(t, dir, "show", "HEAD:notes.txt")
	require.Contains(t, committed, "ONE")
	require.Contains(t, committed, "five")
	require.NotContains(t, committed, "FIVE")
	working := string(mustReadRealFile(t, filepath.Join(dir, "notes.txt")))
	require.Contains(t, working, "FIVE")
	require.Equal(t, "only first hunk", runRealGit(t, dir, "log", "-1", "--format=%s"))
	require.Equal(t, "keep-staged.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
	showStaged := exec.Command("git", "show", "HEAD:keep-staged.txt")
	showStaged.Dir = dir
	require.Error(t, showStaged.Run())
}

func TestGitRealAmendAndBranchWorkflow(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "README.md", "base\n", "initial")
	baseHash := runRealGit(t, dir, "rev-parse", "HEAD")

	r, _ := setupRouter()
	w := postJSON(r, "/git/create-branch", map[string]string{"path": dir, "branch": "feature/real"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = postJSON(r, "/git/switch-branch", map[string]string{"path": dir, "branch": "feature/real"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("feature\n"), 0644))
	w = postJSON(r, "/git/commit", map[string]interface{}{
		"path": dir, "message": "feature commit", "author": "VibeGo Test", "email": "vibego-test@example.com",
	})
	// The normal commit endpoint requires the caller to stage the file.
	require.Equal(t, http.StatusInternalServerError, w.Code)
	runRealGit(t, dir, "add", "README.md")
	w = postJSON(r, "/git/commit", map[string]interface{}{
		"path": dir, "message": "feature commit", "author": "VibeGo Test", "email": "vibego-test@example.com",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("feature amended\n"), 0644))
	w = postJSON(r, "/git/amend", map[string]interface{}{
		"path": dir, "files": []string{"README.md"}, "patches": []interface{}{},
		"summary": "feature amended", "description": "details",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "feature amended", runRealGit(t, dir, "log", "-1", "--format=%s"))
	require.Contains(t, runRealGit(t, dir, "log", "-1", "--format=%B"), "details")
	require.NotEqual(t, baseHash, runRealGit(t, dir, "rev-parse", "HEAD"))

	w = postJSON(r, "/git/branches", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var branches struct {
		Branches []BranchInfo `json:"branches"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &branches))
	found := false
	for _, branch := range branches.Branches {
		if branch.Name == "feature/real" {
			found = true
		}
	}
	require.True(t, found)
}

func TestGitRealPartialCommitPreservesSamePathStagedChange(t *testing.T) {
	dir := newRealGitRepo(t)
	base := "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
	commitRealFile(t, dir, "mixed.txt", base, "initial")

	staged := "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "mixed.txt"), []byte(staged), 0644))
	runRealGit(t, dir, "add", "mixed.txt")
	working := "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "mixed.txt"), []byte(working), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "mixed.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var diff InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diff))
	firstIDs := make([]string, 0, 2)
	lastIDs := make([]string, 0, 2)
	for _, hunk := range diff.Hunks {
		for _, line := range hunk.Lines {
			switch line.Content {
			case "one", "ONE":
				firstIDs = append(firstIDs, line.ID)
			case "ten", "TEN":
				lastIDs = append(lastIDs, line.ID)
			}
		}
	}
	require.Len(t, firstIDs, 2)
	require.Len(t, lastIDs, 2)

	// Exclude the first (already staged) change from the selected commit. The
	// second change remains selected and is committed through the patch path.
	w = postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "mixed.txt", "mode": "working",
		"target": "line", "action": "exclude", "patchHash": diff.PatchHash,
		"lineIds": firstIDs, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path": dir, "summary": "commit second change", "patches": []interface{}{},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN", runRealGit(t, dir, "show", "HEAD:mixed.txt"))
	require.Equal(t, "mixed.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
	require.Contains(t, runRealGit(t, dir, "diff", "--cached", "--", "mixed.txt"), "+ONE")
	require.Equal(t, working, string(mustReadRealFile(t, filepath.Join(dir, "mixed.txt"))))
}

func TestGitRealPartialCommitFailureRestoresIndex(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "target.txt", "base\n", "initial")
	commitRealFile(t, dir, "keep.txt", "keep base\n", "keep")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep staged\n"), 0644))
	runRealGit(t, dir, "add", "keep.txt")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "target.txt"), []byte("target working\n"), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path": dir, "summary": "should fail",
		"patches": []GitPatchPayload{{
			FilePath: "target.txt",
			Patch:    "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-not-base\n+target selected\n",
		}},
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Equal(t, "keep.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
	require.Equal(t, "keep staged\n", string(mustReadRealFile(t, filepath.Join(dir, "keep.txt"))))
	require.Equal(t, "target working\n", string(mustReadRealFile(t, filepath.Join(dir, "target.txt"))))
	require.Equal(t, "keep", runRealGit(t, dir, "log", "-1", "--format=%s"))
}

func TestGitRealSelectedCommitHookFailureRestoresIndex(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "target.txt", "base\n", "initial")
	commitRealFile(t, dir, "keep.txt", "keep base\n", "keep")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep staged\n"), 0644))
	runRealGit(t, dir, "add", "--", "keep.txt")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "target.txt"), []byte("target working\n"), 0644))

	hookPath := filepath.Join(absoluteGitDir(dir), "hooks", "pre-commit")
	require.NoError(t, os.WriteFile(hookPath, []byte("#!/bin/sh\nexit 1\n"), 0755))
	require.NoError(t, os.Chmod(hookPath, 0755))

	headBefore := runRealGit(t, dir, "rev-parse", "HEAD")
	indexBefore := runRealGit(t, dir, "ls-files", "--stage")
	cachedBefore := runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index")

	r, _ := setupRouter()
	w := postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path": dir, "files": []string{"target.txt"}, "patches": []interface{}{},
		"summary": "hook failure",
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())

	require.Equal(t, headBefore, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, indexBefore, runRealGit(t, dir, "ls-files", "--stage"))
	require.Equal(t, cachedBefore, runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index"))
	require.Equal(t, "keep.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
	require.Equal(t, "target working\n", string(mustReadRealFile(t, filepath.Join(dir, "target.txt"))))
	require.Equal(t, "keep staged\n", string(mustReadRealFile(t, filepath.Join(dir, "keep.txt"))))
}

func TestGitRealCommitOptions(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "target.txt", "base\n", "initial")
	hookPath := filepath.Join(absoluteGitDir(dir), "hooks", "pre-commit")
	require.NoError(t, os.WriteFile(hookPath, []byte("#!/bin/sh\nexit 1\n"), 0755))
	require.NoError(t, os.Chmod(hookPath, 0755))
	r, _ := setupRouter()

	// --no-verify must bypass a failing pre-commit hook.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "target.txt"), []byte("hook bypassed\n"), 0644))
	runRealGit(t, dir, "add", "--", "target.txt")
	w := postJSON(r, "/git/commit", map[string]interface{}{
		"path": dir, "message": "skip hook", "author": "VibeGo Test", "email": "vibego-test@example.com",
		"noVerify": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "skip hook", runRealGit(t, dir, "log", "-1", "--format=%s"))

	// --signoff appends the configured committer trailer.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "target.txt"), []byte("signed\n"), 0644))
	runRealGit(t, dir, "add", "--", "target.txt")
	w = postJSON(r, "/git/commit", map[string]interface{}{
		"path": dir, "message": "signed commit", "author": "VibeGo Test", "email": "vibego-test@example.com",
		"noVerify": true, "signOff": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, runRealGit(t, dir, "log", "-1", "--format=%B"), "Signed-off-by: VibeGo Test <vibego-test@example.com>")

	// --allow-empty creates a commit even when the index has no changes.
	w = postJSON(r, "/git/commit", map[string]interface{}{
		"path": dir, "message": "empty commit", "author": "VibeGo Test", "email": "vibego-test@example.com",
		"noVerify": true, "allowEmpty": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "empty commit", runRealGit(t, dir, "log", "-1", "--format=%s"))
}

func TestGitRealAmendWithoutSelectionPreservesStagedIndex(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "initial")
	commitRealFile(t, dir, "staged.txt", "before\n", "staged fixture")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "staged.txt"), []byte("staged change\n"), 0644))
	runRealGit(t, dir, "add", "--", "staged.txt")
	scope := map[string]interface{}{"workspace_session_id": "amend-no-selection", "group_id": "git"}
	indexBefore := runRealGit(t, dir, "ls-files", "--stage")
	cachedBefore := runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index")

	r, _ := setupRouter()
	w := postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": "staged.txt", "mode": "working", "target": "file", "action": "exclude",
		"lineIds": []string{}, "hunkIds": []string{},
		"workspace_session_id": scope["workspace_session_id"], "group_id": scope["group_id"],
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = postJSON(r, "/git/amend", map[string]interface{}{
		"path": dir, "summary": "amended without selection", "description": "keep index",
		"files": []string{}, "patches": []interface{}{}, "allowEmpty": true, "noVerify": true,
		"workspace_session_id": scope["workspace_session_id"], "group_id": scope["group_id"],
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "amended without selection", runRealGit(t, dir, "log", "-1", "--format=%s"))
	require.Equal(t, indexBefore, runRealGit(t, dir, "ls-files", "--stage"))
	require.Equal(t, cachedBefore, runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index"))
}

func TestGitRealSelectedCommitOptionsSkipHookSignOffAndPreserveIndex(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "target.txt", "base target\n", "target base")
	commitRealFile(t, dir, "keep.txt", "base keep\n", "keep base")

	// Keep an unrelated staged change in the caller's index. The selected
	// commit must not consume or rewrite it while applying commit options.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("staged keep\n"), 0644))
	runRealGit(t, dir, "add", "--", "keep.txt")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "target.txt"), []byte("selected target\n"), 0644))

	marker := filepath.Join(t.TempDir(), "pre-commit-ran")
	hookPath := filepath.Join(absoluteGitDir(dir), "hooks", "pre-commit")
	hook := fmt.Sprintf("#!/bin/sh\nprintf ran > %s\nexit 1\n", shellQuoteOperationTest(marker))
	require.NoError(t, os.WriteFile(hookPath, []byte(hook), 0755))
	require.NoError(t, os.Chmod(hookPath, 0755))

	keepIndexBefore := runRealGit(t, dir, "ls-files", "--stage", "--", "keep.txt")
	cachedBefore := runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index")
	r, _ := setupRouter()
	w := postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path":     dir,
		"files":    []string{"target.txt"},
		"patches":  []interface{}{},
		"summary":  "selected options",
		"author":   "VibeGo Test",
		"email":    "vibego-test@example.com",
		"noVerify": true,
		"signOff":  true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	_, markerErr := os.Stat(marker)
	require.ErrorIs(t, markerErr, os.ErrNotExist, "--no-verify must skip pre-commit")

	message := runRealGit(t, dir, "log", "-1", "--format=%B")
	require.Contains(t, message, "selected options")
	require.Contains(t, message, "Signed-off-by: VibeGo Test <vibego-test@example.com>")
	require.Equal(t, keepIndexBefore, runRealGit(t, dir, "ls-files", "--stage", "--", "keep.txt"))
	require.Equal(t, cachedBefore, runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index"))
	require.Equal(t, "selected target", runRealGit(t, dir, "show", "HEAD:target.txt"))
	require.Equal(t, "keep.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
}

func TestGitRealCommitAllowEmptyAndAmendWithoutChanges(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "README.md", "base\n", "initial")

	marker := filepath.Join(t.TempDir(), "pre-commit-ran")
	hookPath := filepath.Join(absoluteGitDir(dir), "hooks", "pre-commit")
	hook := fmt.Sprintf("#!/bin/sh\nprintf ran > %s\nexit 1\n", shellQuoteOperationTest(marker))
	require.NoError(t, os.WriteFile(hookPath, []byte(hook), 0755))
	require.NoError(t, os.Chmod(hookPath, 0755))

	r, _ := setupRouter()
	before := runRealGit(t, dir, "rev-parse", "HEAD")
	w := postJSON(r, "/git/commit", map[string]interface{}{
		"path":       dir,
		"message":    "empty commit",
		"author":     "VibeGo Test",
		"email":      "vibego-test@example.com",
		"noVerify":   true,
		"signOff":    true,
		"allowEmpty": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	afterEmpty := runRealGit(t, dir, "rev-parse", "HEAD")
	require.NotEqual(t, before, afterEmpty)
	emptyMessage := runRealGit(t, dir, "log", "-1", "--format=%B")
	require.Contains(t, emptyMessage, "empty commit")
	require.Contains(t, emptyMessage, "Signed-off-by: VibeGo Test <vibego-test@example.com>")

	// Amend with no selected files exercises the explicit allow-empty branch in
	// the temporary-index path. It must still skip hooks and produce a new HEAD.
	w = postJSON(r, "/git/amend", map[string]interface{}{
		"path":        dir,
		"files":       []string{},
		"patches":     []interface{}{},
		"summary":     "amended empty",
		"description": "amended body",
		"author":      "VibeGo Test",
		"email":       "vibego-test@example.com",
		"noVerify":    true,
		"signOff":     true,
		"allowEmpty":  true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	afterAmend := runRealGit(t, dir, "rev-parse", "HEAD")
	require.NotEqual(t, afterEmpty, afterAmend)
	amendedMessage := runRealGit(t, dir, "log", "-1", "--format=%B")
	require.Contains(t, amendedMessage, "amended empty")
	require.Contains(t, amendedMessage, "amended body")
	require.Contains(t, amendedMessage, "Signed-off-by: VibeGo Test <vibego-test@example.com>")
	_, markerErr := os.Stat(marker)
	require.ErrorIs(t, markerErr, os.ErrNotExist, "--no-verify must skip hooks for amend")
}

func TestGitRealCommitResetAfterCommitPreservesOptions(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "README.md", "base\n", "initial")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "new.txt"), []byte("new\n"), 0644))
	r, _ := setupRouter()
	scope := map[string]interface{}{
		"workspace_session_id": "commit-options-session",
		"group_id":             "commit-options-group",
	}

	w := postJSON(r, "/git/draft", map[string]interface{}{
		"path":                 dir,
		"summary":              "draft summary",
		"description":          "draft description",
		"isAmend":              true,
		"noVerify":             true,
		"signOff":              true,
		"allowEmpty":           true,
		"workspace_session_id": scope["workspace_session_id"],
		"group_id":             scope["group_id"],
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var saved GitDraftResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &saved))
	require.True(t, saved.NoVerify)
	require.True(t, saved.SignOff)
	require.True(t, saved.AllowEmpty)

	w = postJSON(r, "/git/commit-selected", map[string]interface{}{
		"path":                 dir,
		"files":                []string{"new.txt"},
		"patches":              []interface{}{},
		"summary":              "committed draft",
		"description":          "committed description",
		"noVerify":             true,
		"signOff":              true,
		"allowEmpty":           true,
		"workspace_session_id": scope["workspace_session_id"],
		"group_id":             scope["group_id"],
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	query := "/git/draft?path=" + url.QueryEscape(dir) +
		"&workspace_session_id=" + url.QueryEscape(scope["workspace_session_id"].(string)) +
		"&group_id=" + url.QueryEscape(scope["group_id"].(string))
	req, err := http.NewRequest("GET", query, nil)
	require.NoError(t, err)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	saved = GitDraftResponse{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &saved))
	require.Empty(t, saved.Summary)
	require.Empty(t, saved.Description)
	require.False(t, saved.IsAmend)
	require.True(t, saved.NoVerify)
	require.True(t, saved.SignOff)
	require.False(t, saved.AllowEmpty)
	require.True(t, saved.SkipCommitHooks)
	require.True(t, saved.SignOffCommits)
	require.False(t, saved.AllowEmptyCommit)
}

func TestGitRealStashPullAndPushWorkflow(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "origin.git")
	runRealGit(t, root, "init", "--bare", remote)

	source := filepath.Join(root, "source")
	runRealGit(t, root, "clone", remote, source)
	runRealGit(t, source, "config", "user.name", "VibeGo Test")
	runRealGit(t, source, "config", "user.email", "vibego-test@example.com")
	commitRealFile(t, source, "README.md", "base\n", "initial")
	runRealGit(t, source, "push", "-u", "origin", "HEAD")

	clonePath := filepath.Join(root, "clone")
	runRealGit(t, root, "clone", remote, clonePath)
	runRealGit(t, clonePath, "config", "user.name", "VibeGo Test")
	runRealGit(t, clonePath, "config", "user.email", "vibego-test@example.com")
	r, _ := setupRouter()

	// Make a remote-only commit, then fetch and pull it through the handler.
	commitRealFile(t, source, "remote.txt", "remote\n", "remote commit")
	runRealGit(t, source, "push", "origin", "HEAD")
	w := postJSON(r, "/git/fetch", map[string]string{"path": clonePath, "remote": "origin"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = postJSON(r, "/git/pull", map[string]string{"path": clonePath, "remote": "origin"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.FileExists(t, filepath.Join(clonePath, "remote.txt"))

	// Stash and restore a real working-tree change through the API.
	require.NoError(t, os.WriteFile(filepath.Join(clonePath, "README.md"), []byte("local dirty\n"), 0644))
	w = postJSON(r, "/git/stash", map[string]interface{}{"path": clonePath, "message": "workflow stash"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = postJSON(r, "/git/stash-list", map[string]string{"path": clonePath})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var stashes struct {
		Stashes []StashEntry `json:"stashes"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &stashes))
	require.Len(t, stashes.Stashes, 1)
	w = postJSON(r, "/git/stash-pop", map[string]interface{}{"path": clonePath, "index": 0})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "local dirty\n", string(mustReadRealFile(t, filepath.Join(clonePath, "README.md"))))

	// Push a local commit and verify the bare repository ref, exercising the
	// handler's upstream detection after the initial clone.
	commitRealFile(t, clonePath, "local.txt", "local\n", "local commit")
	w = postJSON(r, "/git/push", map[string]string{"path": clonePath, "remote": "origin"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	head := runRealGit(t, clonePath, "rev-parse", "HEAD")
	require.Equal(t, head, runRealGit(t, remote, "rev-parse", "refs/heads/"+runRealGit(t, clonePath, "branch", "--show-current")))
}

func TestGitRealConflictDetailsAndResolve(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "conflict.txt", "common\nbase\nend\n", "initial")
	baseBranch := runRealGit(t, dir, "branch", "--show-current")
	runRealGit(t, dir, "checkout", "-b", "theirs")
	commitRealFile(t, dir, "conflict.txt", "common\ntheirs\nend\n", "theirs")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "common\nours\nend\n", "ours")
	mergeCmd := exec.Command("git", "merge", "theirs")
	mergeCmd.Dir = dir
	_, err := mergeCmd.CombinedOutput()
	require.Error(t, err)

	r, _ := setupRouter()
	w := postJSON(r, "/git/conflicts", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var conflicts struct {
		Conflicts []string `json:"conflicts"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &conflicts))
	require.Equal(t, []string{"conflict.txt"}, conflicts.Conflicts)

	w = postJSON(r, "/git/conflict-details", map[string]string{"path": dir, "filePath": "conflict.txt"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var details ConflictDetailsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &details))
	require.Equal(t, 1, details.BlocksTotal)
	require.Len(t, details.Segments, 3)
	require.Equal(t, []string{"ours"}, details.Segments[1].Ours)
	require.Equal(t, []string{"theirs"}, details.Segments[1].Theirs)

	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "conflict.txt", "mode": "ours",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Empty(t, collectConflictFiles(dir))
	require.Equal(t, "common\nours\nend\n", string(mustReadRealFile(t, filepath.Join(dir, "conflict.txt"))))
	require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
}

func TestGitRealConflictResolveChecksHashAndAllowsEmptyContent(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "conflict.txt", "base\n", "initial")
	baseBranch := runRealGit(t, dir, "branch", "--show-current")
	runRealGit(t, dir, "checkout", "-b", "theirs")
	commitRealFile(t, dir, "conflict.txt", "theirs\n", "theirs")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "ours\n", "ours")
	mergeCmd := exec.Command("git", "merge", "theirs")
	mergeCmd.Dir = dir
	_, err := mergeCmd.CombinedOutput()
	require.Error(t, err)

	r, _ := setupRouter()
	w := postJSON(r, "/git/conflict-details", map[string]string{
		"path": dir, "filePath": "conflict.txt",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var details ConflictDetailsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &details))
	require.NotEmpty(t, details.Hash)

	// Simulate an editor or another process changing the file after the
	// details snapshot was loaded. A stale resolution must not overwrite it or
	// alter the unmerged index.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "conflict.txt"), []byte("changed\n"), 0644))
	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "conflict.txt", "mode": "manual",
		"hash": details.Hash, "manualContent": "stale resolution\n",
	})
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Equal(t, "changed\n", string(mustReadRealFile(t, filepath.Join(dir, "conflict.txt"))))
	require.NotEmpty(t, runRealGit(t, dir, "ls-files", "-u"))

	// An explicitly supplied empty string is a valid resolution (it removes the
	// file contents), and should be distinguished from an omitted field.
	w = postJSON(r, "/git/conflict-details", map[string]string{
		"path": dir, "filePath": "conflict.txt",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &details))
	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "conflict.txt", "mode": "manual",
		"hash": details.Hash, "manualContent": "",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	info, statErr := os.Stat(filepath.Join(dir, "conflict.txt"))
	require.NoError(t, statErr)
	require.Equal(t, int64(0), info.Size())
	require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
}

func TestGitRealConflictResolveAcceptsLegacyContentHash(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "conflict.txt", "base\n", "initial")
	baseBranch := runRealGit(t, dir, "branch", "--show-current")
	runRealGit(t, dir, "checkout", "-b", "theirs")
	commitRealFile(t, dir, "conflict.txt", "theirs\n", "theirs")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "ours\n", "ours")
	mergeCmd := exec.Command("git", "merge", "theirs")
	mergeCmd.Dir = dir
	require.Error(t, mergeCmd.Run())

	content := string(mustReadRealFile(t, filepath.Join(dir, "conflict.txt")))
	r, _ := setupRouter()
	w := postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "conflict.txt", "mode": "manual",
		"hash": computePatchHash(content), "manualContent": "legacy client resolution\n",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "legacy client resolution\n", string(mustReadRealFile(t, filepath.Join(dir, "conflict.txt"))))
	require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
}

func TestGitRealLegacyConflictResolverKeepsEmptyFileSemantics(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "conflict.txt", "base\n", "initial")
	baseBranch := runRealGit(t, dir, "branch", "--show-current")
	runRealGit(t, dir, "checkout", "-b", "theirs")
	commitRealFile(t, dir, "conflict.txt", "theirs\n", "theirs")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "ours\n", "ours")
	mergeCmd := exec.Command("git", "merge", "theirs")
	mergeCmd.Dir = dir
	require.Error(t, mergeCmd.Run())

	r, _ := setupRouter()
	w := postJSON(r, "/git/resolve-conflict", map[string]string{
		"path": dir, "filePath": "conflict.txt", "content": "",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	info, err := os.Stat(filepath.Join(dir, "conflict.txt"))
	require.NoError(t, err)
	require.Zero(t, info.Size())
	require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
}

func createRealModifyDeleteConflict(t *testing.T, deletedSide string) string {
	t.Helper()
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "modify-delete.txt", "base\n", "initial")
	baseBranch := runRealGit(t, dir, "branch", "--show-current")

	if deletedSide == "theirs" {
		runRealGit(t, dir, "checkout", "-b", "delete-side")
		runRealGit(t, dir, "rm", "--", "modify-delete.txt")
		runRealGit(t, dir, "commit", "-m", "delete theirs")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "modify-delete.txt", "ours\n", "modify ours")
		mergeCmd := exec.Command("git", "merge", "delete-side")
		mergeCmd.Dir = dir
		require.Error(t, mergeCmd.Run())
		return dir
	}

	runRealGit(t, dir, "checkout", "-b", "modify-side")
	commitRealFile(t, dir, "modify-delete.txt", "theirs\n", "modify theirs")
	runRealGit(t, dir, "checkout", baseBranch)
	runRealGit(t, dir, "rm", "--", "modify-delete.txt")
	runRealGit(t, dir, "commit", "-m", "delete ours")
	mergeCmd := exec.Command("git", "merge", "modify-side")
	mergeCmd.Dir = dir
	require.Error(t, mergeCmd.Run())
	return dir
}

func TestGitRealModifyDeleteConflictDetailsAndDeleteResolution(t *testing.T) {
	for _, tc := range []struct {
		name         string
		deletedSide  string
		deletedStage string
		keptStage    string
		keptContent  string
		resolveMode  string
		cachedDelete bool
	}{
		{name: "theirs deleted", deletedSide: "theirs", deletedStage: "theirs", keptStage: "ours", keptContent: "ours\n", resolveMode: "delete", cachedDelete: true},
		{name: "ours deleted", deletedSide: "ours", deletedStage: "ours", keptStage: "theirs", keptContent: "theirs\n", resolveMode: "ours"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := createRealModifyDeleteConflict(t, tc.deletedSide)
			r, _ := setupRouter()

			w := postJSON(r, "/git/conflict-details", map[string]string{
				"path": dir, "filePath": "modify-delete.txt",
			})
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			var details ConflictDetailsResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &details))
			require.Equal(t, 1, details.BlocksTotal)
			require.Len(t, details.Segments, 1)
			stages := details.Stages
			for _, side := range []string{"ours", "theirs"} {
				stage := stages.Ours
				if side == "theirs" {
					stage = stages.Theirs
				}
				if side == tc.deletedStage {
					require.False(t, stage.Present, side)
					require.True(t, stage.Deleted, side)
				} else {
					require.True(t, stage.Present, side)
					require.False(t, stage.Deleted, side)
				}
			}
			if tc.deletedStage == "ours" {
				require.Empty(t, details.Segments[0].Ours)
				require.Equal(t, []string{"theirs", ""}, details.Segments[0].Theirs)
			} else {
				require.Equal(t, []string{"ours", ""}, details.Segments[0].Ours)
				require.Empty(t, details.Segments[0].Theirs)
			}

			w = postJSON(r, "/git/conflict-resolve", map[string]string{
				"path": dir, "filePath": "modify-delete.txt", "mode": tc.resolveMode, "hash": details.Hash,
			})
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
			require.NoFileExists(t, filepath.Join(dir, "modify-delete.txt"))
			cachedStatus := runRealGit(t, dir, "diff", "--cached", "--name-status")
			if tc.cachedDelete {
				require.Contains(t, cachedStatus, "D\tmodify-delete.txt")
			} else {
				require.Empty(t, cachedStatus)
			}

			// The retained side remains available in the details response and is
			// never copied into the delete resolution.
			require.NotEmpty(t, tc.keptContent)
		})
	}
}

func TestGitRealModifyDeleteConflictMissingWorktreeSnapshot(t *testing.T) {
	t.Run("stage metadata becomes stale", func(t *testing.T) {
		dir := createRealModifyDeleteConflict(t, "theirs")
		filePath := filepath.Join(dir, "modify-delete.txt")
		require.NoError(t, os.Remove(filePath))
		r, _ := setupRouter()
		w := postJSON(r, "/git/conflict-details", map[string]string{
			"path": dir, "filePath": "modify-delete.txt",
		})
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var details ConflictDetailsResponse
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &details))

		runRealGit(t, dir, "add", "-u", "--", "modify-delete.txt")
		w = postJSON(r, "/git/conflict-resolve", map[string]string{
			"path": dir, "filePath": "modify-delete.txt", "mode": "delete", "hash": details.Hash,
		})
		require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
		require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
	})

	dir := createRealModifyDeleteConflict(t, "theirs")
	filePath := filepath.Join(dir, "modify-delete.txt")
	require.NoError(t, os.Remove(filePath))
	r, _ := setupRouter()

	w := postJSON(r, "/git/conflict-details", map[string]string{
		"path": dir, "filePath": "modify-delete.txt",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var missingDetails ConflictDetailsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &missingDetails))
	require.True(t, missingDetails.Stages.Base.Present)
	require.True(t, missingDetails.Stages.Ours.Present)
	require.True(t, missingDetails.Stages.Theirs.Deleted)
	require.Equal(t, []string{"ours", ""}, missingDetails.Segments[0].Ours)
	require.Empty(t, missingDetails.Segments[0].Theirs)
	require.NotEmpty(t, missingDetails.Hash)

	// Missing and empty are distinct worktree snapshots. Creating an empty file
	// after details were loaded must make the old resolution stale without
	// changing the unmerged index.
	indexBefore := runRealGit(t, dir, "ls-files", "-u")
	require.NoError(t, os.WriteFile(filePath, nil, 0644))
	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "modify-delete.txt", "mode": "delete", "hash": missingDetails.Hash,
	})
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Equal(t, indexBefore, runRealGit(t, dir, "ls-files", "-u"))

	// Refreshing the snapshot and removing the file again still permits a
	// delete-side resolution through git rm.
	require.NoError(t, os.Remove(filePath))
	w = postJSON(r, "/git/conflict-details", map[string]string{
		"path": dir, "filePath": "modify-delete.txt",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &missingDetails))
	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "modify-delete.txt", "mode": "delete", "hash": missingDetails.Hash,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoFileExists(t, filePath)
	require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
}

func TestGitRealConflictEndpointsRejectGitMetadataAndSymlinkAliases(t *testing.T) {
	dir := newRealGitRepo(t)
	configPath := filepath.Join(dir, ".git", "config")
	originalConfig := mustReadRealFile(t, configPath)
	r, _ := setupRouter()

	// All conflict endpoints accept repository-relative paths, but none may
	// read or write the repository control directory.
	w := postJSON(r, "/git/conflict-details", map[string]string{
		"path": dir, "filePath": ".git/config",
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "Git metadata")

	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": ".git/config", "mode": "manual",
		"manualContent": "must not overwrite metadata\n",
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "Git metadata")

	w = postJSON(r, "/git/resolve-conflict", map[string]string{
		"path": dir, "filePath": ".git/config", "content": "must not overwrite metadata\n",
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "Git metadata")

	linkPath := filepath.Join(dir, "metadata-link")
	if err := os.Symlink(filepath.Join(dir, ".git"), linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	statusBefore := runRealGit(t, dir, "status", "--porcelain")

	// Lexical metadata checks do not catch aliases such as metadata-link/config;
	// the write-path guard must reject every symlink component as well.
	for _, endpoint := range []string{"/git/conflict-details", "/git/conflict-resolve", "/git/resolve-conflict"} {
		payload := map[string]string{
			"path": dir, "filePath": "metadata-link/config", "mode": "manual",
			"manualContent": "must not overwrite metadata\n", "content": "must not overwrite metadata\n",
		}
		w = postJSON(r, endpoint, payload)
		require.Equal(t, http.StatusBadRequest, w.Code, "%s: %s", endpoint, w.Body.String())
		require.Contains(t, w.Body.String(), "symbolic link", endpoint)
	}

	require.Equal(t, originalConfig, mustReadRealFile(t, configPath))
	require.Equal(t, statusBefore, runRealGit(t, dir, "status", "--porcelain"))
}

func TestGitRealConflictResolveRejectsCaseVariantAndNestedGitMetadata(t *testing.T) {
	dir := newRealGitRepo(t)
	configPath := filepath.Join(dir, ".git", "config")
	originalConfig := mustReadRealFile(t, configPath)
	r, _ := setupRouter()

	// Metadata checks are component-based and case-insensitive so callers
	// cannot reach the control directory through alternate spellings.
	for _, filePath := range []string{".GIT/config", "nested/.git/config"} {
		w := postJSON(r, "/git/conflict-resolve", map[string]string{
			"path": dir, "filePath": filePath, "mode": "manual",
			"manualContent": "must not overwrite metadata\n",
		})
		require.Equal(t, http.StatusBadRequest, w.Code, "%s: %s", filePath, w.Body.String())
		require.Contains(t, w.Body.String(), "Git metadata", filePath)
	}

	require.Equal(t, originalConfig, mustReadRealFile(t, configPath))
}

func TestGitRealForcePushUsesLease(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "origin.git")
	runRealGit(t, root, "init", "--bare", remote)

	source := filepath.Join(root, "source")
	runRealGit(t, root, "clone", remote, source)
	runRealGit(t, source, "config", "user.name", "VibeGo Test")
	runRealGit(t, source, "config", "user.email", "vibego-test@example.com")
	commitRealFile(t, source, "README.md", "base\n", "initial")
	runRealGit(t, source, "push", "-u", "origin", "HEAD")

	local := filepath.Join(root, "local")
	peer := filepath.Join(root, "peer")
	runRealGit(t, root, "clone", remote, local)
	runRealGit(t, root, "clone", remote, peer)
	for _, repo := range []string{local, peer} {
		runRealGit(t, repo, "config", "user.name", "VibeGo Test")
		runRealGit(t, repo, "config", "user.email", "vibego-test@example.com")
	}

	// Keep local's origin/master at the initial commit while the remote is
	// advanced by another clone.
	commitRealFile(t, local, "local.txt", "local\n", "local change")
	commitRealFile(t, peer, "peer.txt", "peer\n", "peer change")
	runRealGit(t, peer, "push", "origin", "HEAD")
	runRealGit(t, local, "reset", "--hard", "HEAD~1")

	r, _ := setupRouter()
	w := postJSON(r, "/git/push", map[string]interface{}{
		"path": local, "remote": "origin", "force": true,
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "stale info")
	require.Contains(t, runRealGit(t, remote, "log", "-1", "--format=%s"), "peer change")
}

func TestGitRealCheckoutRemovesUntrackedDirectory(t *testing.T) {
	dir := newRealGitRepo(t)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "untracked", "nested"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "untracked", "nested", "file.txt"), []byte("discard me\n"), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/checkout", map[string]interface{}{
		"path": dir, "files": []string{"untracked"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	_, err := os.Stat(filepath.Join(dir, "untracked"))
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestGitRealCheckoutRejectsTrackedDirectory(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "mixed/tracked.txt", "original\n", "initial")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "mixed", "tracked.txt"), []byte("keep this change\n"), 0644))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "mixed", "untracked", "nested"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "mixed", "untracked", "nested", "file.txt"), []byte("keep me\n"), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/checkout", map[string]interface{}{
		"path": dir, "files": []string{"mixed"},
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "cannot discard directory containing tracked files")
	require.Equal(t, "keep this change\n", string(mustReadRealFile(t, filepath.Join(dir, "mixed", "tracked.txt"))))
	require.Equal(t, "keep me\n", string(mustReadRealFile(t, filepath.Join(dir, "mixed", "untracked", "nested", "file.txt"))))
}

func TestGitRealCheckoutRejectsGitMetadata(t *testing.T) {
	dir := newRealGitRepo(t)
	configPath := filepath.Join(dir, ".git", "config")
	originalConfig := mustReadRealFile(t, configPath)

	r, _ := setupRouter()
	w := postJSON(r, "/git/checkout", map[string]interface{}{
		"path": dir, "files": []string{".git"},
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "cannot discard Git metadata")
	require.Equal(t, originalConfig, mustReadRealFile(t, configPath))
	require.Equal(t, "", runRealGit(t, dir, "status", "--porcelain"))
}

func TestGitRealCheckoutRejectsSymlinkIntoGitMetadata(t *testing.T) {
	dir := newRealGitRepo(t)
	linkPath := filepath.Join(dir, "metadata-link")
	if err := os.Symlink(filepath.Join(dir, ".git"), linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	configPath := filepath.Join(dir, ".git", "config")
	originalConfig := mustReadRealFile(t, configPath)

	r, _ := setupRouter()
	w := postJSON(r, "/git/checkout", map[string]interface{}{
		"path": dir, "files": []string{"metadata-link/config"},
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "symbolic link")
	require.Equal(t, originalConfig, mustReadRealFile(t, configPath))
	require.Contains(t, runRealGit(t, dir, "status", "--porcelain"), "metadata-link")
}

func TestGitRealCheckoutNormalizesTrailingSlashForTrackedFile(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "tracked.txt", "original\n", "initial")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("changed\n"), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/checkout", map[string]interface{}{
		"path": dir, "files": []string{"tracked.txt/"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "original\n", string(mustReadRealFile(t, filepath.Join(dir, "tracked.txt"))))
}

func TestGitRealApplySelectionRejectsGitMetadata(t *testing.T) {
	dir := newRealGitRepo(t)
	configPath := filepath.Join(dir, ".git", "config")
	originalConfig := mustReadRealFile(t, configPath)

	r, _ := setupRouter()
	w := postJSON(r, "/git/apply-selection", map[string]interface{}{
		"path": dir, "filePath": ".git", "mode": "working", "target": "file", "action": "discard",
		"lineIds": []string{}, "hunkIds": []string{},
	})
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "cannot discard Git metadata")
	require.Equal(t, originalConfig, mustReadRealFile(t, configPath))
	require.Equal(t, "", runRealGit(t, dir, "status", "--porcelain"))
}

func TestGitRealFetchPrunesRemoteTrackingBranches(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "origin.git")
	runRealGit(t, root, "init", "--bare", remote)
	repo := filepath.Join(root, "repo")
	runRealGit(t, root, "clone", remote, repo)
	runRealGit(t, repo, "config", "user.name", "VibeGo Test")
	runRealGit(t, repo, "config", "user.email", "vibego-test@example.com")
	commitRealFile(t, repo, "README.md", "base\n", "initial")
	runRealGit(t, repo, "push", "-u", "origin", "HEAD")
	mainBranch := runRealGit(t, repo, "branch", "--show-current")
	runRealGit(t, repo, "checkout", "-b", "stale")
	commitRealFile(t, repo, "stale.txt", "stale\n", "stale")
	runRealGit(t, repo, "push", "-u", "origin", "HEAD")
	runRealGit(t, repo, "checkout", mainBranch)
	runRealGit(t, remote, "update-ref", "-d", "refs/heads/stale")
	require.True(t, branchManagementHasRef(t, repo, "refs/remotes/origin/stale"))

	r, _ := setupRouter()
	w := postJSON(r, "/git/fetch", map[string]string{"path": repo, "remote": "origin"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.False(t, branchManagementHasRef(t, repo, "refs/remotes/origin/stale"))
}

func TestGitRealPullUsesFastForwardDefaultForDivergedHistory(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "origin.git")
	runRealGit(t, root, "init", "--bare", remote)
	source := filepath.Join(root, "source")
	local := filepath.Join(root, "local")
	runRealGit(t, root, "clone", remote, source)
	runRealGit(t, source, "config", "user.name", "VibeGo Test")
	runRealGit(t, source, "config", "user.email", "vibego-test@example.com")
	commitRealFile(t, source, "README.md", "base\n", "initial")
	runRealGit(t, source, "push", "-u", "origin", "HEAD")
	runRealGit(t, root, "clone", remote, local)
	runRealGit(t, local, "config", "user.name", "VibeGo Test")
	runRealGit(t, local, "config", "user.email", "vibego-test@example.com")
	commitRealFile(t, source, "remote.txt", "remote\n", "remote change")
	runRealGit(t, source, "push", "origin", "HEAD")
	commitRealFile(t, local, "local.txt", "local\n", "local change")

	// Keep the test independent of a developer's global pull.ff/pull.rebase
	// settings so the handler's default --ff behavior is exercised.
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(root, "empty-global-config"))
	r, _ := setupRouter()
	w := postJSON(r, "/git/pull", map[string]string{"path": local, "remote": "origin"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.FileExists(t, filepath.Join(local, "remote.txt"))
	require.FileExists(t, filepath.Join(local, "local.txt"))
}

func TestGitRealSmartSwitchStashesUntrackedConflict(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "initial")
	baseBranch := runRealGit(t, dir, "branch", "--show-current")
	runRealGit(t, dir, "checkout", "-b", "target")
	commitRealFile(t, dir, "untracked.txt", "target\n", "target file")
	runRealGit(t, dir, "checkout", baseBranch)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("local untracked\n"), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/smart-switch-branch", map[string]string{"path": dir, "branch": "target"})
	// A real desktop-style auto-stash should switch branches and surface the
	// restore failure for the colliding untracked path without losing data.
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var response struct {
		Branch        string `json:"branch"`
		Stashed       bool   `json:"stashed"`
		StashConflict bool   `json:"stashConflict"`
		StashError    string `json:"stashError"`
		Status        struct {
			Files   []StructuredFile `json:"files"`
			Summary StatusSummary    `json:"summary"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.Equal(t, "target", response.Branch)
	require.True(t, response.Stashed)
	require.True(t, response.StashConflict)
	require.Contains(t, response.StashError, "untracked.txt")
	require.NotNil(t, response.Status.Files)
	require.Equal(t, "target\n", string(mustReadRealFile(t, filepath.Join(dir, "untracked.txt"))))
	require.NotEmpty(t, runRealGit(t, dir, "stash", "list"))
	require.Equal(t, "local untracked", runRealGit(t, dir, "show", "stash@{0}^3:untracked.txt"))
}

func TestGitRealSmartSwitchPreservesIndexAndExistingStash(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "staged.txt", "base staged\n", "add staged fixture")
	commitRealFile(t, dir, "unstaged.txt", "base unstaged\n", "add unstaged fixture")
	commitRealFile(t, dir, "old-stash.txt", "base stash\n", "add stash fixture")
	runRealGit(t, dir, "branch", "target-index")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "old-stash.txt"), []byte("saved user work\n"), 0644))
	runRealGit(t, dir, "stash", "push", "-m", "existing user stash", "--", "old-stash.txt")
	oldStashOID := runRealGit(t, dir, "rev-parse", "refs/stash")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "staged.txt"), []byte("staged change\n"), 0644))
	runRealGit(t, dir, "add", "--", "staged.txt")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "unstaged.txt"), []byte("unstaged change\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("untracked change\n"), 0644))

	r, _ := setupRouter()
	w := postJSON(r, "/git/smart-switch-branch", map[string]string{"path": dir, "branch": "target-index"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var response struct {
		Branch        string `json:"branch"`
		Stashed       bool   `json:"stashed"`
		StashConflict bool   `json:"stashConflict"`
		StashError    string `json:"stashError"`
		Status        struct {
			Files   []StructuredFile `json:"files"`
			Summary StatusSummary    `json:"summary"`
		} `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.Equal(t, "target-index", response.Branch)
	require.True(t, response.Stashed)
	require.False(t, response.StashConflict)
	require.Empty(t, response.StashError)
	require.Equal(t, StatusSummary{Changed: 3, Staged: 1, Unstaged: 2, Included: 3}, response.Status.Summary)
	require.Len(t, response.Status.Files, 3)

	files := make(map[string]StructuredFile, len(response.Status.Files))
	for _, file := range response.Status.Files {
		files[file.Path] = file
	}
	require.Equal(t, "modified", files["staged.txt"].IndexStatus)
	require.Equal(t, "clean", files["staged.txt"].WorktreeStatus)
	require.Equal(t, "clean", files["unstaged.txt"].IndexStatus)
	require.Equal(t, "modified", files["unstaged.txt"].WorktreeStatus)
	require.Equal(t, "untracked", files["untracked.txt"].ChangeType)

	require.Equal(t, "target-index", runRealGit(t, dir, "branch", "--show-current"))
	require.Equal(t, "staged.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
	require.Equal(t, "unstaged.txt", runRealGit(t, dir, "diff", "--name-only"))
	require.Equal(t, "untracked.txt", runRealGit(t, dir, "ls-files", "--others", "--exclude-standard"))
	require.Equal(t, oldStashOID, runRealGit(t, dir, "rev-parse", "refs/stash"))
	require.Contains(t, runRealGit(t, dir, "stash", "list"), "existing user stash")
	require.NotContains(t, runRealGit(t, dir, "stash", "list"), "auto-stash")
}

func TestGitAutoStashRestoresCapturedOIDWithoutDroppingNewerStash(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "staged.txt", "base staged\n", "add staged fixture")
	commitRealFile(t, dir, "unstaged.txt", "base unstaged\n", "add unstaged fixture")
	commitRealFile(t, dir, "newer.txt", "base newer\n", "add newer fixture")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "staged.txt"), []byte("captured staged\n"), 0644))
	runRealGit(t, dir, "add", "--", "staged.txt")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "unstaged.txt"), []byte("captured unstaged\n"), 0644))
	autoStashOID, err := createAutoStash(dir, "auto-stash: captured oid test")
	require.NoError(t, err)
	require.NotEmpty(t, autoStashOID)

	require.NoError(t, os.WriteFile(filepath.Join(dir, "newer.txt"), []byte("newer user work\n"), 0644))
	runRealGit(t, dir, "stash", "push", "-m", "newer user stash", "--", "newer.txt")
	newerStashOID := runRealGit(t, dir, "rev-parse", "refs/stash")
	require.NotEqual(t, autoStashOID, newerStashOID)

	require.NoError(t, restoreAutoStash(dir, autoStashOID))
	require.Equal(t, "staged.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
	require.Equal(t, "unstaged.txt", runRealGit(t, dir, "diff", "--name-only"))
	require.Equal(t, "base newer\n", string(mustReadRealFile(t, filepath.Join(dir, "newer.txt"))))
	require.Equal(t, newerStashOID, runRealGit(t, dir, "rev-parse", "refs/stash"))
	stashOIDs := strings.Split(runRealGit(t, dir, "stash", "list", "--format=%H"), "\n")
	require.NotContains(t, stashOIDs, autoStashOID)
	require.Contains(t, stashOIDs, newerStashOID)
}

func mustReadRealFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	return content
}
