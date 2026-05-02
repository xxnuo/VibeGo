package handler

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/middleware"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
)

type testSFTPProvider struct {
	root string
	err  error
	wg   sync.WaitGroup
}

type singleSFTPClientProvider struct {
	client *sftp.Client
}

type blockAwareSFTPProvider struct {
	base *testSFTPProvider

	mu       sync.Mutex
	terminal string
	blockID  string
	created  int64
	calls    int
}

func (p *singleSFTPClientProvider) OpenSFTP(context.Context, string) (*sftp.Client, error) {
	return p.client, nil
}

func (p *blockAwareSFTPProvider) OpenSFTP(ctx context.Context, terminalID string) (*sftp.Client, error) {
	return p.base.OpenSFTP(ctx, terminalID)
}

func (p *blockAwareSFTPProvider) OpenBlockSFTP(
	ctx context.Context,
	terminalID, blockID string,
	blockCreatedAt int64,
) (*sftp.Client, error) {
	p.mu.Lock()
	p.terminal = terminalID
	p.blockID = blockID
	p.created = blockCreatedAt
	p.calls++
	p.mu.Unlock()
	return p.base.OpenSFTP(ctx, terminalID)
}

func newStalledSFTPClient(t *testing.T) (*sftp.Client, <-chan struct{}) {
	t.Helper()
	clientConn, serverConn := net.Pipe()
	requestSeen := make(chan struct{})
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		defer serverConn.Close()
		if err := readSFTPPacket(serverConn); err != nil {
			return
		}
		if _, err := serverConn.Write([]byte{0, 0, 0, 5, 2, 0, 0, 0, 3}); err != nil {
			return
		}
		if err := readSFTPPacket(serverConn); err != nil {
			return
		}
		close(requestSeen)
		_, _ = io.Copy(io.Discard, serverConn)
	}()
	client, err := sftp.NewClientPipe(clientConn, clientConn, sftp.UseConcurrentReads(false))
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = client.Close()
		select {
		case <-serverDone:
		case <-time.After(2 * time.Second):
			t.Error("stalled SFTP server did not stop")
		}
	})
	return client, requestSeen
}

func readSFTPPacket(conn net.Conn) error {
	var size [4]byte
	if _, err := io.ReadFull(conn, size[:]); err != nil {
		return err
	}
	length := binary.BigEndian.Uint32(size[:])
	if length == 0 || length > 1024*1024 {
		return fmt.Errorf("invalid SFTP packet length %d", length)
	}
	_, err := io.CopyN(io.Discard, conn, int64(length))
	return err
}

func (p *testSFTPProvider) OpenSFTP(context.Context, string) (*sftp.Client, error) {
	if p.err != nil {
		return nil, p.err
	}
	clientConn, serverConn := net.Pipe()
	server, err := sftp.NewServer(serverConn, sftp.WithServerWorkingDirectory(p.root))
	if err != nil {
		_ = clientConn.Close()
		_ = serverConn.Close()
		return nil, err
	}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer serverConn.Close()
		_ = server.Serve()
	}()
	client, err := sftp.NewClientPipe(clientConn, clientConn, sftp.UseConcurrentReads(false))
	if err != nil {
		_ = clientConn.Close()
		return nil, err
	}
	return client, nil
}

func (p *testSFTPProvider) Close() {
	p.wg.Wait()
}

func setupRemoteFileHandler(t *testing.T, provider RemoteFileProvider) (*gin.Engine, *middleware.FileViewAuthorizer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	views, err := middleware.NewFileViewAuthorizer()
	require.NoError(t, err)
	h := NewFileHandler(views)
	h.SetRemoteFileProvider(provider)
	r := gin.New()
	r.Use(middleware.Auth("test-key", views))
	h.Register(r.Group("/api"))
	return r, views
}

func remoteFileRequestRecorder(t *testing.T, r http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		payload, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(payload)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Authorization", "Bearer test-key")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	r.ServeHTTP(w, req)
	return w
}

func TestRemoteDownloadDescriptorNeverFallsBackToLocalPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	views, err := middleware.NewFileViewAuthorizer()
	require.NoError(t, err)
	h := NewFileHandler(views)
	baseDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "vibego-remote-file-v1.bad"), []byte("local secret"), 0600))
	h.SetBaseDir(baseDir)
	r := gin.New()
	h.Register(r.Group("/api"))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/file/download?path=vibego-remote-file-v1.bad", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "invalid_remote_file_descriptor")
	require.NotContains(t, w.Body.String(), "local secret")
}

