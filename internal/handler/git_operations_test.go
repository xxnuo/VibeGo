package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func setupGitOperationRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewGitHandler(nil)
	r := gin.New()
	h.RegisterGitOperationRoutes(r.Group("/"))
	return r
}

func decodeGitOperation(t *testing.T, body interface{ Bytes() []byte }) GitOperationResponse {
	t.Helper()
	var response GitOperationResponse
	require.NoError(t, json.Unmarshal(body.Bytes(), &response))
	return response
}

func writeOperationFile(t *testing.T, repoRoot, path, content string) {
	t.Helper()
	abs := filepath.Join(repoRoot, filepath.FromSlash(path))
	require.NoError(t, os.MkdirAll(filepath.Dir(abs), 0755))
	require.NoError(t, os.WriteFile(abs, []byte(content), 0644))
}

func currentOperationBranch(t *testing.T, repoRoot string) string {
	t.Helper()
	return runRealGit(t, repoRoot, "branch", "--show-current")
}

func operationRepoWithBase(t *testing.T, content string) (string, string, string) {
	t.Helper()
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "conflict.txt", content, "base")
	return dir, currentOperationBranch(t, dir), runRealGit(t, dir, "rev-parse", "HEAD")
}

func operationResponse(t *testing.T, w interface{ Bytes() []byte }) GitOperationResponse {
	t.Helper()
	return decodeGitOperation(t, w)
}

func shellQuoteOperationTest(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func installBlockingPostCommitHook(t *testing.T, repoRoot, readyPath, releasePath string) {
	t.Helper()
	hookPath := filepath.Join(absoluteGitDir(repoRoot), "hooks", "post-commit")
	quote := shellQuoteOperationTest
	script := fmt.Sprintf("#!/bin/sh\n: > %s\n"+
		"while [ ! -e %s ]; do\n  sleep 0.01\ndone\n",
		quote(readyPath), quote(releasePath))
	require.NoError(t, os.WriteFile(hookPath, []byte(script), 0755))
	require.NoError(t, os.Chmod(hookPath, 0755))
	t.Cleanup(func() {
		// Always unblock a Git process if an assertion exits early.
		_ = os.WriteFile(releasePath, []byte("release\n"), 0600)
	})
}

func waitForOperationMarker(t *testing.T, markerPath string) {
	t.Helper()
	require.Eventually(t, func() bool {
		_, err := os.Stat(markerPath)
		return err == nil
	}, 5*time.Second, 10*time.Millisecond)
}

func awaitOperationResponse(t *testing.T, done <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case response := <-done:
		return response
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Git operation request")
		return nil
	}
}

func TestGitOperationRepoLockSerializesConcurrentOperationsAndSidecars(t *testing.T) {
	dir, _, baseHash, firstMergeHash := mergeCommitMainlineFixture(t)
	// Create a second merge commit from the same base. Both requests use a
	// mainline sidecar, making an unlocked start observable while the first
	// request is paused in its post-commit hook.
	runRealGit(t, dir, "checkout", "-b", "second-incoming", baseHash)
	commitRealFile(t, dir, "second.txt", "second\n", "second incoming change")
	runRealGit(t, dir, "checkout", "-b", "second-merge-base", baseHash)
	runRealGit(t, dir, "merge", "--no-ff", "second-incoming", "-m", "second merge")
	secondMergeHash := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", "-b", "operation-target", baseHash)

	markers := t.TempDir()
	readyPath := filepath.Join(markers, "ready")
	releasePath := filepath.Join(markers, "release")
	installBlockingPostCommitHook(t, dir, readyPath, releasePath)
	r := setupGitOperationRouter()

	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstDone <- postJSON(r, "/git/cherry-pick", map[string]interface{}{
			"path": dir, "commit": firstMergeHash, "mainline": 1,
		})
	}()
	waitForOperationMarker(t, readyPath)

	ownership, err := readGitOperationOwnershipState(dir)
	require.NoError(t, err)
	require.NotNil(t, ownership)
	require.Equal(t, "cherry-pick", ownership.Operation)
	require.Equal(t, firstMergeHash, ownership.Commits[0])

	secondDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		secondDone <- postJSON(r, "/git/cherry-pick", map[string]interface{}{
			"path": dir, "commit": secondMergeHash, "mainline": 1,
		})
	}()
	// The second request must wait for the first request's repository lock. In
	// particular, it must not clear or replace the first request's sidecar.
	select {
	case response := <-secondDone:
		t.Fatalf("second operation completed while first was paused: %s", response.Body.String())
	case <-time.After(150 * time.Millisecond):
	}
	ownership, err = readGitOperationOwnershipState(dir)
	require.NoError(t, err)
	require.NotNil(t, ownership)
	require.Equal(t, firstMergeHash, ownership.Commits[0])

	require.NoError(t, os.WriteFile(releasePath, []byte("release\n"), 0600))
	firstResponse := operationResponse(t, awaitOperationResponse(t, firstDone).Body)
	secondResponse := operationResponse(t, awaitOperationResponse(t, secondDone).Body)
	require.True(t, firstResponse.OK, firstResponse.Error)
	require.True(t, secondResponse.OK, secondResponse.Error)
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
	require.Equal(t, "second merge", runRealGit(t, dir, "show", "-s", "--format=%s", "HEAD"))
}

func TestCanonicalGitOperationRepoRootSharesSymlinkLock(t *testing.T) {
	dir := newRealGitRepo(t)
	link := filepath.Join(t.TempDir(), "repo-link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	require.Equal(t, canonicalGitOperationRepoRoot(dir), canonicalGitOperationRepoRoot(link))
	unlock := lockGitOperationRepo(dir)
	defer unlock()
	acquired := make(chan struct{}, 1)
	go func() {
		otherUnlock := lockGitOperationRepo(link)
		acquired <- struct{}{}
		otherUnlock()
	}()
	select {
	case <-acquired:
		t.Fatal("symlink alias acquired repository lock concurrently")
	case <-time.After(100 * time.Millisecond):
	}
	unlock()
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("symlink alias did not acquire lock after release")
	}
}

func TestGitOperationStatusIdle(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "README.md", "base\n", "initial")

	w := postJSON(setupGitOperationRouter(), "/git/operation-status", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK)
	require.Equal(t, "none", response.Operation)
	require.Equal(t, "idle", response.State)
	require.Empty(t, response.Conflicts)
	require.Len(t, response.HeadHash, 40)
	require.NotEmpty(t, response.HeadRef)
}

