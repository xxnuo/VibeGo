package handler

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/middleware"
)

func TestFileViewSessionLogoutRevokesOnlyCurrentBrowser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const key = "test-key"
	tmpDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmpDir, "media.bin"), []byte("0123456789"), 0644))

	fileViews, err := middleware.NewFileViewAuthorizer()
	require.NoError(t, err)
	fileHandler := NewFileHandler(fileViews)
	fileHandler.SetBaseDir(tmpDir)

	r := gin.New()
	api := r.Group("/api")
	NewAuthHandler(nil, key, true).Register(api)
	api.Use(middleware.Auth(key, fileViews))
	fileHandler.Register(api)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	first := newFileViewTestClient(t)
	second := newFileViewTestClient(t)
	firstGrant := requestFileViewGrant(t, first, server.URL, key)
	secondGrant := requestFileViewGrant(t, second, server.URL, key)
	require.NotEqual(t, firstGrant, secondGrant)

	assertFileViewStatus(t, first, server.URL+firstGrant, http.StatusOK)
	assertFileViewStatus(t, second, server.URL+secondGrant, http.StatusOK)
	assertFileViewStatus(t, first, server.URL+secondGrant, http.StatusUnauthorized)

	req, err := http.NewRequest(http.MethodPost, server.URL+"/api/file/view-session/logout", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+key)
	response, err := first.Do(req)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)

	downloadURL, err := url.Parse(server.URL + "/api/file/download")
	require.NoError(t, err)
	assert.Empty(t, first.Jar.Cookies(downloadURL), "logout must clear the path-scoped browser cookie")
	assertFileViewStatus(t, first, server.URL+firstGrant, http.StatusUnauthorized)
	assertFileViewStatus(t, second, server.URL+secondGrant, http.StatusOK)
}

func newFileViewTestClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	return &http.Client{Jar: jar}
}

func requestFileViewGrant(t *testing.T, client *http.Client, serverURL, key string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, serverURL+"/api/file/view-url?path=media.bin", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+key)
	response, err := client.Do(req)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
	var grant struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&grant))
	require.NotEmpty(t, grant.URL)
	return grant.URL
}

func assertFileViewStatus(t *testing.T, client *http.Client, target string, want int) {
	t.Helper()
	response, err := client.Get(target)
	require.NoError(t, err)
	response.Body.Close()
	assert.Equal(t, want, response.StatusCode)
}