func TestRemoteFileDescriptorPreservesPathWhitespace(t *testing.T) {
	views, err := middleware.NewFileViewAuthorizer()
	require.NoError(t, err)
	remotePath := " docs/report .md "
	descriptor, err := encodeRemoteFileDescriptor(views, " ssh-terminal ", remotePath)
	require.NoError(t, err)
	decoded, remote, err := decodeRemoteFileDescriptor(views, descriptor)
	require.NoError(t, err)
	require.True(t, remote)
	require.Equal(t, "ssh-terminal", decoded.Terminal)
	require.Equal(t, remotePath, decoded.Path)

	_, err = encodeRemoteFileDescriptor(views, "ssh-terminal", " \t ")
	require.Error(t, err)
}

func TestRemoteFileOperationStopsWhenRequestIsCanceled(t *testing.T) {
	client, requestSeen := newStalledSFTPClient(t)
	r, _ := setupRemoteFileHandler(t, &singleSFTPClientProvider{client: client})
	requestContext, cancel := context.WithCancel(context.Background())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/file/remote/info?terminal_id=ssh-1&path=blocked.txt",
		nil,
	).WithContext(requestContext)
	req.Header.Set("Authorization", "Bearer test-key")
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.ServeHTTP(w, req)
	}()

	select {
	case <-requestSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("remote SFTP operation did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("remote SFTP operation was not interrupted by request cancellation")
	}
	require.Equal(t, http.StatusRequestTimeout, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "request_canceled")
}

func TestRemoteFileRoutesReturnExplicitReconnectBoundary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	views, err := middleware.NewFileViewAuthorizer()
	require.NoError(t, err)
	h := NewFileHandler(views)
	r := gin.New()
	h.Register(r.Group("/api"))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/file/remote/info?terminal_id=ssh-terminal&path=report.md", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "remote_files_unsupported")

	descriptor, err := encodeRemoteFileDescriptor(views, "ssh-terminal", "/remote/report.md")
	require.NoError(t, err)
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/file/download?path="+descriptor, nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "remote_files_unsupported")
}