func TestGitMergeSuccessAndAlreadyUpToDate(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "feature.txt", "feature\n", "feature commit")
	runRealGit(t, dir, "checkout", baseBranch)

	w := postJSON(r, "/git/merge", map[string]interface{}{
		"path": dir, "ref": "feature", "noFF": true,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "merge", response.Operation)
	require.Equal(t, "completed", response.State)
	require.Empty(t, response.Conflicts)
	require.Contains(t, runRealGit(t, dir, "log", "-1", "--format=%s"), "Merge commit")

	// A second merge should be reported as a successful no-op.
	w = postJSON(r, "/git/merge", map[string]string{"path": dir, "branch": "feature"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "already_up_to_date", response.State)
}

func TestGitMergeConflictContinueDoesNotCommitUnrelatedDirtyFile(t *testing.T) {
	dir, baseBranch, baseHash := operationRepoWithBase(t, "base\n")
	commitRealFile(t, dir, "unrelated.txt", "clean\n", "unrelated base")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	writeOperationFile(t, dir, "conflict.txt", "feature\n")
	runRealGit(t, dir, "add", "--", "conflict.txt")
	runRealGit(t, dir, "commit", "-m", "feature change")
	runRealGit(t, dir, "checkout", baseBranch)
	writeOperationFile(t, dir, "conflict.txt", "main\n")
	runRealGit(t, dir, "add", "--", "conflict.txt")
	runRealGit(t, dir, "commit", "-m", "main change")

	w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": "feature"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "merge", response.Operation)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")

	// Keep an unrelated tracked change in the worktree while resolving the merge.
	writeOperationFile(t, dir, "unrelated.txt", "dirty\n")
	writeOperationFile(t, dir, "conflict.txt", "resolved\n")
	w = postJSON(r, "/git/merge", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "merge", response.Operation)
	require.Equal(t, "completed", response.State)
	require.Empty(t, response.Conflicts)
	require.Equal(t, "resolved", runRealGit(t, dir, "show", "HEAD:conflict.txt"))
	// The unrelated file remains a worktree-only modification.
	require.Equal(t, "dirty\n", string(mustReadRealFile(t, filepath.Join(dir, "unrelated.txt"))))
	require.NotContains(t, runRealGit(t, dir, "show", "--format=", "--name-only", "HEAD"), "unrelated.txt")
	require.NotEqual(t, baseHash, runRealGit(t, dir, "rev-parse", "HEAD"))
}

func TestGitMergeConflictResolveThenContinueWithoutFiles(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r, _ := setupRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "main\n", "main change")

	w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": "feature"})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)

	// Editing a conflicted file alone does not mark it resolved. Continue must
	// leave the unmerged index intact rather than implicitly adding every path.
	writeOperationFile(t, dir, "conflict.txt", "resolved\n")
	w = postJSON(r, "/git/merge", map[string]string{"path": dir, "action": "continue"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.NotEmpty(t, runRealGit(t, dir, "ls-files", "-u"))

	// The conflict editor resolves and stages the selected file. Once that API
	// succeeds, Continue intentionally needs no files payload.
	w = postJSON(r, "/git/conflict-resolve", map[string]string{
		"path": dir, "filePath": "conflict.txt", "mode": "manual", "manualContent": "resolved\n",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Empty(t, runRealGit(t, dir, "ls-files", "-u"))
	require.Equal(t, "conflict.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))

	w = postJSON(r, "/git/merge", map[string]string{"path": dir, "action": "continue"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Equal(t, "resolved", runRealGit(t, dir, "show", "HEAD:conflict.txt"))
}

func TestGitMergeConflictAbort(t *testing.T) {
	dir, baseBranch, baseHash := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "main\n", "main change")

	w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": "feature"})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)

	w = postJSON(r, "/git/merge", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "aborted", response.State)
	require.Equal(t, "merge", response.Operation)
	require.Empty(t, response.Conflicts)
	require.Equal(t, baseBranch, currentOperationBranch(t, dir))
	require.NotEqual(t, baseHash, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, "main", runRealGit(t, dir, "show", "HEAD:conflict.txt"))
}

func TestGitRebaseSuccess(t *testing.T) {
	dir, baseBranch, baseHash := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "feature.txt", "feature\n", "feature commit")
	featureBefore := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "main.txt", "main\n", "main commit")
	mainHead := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", "feature")

	w := postJSON(r, "/git/rebase", map[string]string{"path": dir, "upstream": baseBranch})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "rebase", response.Operation)
	require.Equal(t, "completed", response.State)
	require.Equal(t, "feature", response.HeadRef)
	require.NotEqual(t, featureBefore, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, mainHead, runRealGit(t, dir, "rev-parse", "HEAD~1"))
	require.NotEqual(t, baseHash, runRealGit(t, dir, "rev-parse", "HEAD"))
}

func TestGitSquashReplaysSelectedCommitsAtTarget(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "base")
	base := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "a.txt", "a\n", "A")
	a := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "b.txt", "b\n", "B")
	commitRealFile(t, dir, "c.txt", "c\n", "C")
	c := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "d.txt", "d\n", "D")
	commitRealFile(t, dir, "e.txt", "e\n", "E")
	e := runRealGit(t, dir, "rev-parse", "HEAD")

	w := postJSON(setupGitOperationRouter(), "/git/squash", map[string]interface{}{
		"path": dir, "toSquash": []string{a, e}, "squashOnto": c,
		"lastRetainedCommitRef": base, "message": "combined\n\nbody\n",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	logLines := strings.Split(runRealGit(t, dir, "log", "-4", "--format=%s"), "\n")
	require.Equal(t, []string{"D", "combined", "B", "base"}, logLines)
	require.Contains(t, runRealGit(t, dir, "log", "--format=%B", "--all"), "body")
	for _, name := range []string{"base.txt", "a.txt", "b.txt", "c.txt", "d.txt", "e.txt"} {
		require.NotEmpty(t, runRealGit(t, dir, "show", "HEAD:"+name))
	}
}

func TestGitInteractiveRewriteDerivesRecentFirstParentBoundary(t *testing.T) {
	newRepo := func(t *testing.T) (string, string, string, string) {
		t.Helper()
		dir := newRealGitRepo(t)
		commitRealFile(t, dir, "base.txt", "base\n", "base")
		baseBranch := currentOperationBranch(t, dir)
		runRealGit(t, dir, "checkout", "-b", "side")
		commitRealFile(t, dir, "side.txt", "side\n", "side")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "main.txt", "main\n", "main")
		runRealGit(t, dir, "merge", "--no-ff", "side", "-m", "early merge")
		commitRealFile(t, dir, "a.txt", "a\n", "A")
		a := runRealGit(t, dir, "rev-parse", "HEAD")
		commitRealFile(t, dir, "b.txt", "b\n", "B")
		b := runRealGit(t, dir, "rev-parse", "HEAD")
		commitRealFile(t, dir, "c.txt", "c\n", "C")
		c := runRealGit(t, dir, "rev-parse", "HEAD")
		return dir, a, b, c
	}

	t.Run("squash", func(t *testing.T) {
		dir, _, b, c := newRepo(t)
		w := postJSON(setupGitOperationRouter(), "/git/squash", map[string]interface{}{
			"path": dir, "toSquash": []string{c}, "squashOnto": b, "message": "combined",
		})
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		response := operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Equal(t, []string{"combined", "A", "early merge"}, strings.Split(runRealGit(t, dir, "log", "-3", "--format=%s"), "\n"))
	})

	t.Run("reorder", func(t *testing.T) {
		dir, a, b, c := newRepo(t)
		w := postJSON(setupGitOperationRouter(), "/git/reorder", map[string]interface{}{
			"path": dir, "toMove": []string{c}, "beforeCommit": b,
		})
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		response := operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Equal(t, []string{"B", "C", "A"}, strings.Split(runRealGit(t, dir, "log", "-3", "--format=%s"), "\n"))
		require.NotEmpty(t, a)
	})

	t.Run("root", func(t *testing.T) {
		dir := newRealGitRepo(t)
		commitRealFile(t, dir, "root.txt", "root\n", "root")
		root := runRealGit(t, dir, "rev-parse", "HEAD")
		commitRealFile(t, dir, "child.txt", "child\n", "child")
		child := runRealGit(t, dir, "rev-parse", "HEAD")
		w := postJSON(setupGitOperationRouter(), "/git/squash", map[string]interface{}{
			"path": dir, "toSquash": []string{child}, "squashOnto": root, "message": "root combined",
		})
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		response := operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Equal(t, "root combined", runRealGit(t, dir, "log", "-1", "--format=%s"))
		require.Equal(t, "1", runRealGit(t, dir, "rev-list", "--count", "HEAD"))
	})
}

