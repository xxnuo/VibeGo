package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

const (
	// Runtime requests do not carry persisted PTY output, but a command may be
	// supplied as initial input. Keep the body bounded independently of the
	// larger BlockTerm block payload limit.
	blockRuntimeMaxBodyBytes  = 2 * 1024 * 1024
	blockRuntimeMaxInputBytes = 1 * 1024 * 1024
)

var blockTermRuntimeUpgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

type blockRuntimeCreateRequest struct {
	TerminalID   string          `json:"terminal_id"`
	BlockID      string          `json:"block_id"`
	BlockToken   string          `json:"block_token"`
	Token        string          `json:"token"`
	RuntimeType  string          `json:"runtime_type"`
	SSHProfileID string          `json:"ssh_profile_id"`
	ProfileID    string          `json:"profile_id"`
	Cwd          string          `json:"cwd"`
	Cols         int             `json:"cols"`
	Rows         int             `json:"rows"`
	Command      string          `json:"command"`
	InitialInput json.RawMessage `json:"initial_input"`
	SSHAuth      sshAuthRequest  `json:"ssh_auth"`
}

type blockRuntimeInputRequest struct {
	BlockToken string          `json:"block_token"`
	Token      string          `json:"token"`
	Data       json.RawMessage `json:"data"`
	Input      json.RawMessage `json:"input"`
}

type blockRuntimeSignalRequest struct {
	BlockToken string `json:"block_token"`
	Token      string `json:"token"`
	Signal     string `json:"signal"`
}