func TestRemoteFileRendererTransportOverSFTP(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, "docs"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "docs", "readme.md"), []byte("# Remote\n"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("0123456789"), 0644))
	symlinkReadable := os.Symlink("docs/readme.md", filepath.Join(root, "readme-link.md")) == nil
	provider := &testSFTPProvider{root: root}
	t.Cleanup(provider.Close)
	r, _ := setupRemoteFileHandler(t, provider)

	w := remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/info?terminal_id=ssh-1&path=docs/readme.md", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var info FileInfo
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &info))
	require.Equal(t, "docs/readme.md", info.Path)
	require.Equal(t, "readme.md", info.Name)
	require.Equal(t, int64(len("# Remote\n")), info.Size)
	require.Equal(t, "text/markdown", info.MimeType)

	w = remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/read?terminal_id=ssh-1&path=docs/readme.md", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "# Remote")
	if symlinkReadable {
		w = remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/read?terminal_id=ssh-1&path=readme-link.md", nil)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), "# Remote")
	}

	w = remoteFileRequestRecorder(t, r, http.MethodPost, "/api/file/remote/check", map[string]any{
		"terminal_id": "ssh-1",
		"path":        "docs/missing.md",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.JSONEq(t, `{"exist":false}`, w.Body.String())

	w = remoteFileRequestRecorder(t, r, http.MethodPost, "/api/file/remote/save", map[string]any{
		"terminal_id": "ssh-1",
		"path":        "docs/readme.md",
		"content":     "updated",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	content, err := os.ReadFile(filepath.Join(root, "docs", "readme.md"))
	require.NoError(t, err)
	require.Equal(t, "updated", string(content))

	w = remoteFileRequestRecorder(t, r, http.MethodPost, "/api/file/remote/save", map[string]any{
		"terminal_id": "ssh-1",
		"path":        "docs/new.txt",
		"content":     "new remote file",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	content, err = os.ReadFile(filepath.Join(root, "docs", "new.txt"))
	require.NoError(t, err)
	require.Equal(t, "new remote file", string(content))

	w = remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/view-url?terminal_id=ssh-1&path=clip.mp4", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var grant struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &grant))
	require.NotContains(t, grant.URL, "clip.mp4")
	parsed, err := url.Parse(grant.URL)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(parsed.Query().Get("path"), remoteFileDescriptorPrefix))
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)

	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, grant.URL, nil)
	req.AddCookie(cookies[0])
	req.Header.Set("Range", "bytes=2-5")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusPartialContent, w.Code, w.Body.String())
	require.Equal(t, "2345", w.Body.String())
	require.Equal(t, "bytes 2-5/10", w.Header().Get("Content-Range"))
	require.Contains(t, w.Header().Get("Content-Disposition"), "inline")
}

func TestRemoteFileBlockScopeUsesOptionalV2DescriptorAndKeepsV1Compatibility(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "block.txt"), []byte("block-content"), 0644))
	provider := &blockAwareSFTPProvider{base: &testSFTPProvider{root: root}}
	t.Cleanup(provider.base.Close)
	r, views := setupRemoteFileHandler(t, provider)

	query := "terminal_id=parent-terminal&block_id=child-block&block_created_at=42&path=block.txt"
	w := remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/info?"+query, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	provider.mu.Lock()
	require.Equal(t, "parent-terminal", provider.terminal)
	require.Equal(t, "child-block", provider.blockID)
	require.EqualValues(t, 42, provider.created)
	require.Equal(t, 1, provider.calls)
	provider.mu.Unlock()

	w = remoteFileRequestRecorder(t, r, http.MethodGet,
		"/api/file/remote/view-url?"+query, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var grant struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &grant))
	parsed, err := url.Parse(grant.URL)
	require.NoError(t, err)
	sealed := parsed.Query().Get("path")
	require.True(t, strings.HasPrefix(sealed, remoteFileDescriptorV2Prefix))
	decoded, remote, err := decodeRemoteFileDescriptor(views, sealed)
	require.NoError(t, err)
	require.True(t, remote)
	require.Equal(t, 2, decoded.Version)
	require.Equal(t, "parent-terminal", decoded.Terminal)
	require.Equal(t, "child-block", decoded.BlockID)
	require.NotNil(t, decoded.BlockCreatedAt)
	require.EqualValues(t, 42, *decoded.BlockCreatedAt)

	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, grant.URL, nil)
	req.AddCookie(cookies[0])
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "block-content", w.Body.String())
	provider.mu.Lock()
	require.Equal(t, "parent-terminal", provider.terminal)
	require.Equal(t, "child-block", provider.blockID)
	require.EqualValues(t, 42, provider.created)
	require.Equal(t, 3, provider.calls)
	provider.mu.Unlock()

	// The old terminal-only endpoint still emits/accepts v1 descriptors.
	w = remoteFileRequestRecorder(t, r, http.MethodGet,
		"/api/file/remote/view-url?terminal_id=parent-terminal&path=block.txt", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &grant))
	parsed, err = url.Parse(grant.URL)
	require.NoError(t, err)
	sealed = parsed.Query().Get("path")
	require.True(t, strings.HasPrefix(sealed, remoteFileDescriptorPrefix))
	require.False(t, strings.HasPrefix(sealed, remoteFileDescriptorV2Prefix))
	decoded, remote, err = decodeRemoteFileDescriptor(views, sealed)
	require.NoError(t, err)
	require.True(t, remote)
	require.Equal(t, 1, decoded.Version)
	require.Empty(t, decoded.BlockID)

	w = remoteFileRequestRecorder(t, r, http.MethodGet,
		"/api/file/remote/info?terminal_id=parent-terminal&block_id=child-block&path=block.txt", nil)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

func TestRemoteSaveRejectsSymlinkDirectoryAndSpecialFile(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "target.txt"), []byte("target"), 0644))
	require.NoError(t, os.Mkdir(filepath.Join(root, "folder"), 0755))
	rejectedPaths := []string{"folder"}
	if err := os.Symlink("target.txt", filepath.Join(root, "link.txt")); err == nil {
		rejectedPaths = append(rejectedPaths, "link.txt")
	}
	if socket, err := net.Listen("unix", filepath.Join(root, "socket")); err == nil {
		defer socket.Close()
		rejectedPaths = append(rejectedPaths, "socket")
	}
	provider := &testSFTPProvider{root: root}
	t.Cleanup(provider.Close)
	r, _ := setupRemoteFileHandler(t, provider)

	for _, remotePath := range rejectedPaths {
		w := remoteFileRequestRecorder(t, r, http.MethodPost, "/api/file/remote/save", map[string]any{
			"terminal_id": "ssh-1",
			"path":        remotePath,
			"content":     "blocked",
		})
		require.NotEqual(t, http.StatusOK, w.Code, fmt.Sprintf("path %s must be rejected", remotePath))
	}
	content, err := os.ReadFile(filepath.Join(root, "target.txt"))
	require.NoError(t, err)
	require.Equal(t, "target", string(content))
}