func TestVerifyGitCommitRefAcceptsParentBoundary(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "one.txt", "one\n", "one")
	commitRealFile(t, dir, "two.txt", "two\n", "two")
	head := runRealGit(t, dir, "rev-parse", "HEAD")
	parent := runRealGit(t, dir, "rev-parse", "HEAD^")
	resolved, err := verifyGitCommitRef(dir, head+"^")
	require.NoError(t, err)
	require.Equal(t, parent, resolved)
}

func TestGitSquashConflictContinuePreservesCustomMessage(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "conflict.txt", "a\nz\nq\n", "base")
	base := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "conflict.txt", "c\nz\nq\n", "C")
	cCommit := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "conflict.txt", "c\nd\nz\nq\n", "D")
	commitRealFile(t, dir, "conflict.txt", "c\nd\ne\nq\n", "E")
	eCommit := runRealGit(t, dir, "rev-parse", "HEAD")
	r := setupGitOperationRouter()
	require.NoError(t, writeGitInteractiveRewriteState(dir, "squash", "stale message"))

	w := postJSON(r, "/git/squash", map[string]interface{}{
		"path": dir, "toSquash": []string{eCommit}, "squashOnto": cCommit,
		"message": "custom title\n\ncustom body\n",
	})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.FileExists(t, gitInteractiveRewriteStatePath(dir))
	rewriteState, err := readGitInteractiveRewriteState(dir)
	require.NoError(t, err)
	require.Equal(t, "custom title\n\ncustom body\n", rewriteState.Message)

	writeOperationFile(t, dir, "conflict.txt", "c\ne\nq\n")
	w = postJSON(r, "/git/rebase", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.FileExists(t, gitInteractiveRewriteStatePath(dir))

	writeOperationFile(t, dir, "conflict.txt", "c\nd\ne\nq\n")
	w = postJSON(r, "/git/rebase", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Equal(t, []string{"D", "custom title", "base"}, strings.Split(runRealGit(t, dir, "log", "-3", "--format=%s"), "\n"))
	require.Equal(t, "custom title\n\ncustom body", runRealGit(t, dir, "show", "-s", "--format=%B", "HEAD~1"))
	require.Equal(t, base, runRealGit(t, dir, "rev-parse", "HEAD~2"))
	require.NoFileExists(t, gitInteractiveRewriteStatePath(dir))
}

func TestGitReorderMovesSelectedCommits(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "base")
	base := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "a.txt", "a\n", "A")
	a := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "b.txt", "b\n", "B")
	commitRealFile(t, dir, "c.txt", "c\n", "C")
	c := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "d.txt", "d\n", "D")
	commitRealFile(t, dir, "e.txt", "e\n", "E")
	e := runRealGit(t, dir, "rev-parse", "HEAD")

	r := setupGitOperationRouter()
	invalid := postJSON(r, "/git/reorder", map[string]interface{}{
		"path": dir, "toMove": []string{a, a}, "beforeCommit": c,
		"lastRetainedCommitRef": base,
	})
	require.Equal(t, http.StatusBadRequest, invalid.Code, invalid.Body.String())
	invalidResponse := operationResponse(t, invalid.Body)
	require.False(t, invalidResponse.OK)
	require.Contains(t, invalidResponse.Error, "duplicate")

	w := postJSON(r, "/git/reorder", map[string]interface{}{
		"path": dir, "toMove": []string{a, e}, "beforeCommit": c,
		"lastRetainedCommitRef": base,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	logLines := strings.Split(runRealGit(t, dir, "log", "-5", "--format=%s"), "\n")
	require.Equal(t, []string{"D", "C", "E", "A", "B"}, logLines)
}

func TestGitInteractiveHistoryRewriteRejectsUnsafeSelection(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "base")
	base := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "change.txt", "change\n", "change")
	change := runRealGit(t, dir, "rev-parse", "HEAD")
	r := setupGitOperationRouter()

	for _, tc := range []struct {
		name     string
		endpoint string
		body     map[string]interface{}
		contains string
	}{
		{name: "empty squash", endpoint: "/git/squash", body: map[string]interface{}{
			"path": dir, "squashOnto": change, "lastRetainedCommitRef": base,
		}, contains: "toSquash"},
		{name: "duplicate reorder", endpoint: "/git/reorder", body: map[string]interface{}{
			"path": dir, "toMove": []string{change, change}, "lastRetainedCommitRef": base,
		}, contains: "duplicate"},
		{name: "outside range", endpoint: "/git/reorder", body: map[string]interface{}{
			"path": dir, "toMove": []string{base}, "lastRetainedCommitRef": base,
		}, contains: "outside"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := postJSON(r, tc.endpoint, tc.body)
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			response := operationResponse(t, w.Body)
			require.False(t, response.OK)
			require.Equal(t, "invalid", response.State)
			require.Contains(t, response.Error, tc.contains)
		})
	}
}

