package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
	"github.com/xxnuo/vibego/internal/middleware"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
	"github.com/xxnuo/vibego/internal/service/terminal"
)

const (
	remoteFileDescriptorPrefix   = "vibego-remote-file-v1."
	remoteFileDescriptorV2Prefix = "vibego-remote-file-v2."
	remoteFileDescriptorKind     = "ssh-sftp"
	remoteFileMaxBytes           = 10 * 1024 * 1024
	remoteFileMaxBodyBytes       = remoteFileMaxBytes + 1024*1024
	remoteFileOperationTimeout   = 15 * time.Second
	remoteAnonymousPrincipal     = "vibego-anonymous-file-view"
	remoteFileContextKey         = "vibego.remote-file-operation-context"
)

var (
	errRemotePathIsDirectory = errors.New("path is a directory")
	errRemotePathNotRegular  = errors.New("path is not a regular file")
	errRemotePathTooLarge    = errors.New("file too large (>10MB)")
)

// RemoteFileProvider opens a new SFTP subsystem on an already-connected SSH
// terminal. The returned client is owned by the caller and must be closed.
type RemoteFileProvider interface {
	OpenSFTP(context.Context, string) (*sftp.Client, error)
}

type RemoteBlockFileProvider interface {
	OpenBlockSFTP(context.Context, string, string, int64) (*sftp.Client, error)
}

type remoteFileDescriptor struct {
	Version        int    `json:"v"`
	Terminal       string `json:"terminal_id"`
	BlockID        string `json:"block_id,omitempty"`
	BlockCreatedAt *int64 `json:"block_created_at,omitempty"`
	Path           string `json:"path"`
}

type remoteFileScope struct {
	TerminalID     string
	BlockID        string
	BlockCreatedAt *int64
}

type remoteFileRequest struct {
	TerminalID     string `json:"terminal_id" binding:"required"`
	BlockID        string `json:"block_id"`
	BlockCreatedAt *int64 `json:"block_created_at"`
	Path           string `json:"path" binding:"required"`
}

type remoteFileEditRequest struct {
	TerminalID     string `json:"terminal_id" binding:"required"`
	BlockID        string `json:"block_id"`
	BlockCreatedAt *int64 `json:"block_created_at"`
	Path           string `json:"path" binding:"required"`
	Content        string `json:"content"`
}

func encodeRemoteFileDescriptor(authorizer *middleware.FileViewAuthorizer, terminalID, remotePath string) (string, error) {
	terminalID = strings.TrimSpace(terminalID)
	if terminalID == "" || strings.TrimSpace(remotePath) == "" || strings.IndexByte(terminalID, 0) >= 0 || strings.IndexByte(remotePath, 0) >= 0 {
		return "", errors.New("invalid remote file descriptor")
	}
	payload, err := json.Marshal(remoteFileDescriptor{Version: 1, Terminal: terminalID, Path: remotePath})
	if err != nil {
		return "", fmt.Errorf("encode remote file descriptor: %w", err)
	}
	if authorizer == nil {
		return "", errors.New("file view authorizer unavailable")
	}
	sealed, err := authorizer.SealPathDescriptor(remoteFileDescriptorKind, payload)
	if err != nil {
		return "", err
	}
	return remoteFileDescriptorPrefix + sealed, nil
}

func encodeBlockRemoteFileDescriptor(
	authorizer *middleware.FileViewAuthorizer,
	scope remoteFileScope,
	remotePath string,
) (string, error) {
	normalized, err := normalizeRemoteFileScope(scope.TerminalID, scope.BlockID, scope.BlockCreatedAt)
	if err != nil || normalized.BlockID == "" || strings.TrimSpace(remotePath) == "" || strings.IndexByte(remotePath, 0) >= 0 {
		return "", errors.New("invalid remote file descriptor")
	}
	payload, err := json.Marshal(remoteFileDescriptor{
		Version:        2,
		Terminal:       normalized.TerminalID,
		BlockID:        normalized.BlockID,
		BlockCreatedAt: normalized.BlockCreatedAt,
		Path:           remotePath,
	})
	if err != nil {
		return "", fmt.Errorf("encode remote file descriptor: %w", err)
	}
	if authorizer == nil {
		return "", errors.New("file view authorizer unavailable")
	}
	sealed, err := authorizer.SealPathDescriptor(remoteFileDescriptorKind, payload)
	if err != nil {
		return "", err
	}
	return remoteFileDescriptorV2Prefix + sealed, nil
}