func TestRemoteReadViewAndDownloadRejectSpecialFiles(t *testing.T) {
	root := t.TempDir()
	socket, err := net.Listen("unix", filepath.Join(root, "socket"))
	if err != nil {
		t.Skipf("unix socket is unavailable: %v", err)
	}
	defer socket.Close()
	rejectedPaths := []string{"socket"}
	if err := os.Symlink("socket", filepath.Join(root, "socket-link")); err == nil {
		rejectedPaths = append(rejectedPaths, "socket-link")
	}

	provider := &testSFTPProvider{root: root}
	t.Cleanup(provider.Close)
	r, views := setupRemoteFileHandler(t, provider)

	for _, remotePath := range rejectedPaths {
		w := remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/read?terminal_id=ssh-1&path="+url.QueryEscape(remotePath), nil)
		require.Equal(t, http.StatusBadRequest, w.Code, "read must reject %s", remotePath)
		require.Contains(t, w.Body.String(), "remote_path_not_regular")

		w = remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/view-url?terminal_id=ssh-1&path="+url.QueryEscape(remotePath), nil)
		require.Equal(t, http.StatusBadRequest, w.Code, "view must reject %s", remotePath)
		require.Contains(t, w.Body.String(), "remote_path_not_regular")

		descriptor, err := encodeRemoteFileDescriptor(views, "ssh-1", remotePath)
		require.NoError(t, err)
		w = remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/download?path="+url.QueryEscape(descriptor), nil)
		require.Equal(t, http.StatusBadRequest, w.Code, "download must reject %s", remotePath)
		require.Contains(t, w.Body.String(), "remote_path_not_regular")
	}
}

func TestRemoteReadViewAndDownloadRejectOversizedFiles(t *testing.T) {
	root := t.TempDir()
	largePath := filepath.Join(root, "large.mp4")
	require.NoError(t, os.WriteFile(largePath, nil, 0644))
	require.NoError(t, os.Truncate(largePath, remoteFileMaxBytes+1))

	provider := &testSFTPProvider{root: root}
	t.Cleanup(provider.Close)
	r, views := setupRemoteFileHandler(t, provider)

	for _, target := range []string{
		"/api/file/remote/read?terminal_id=ssh-1&path=large.mp4",
		"/api/file/remote/view-url?terminal_id=ssh-1&path=large.mp4",
	} {
		w := remoteFileRequestRecorder(t, r, http.MethodGet, target, nil)
		require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, target)
		require.Contains(t, w.Body.String(), "remote_file_too_large")
	}

	descriptor, err := encodeRemoteFileDescriptor(views, "ssh-1", "large.mp4")
	require.NoError(t, err)
	w := remoteFileRequestRecorder(
		t,
		r,
		http.MethodGet,
		"/api/file/download?path="+url.QueryEscape(descriptor),
		nil,
	)
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "remote_file_too_large")
}

func TestRemoteSaveRejectsOversizedContentAndBody(t *testing.T) {
	r, _ := setupRemoteFileHandler(t, nil)

	w := remoteFileRequestRecorder(t, r, http.MethodPost, "/api/file/remote/save", map[string]any{
		"terminal_id": "ssh-1",
		"path":        "large.txt",
		"content":     strings.Repeat("x", remoteFileMaxBytes+1),
	})
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "remote_file_content_too_large")

	payload := `{"terminal_id":"ssh-1","path":"large.txt","content":"` + strings.Repeat("x", remoteFileMaxBodyBytes)
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/file/remote/save", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "remote_file_request_too_large")
}

func TestRemoteFileRoutesExposeReconnectError(t *testing.T) {
	provider := &testSFTPProvider{err: sshconnection.ErrReconnectRequired}
	r, _ := setupRemoteFileHandler(t, provider)
	w := remoteFileRequestRecorder(t, r, http.MethodGet, "/api/file/remote/info?terminal_id=ssh-1&path=readme.md", nil)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Contains(t, w.Body.String(), "ssh_reconnect_required")
}