func TestGitRebaseExplicitTargetKeepsBranchAttached(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "target")
	commitRealFile(t, dir, "target.txt", "target\n", "target commit")
	targetBefore := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "base.txt", "base change\n", "base commit")

	w := postJSON(r, "/git/rebase", map[string]string{
		"path": dir, "upstream": baseBranch, "targetBranch": "refs/heads/target",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "target", currentOperationBranch(t, dir))
	require.Equal(t, "target", runRealGit(t, dir, "branch", "--show-current"))
	require.Equal(t, "target commit", runRealGit(t, dir, "log", "-1", "--format=%s"))
	targetAfter := runRealGit(t, dir, "rev-parse", "HEAD")
	require.NotEqual(t, targetBefore, targetAfter)
	require.Equal(t, targetAfter, runRealGit(t, dir, "rev-parse", "refs/heads/target"))
}

func TestGitOperationStartRejectsExistingStagedChanges(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	writeOperationFile(t, dir, "staged.txt", "staged\n")
	runRealGit(t, dir, "add", "--", "staged.txt")

	for _, operation := range []string{"merge", "rebase", "cherry-pick", "revert"} {
		t.Run(operation, func(t *testing.T) {
			body := map[string]interface{}{"path": dir}
			switch operation {
			case "merge":
				body["ref"] = baseBranch
			case "rebase":
				body["upstream"] = baseBranch
			case "cherry-pick":
				body["commit"] = runRealGit(t, dir, "rev-parse", "HEAD")
			case "revert":
				body["commit"] = runRealGit(t, dir, "rev-parse", "HEAD")
			}

			w := postJSON(r, "/git/"+operation, body)
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			response := operationResponse(t, w.Body)
			require.False(t, response.OK)
			require.Equal(t, "invalid", response.State)
			require.Contains(t, response.Error, "staged")
		})
	}
	require.Equal(t, "staged.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))
}

func assertGitOperationContinueRejectsUnrelatedStaged(t *testing.T, r *gin.Engine, endpoint string, dir string) {
	t.Helper()
	writeOperationFile(t, dir, "unrelated.txt", "dirty\n")
	runRealGit(t, dir, "add", "--", "unrelated.txt")
	stagedBefore := runRealGit(t, dir, "diff", "--cached", "--name-only", "--no-renames")

	w := postJSON(r, endpoint, map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Error, "unrelated staged path")

	// The guard runs before git add, so rejecting the request must leave both
	// the operation and the caller's index untouched.
	require.Equal(t, stagedBefore, runRealGit(t, dir, "diff", "--cached", "--name-only", "--no-renames"))
	require.Contains(t, response.Conflicts, "conflict.txt")
}

func TestGitOperationContinueRejectsUnrelatedStagedPaths(t *testing.T) {
	t.Run("merge", func(t *testing.T) {
		dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		runRealGit(t, dir, "checkout", "-b", "feature")
		commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "conflict.txt", "main\n", "main change")

		w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": "feature"})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		require.Equal(t, "conflicts", response.State)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		assertGitOperationContinueRejectsUnrelatedStaged(t, r, "/git/merge", dir)
	})

	t.Run("rebase", func(t *testing.T) {
		dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		runRealGit(t, dir, "checkout", "-b", "feature")
		commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "conflict.txt", "main\n", "main change")
		runRealGit(t, dir, "checkout", "feature")

		w := postJSON(r, "/git/rebase", map[string]string{"path": dir, "upstream": baseBranch})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		require.Equal(t, "conflicts", response.State)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		assertGitOperationContinueRejectsUnrelatedStaged(t, r, "/git/rebase", dir)
	})

	t.Run("cherry-pick", func(t *testing.T) {
		dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		runRealGit(t, dir, "checkout", "-b", "source")
		commitRealFile(t, dir, "conflict.txt", "source\n", "source change")
		pickedHash := runRealGit(t, dir, "rev-parse", "HEAD")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "conflict.txt", "target\n", "target change")

		w := postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "commit": pickedHash})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		require.Equal(t, "conflicts", response.State)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		assertGitOperationContinueRejectsUnrelatedStaged(t, r, "/git/cherry-pick", dir)
	})

	t.Run("revert", func(t *testing.T) {
		dir, _, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		commitRealFile(t, dir, "conflict.txt", "first\n", "first change")
		commitHash := runRealGit(t, dir, "rev-parse", "HEAD")
		commitRealFile(t, dir, "conflict.txt", "second\n", "second change")

		w := postJSON(r, "/git/revert", map[string]string{"path": dir, "commit": commitHash})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		require.Equal(t, "conflicts", response.State)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		assertGitOperationContinueRejectsUnrelatedStaged(t, r, "/git/revert", dir)
	})
}

