package handler

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestGitWriteEndpointWaitsForCanonicalRepoLock guards the boundary between
// advanced operations and ordinary index mutations. Holding the process-local
// lock directly makes the assertion deterministic and avoids depending on Git
// hook timing or scheduler luck.
func TestGitWriteEndpointWaitsForCanonicalRepoLock(t *testing.T) {
	dir := newRealGitRepo(t)
	commitRealFile(t, dir, "base.txt", "base\n", "base")
	writeOperationFile(t, dir, "staged.txt", "staged\n")

	r, _ := setupRouter()
	unlock := lockGitOperationRepo(dir)

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- postJSON(r, "/git/add", map[string]interface{}{
			"path":  dir,
			"files": []string{"staged.txt"},
		})
	}()

	select {
	case response := <-done:
		t.Fatalf("git add crossed the repository lock: status=%d body=%s", response.Code, response.Body.String())
	case <-time.After(150 * time.Millisecond):
	}
	require.Empty(t, runRealGit(t, dir, "diff", "--cached", "--name-only"))

	unlock()
	select {
	case response := <-done:
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	case <-time.After(5 * time.Second):
		t.Fatal("git add did not proceed after repository lock release")
	}
	require.Equal(t, "staged.txt", runRealGit(t, dir, "diff", "--cached", "--name-only"))

	// Keep the test honest if a future implementation accidentally leaves a
	// lock entry held after the request completes.
	acquired := make(chan struct{}, 1)
	go func() {
		secondUnlock := lockGitOperationRepo(dir)
		close(acquired)
		secondUnlock()
	}()
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("repository lock remained held after git add completed")
	}
}

func TestGitInitWaitsForTargetLock(t *testing.T) {
	target := filepath.Join(t.TempDir(), "new-repo")
	r, _ := setupRouter()
	unlock := lockGitOperationRepo(target)

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- postJSON(r, "/git/init", map[string]string{"path": target})
	}()

	select {
	case response := <-done:
		t.Fatalf("git init crossed the target lock: status=%d body=%s", response.Code, response.Body.String())
	case <-time.After(150 * time.Millisecond):
	}
	require.NoDirExists(t, target)

	unlock()
	select {
	case response := <-done:
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	case <-time.After(5 * time.Second):
		t.Fatal("git init did not proceed after target lock release")
	}
	require.DirExists(t, filepath.Join(target, ".git"))
}

func TestGitCloneWaitsForTargetLock(t *testing.T) {
	source := newRealGitRepo(t)
	commitRealFile(t, source, "base.txt", "base\n", "base")
	target := filepath.Join(t.TempDir(), "clone")
	r, _ := setupRouter()
	unlock := lockGitOperationRepo(target)

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- postJSON(r, "/git/clone", map[string]string{"url": source, "path": target})
	}()

	select {
	case response := <-done:
		t.Fatalf("git clone crossed the target lock: status=%d body=%s", response.Code, response.Body.String())
	case <-time.After(150 * time.Millisecond):
	}
	require.NoDirExists(t, target)

	unlock()
	select {
	case response := <-done:
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	case <-time.After(5 * time.Second):
		t.Fatal("git clone did not proceed after target lock release")
	}
	require.FileExists(t, filepath.Join(target, "base.txt"))
}

func TestGitMutationLockPathUsesEnclosingRepository(t *testing.T) {
	repoRoot := newRealGitRepo(t)
	target := filepath.Join(repoRoot, "nested", "new-repo")
	require.Equal(t, canonicalGitOperationRepoRoot(repoRoot), canonicalGitOperationRepoRoot(gitOperationLockPathForMutation(target)))
}

func TestCanonicalGitOperationRepoRootResolvesMissingSymlinkLeaf(t *testing.T) {
	realParent := t.TempDir()
	linkParent := filepath.Join(t.TempDir(), "parent-link")
	if err := os.Symlink(realParent, linkParent); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	realTarget := filepath.Join(realParent, "missing", "repo")
	linkTarget := filepath.Join(linkParent, "missing", "repo")
	require.Equal(t, canonicalGitOperationRepoRoot(realTarget), canonicalGitOperationRepoRoot(linkTarget))
}