func decodeRemoteFileDescriptor(authorizer *middleware.FileViewAuthorizer, value string) (remoteFileDescriptor, bool, error) {
	prefix := ""
	wantVersion := 0
	switch {
	case strings.HasPrefix(value, remoteFileDescriptorPrefix):
		prefix = remoteFileDescriptorPrefix
		wantVersion = 1
	case strings.HasPrefix(value, remoteFileDescriptorV2Prefix):
		prefix = remoteFileDescriptorV2Prefix
		wantVersion = 2
	default:
		return remoteFileDescriptor{}, false, nil
	}
	sealed := strings.TrimPrefix(value, prefix)
	if sealed == "" || len(sealed) > 32*1024 || authorizer == nil {
		return remoteFileDescriptor{}, true, errors.New("invalid remote file descriptor")
	}
	payload, err := authorizer.OpenPathDescriptor(remoteFileDescriptorKind, sealed)
	if err != nil {
		return remoteFileDescriptor{}, true, errors.New("invalid remote file descriptor")
	}
	var descriptor remoteFileDescriptor
	if err := json.Unmarshal(payload, &descriptor); err != nil || descriptor.Version != wantVersion ||
		strings.TrimSpace(descriptor.Terminal) == "" || strings.TrimSpace(descriptor.Path) == "" {
		return remoteFileDescriptor{}, true, errors.New("invalid remote file descriptor")
	}
	if strings.IndexByte(descriptor.Terminal, 0) >= 0 || strings.IndexByte(descriptor.Path, 0) >= 0 {
		return remoteFileDescriptor{}, true, errors.New("invalid remote file descriptor")
	}
	descriptor.Terminal = strings.TrimSpace(descriptor.Terminal)
	if descriptor.Version == 1 {
		if descriptor.BlockID != "" || descriptor.BlockCreatedAt != nil {
			return remoteFileDescriptor{}, true, errors.New("invalid remote file descriptor")
		}
		return descriptor, true, nil
	}
	scope, err := normalizeRemoteFileScope(descriptor.Terminal, descriptor.BlockID, descriptor.BlockCreatedAt)
	if err != nil || scope.BlockID == "" {
		return remoteFileDescriptor{}, true, errors.New("invalid remote file descriptor")
	}
	descriptor.Terminal = scope.TerminalID
	descriptor.BlockID = scope.BlockID
	descriptor.BlockCreatedAt = scope.BlockCreatedAt
	return descriptor, true, nil
}

func normalizeRemoteFileScope(terminalID, blockID string, blockCreatedAt *int64) (remoteFileScope, error) {
	terminalID = strings.TrimSpace(terminalID)
	blockID = strings.TrimSpace(blockID)
	if terminalID == "" || strings.IndexByte(terminalID, 0) >= 0 || strings.IndexByte(blockID, 0) >= 0 {
		return remoteFileScope{}, errors.New("invalid remote file scope")
	}
	if blockID == "" {
		if blockCreatedAt != nil {
			return remoteFileScope{}, errors.New("block_id is required with block_created_at")
		}
		return remoteFileScope{TerminalID: terminalID}, nil
	}
	if blockCreatedAt == nil || *blockCreatedAt < 0 {
		return remoteFileScope{}, errors.New("block_created_at is required with block_id")
	}
	createdAt := *blockCreatedAt
	return remoteFileScope{TerminalID: terminalID, BlockID: blockID, BlockCreatedAt: &createdAt}, nil
}

