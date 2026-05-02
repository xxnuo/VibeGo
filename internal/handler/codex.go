package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
)

const (
	codexMaxMessageBytes    = 16 << 20
	codexMaxOutputLineBytes = 32 << 20
	codexWriteTimeout       = 15 * time.Second
	codexOutputTooLargeCode = -32001
)

type codexCommandFactory func(context.Context) *exec.Cmd
type codexStatusProbe func(context.Context) CodexStatus

type CodexStatus struct {
	Available bool   `json:"available"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Error     string `json:"error,omitempty"`
}

type CodexHandler struct {
	upgrader       websocket.Upgrader
	commandFactory codexCommandFactory
	statusProbe    codexStatusProbe
}

func NewCodexHandler() *CodexHandler {
	return newCodexHandlerWithDependencies(
		func(ctx context.Context) *exec.Cmd {
			return exec.CommandContext(ctx, "codex", "app-server", "--listen", "stdio://")
		},
		probeCodexStatus,
	)
}

func newCodexHandlerWithDependencies(commandFactory codexCommandFactory, statusProbe codexStatusProbe) *CodexHandler {
	return &CodexHandler{
		upgrader:       websocket.Upgrader{},
		commandFactory: commandFactory,
		statusProbe:    statusProbe,
	}
}

func (h *CodexHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/codex")
	g.GET("/status", h.Status)
	g.GET("/ws", h.WebSocket)
}

func (h *CodexHandler) Status(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	c.JSON(http.StatusOK, h.statusProbe(ctx))
}

func probeCodexStatus(ctx context.Context) CodexStatus {
	path, err := exec.LookPath("codex")
	if err != nil {
		return CodexStatus{Available: false, Error: err.Error()}
	}
	output, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
	if err != nil {
		return CodexStatus{Available: false, Path: path, Error: strings.TrimSpace(string(output))}
	}
	return CodexStatus{Available: true, Path: path, Version: strings.TrimSpace(string(output))}
}

func (h *CodexHandler) WebSocket(c *gin.Context) {
	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("Failed to upgrade Codex websocket")
		return
	}
	defer conn.Close()
	conn.SetReadLimit(codexMaxMessageBytes)

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	cmd := h.commandFactory(ctx)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		writeCodexClose(conn, websocket.CloseInternalServerErr, err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeCodexClose(conn, websocket.CloseInternalServerErr, err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		writeCodexClose(conn, websocket.CloseInternalServerErr, err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		writeCodexClose(conn, websocket.CloseInternalServerErr, fmt.Sprintf("start codex app-server: %v", err))
		return
	}

	var writeMu sync.Mutex
	writeText := func(payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(codexWriteTimeout)); err != nil {
			return err
		}
		return conn.WriteMessage(websocket.TextMessage, payload)
	}

	stdoutDone := make(chan error, 1)
	go func() {
		stdoutDone <- forwardCodexOutput(stdout, writeText)
	}()

	go logCodexStderr(stderr)

	clientDone := make(chan error, 1)
	go func() {
		clientDone <- forwardCodexInput(conn, stdin)
	}()

	processDone := make(chan error, 1)
	go func() {
		processDone <- cmd.Wait()
	}()

	var bridgeErr error
	select {
	case bridgeErr = <-clientDone:
	case bridgeErr = <-stdoutDone:
	case bridgeErr = <-processDone:
	}

	cancel()
	_ = stdin.Close()

	select {
	case <-processDone:
	case <-time.After(2 * time.Second):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}

	if bridgeErr != nil && !isExpectedCodexDisconnect(bridgeErr) {
		log.Warn().Err(bridgeErr).Msg("Codex websocket bridge closed")
		writeMu.Lock()
		_ = conn.SetWriteDeadline(time.Now().Add(codexWriteTimeout))
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, truncateCodexCloseReason(bridgeErr.Error())),
			time.Now().Add(codexWriteTimeout),
		)
		writeMu.Unlock()
	}
}

func forwardCodexInput(conn *websocket.Conn, stdin io.Writer) error {
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if messageType != websocket.TextMessage {
			return fmt.Errorf("Codex protocol requires text websocket messages")
		}
		if len(payload) > codexMaxMessageBytes {
			return fmt.Errorf("Codex request exceeds %d bytes", codexMaxMessageBytes)
		}
		var message map[string]json.RawMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return fmt.Errorf("invalid Codex JSON-RPC message: %w", err)
		}
		normalized, err := json.Marshal(message)
		if err != nil {
			return err
		}
		normalized = append(normalized, '\n')
		if _, err := stdin.Write(normalized); err != nil {
			return err
		}
	}
}

func forwardCodexOutput(stdout io.Reader, writeText func([]byte) error) error {
	return forwardCodexOutputWithLimit(stdout, writeText, codexMaxOutputLineBytes)
}

func forwardCodexOutputWithLimit(stdout io.Reader, writeText func([]byte) error, maxLineBytes int) error {
	if maxLineBytes < 1 {
		return fmt.Errorf("Codex stdout line limit must be positive")
	}
	reader := bufio.NewReaderSize(stdout, 64<<10)
	line := make([]byte, 0, 64<<10)
	var oversizedResponseID json.RawMessage
	oversized := false
	for {
		chunk, err := reader.ReadSlice('\n')
		if !oversized {
			remaining := maxLineBytes - len(line)
			if len(chunk) > remaining {
				if remaining > 0 {
					line = append(line, chunk[:remaining]...)
				}
				oversized = true
				oversizedResponseID, _ = extractCodexResponseID(line)
			} else {
				line = append(line, chunk...)
			}
		}
		if err != nil && !errors.Is(err, bufio.ErrBufferFull) && !errors.Is(err, io.EOF) {
			return err
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if len(line) == 0 && !oversized && errors.Is(err, io.EOF) {
			return nil
		}
		if oversized {
			if len(oversizedResponseID) > 0 {
				payload, marshalErr := marshalCodexOutputTooLargeResponse(oversizedResponseID, maxLineBytes)
				if marshalErr != nil {
					return marshalErr
				}
				if err := writeText(payload); err != nil {
					return err
				}
			} else {
				log.Warn().Int("limit", maxLineBytes).Msg("Ignored oversized Codex stdout notification")
			}
		} else {
			if len(line) > 0 && line[len(line)-1] == '\n' {
				line = line[:len(line)-1]
			}
			payload := append([]byte(nil), line...)
			if json.Valid(payload) {
				if err := writeText(payload); err != nil {
					return err
				}
			} else {
				log.Warn().Str("line", truncateCodexLogLine(string(payload))).Msg("Ignored non-JSON Codex stdout")
			}
		}
		line = line[:0]
		oversizedResponseID = nil
		oversized = false
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}

func extractCodexResponseID(prefix []byte) (json.RawMessage, bool) {
	prefix = bytes.TrimSpace(prefix)
	if len(prefix) == 0 || prefix[0] != '{' {
		return nil, false
	}
	prefix = bytes.TrimSpace(prefix[1:])
	if !bytes.HasPrefix(prefix, []byte(`"id"`)) {
		return nil, false
	}
	prefix = bytes.TrimSpace(prefix[len(`"id"`):])
	if len(prefix) == 0 || prefix[0] != ':' {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(prefix[1:]))
	var id json.RawMessage
	if err := decoder.Decode(&id); err != nil || len(id) == 0 {
		return nil, false
	}
	if id[0] != '"' && id[0] != '-' && (id[0] < '0' || id[0] > '9') {
		return nil, false
	}
	return append(json.RawMessage(nil), id...), true
}

func marshalCodexOutputTooLargeResponse(id json.RawMessage, limit int) ([]byte, error) {
	return json.Marshal(struct {
		ID    json.RawMessage `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    struct {
				LimitBytes int `json:"limitBytes"`
			} `json:"data"`
		} `json:"error"`
	}{
		ID: id,
		Error: struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    struct {
				LimitBytes int `json:"limitBytes"`
			} `json:"data"`
		}{
			Code:    codexOutputTooLargeCode,
			Message: fmt.Sprintf("Codex response exceeds %d byte bridge limit", limit),
			Data: struct {
				LimitBytes int `json:"limitBytes"`
			}{LimitBytes: limit},
		},
	})
}

func logCodexStderr(stderr io.Reader) {
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 16<<10), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			log.Debug().Str("codex", truncateCodexLogLine(line)).Msg("Codex app-server")
		}
	}
}

func writeCodexClose(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, truncateCodexCloseReason(reason)),
		time.Now().Add(codexWriteTimeout),
	)
}

func truncateCodexCloseReason(value string) string {
	const maxBytes = 120
	value = strings.TrimSpace(value)
	if len(value) <= maxBytes {
		return value
	}
	return value[:maxBytes]
}

func truncateCodexLogLine(value string) string {
	const maxBytes = 2048
	if len(value) <= maxBytes {
		return value
	}
	return value[:maxBytes] + "..."
}

func isExpectedCodexDisconnect(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
		return true
	}
	return websocket.IsCloseError(
		err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	)
}