func TestGitMergeContinueRejectsStagedPathFromCurrentBranchOnlyCommit(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
	featureHash := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "main\n", "main change")
	// This path exists only in the current branch after the merge base. It must
	// not be classified as incoming merge-owned merely because it differs from
	// the incoming head.
	commitRealFile(t, dir, "current-only.txt", "current\n", "current-only change")

	w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": featureHash})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")

	writeOperationFile(t, dir, "conflict.txt", "resolved\n")
	writeOperationFile(t, dir, "current-only.txt", "current staged edit\n")
	runRealGit(t, dir, "add", "--", "current-only.txt")
	stagedBefore := runRealGit(t, dir, "diff", "--cached", "--name-only", "--no-renames")
	headBefore := runRealGit(t, dir, "rev-parse", "HEAD")

	w = postJSON(r, "/git/merge", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Error, "unrelated staged path")
	require.Equal(t, headBefore, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, stagedBefore, runRealGit(t, dir, "diff", "--cached", "--name-only", "--no-renames"))
}

func mergeCommitMainlineFixture(t *testing.T) (dir, baseBranch, baseHash, mergeHash string) {
	t.Helper()
	dir, baseBranch, _ = operationRepoWithBase(t, "base\n")
	commitRealFile(t, dir, "current-only.txt", "base\n", "current-only base")
	baseHash = runRealGit(t, dir, "rev-parse", "HEAD")

	runRealGit(t, dir, "checkout", "-b", "incoming")
	commitRealFile(t, dir, "conflict.txt", "incoming\n", "incoming conflict change")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "current-only.txt", "current branch\n", "current-only change")
	runRealGit(t, dir, "merge", "--no-ff", "incoming", "-m", "merge incoming")
	mergeHash = runRealGit(t, dir, "rev-parse", "HEAD")
	return dir, baseBranch, baseHash, mergeHash
}

func assertMainlineContinueRejectsOtherParentPath(t *testing.T, r *gin.Engine, endpoint, dir string) {
	t.Helper()
	writeOperationFile(t, dir, "conflict.txt", "resolved\n")
	writeOperationFile(t, dir, "current-only.txt", "unrelated staged edit\n")
	runRealGit(t, dir, "add", "--", "current-only.txt")
	headBefore := runRealGit(t, dir, "rev-parse", "HEAD")
	indexBefore := runRealGit(t, dir, "ls-files", "--stage")
	cachedBefore := runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index")

	w := postJSON(r, endpoint, map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Error, `unrelated staged path "current-only.txt"`)
	require.Equal(t, headBefore, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, indexBefore, runRealGit(t, dir, "ls-files", "--stage"))
	require.Equal(t, cachedBefore, runRealGit(t, dir, "diff", "--cached", "--binary", "--full-index"))
}