func remoteFileQueryScope(c *gin.Context) (remoteFileScope, error) {
	var blockCreatedAt *int64
	if raw, present := c.GetQuery("block_created_at"); present {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return remoteFileScope{}, errors.New("block_created_at must be an integer")
		}
		blockCreatedAt = &value
	}
	return normalizeRemoteFileScope(c.Query("terminal_id"), c.Query("block_id"), blockCreatedAt)
}

func (h *FileHandler) openRemoteFile(c *gin.Context, scope remoteFileScope) (*sftp.Client, context.CancelFunc, error) {
	if h.remote == nil {
		return nil, func() {}, sshconnection.ErrRemoteFilesUnsupported
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), remoteFileOperationTimeout)
	var client *sftp.Client
	var err error
	if scope.BlockID == "" {
		client, err = h.remote.OpenSFTP(ctx, scope.TerminalID)
	} else if blockProvider, ok := h.remote.(RemoteBlockFileProvider); ok {
		client, err = blockProvider.OpenBlockSFTP(
			ctx,
			scope.TerminalID,
			scope.BlockID,
			*scope.BlockCreatedAt,
		)
	} else {
		err = sshconnection.ErrRemoteFilesUnsupported
	}
	if err != nil {
		cancel()
		return nil, func() {}, err
	}
	c.Set(remoteFileContextKey, ctx)
	var closeOnce sync.Once
	closeClient := func() {
		closeOnce.Do(func() {
			_ = client.Close()
		})
	}
	stopWatcher := context.AfterFunc(ctx, closeClient)
	cleanup := func() {
		stopWatcher()
		cancel()
		closeClient()
	}
	if err := ctx.Err(); err != nil {
		cleanup()
		return nil, func() {}, err
	}
	return client, cleanup, nil
}

func writeRemoteFileError(c *gin.Context, err error) {
	if err == nil {
		return
	}
	if operationContext, ok := c.Get(remoteFileContextKey); ok {
		if ctx, valid := operationContext.(context.Context); valid && ctx.Err() != nil {
			err = ctx.Err()
		}
	}
	status := http.StatusInternalServerError
	code := "remote_file_error"
	switch {
	case errors.Is(err, sshconnection.ErrReconnectRequired):
		status = http.StatusServiceUnavailable
		code = "ssh_reconnect_required"
	case errors.Is(err, sshconnection.ErrAuthenticationRequired), errors.Is(err, sshconnection.ErrAuthenticationFailed):
		status = http.StatusUnauthorized
		code = "ssh_authentication_required"
	case errors.Is(err, sshconnection.ErrProfileNotFound):
		status = http.StatusNotFound
		code = "ssh_profile_not_found"
	case errors.Is(err, sshconnection.ErrRemoteFilesUnsupported):
		status = http.StatusBadRequest
		code = "remote_files_unsupported"
	case errors.Is(err, sshconnection.ErrRemoteFileBlockNotFound):
		status = http.StatusNotFound
		code = "remote_file_block_not_found"
	case errors.Is(err, terminal.ErrTerminalNotFound):
		status = http.StatusNotFound
		code = "terminal_not_found"
	case errors.Is(err, context.DeadlineExceeded):
		status = http.StatusGatewayTimeout
		code = "ssh_operation_timeout"
	case errors.Is(err, context.Canceled):
		status = http.StatusRequestTimeout
		code = "request_canceled"
	case errors.Is(err, errRemotePathIsDirectory):
		status = http.StatusBadRequest
		code = "remote_path_is_directory"
	case errors.Is(err, errRemotePathNotRegular):
		status = http.StatusBadRequest
		code = "remote_path_not_regular"
	case errors.Is(err, errRemotePathTooLarge):
		status = http.StatusRequestEntityTooLarge
		code = "remote_file_too_large"
	case errors.Is(err, os.ErrNotExist), errors.Is(err, sftp.ErrSSHFxNoSuchFile):
		status = http.StatusNotFound
		code = "remote_file_not_found"
	case errors.Is(err, os.ErrPermission), errors.Is(err, sftp.ErrSSHFxPermissionDenied):
		status = http.StatusForbidden
		code = "remote_file_permission_denied"
	}
	c.JSON(status, gin.H{"error": err.Error(), "code": code})
}

