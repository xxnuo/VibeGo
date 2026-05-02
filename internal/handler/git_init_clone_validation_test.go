package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGitInitRejectsUnsafeTargetArguments(t *testing.T) {
	r, _ := setupRouter()
	for _, tc := range []struct {
		name string
		path string
	}{
		{name: "option", path: "-template=evil"},
		{name: "nul", path: "repo\x00name"},
		{name: "newline", path: "repo\nname"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := postJSON(r, "/git/init", map[string]string{"path": tc.path})
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
		})
	}
}

func TestGitCloneRejectsUnsafeArguments(t *testing.T) {
	r, _ := setupRouter()
	for _, tc := range []struct {
		name string
		url  string
		path string
	}{
		{name: "option-url", url: "-upload-pack=evil", path: "clone"},
		{name: "option-path", url: "https://example.invalid/repo.git", path: "-clone"},
		{name: "nul-url", url: "file\x00repo", path: "clone"},
		{name: "control-path", url: "file:///tmp/repo", path: "clone\nname"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := postJSON(r, "/git/clone", map[string]string{"url": tc.url, "path": tc.path})
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
		})
	}
}

func TestGitInitAllowsExplicitRelativeDashName(t *testing.T) {
	parent := t.TempDir()
	path := filepath.Join(parent, "-repo")
	r, _ := setupRouter()
	w := postJSON(r, "/git/init", map[string]string{"path": path})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.DirExists(t, filepath.Join(path, ".git"))
	require.NoError(t, os.RemoveAll(path))
}