func TestGitCherryPickMainlineRejectsPathChangedOnlyAgainstOtherParent(t *testing.T) {
	dir, _, baseHash, mergeHash := mergeCommitMainlineFixture(t)
	r := setupGitOperationRouter()
	runRealGit(t, dir, "checkout", "-b", "target", baseHash)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target conflict change")

	w := postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "commit": mergeHash, "mainline": 1,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")
	require.FileExists(t, gitOperationOwnershipStatePath(dir))

	assertMainlineContinueRejectsOtherParentPath(t, r, "/git/cherry-pick", dir)
	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitCommitChangedPathsUseSelectedMainlineParent(t *testing.T) {
	dir, _, _, mergeHash := mergeCommitMainlineFixture(t)
	firstParentPaths, err := collectGitCommitChangedPaths(dir, mergeHash, 1)
	require.NoError(t, err)
	require.Equal(t, map[string]struct{}{"conflict.txt": {}}, firstParentPaths)

	secondParentPaths, err := collectGitCommitChangedPaths(dir, mergeHash, 2)
	require.NoError(t, err)
	require.Equal(t, map[string]struct{}{"current-only.txt": {}}, secondParentPaths)
}

func TestGitRebaseMergeCommitOwnershipFailsClosed(t *testing.T) {
	dir, _, _, mergeHash := mergeCommitMainlineFixture(t)
	gitDir := absoluteGitDir(dir)
	require.NotEmpty(t, gitDir)
	require.NoError(t, os.WriteFile(filepath.Join(gitDir, "REBASE_HEAD"), []byte(mergeHash+"\n"), 0600))
	owned, err := collectGitOperationOwnedPaths(dir, "rebase")
	require.Nil(t, owned)
	require.Error(t, err)
	require.Contains(t, err.Error(), "cannot determine mainline parent")
}

func TestGitCherryPickMainlineOwnershipLifecycle(t *testing.T) {
	dir, _, baseHash, mergeHash := mergeCommitMainlineFixture(t)
	r := setupGitOperationRouter()
	runRealGit(t, dir, "checkout", "-b", "target", baseHash)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target conflict change")
	targetHead := runRealGit(t, dir, "rev-parse", "HEAD")

	w := postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "commit": mergeHash, "mainline": 1,
	})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	content, err := os.ReadFile(gitOperationOwnershipStatePath(dir))
	require.NoError(t, err)
	var ownership gitOperationOwnershipState
	require.NoError(t, json.Unmarshal(content, &ownership))
	require.Equal(t, "cherry-pick", ownership.Operation)
	require.Equal(t, 1, ownership.Mainline)
	require.Equal(t, targetHead, ownership.OriginalHead)
	require.Equal(t, []string{mergeHash}, ownership.Commits)

	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))

	// A successful mainline cherry-pick must also remove the sidecar.
	runRealGit(t, dir, "checkout", "-B", "clean-target", runRealGit(t, dir, "rev-parse", mergeHash+"^1"))
	w = postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "commit": mergeHash, "mainline": 1,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitCherryPickMainlineSkipCleansOwnershipState(t *testing.T) {
	dir, _, baseHash, mergeHash := mergeCommitMainlineFixture(t)
	r := setupGitOperationRouter()
	runRealGit(t, dir, "checkout", "-b", "skip-target", baseHash)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target conflict change")
	headBefore := runRealGit(t, dir, "rev-parse", "HEAD")

	w := postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "commit": mergeHash, "mainline": 1,
	})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.FileExists(t, gitOperationOwnershipStatePath(dir))

	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "action": "skip"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, headBefore, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitCherryPickMainlineStartFailureCleansOwnershipState(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	runRealGit(t, dir, "checkout", "-b", "ordinary-source")
	commitRealFile(t, dir, "ordinary.txt", "ordinary\n", "ordinary change")
	ordinaryHash := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	r := setupGitOperationRouter()

	w := postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "commit": ordinaryHash, "mainline": 2,
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "failed", response.State)
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitCherryPickExternalMainlineConflictFailsClosed(t *testing.T) {
	dir, _, baseHash, mergeHash := mergeCommitMainlineFixture(t)
	r := setupGitOperationRouter()
	runRealGit(t, dir, "checkout", "-b", "external-target", baseHash)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target conflict change")

	cmd := exec.Command("git", "cherry-pick", "-m", "1", mergeHash)
	cmd.Dir = dir
	_, err := cmd.CombinedOutput()
	require.Error(t, err)
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))

	w := postJSON(r, "/git/cherry-pick", map[string]string{
		"path": dir, "action": "continue",
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Error, "cannot determine mainline parent")

	// Abort is still allowed and must not leave metadata behind.
	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitRevertMainlineRejectsPathChangedOnlyAgainstOtherParent(t *testing.T) {
	dir, _, _, mergeHash := mergeCommitMainlineFixture(t)
	r := setupGitOperationRouter()
	commitRealFile(t, dir, "conflict.txt", "after merge\n", "post-merge conflict change")

	w := postJSON(r, "/git/revert", map[string]string{"path": dir, "commit": mergeHash})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")
	require.FileExists(t, gitOperationOwnershipStatePath(dir))

	assertMainlineContinueRejectsOtherParentPath(t, r, "/git/revert", dir)
	w = postJSON(r, "/git/revert", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitOperationContinueAllowsOperationOwnedStagedPaths(t *testing.T) {
	t.Run("merge", func(t *testing.T) {
		dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		runRealGit(t, dir, "checkout", "-b", "feature")
		commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
		commitRealFile(t, dir, "operation-owned.txt", "merge\n", "owned change")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "conflict.txt", "main\n", "main change")

		w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": "feature"})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		w = postJSON(r, "/git/merge", map[string]interface{}{
			"path": dir, "action": "continue", "files": []string{"conflict.txt"},
		})
		response = operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Equal(t, "merge", runRealGit(t, dir, "show", "HEAD:operation-owned.txt"))
	})

	t.Run("rebase", func(t *testing.T) {
		dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		runRealGit(t, dir, "checkout", "-b", "feature")
		writeOperationFile(t, dir, "conflict.txt", "feature\n")
		writeOperationFile(t, dir, "operation-owned.txt", "rebase\n")
		runRealGit(t, dir, "add", "--", "conflict.txt", "operation-owned.txt")
		runRealGit(t, dir, "commit", "-m", "feature change")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "conflict.txt", "main\n", "main change")
		runRealGit(t, dir, "checkout", "feature")

		w := postJSON(r, "/git/rebase", map[string]string{"path": dir, "upstream": baseBranch})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		w = postJSON(r, "/git/rebase", map[string]interface{}{
			"path": dir, "action": "continue", "files": []string{"conflict.txt"},
		})
		response = operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Equal(t, "rebase", runRealGit(t, dir, "show", "HEAD:operation-owned.txt"))
	})

	t.Run("cherry-pick", func(t *testing.T) {
		dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		runRealGit(t, dir, "checkout", "-b", "source")
		writeOperationFile(t, dir, "conflict.txt", "source\n")
		writeOperationFile(t, dir, "operation-owned.txt", "cherry-pick\n")
		runRealGit(t, dir, "add", "--", "conflict.txt", "operation-owned.txt")
		runRealGit(t, dir, "commit", "-m", "source change")
		pickedHash := runRealGit(t, dir, "rev-parse", "HEAD")
		runRealGit(t, dir, "checkout", baseBranch)
		commitRealFile(t, dir, "conflict.txt", "target\n", "target change")

		w := postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "commit": pickedHash})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		w = postJSON(r, "/git/cherry-pick", map[string]interface{}{
			"path": dir, "action": "continue", "files": []string{"conflict.txt"},
		})
		response = operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Equal(t, "cherry-pick", runRealGit(t, dir, "show", "HEAD:operation-owned.txt"))
	})

	t.Run("revert", func(t *testing.T) {
		dir, _, _ := operationRepoWithBase(t, "base\n")
		r := setupGitOperationRouter()
		writeOperationFile(t, dir, "conflict.txt", "first\n")
		writeOperationFile(t, dir, "operation-owned.txt", "revert\n")
		runRealGit(t, dir, "add", "--", "conflict.txt", "operation-owned.txt")
		commitRealFile(t, dir, "operation-owned.txt", "revert\n", "change to revert")
		commitHash := runRealGit(t, dir, "rev-parse", "HEAD")
		commitRealFile(t, dir, "conflict.txt", "second\n", "second change")

		w := postJSON(r, "/git/revert", map[string]string{"path": dir, "commit": commitHash})
		response := operationResponse(t, w.Body)
		require.False(t, response.OK)
		writeOperationFile(t, dir, "conflict.txt", "resolved\n")
		w = postJSON(r, "/git/revert", map[string]interface{}{
			"path": dir, "action": "continue", "files": []string{"conflict.txt"},
		})
		response = operationResponse(t, w.Body)
		require.True(t, response.OK, response.Error)
		require.Error(t, exec.Command("git", "-C", dir, "cat-file", "-e", "HEAD:operation-owned.txt").Run())
	})
}