func bindRemoteFileJSON(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, remoteFileMaxBodyBytes)
	if err := c.ShouldBindJSON(target); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large", "code": "remote_file_request_too_large"})
			return false
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "invalid_remote_file_request"})
		return false
	}
	return true
}

func normalizeRemotePath(client *sftp.Client, raw string) (string, error) {
	if raw == "" || strings.IndexByte(raw, 0) >= 0 {
		return "", errors.New("path is required")
	}
	raw = strings.ReplaceAll(raw, "\\", "/")
	if raw == "~" || strings.HasPrefix(raw, "~/") {
		home, err := client.RealPath(".")
		if err != nil {
			return "", fmt.Errorf("resolve remote home: %w", err)
		}
		if raw == "~" {
			raw = home
		} else {
			raw = pathpkg.Join(home, strings.TrimPrefix(raw, "~/"))
		}
	}
	clean := pathpkg.Clean(raw)
	if clean == "" {
		return ".", nil
	}
	return clean, nil
}

func remoteUIDGID(info os.FileInfo) (string, string) {
	stat, ok := info.Sys().(*sftp.FileStat)
	if !ok || stat == nil {
		return "", ""
	}
	return strconv.FormatUint(uint64(stat.UID), 10), strconv.FormatUint(uint64(stat.GID), 10)
}

func remoteMimeType(client *sftp.Client, path string, info os.FileInfo) string {
	if info.IsDir() {
		return "directory"
	}
	if !info.Mode().IsRegular() {
		return "application/octet-stream"
	}
	if mime := mimeTypes[strings.ToLower(pathpkg.Ext(path))]; mime != "" {
		return mime
	}
	file, err := client.Open(path)
	if err != nil {
		return "application/octet-stream"
	}
	defer file.Close()
	buf := make([]byte, 512)
	n, err := file.Read(buf)
	if err != nil && err != io.EOF {
		return "application/octet-stream"
	}
	if n == 0 {
		return "application/octet-stream"
	}
	return http.DetectContentType(buf[:n])
}

func remoteFileInfo(client *sftp.Client, cleanPath string) (*FileInfo, error) {
	linkInfo, err := client.Lstat(cleanPath)
	if err != nil {
		return nil, err
	}
	name := pathpkg.Base(cleanPath)
	if name == "." || name == "/" || name == "" {
		name = cleanPath
	}
	uid, gid := remoteUIDGID(linkInfo)
	fileInfo := &FileInfo{
		Path:      cleanPath,
		Name:      name,
		Uid:       uid,
		Gid:       gid,
		Extension: pathpkg.Ext(name),
		Size:      linkInfo.Size(),
		IsDir:     linkInfo.IsDir(),
		IsSymlink: linkInfo.Mode()&os.ModeSymlink != 0,
		IsHidden:  strings.HasPrefix(name, "."),
		Mode:      fmt.Sprintf("%04o", linkInfo.Mode().Perm()),
		ModTime:   linkInfo.ModTime(),
	}
	fileInfo.MimeType = remoteMimeType(client, cleanPath, linkInfo)
	if !fileInfo.IsSymlink {
		return fileInfo, nil
	}
	fileInfo.LinkPath, _ = client.ReadLink(cleanPath)
	targetInfo, targetErr := client.Stat(cleanPath)
	if targetErr != nil {
		fileInfo.Type = "invalid_link"
		return fileInfo, nil
	}
	fileInfo.IsDir = targetInfo.IsDir()
	fileInfo.Size = targetInfo.Size()
	fileInfo.Mode = fmt.Sprintf("%04o", targetInfo.Mode().Perm())
	fileInfo.ModTime = targetInfo.ModTime()
	fileInfo.Uid, fileInfo.Gid = remoteUIDGID(targetInfo)
	fileInfo.MimeType = remoteMimeType(client, cleanPath, targetInfo)
	return fileInfo, nil
}