type blockRuntimeResizeRequest struct {
	BlockToken string `json:"block_token"`
	Token      string `json:"token"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

// registerBlockRuntimeRoutes keeps the independent runtime API separate from
// durable block CRUD. The plural alias was used by an early client build and
// is intentionally kept until all clients have migrated.
func (h *BlockTermHandler) registerBlockRuntimeRoutes(r *gin.RouterGroup) {
	for _, prefix := range []string{"/blockterm/runtime", "/blockterm/runtimes"} {
		g := r.Group(prefix)
		g.POST("", h.CreateRuntime)
		g.GET("/:terminal_id/:block_id", h.GetRuntime)
		g.POST("/:terminal_id/:block_id/input", h.InputRuntime)
		g.POST("/:terminal_id/:block_id/resize", h.ResizeRuntime)
		g.POST("/:terminal_id/:block_id/signal", h.SignalRuntime)
		g.DELETE("/:terminal_id/:block_id", h.CloseRuntime)
		g.GET("/ws/:terminal_id/:block_id", h.AttachRuntime)
	}
}

func blockRuntimeFirstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func blockRuntimeToken(values ...string) (string, error) {
	token := ""
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if token == "" {
			token = value
			continue
		}
		if value != token {
			return "", fmt.Errorf("%w: block token values differ", terminal.ErrBlockRuntimeInvalid)
		}
	}
	return token, nil
}

func blockRuntimeTokenFromContext(c *gin.Context, bodyTokens ...string) (string, error) {
	values := append([]string(nil), bodyTokens...)
	values = append(values,
		c.Query("block_token"),
		c.Query("token"),
		c.GetHeader("X-BlockTerm-Block-Token"),
		c.GetHeader("X-Block-Token"),
	)
	return blockRuntimeToken(values...)
}

func blockRuntimeManagerRequired(manager *terminal.Manager) error {
	if manager == nil {
		return terminal.ErrBlockRuntimeInvalid
	}
	return nil
}

func blockRuntimePath(c *gin.Context) (string, string) {
	return strings.TrimSpace(c.Param("terminal_id")), strings.TrimSpace(c.Param("block_id"))
}

func blockRuntimeRouteInputError(terminalID, blockID, token string) error {
	if terminalID == "" || blockID == "" || token == "" {
		return fmt.Errorf("%w: terminal_id, block_id and block_token are required", terminal.ErrBlockRuntimeInvalid)
	}
	return nil
}

// decodeBlockRuntimeBytes accepts the canonical base64 string and also the
// []byte JSON representation emitted by Go clients. Supporting both avoids a
// surprising incompatibility for callers that marshal []byte directly.
func decodeBlockRuntimeBytes(raw json.RawMessage, field string) ([]byte, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err == nil {
		decoded, decodeErr := base64.StdEncoding.DecodeString(encoded)
		if decodeErr != nil {
			if decoded, decodeErr = base64.RawStdEncoding.DecodeString(encoded); decodeErr != nil {
				return nil, fmt.Errorf("%s must be base64", field)
			}
		}
		return decoded, nil
	}
	var values []byte
	if err := json.Unmarshal(raw, &values); err == nil {
		return values, nil
	}
	return nil, fmt.Errorf("%s must be a base64 string", field)
}

func decodeBlockRuntimeInputBody(c *gin.Context, req *blockRuntimeInputRequest) ([]byte, error) {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(c.GetHeader("Content-Type"), ";")[0]))
	if contentType == "application/octet-stream" {
		reader := http.MaxBytesReader(c.Writer, c.Request.Body, blockRuntimeMaxInputBytes)
		data, err := io.ReadAll(reader)
		if err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				return nil, fmt.Errorf("input is too large")
			}
			return nil, fmt.Errorf("failed to read input")
		}
		return data, nil
	}
	if !bindLimitedJSON(c, req, blockRuntimeMaxBodyBytes) {
		return nil, errBlockRuntimeBodyAlreadyWritten
	}
	raw := req.Data
	field := "data"
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = req.Input
		field = "input"
	}
	return decodeBlockRuntimeBytes(raw, field)
}

// Sentinel used internally to tell a caller that bindLimitedJSON already
// emitted the response. It is never exposed in an API response.
var errBlockRuntimeBodyAlreadyWritten = errors.New("block runtime request body already written")

func blockRuntimeRouteError(manager *terminal.Manager, terminalID, blockID, token string) error {
	if err := blockRuntimeRouteInputError(terminalID, blockID, token); err != nil {
		return err
	}
	if manager == nil {
		return terminal.ErrBlockRuntimeNotFound
	}
	registry := manager.BlockTermRuntimeRegistry()
	if registry == nil {
		return terminal.ErrBlockRuntimeNotFound
	}
	resolution := registry.ResolveByKey(terminalID, blockID, token)
	switch resolution.Status {
	case terminal.BlockTermRuntimeRouteStatusBlock:
		return nil
	case terminal.BlockTermRuntimeRouteStatusTokenMismatch:
		return terminal.ErrBlockRuntimeRouteMismatch
	case terminal.BlockTermRuntimeRouteStatusUnknownTagged:
		return terminal.ErrBlockRuntimeNotFound
	default:
		return terminal.ErrBlockRuntimeInvalid
	}
}

func writeBlockRuntimeError(c *gin.Context, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, errBlockRuntimeBodyAlreadyWritten) {
		return
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, terminal.ErrBlockRuntimeInvalid):
		status = http.StatusBadRequest
	case errors.Is(err, terminal.ErrBlockRuntimeNotFound), errors.Is(err, terminal.ErrTerminalNotFound), errors.Is(err, gorm.ErrRecordNotFound):
		status = http.StatusNotFound
	case errors.Is(err, terminal.ErrBlockRuntimeAlreadyExists), errors.Is(err, terminal.ErrBlockRuntimeRouteMismatch), errors.Is(err, terminal.ErrBlockRuntimeNotRunning):
		status = http.StatusConflict
	}
	c.JSON(status, gin.H{"error": err.Error()})
}

func (h *BlockTermHandler) CreateRuntime(c *gin.Context) {
	var req blockRuntimeCreateRequest
	if !bindLimitedJSON(c, &req, blockRuntimeMaxBodyBytes) {
		return
	}
	terminalID := strings.TrimSpace(req.TerminalID)
	blockID := strings.TrimSpace(req.BlockID)
	token, err := blockRuntimeToken(req.BlockToken, req.Token)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeRouteInputError(terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if h.manager == nil {
		writeBlockRuntimeError(c, terminal.ErrBlockRuntimeInvalid)
		return
	}
	initialInput, err := decodeBlockRuntimeBytes(req.InitialInput, "initial_input")
	if err != nil {
		writeBlockRuntimeError(c, fmt.Errorf("%w: %v", terminal.ErrBlockRuntimeInvalid, err))
		return
	}
	if len(initialInput) > blockRuntimeMaxInputBytes || len(req.Command) > blockRuntimeMaxInputBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "initial input is too large"})
		return
	}
	if len(initialInput) > 0 && req.Command != "" {
		writeBlockRuntimeError(c, fmt.Errorf("%w: command and initial_input are mutually exclusive", terminal.ErrBlockRuntimeInvalid))
		return
	}
	info, err := h.manager.CreateBlockRuntime(terminal.BlockRuntimeCreateOptions{
		TerminalID:   terminalID,
		BlockID:      blockID,
		BlockToken:   token,
		RuntimeType:  strings.TrimSpace(req.RuntimeType),
		SSHProfileID: blockRuntimeFirstNonEmpty(req.SSHProfileID, req.ProfileID),
		Cwd:          req.Cwd,
		Cols:         req.Cols,
		Rows:         req.Rows,
		SSHAuth:      req.SSHAuth.secrets(),
		Context:      c.Request.Context(),
		InitialInput: initialInput,
		Command:      req.Command,
	})
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	// CreateBlockRuntime returns a value snapshot that is valid even when a
	// one-shot command exits before this response is written. Do not re-run the
	// database/route admission check here: the runtime finalizer may have
	// intentionally removed its route and settled the durable block in the small
	// interval after creation. Admission is performed before creation above;
	// the manager owns the exact runtime after that hand-off.
	c.JSON(http.StatusCreated, gin.H{"ok": true, "runtime": info})
}

func (h *BlockTermHandler) GetRuntime(c *gin.Context) {
	terminalID, blockID := blockRuntimePath(c)
	token, err := blockRuntimeTokenFromContext(c)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeRouteError(h.manager, terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	info, ok := h.manager.GetBlockRuntime(terminalID, blockID, token)
	if !ok {
		writeBlockRuntimeError(c, terminal.ErrBlockRuntimeNotFound)
		return
	}
	c.JSON(http.StatusOK, gin.H{"runtime": info})
}

func (h *BlockTermHandler) InputRuntime(c *gin.Context) {
	terminalID, blockID := blockRuntimePath(c)
	var req blockRuntimeInputRequest
	data, err := decodeBlockRuntimeInputBody(c, &req)
	if err != nil {
		if errors.Is(err, errBlockRuntimeBodyAlreadyWritten) {
			return
		}
		if err.Error() == "input is too large" {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		writeBlockRuntimeError(c, fmt.Errorf("%w: %v", terminal.ErrBlockRuntimeInvalid, err))
		return
	}
	token, tokenErr := blockRuntimeTokenFromContext(c, req.BlockToken, req.Token)
	if tokenErr != nil {
		writeBlockRuntimeError(c, tokenErr)
		return
	}
	if err := blockRuntimeRouteInputError(terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeManagerRequired(h.manager); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if len(data) == 0 {
		writeBlockRuntimeError(c, fmt.Errorf("%w: input is required", terminal.ErrBlockRuntimeInvalid))
		return
	}
	if len(data) > blockRuntimeMaxInputBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "input is too large"})
		return
	}
	if err := h.manager.WriteBlockRuntime(terminalID, blockID, token, data); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *BlockTermHandler) ResizeRuntime(c *gin.Context) {
	terminalID, blockID := blockRuntimePath(c)
	var req blockRuntimeResizeRequest
	if !bindLimitedJSON(c, &req, blockRuntimeMaxBodyBytes) {
		return
	}
	token, err := blockRuntimeTokenFromContext(c, req.BlockToken, req.Token)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeRouteInputError(terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeManagerRequired(h.manager); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if req.Cols <= 0 || req.Rows <= 0 {
		writeBlockRuntimeError(c, fmt.Errorf("%w: cols and rows must be positive", terminal.ErrBlockRuntimeInvalid))
		return
	}
	if err := h.manager.ResizeBlockRuntime(terminalID, blockID, token, req.Cols, req.Rows); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *BlockTermHandler) SignalRuntime(c *gin.Context) {
	terminalID, blockID := blockRuntimePath(c)
	var req blockRuntimeSignalRequest
	if !bindLimitedJSON(c, &req, blockRuntimeMaxBodyBytes) {
		return
	}
	token, err := blockRuntimeTokenFromContext(c, req.BlockToken, req.Token)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeRouteInputError(terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeManagerRequired(h.manager); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if _, err := terminal.NormalizeTerminalSignal(req.Signal); err != nil {
		writeBlockRuntimeError(c, fmt.Errorf("%w: %v", terminal.ErrBlockRuntimeInvalid, err))
		return
	}
	if err := h.manager.SignalBlockRuntime(terminalID, blockID, token, req.Signal); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *BlockTermHandler) CloseRuntime(c *gin.Context) {
	terminalID, blockID := blockRuntimePath(c)
	token, err := blockRuntimeTokenFromContext(c)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeRouteInputError(terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeManagerRequired(h.manager); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := h.manager.CloseBlockRuntime(terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func parseBlockRuntimeCursor(c *gin.Context) (uint64, error) {
	raw, ok := c.GetQuery("cursor")
	if !ok || strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	cursor, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: cursor must be a non-negative integer", terminal.ErrBlockRuntimeInvalid)
	}
	return cursor, nil
}

func (h *BlockTermHandler) AttachRuntime(c *gin.Context) {
	terminalID, blockID := blockRuntimePath(c)
	token, err := blockRuntimeTokenFromContext(c)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	if err := blockRuntimeRouteError(h.manager, terminalID, blockID, token); err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	cursor, err := parseBlockRuntimeCursor(c)
	if err != nil {
		writeBlockRuntimeError(c, err)
		return
	}
	conn, err := blockTermRuntimeUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	connection, err := h.manager.AttachBlockRuntime(terminalID, blockID, token, conn, terminal.BlockRuntimeAttachOptions{Cursor: cursor})
	if err != nil {
		_ = conn.Close()
		return
	}
	<-connection.Done
}