func TestGitResetStartAllowsExistingStagedChanges(t *testing.T) {
	dir, baseBranch, baseHash := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()
	commitRealFile(t, dir, "second.txt", "second\n", "second commit")
	writeOperationFile(t, dir, "staged.txt", "staged\n")
	runRealGit(t, dir, "add", "--", "staged.txt")

	w := postJSON(r, "/git/reset-to-commit", map[string]string{
		"path": dir, "ref": baseHash, "mode": "soft",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Equal(t, baseHash, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, baseBranch, currentOperationBranch(t, dir))
	staged := runRealGit(t, dir, "diff", "--cached", "--name-only")
	require.Contains(t, staged, "staged.txt")
	require.Contains(t, staged, "second.txt")
}

func TestGitRebaseConflictContinueAndOperationStatus(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	commitRealFile(t, dir, "unrelated.txt", "clean\n", "unrelated base")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "main\n", "main change")
	runRealGit(t, dir, "checkout", "feature")

	w := postJSON(r, "/git/rebase", map[string]string{"path": dir, "upstream": baseBranch})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "rebase", response.Operation)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")
	require.NotNil(t, response.Progress)

	w = postJSON(r, "/git/operation-status", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	status := operationResponse(t, w.Body)
	require.Equal(t, "rebase", status.Operation)
	require.Equal(t, "conflicts", status.State)

	writeOperationFile(t, dir, "unrelated.txt", "dirty\n")
	writeOperationFile(t, dir, "conflict.txt", "resolved\n")
	w = postJSON(r, "/git/rebase", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "in_progress", response.State)
	require.Contains(t, response.Error, "merge conflicts")

	// Rebase itself refuses to continue while an unrelated tracked edit is
	// present. Once that edit is restored, the explicitly staged conflict can
	// be continued without pulling the unrelated path into the commit.
	writeOperationFile(t, dir, "unrelated.txt", "clean\n")
	w = postJSON(r, "/git/rebase", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Empty(t, response.Conflicts)
	require.Equal(t, "resolved", runRealGit(t, dir, "show", "HEAD:conflict.txt"))
	require.NotContains(t, runRealGit(t, dir, "show", "--format=", "--name-only", "HEAD"), "unrelated.txt")
}

func TestGitRebaseConflictAbort(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
	featureHead := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "main\n", "main change")
	runRealGit(t, dir, "checkout", "feature")

	w := postJSON(r, "/git/rebase", map[string]string{"path": dir, "upstream": baseBranch})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)

	w = postJSON(r, "/git/rebase", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "aborted", response.State)
	require.Equal(t, "rebase", response.Operation)
	require.Equal(t, featureHead, runRealGit(t, dir, "rev-parse", "HEAD"))
}

func TestGitCherryPickSuccessConflictContinueAndAbort(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()

	runRealGit(t, dir, "checkout", "-b", "source")
	commitRealFile(t, dir, "picked.txt", "picked\n", "picked commit")
	pickedHash := runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	w := postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "commit": pickedHash})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Equal(t, "picked commit", runRealGit(t, dir, "log", "-1", "--format=%s"))

	// Build an independent conflicting commit and verify the conflict lifecycle.
	dir, baseBranch, _ = operationRepoWithBase(t, "base\n")
	runRealGit(t, dir, "checkout", "-b", "source")
	commitRealFile(t, dir, "conflict.txt", "source\n", "source change")
	pickedHash = runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target change")

	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "sha": pickedHash})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "cherry-pick", response.Operation)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")

	writeOperationFile(t, dir, "conflict.txt", "resolved\n")
	w = postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Equal(t, "resolved", runRealGit(t, dir, "show", "HEAD:conflict.txt"))

	// Recreate the conflict to cover abort.
	dir, baseBranch, _ = operationRepoWithBase(t, "base\n")
	runRealGit(t, dir, "checkout", "-b", "source")
	commitRealFile(t, dir, "conflict.txt", "source\n", "source change")
	pickedHash = runRealGit(t, dir, "rev-parse", "HEAD")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target change")
	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "commit": pickedHash})
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	w = postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "aborted", response.State)
	require.Equal(t, "cherry-pick", response.Operation)
}

func TestGitCherryPickRejectsCommitAlreadyInHeadHistory(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "base")
	ancestor := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "next.txt", "next\n", "next")
	headBefore := runRealGit(t, dir, "rev-parse", "HEAD")
	countBefore := runRealGit(t, dir, "rev-list", "--count", "HEAD")
	r := setupGitOperationRouter()

	w := postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "commit": ancestor})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "invalid", response.State)
	require.Contains(t, response.Error, "already an ancestor of HEAD")
	require.Equal(t, headBefore, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, countBefore, runRealGit(t, dir, "rev-list", "--count", "HEAD"))
	require.Equal(t, "none", collectGitOperationDiskState(dir).Operation)
	require.NoFileExists(t, gitOperationOwnershipStatePath(dir))
}

func TestGitCherryPickDropsRedundantPatchWithoutEmptyCommit(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "same.txt", "base\n", "base")
	base := runRealGit(t, dir, "rev-parse", "HEAD")

	runRealGit(t, dir, "checkout", "-b", "source")
	commitRealFile(t, dir, "same.txt", "same\n", "source change")
	sourceCommit := runRealGit(t, dir, "rev-parse", "HEAD")

	runRealGit(t, dir, "checkout", "-b", "target", base)
	commitRealFile(t, dir, "same.txt", "same\n", "target change")
	targetHead := runRealGit(t, dir, "rev-parse", "HEAD")
	countBefore := runRealGit(t, dir, "rev-list", "--count", "HEAD")
	r := setupGitOperationRouter()

	w := postJSON(r, "/git/cherry-pick", map[string]string{"path": dir, "commit": sourceCommit})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "cherry-pick", response.Operation)
	require.Equal(t, "completed", response.State)
	require.Equal(t, targetHead, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, countBefore, runRealGit(t, dir, "rev-list", "--count", "HEAD"))
}

func TestGitRevertSuccessConflictContinueAndAbort(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()
	commitRealFile(t, dir, "revert.txt", "added\n", "add file")
	commitHash := runRealGit(t, dir, "rev-parse", "HEAD")

	w := postJSON(r, "/git/revert", map[string]string{"path": dir, "commit": commitHash})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)

	// Revert a same-line change after a subsequent conflicting change.
	dir, baseBranch, _ = operationRepoWithBase(t, "base\n")
	commitRealFile(t, dir, "conflict.txt", "first\n", "first change")
	commitHash = runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "conflict.txt", "second\n", "second change")
	w = postJSON(r, "/git/revert", map[string]string{"path": dir, "sha": commitHash})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "revert", response.Operation)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")

	writeOperationFile(t, dir, "conflict.txt", "reverted\n")
	w = postJSON(r, "/git/revert", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"conflict.txt"},
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "completed", response.State)
	require.Equal(t, "reverted", runRealGit(t, dir, "show", "HEAD:conflict.txt"))

	// Abort a freshly recreated revert conflict.
	dir, baseBranch, _ = operationRepoWithBase(t, "base\n")
	commitRealFile(t, dir, "conflict.txt", "first\n", "first change")
	commitHash = runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "conflict.txt", "second\n", "second change")
	w = postJSON(r, "/git/revert", map[string]string{"path": dir, "commit": commitHash})
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	w = postJSON(r, "/git/revert", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "aborted", response.State)
	require.Equal(t, "revert", response.Operation)
	_ = baseBranch
}