func remoteRegularFileInfo(client *sftp.Client, cleanPath string) (os.FileInfo, error) {
	info, err := client.Stat(cleanPath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errRemotePathIsDirectory
	}
	if !info.Mode().IsRegular() {
		return nil, errRemotePathNotRegular
	}
	return info, nil
}

func (h *FileHandler) RemoteInfo(c *gin.Context) {
	scope, scopeErr := remoteFileQueryScope(c)
	rawPath := c.Query("path")
	if scopeErr != nil || rawPath == "" {
		if scopeErr == nil {
			scopeErr = errors.New("path is required")
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": scopeErr.Error(), "code": "invalid_remote_file_request"})
		return
	}
	client, cancel, err := h.openRemoteFile(c, scope)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer cancel()
	cleanPath, err := normalizeRemotePath(client, rawPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	info, err := remoteFileInfo(client, cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	c.JSON(http.StatusOK, info)
}

func (h *FileHandler) RemoteRead(c *gin.Context) {
	scope, scopeErr := remoteFileQueryScope(c)
	rawPath := c.Query("path")
	if scopeErr != nil || rawPath == "" {
		if scopeErr == nil {
			scopeErr = errors.New("path is required")
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": scopeErr.Error(), "code": "invalid_remote_file_request"})
		return
	}
	client, cancel, err := h.openRemoteFile(c, scope)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer cancel()
	cleanPath, err := normalizeRemotePath(client, rawPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	info, err := remoteRegularFileInfo(client, cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	if info.Size() > remoteFileMaxBytes {
		writeRemoteFileError(c, errRemotePathTooLarge)
		return
	}
	file, err := client.Open(cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, remoteFileMaxBytes+1))
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	if int64(len(content)) > remoteFileMaxBytes {
		writeRemoteFileError(c, errRemotePathTooLarge)
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": cleanPath, "content": string(content), "size": info.Size()})
}

func (h *FileHandler) RemoteCheckExist(c *gin.Context) {
	var req remoteFileRequest
	if !bindRemoteFileJSON(c, &req) {
		return
	}
	scope, err := normalizeRemoteFileScope(req.TerminalID, req.BlockID, req.BlockCreatedAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "invalid_remote_file_request"})
		return
	}
	client, cancel, err := h.openRemoteFile(c, scope)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer cancel()
	cleanPath, err := normalizeRemotePath(client, req.Path)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	_, err = client.Lstat(cleanPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, sftp.ErrSSHFxNoSuchFile) {
			c.JSON(http.StatusOK, gin.H{"exist": false})
			return
		}
		writeRemoteFileError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"exist": true, "path": cleanPath})
}

func (h *FileHandler) RemoteSaveContent(c *gin.Context) {
	var req remoteFileEditRequest
	if !bindRemoteFileJSON(c, &req) {
		return
	}
	if len(req.Content) > remoteFileMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "content is too large", "code": "remote_file_content_too_large"})
		return
	}
	scope, err := normalizeRemoteFileScope(req.TerminalID, req.BlockID, req.BlockCreatedAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "invalid_remote_file_request"})
		return
	}
	client, cancel, err := h.openRemoteFile(c, scope)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer cancel()
	cleanPath, err := normalizeRemotePath(client, req.Path)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	info, statErr := client.Lstat(cleanPath)
	if statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			writeRemoteFileError(c, errors.New("writing through a symbolic link is not supported"))
			return
		}
		if info.IsDir() {
			writeRemoteFileError(c, errRemotePathIsDirectory)
			return
		}
		if !info.Mode().IsRegular() {
			writeRemoteFileError(c, errRemotePathNotRegular)
			return
		}
		if info.Mode().Perm()&0222 == 0 {
			writeRemoteFileError(c, errors.New("file is not writable"))
			return
		}
	} else if !errors.Is(statErr, os.ErrNotExist) && !errors.Is(statErr, sftp.ErrSSHFxNoSuchFile) {
		writeRemoteFileError(c, statErr)
		return
	} else {
		if err := ensureRemoteParentIsSafe(client, cleanPath); err != nil {
			writeRemoteFileError(c, err)
			return
		}
	}
	file, err := client.OpenFile(cleanPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	_, writeErr := io.WriteString(file, req.Content)
	closeErr := file.Close()
	if writeErr != nil {
		writeRemoteFileError(c, writeErr)
		return
	}
	if closeErr != nil {
		writeRemoteFileError(c, closeErr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": cleanPath})
}

func ensureRemoteParentIsSafe(client *sftp.Client, cleanPath string) error {
	parent := pathpkg.Dir(cleanPath)
	for {
		info, err := client.Lstat(parent)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("parent path is not a directory")
		}
		if parent == "." || parent == "/" {
			return nil
		}
		next := pathpkg.Dir(parent)
		if next == parent {
			return nil
		}
		parent = next
	}
}

func (h *FileHandler) RemoteViewURL(c *gin.Context) {
	scope, scopeErr := remoteFileQueryScope(c)
	rawPath := c.Query("path")
	if scopeErr != nil || rawPath == "" {
		if scopeErr == nil {
			scopeErr = errors.New("path is required")
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": scopeErr.Error(), "code": "invalid_remote_file_request"})
		return
	}
	client, cancel, err := h.openRemoteFile(c, scope)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer cancel()
	cleanPath, err := normalizeRemotePath(client, rawPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	info, err := remoteRegularFileInfo(client, cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	if info.Size() > remoteFileMaxBytes {
		writeRemoteFileError(c, errRemotePathTooLarge)
		return
	}
	var descriptor string
	if scope.BlockID == "" {
		descriptor, err = encodeRemoteFileDescriptor(h.fileViews, scope.TerminalID, cleanPath)
	} else {
		descriptor, err = encodeBlockRemoteFileDescriptor(h.fileViews, scope, cleanPath)
	}
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	principal := remoteAnonymousPrincipal
	if key, ok := middleware.BearerAccessKey(c); ok {
		principal = key
	}
	grant, err := h.fileViews.Issue(c, principal, descriptor)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"url": grant.URL, "expires_at": grant.ExpiresAt, "hard_expires_at": grant.HardExpiresAt})
}

func (h *FileHandler) downloadRemote(c *gin.Context, descriptor remoteFileDescriptor) {
	scope := remoteFileScope{TerminalID: descriptor.Terminal}
	if descriptor.Version == 2 {
		scope.BlockID = descriptor.BlockID
		scope.BlockCreatedAt = descriptor.BlockCreatedAt
	}
	client, cancel, err := h.openRemoteFile(c, scope)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer cancel()
	cleanPath, err := normalizeRemotePath(client, descriptor.Path)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	regularInfo, err := remoteRegularFileInfo(client, cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	if regularInfo.Size() > remoteFileMaxBytes {
		writeRemoteFileError(c, errRemotePathTooLarge)
		return
	}
	info, err := remoteFileInfo(client, cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	file, err := client.Open(cleanPath)
	if err != nil {
		writeRemoteFileError(c, err)
		return
	}
	defer file.Close()
	disposition := "attachment"
	if c.Query("inline") == "1" {
		if inlineMime := safeInlineMimeType(info.MimeType); inlineMime != "" {
			disposition = "inline"
			c.Header("Content-Type", inlineMime)
		}
	}
	c.Header("Cache-Control", "private, max-age=0, must-revalidate")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", disposition+"; filename*=utf-8''"+url.PathEscape(info.Name))
	// Bound the stream to the size checked above in case the remote file grows
	// between metadata lookup and download.
	content := io.NewSectionReader(file, 0, regularInfo.Size())
	http.ServeContent(c.Writer, c.Request, info.Name, info.ModTime, content)
}
