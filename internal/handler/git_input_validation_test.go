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

func setupGitInputValidationRepo(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "origin.git")
	repo := filepath.Join(root, "repo")
	require.NoError(t, os.Mkdir(repo, 0755))

	runGitInputValidationCommand(t, root, "init", "--bare", remote)
	runGitInputValidationCommand(t, repo, "init")
	runGitInputValidationCommand(t, repo, "config", "user.name", "VibeGo Test")
	runGitInputValidationCommand(t, repo, "config", "user.email", "vibego-test@example.com")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "README.md"), []byte("base\n"), 0644))
	runGitInputValidationCommand(t, repo, "add", "--", "README.md")
	runGitInputValidationCommand(t, repo, "commit", "-m", "initial")
	runGitInputValidationCommand(t, repo, "remote", "add", "origin", remote)
	runGitInputValidationCommand(t, repo, "push", "-u", "origin", "HEAD")
	return repo, remote
}

func runGitInputValidationCommand(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(output)))
	return strings.TrimSpace(string(output))
}

func gitInputValidationRefExists(t *testing.T, repo, ref string) bool {
	t.Helper()
	cmd := exec.Command("git", "show-ref", "--verify", "--quiet", ref)
	cmd.Dir = repo
	return cmd.Run() == nil
}

func TestGitLegacyBranchInputValidation(t *testing.T) {
	repo, _ := setupGitInputValidationRepo(t)
	baseBranch := runGitInputValidationCommand(t, repo, "branch", "--show-current")
	runGitInputValidationCommand(t, repo, "branch", "other")
	runGitInputValidationCommand(t, repo, "checkout", "other")
	runGitInputValidationCommand(t, repo, "checkout", baseBranch)
	require.NoError(t, os.WriteFile(filepath.Join(repo, "dirty.txt"), []byte("dirty\n"), 0644))

	router, _ := setupRouter()
	tests := []struct {
		name string
		path string
		body map[string]interface{}
	}{
		{name: "switch option", path: "/git/switch-branch", body: map[string]interface{}{"path": repo, "branch": "--detach"}},
		{name: "smart switch control", path: "/git/smart-switch-branch", body: map[string]interface{}{"path": repo, "branch": "other\n--force"}},
		{name: "create checkout shorthand", path: "/git/create-branch", body: map[string]interface{}{"path": repo, "branch": "@{-1}"}},
		{name: "delete option", path: "/git/delete-branch", body: map[string]interface{}{"path": repo, "branch": "--all"}},
		{name: "create invalid start point", path: "/git/create-branch", body: map[string]interface{}{"path": repo, "branch": "not-created", "from": "--help"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := postJSON(router, test.path, test.body)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}

	require.Equal(t, baseBranch, runGitInputValidationCommand(t, repo, "branch", "--show-current"))
	require.Empty(t, runGitInputValidationCommand(t, repo, "stash", "list"))
	require.FileExists(t, filepath.Join(repo, "dirty.txt"))
	require.False(t, gitInputValidationRefExists(t, repo, "refs/heads/not-created"))

	response := postJSON(router, "/git/create-branch", map[string]interface{}{
		"path": repo, "branch": "from-expression", "from": "HEAD~0",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t,
		runGitInputValidationCommand(t, repo, "rev-parse", "HEAD"),
		runGitInputValidationCommand(t, repo, "rev-parse", "refs/heads/from-expression"),
	)
}

func TestGitLegacyRemoteAndRefInputValidation(t *testing.T) {
	repo, _ := setupGitInputValidationRepo(t)
	runGitInputValidationCommand(t, repo, "tag", "candidate")
	router, _ := setupRouter()

	tests := []struct {
		name string
		path string
		body map[string]interface{}
	}{
		{name: "tags", path: "/git/tags", body: map[string]interface{}{"path": repo, "remote": "--help"}},
		{name: "create tag", path: "/git/create-tag", body: map[string]interface{}{"path": repo, "name": "not-created", "commit": "HEAD", "remote": "--help"}},
		{name: "delete tag", path: "/git/delete-tag", body: map[string]interface{}{"path": repo, "name": "candidate", "remote": "--help"}},
		{name: "fetch", path: "/git/fetch", body: map[string]interface{}{"path": repo, "remote": "--all"}},
		{name: "pull", path: "/git/pull", body: map[string]interface{}{"path": repo, "remote": "origin\n--upload-pack=bad"}},
		{name: "push", path: "/git/push", body: map[string]interface{}{"path": repo, "remote": "missing"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := postJSON(router, test.path, test.body)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}
	require.False(t, gitInputValidationRefExists(t, repo, "refs/tags/not-created"))
	require.True(t, gitInputValidationRefExists(t, repo, "refs/tags/candidate"))

	response := postJSON(router, "/git/pull", map[string]interface{}{
		"path": repo, "remote": "origin", "branch": "--upload-pack=bad",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())

	response = postJSON(router, "/git/create-tag", map[string]interface{}{
		"path": repo, "name": "invalid-commit", "commit": "--help", "remote": "origin",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	require.False(t, gitInputValidationRefExists(t, repo, "refs/tags/invalid-commit"))

	response = postJSON(router, "/git/create-tag", map[string]interface{}{
		"path": repo, "name": "from-expression", "commit": "HEAD~0", "remote": "origin",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t,
		runGitInputValidationCommand(t, repo, "rev-parse", "HEAD"),
		runGitInputValidationCommand(t, repo, "rev-parse", "refs/tags/from-expression^{}"),
	)

	response = postJSON(router, "/git/create-tag", map[string]interface{}{
		"path": repo, "name": " spaced-tag ", "commit": " HEAD ", "remote": "origin",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.True(t, gitInputValidationRefExists(t, repo, "refs/tags/spaced-tag"))

	response = postJSON(router, "/git/delete-tag", map[string]interface{}{
		"path": repo, "name": " spaced-tag ", "remote": "origin",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.False(t, gitInputValidationRefExists(t, repo, "refs/tags/spaced-tag"))

	branch := runGitInputValidationCommand(t, repo, "branch", "--show-current")
	response = postJSON(router, "/git/pull", map[string]interface{}{
		"path": repo, "remote": "origin", "branch": branch,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	response = postJSON(router, "/git/pull", map[string]interface{}{
		"path": repo, "remote": "origin", "branch": " refs/heads/" + branch + " ",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	runGitInputValidationCommand(t, repo, "remote", "set-url", "origin", filepath.Join(filepath.Dir(repo), "missing-origin.git"))
	response = postJSON(router, "/git/pull", map[string]interface{}{
		"path": repo, "remote": "origin", "branch": branch,
	})
	require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
	require.NotEmpty(t, response.Body.String())
}

func TestGitDeleteLocalTagWithoutRemote(t *testing.T) {
	repoRoot := t.TempDir()
	runGitInputValidationCommand(t, repoRoot, "init")
	runGitInputValidationCommand(t, repoRoot, "config", "user.name", "VibeGo Test")
	runGitInputValidationCommand(t, repoRoot, "config", "user.email", "vibego-test@example.com")
	require.NoError(t, os.WriteFile(filepath.Join(repoRoot, "README.md"), []byte("base\n"), 0644))
	runGitInputValidationCommand(t, repoRoot, "add", "--", "README.md")
	runGitInputValidationCommand(t, repoRoot, "commit", "-m", "initial")
	runGitInputValidationCommand(t, repoRoot, "tag", "local-only")

	router, _ := setupRouter()
	response := postJSON(router, "/git/delete-tag", map[string]interface{}{
		"path": repoRoot,
		"name": " local-only ",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.False(t, gitInputValidationRefExists(t, repoRoot, "refs/tags/local-only"))
}

func TestGitPatchPayloadRejectsUndeclaredPaths(t *testing.T) {
	repo, _ := setupGitInputValidationRepo(t)
	require.NoError(t, os.WriteFile(filepath.Join(repo, "other.txt"), []byte("other\n"), 0644))
	runGitInputValidationCommand(t, repo, "add", "--", "other.txt")
	runGitInputValidationCommand(t, repo, "commit", "-m", "add other file")

	require.NoError(t, os.WriteFile(filepath.Join(repo, "README.md"), []byte("changed readme\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "other.txt"), []byte("changed other\n"), 0644))

	readmePatchCmd := exec.Command("git", "diff", "--", "README.md")
	readmePatchCmd.Dir = repo
	readmePatch, err := readmePatchCmd.Output()
	require.NoError(t, err)
	require.NotEmpty(t, readmePatch)

	multiPatchCmd := exec.Command("git", "diff", "--", "README.md", "other.txt")
	multiPatchCmd.Dir = repo
	multiPatch, err := multiPatchCmd.Output()
	require.NoError(t, err)
	require.NotEmpty(t, multiPatch)

	router, _ := setupRouter()
	tests := []struct {
		name string
		path string
		body map[string]interface{}
	}{
		{
			name: "add patch mismatched file",
			path: "/git/add-patch",
			body: map[string]interface{}{
				"path": repo, "filePath": "other.txt", "patch": string(readmePatch),
			},
		},
		{
			name: "selected commit mismatched file",
			path: "/git/commit-selected",
			body: map[string]interface{}{
				"path": repo,
				"patches": []map[string]string{
					{"filePath": "other.txt", "patch": string(readmePatch)},
				},
				"summary": "must not commit",
			},
		},
		{
			name: "add patch with extra file",
			path: "/git/add-patch",
			body: map[string]interface{}{
				"path": repo, "filePath": "README.md", "patch": string(multiPatch),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := postJSON(router, test.path, test.body)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Empty(t, runGitInputValidationCommand(t, repo, "diff", "--cached", "--name-only"))
		})
	}
	require.NotEqual(t, "must not commit", runGitInputValidationCommand(t, repo, "log", "-1", "--format=%s"))
}

func TestGitTagEndpointsPreserveEmptyRemoteCompatibility(t *testing.T) {
	repo := t.TempDir()
	runGitInputValidationCommand(t, repo, "init")
	runGitInputValidationCommand(t, repo, "config", "user.name", "VibeGo Test")
	runGitInputValidationCommand(t, repo, "config", "user.email", "vibego-test@example.com")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "README.md"), []byte("base\n"), 0644))
	runGitInputValidationCommand(t, repo, "add", "--", "README.md")
	runGitInputValidationCommand(t, repo, "commit", "-m", "initial")

	router, _ := setupRouter()
	response := postJSON(router, "/git/tags", map[string]interface{}{"path": repo})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	response = postJSON(router, "/git/create-tag", map[string]interface{}{
		"path": repo, "name": "local-only", "commit": "HEAD",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.True(t, gitInputValidationRefExists(t, repo, "refs/tags/local-only"))
}

func TestGitBranchRefInputsNormalizeToShortNames(t *testing.T) {
	repo, _ := setupGitInputValidationRepo(t)
	router, _ := setupRouter()

	response := postJSON(router, "/git/create-branch", map[string]interface{}{
		"path": repo, "branch": " refs/heads/ref-created ", "from": "HEAD",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var createResult struct {
		OK     bool   `json:"ok"`
		Branch string `json:"branch"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &createResult))
	require.True(t, createResult.OK)
	require.Equal(t, "ref-created", createResult.Branch)
	require.True(t, gitInputValidationRefExists(t, repo, "refs/heads/ref-created"))

	response = postJSON(router, "/git/switch-branch", map[string]interface{}{
		"path": repo, "branch": "refs/heads/ref-created",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var switchResult struct {
		Branch string `json:"branch"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &switchResult))
	require.Equal(t, "ref-created", switchResult.Branch)
	require.Equal(t, "ref-created", runGitInputValidationCommand(t, repo, "branch", "--show-current"))

	response = postJSON(router, "/git/create-branch", map[string]interface{}{
		"path": repo, "branch": "refs/heads/ref-smart", "from": "HEAD",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = postJSON(router, "/git/smart-switch-branch", map[string]interface{}{
		"path": repo, "branch": "refs/heads/ref-smart",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "ref-smart", runGitInputValidationCommand(t, repo, "branch", "--show-current"))

	response = postJSON(router, "/git/switch-branch", map[string]interface{}{
		"path": repo, "branch": "refs/heads/ref-created",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = postJSON(router, "/git/delete-branch", map[string]interface{}{
		"path": repo, "branch": " refs/heads/ref-smart ",
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.False(t, gitInputValidationRefExists(t, repo, "refs/heads/ref-smart"))
}