func TestGitResetToCommitModesAndValidation(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "value.txt", "one\n", "one")
	first := runRealGit(t, dir, "rev-parse", "HEAD")
	commitRealFile(t, dir, "value.txt", "two\n", "two")
	r := setupGitOperationRouter()

	w := postJSON(r, "/git/reset-to-commit", map[string]string{"path": dir, "commit": first, "mode": "hard"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.True(t, response.OK, response.Error)
	require.Equal(t, "reset", response.Operation)
	require.Equal(t, "completed", response.State)
	require.Equal(t, first, runRealGit(t, dir, "rev-parse", "HEAD"))
	require.Equal(t, "one", runRealGit(t, dir, "show", "HEAD:value.txt"))

	w = postJSON(r, "/git/reset-to-commit", map[string]string{"path": dir, "ref": "missing-ref"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "invalid", response.State)

	w = postJSON(r, "/git/reset-to-commit", map[string]string{"path": dir, "ref": "-bad-ref"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.Contains(t, response.Error, "cannot start with '-'")

	w = postJSON(r, "/git/reset-to-commit", map[string]string{"path": dir, "ref": first, "mode": "invalid"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.Contains(t, response.Error, "invalid reset mode")
}

func TestGitOperationPathValidationOnContinue(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	r := setupGitOperationRouter()
	runRealGit(t, dir, "checkout", "-b", "feature")
	commitRealFile(t, dir, "conflict.txt", "feature\n", "feature change")
	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "main\n", "main change")

	w := postJSON(r, "/git/merge", map[string]string{"path": dir, "ref": "feature"})
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)

	w = postJSON(r, "/git/merge", map[string]interface{}{
		"path": dir, "action": "continue", "files": []string{"../outside.txt"},
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "conflicts", response.State)
	require.Contains(t, response.Error, "escapes repository")

	// The invalid ref is rejected before Git is invoked, including option-like refs.
	idleDir := newRealGitRepo(t)
	commitRealFile(t, idleDir, "file.txt", "base\n", "base")
	w = postJSON(r, "/git/merge", map[string]string{"path": idleDir, "ref": "-bad"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.Contains(t, response.Error, "cannot start with '-'")
}

func TestValidateGitOperationPathRejectsDirectories(t *testing.T) {
	repoRoot := t.TempDir()
	dirPath := filepath.Join(repoRoot, "nested")
	require.NoError(t, os.MkdirAll(dirPath, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(dirPath, "one.txt"), []byte("one\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoRoot, "file.txt"), []byte("file\n"), 0644))

	_, err := validateGitOperationPath(repoRoot, "nested")
	require.ErrorContains(t, err, "not a directory")
	_, err = validateGitOperationPath(repoRoot, "nested/")
	require.ErrorContains(t, err, "not a directory")

	linkPath := filepath.Join(repoRoot, "nested-link")
	if err := os.Symlink(dirPath, linkPath); err == nil {
		_, err = validateGitOperationPath(repoRoot, "nested-link")
		require.ErrorContains(t, err, "not a directory")
	}

	path, err := validateGitOperationPath(repoRoot, "file.txt")
	require.NoError(t, err)
	require.Equal(t, "file.txt", path)
	path, err = validateGitOperationPath(repoRoot, "deleted.txt")
	require.NoError(t, err)
	require.Equal(t, "deleted.txt", path)
}

func TestGitOperationContinueRequiresMatchingOperation(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "file.txt", "base\n", "base")
	r := setupGitOperationRouter()

	w := postJSON(r, "/git/rebase", map[string]interface{}{"path": dir, "action": "continue"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "invalid", response.State)
	require.Contains(t, response.Error, "no rebase operation")
}

func TestGitOperationStatusDoesNotMisclassifyGitAM(t *testing.T) {
	dir, baseBranch, _ := operationRepoWithBase(t, "base\n")
	root := t.TempDir()
	patchPath := filepath.Join(root, "change.patch")

	runRealGit(t, dir, "checkout", "-b", "source")
	commitRealFile(t, dir, "conflict.txt", "source\n", "source change")
	patchCmd := exec.Command("git", "format-patch", "-1", "--stdout")
	patchCmd.Dir = dir
	patch, err := patchCmd.Output()
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(patchPath, patch, 0600))

	runRealGit(t, dir, "checkout", baseBranch)
	commitRealFile(t, dir, "conflict.txt", "target\n", "target change")
	// The three-way mode leaves a real unmerged index and the `applying`
	// marker, matching the state that can coexist with conflict UI actions.
	amCmd := exec.Command("git", "am", "--3way", patchPath)
	amCmd.Dir = dir
	_, err = amCmd.CombinedOutput()
	require.Error(t, err)
	t.Cleanup(func() {
		abort := exec.Command("git", "am", "--abort")
		abort.Dir = dir
		_ = abort.Run()
	})

	state := collectGitOperationDiskState(dir)
	require.Equal(t, "none", state.Operation)
	require.Equal(t, "idle", state.State)

	r := setupGitOperationRouter()
	w := postJSON(r, "/git/operation-status", map[string]string{"path": dir})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.Equal(t, "none", response.Operation)
	require.Equal(t, "idle", response.State)
	require.Contains(t, response.Conflicts, "conflict.txt")

	// The API must not let a mail-application state through the rebase
	// continue/abort path merely because both operations use rebase-apply.
	w = postJSON(r, "/git/rebase", map[string]string{"path": dir, "action": "abort"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response = operationResponse(t, w.Body)
	require.Equal(t, "invalid", response.State)
	require.Contains(t, response.Error, "no rebase operation")
}

func TestGitOperationResponseHasNoControlOutput(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "file.txt", "base\n", "base")
	r := setupGitOperationRouter()

	w := postJSON(r, "/git/cherry-pick", map[string]interface{}{
		"path": dir, "commit": "\n-bad",
	})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	response := operationResponse(t, w.Body)
	require.False(t, response.OK)
	require.Equal(t, "invalid", response.State)
	require.NotContains(t, response.Error, "\n")
	// Keep strings import used for the explicit control-character assertion.
	require.True(t, strings.IndexByte(response.Error, '\x00') < 0)
}
