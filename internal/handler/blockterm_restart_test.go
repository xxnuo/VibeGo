package handler

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

func TestWriteBlockTermRestartError(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "block missing", err: gorm.ErrRecordNotFound, wantStatus: http.StatusNotFound},
		{name: "terminal missing", err: terminal.ErrTerminalNotFound, wantStatus: http.StatusNotFound},
		{name: "busy", err: terminal.ErrBlockTermRestartBusy, wantStatus: http.StatusConflict},
		{name: "unavailable", err: terminal.ErrBlockTermRestartUnavailable, wantStatus: http.StatusConflict},
		{name: "invalid", err: terminal.ErrBlockTermRestartInvalid, wantStatus: http.StatusBadRequest},
		{name: "unsupported", err: terminal.ErrBlockTermRestartUnsupported, wantStatus: http.StatusUnprocessableEntity},
		{name: "internal", err: errors.New("restart failed"), wantStatus: http.StatusInternalServerError},
	}

	gin.SetMode(gin.TestMode)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			writeBlockTermRestartError(context, test.err)
			require.Equal(t, test.wantStatus, response.Code)
			require.Contains(t, response.Body.String(), test.err.Error())
		})
	}
}

func TestBlockTermHandlerRestartRequestErrors(t *testing.T) {
	env := setupBlockTermHandler(t)

	malformed := httptest.NewRequest(
		http.MethodPost,
		"/api/blockterm/blocks/block-1/restart",
		strings.NewReader(`{"token":`),
	)
	malformed.Header.Set("Content-Type", "application/json")
	malformedResponse := httptest.NewRecorder()
	env.router.ServeHTTP(malformedResponse, malformed)
	require.Equal(t, http.StatusBadRequest, malformedResponse.Code)

	oversized := httptest.NewRequest(
		http.MethodPost,
		"/api/blockterm/blocks/block-1/restart",
		bytes.NewBufferString(`{"token":"`+strings.Repeat("a", blockTermRestartMaxBodyBytes)+`"}`),
	)
	oversized.Header.Set("Content-Type", "application/json")
	oversizedResponse := httptest.NewRecorder()
	env.router.ServeHTTP(oversizedResponse, oversized)
	require.Equal(t, http.StatusRequestEntityTooLarge, oversizedResponse.Code)
	require.JSONEq(t, `{"error":"request body is too large"}`, oversizedResponse.Body.String())

	missing := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks/missing/restart", map[string]any{
		"token":             strings.Repeat("a", 64),
		"mode":              "text",
		"term_cols":         120,
		"term_rows":         32,
		"term_flex_rows":    true,
		"term_max_pty_size": 4096,
		"before_state_json": `{"cwd":"/tmp"}`,
	})
	require.Equal(t, http.StatusNotFound, missing.Code)

	malformedCancel := httptest.NewRequest(
		http.MethodPost,
		"/api/blockterm/blocks/block-1/restart/cancel",
		strings.NewReader(`{"token":`),
	)
	malformedCancel.Header.Set("Content-Type", "application/json")
	malformedCancelResponse := httptest.NewRecorder()
	env.router.ServeHTTP(malformedCancelResponse, malformedCancel)
	require.Equal(t, http.StatusBadRequest, malformedCancelResponse.Code)

	missingCancel := doBlockTermJSON(
		t,
		env.router,
		http.MethodPost,
		"/api/blockterm/blocks/missing/restart/cancel",
		map[string]any{"token": strings.Repeat("a", 64)},
	)
	require.Equal(t, http.StatusNotFound, missingCancel.Code)
}

func TestBlockTermHandlerDeleteClearsIndependentRestartState(t *testing.T) {
	const (
		preparedToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
		retryToken    = "fedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcba"
	)
	restartRequest := func(token string) terminal.BlockTermRestartRequest {
		return terminal.BlockTermRestartRequest{
			Token:              token,
			Mode:               "text",
			TermCols:           80,
			TermRows:           24,
			TermMaxPTYSize:     4096,
			IndependentRuntime: true,
		}
	}
	seedBlock := func(t *testing.T, db *gorm.DB, terminalID, blockID, status string, lineNum int) {
		t.Helper()
		require.NoError(t, db.Create(&model.BlockTermBlock{
			ID: blockID, TerminalID: terminalID, LineNum: lineNum,
			Kind: "command", Command: "echo restart", Status: status,
			Mode: "text", Renderer: "terminal",
		}).Error)
	}

	t.Run("preparation", func(t *testing.T) {
		env, manager := setupBlockTermCompletionSSHHandler(t)
		info, err := manager.Create(terminal.CreateOptions{
			Name: "delete prepared restart", RuntimeType: terminal.RuntimeTypeSSH,
			SSHProfileID: "delete-prepared-profile",
		})
		require.NoError(t, err)
		t.Cleanup(func() { _ = manager.Close(info.ID) })

		const blockID = "delete-prepared-restart"
		seedBlock(t, env.db, info.ID, blockID, "success", 0)
		_, err = manager.RestartBlockTermBlock(blockID, restartRequest(preparedToken))
		require.NoError(t, err)

		deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+blockID, nil)
		require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

		seedBlock(t, env.db, info.ID, blockID, "success", 1)
		_, err = manager.RestartBlockTermBlock(blockID, restartRequest(retryToken))
		require.NoError(t, err, "deleted block must not retain its old preparation token")
		manager.ClearBlockRuntimePreparation(info.ID, blockID)
	})

	t.Run("cancellation tombstone", func(t *testing.T) {
		env, manager := setupBlockTermCompletionSSHHandler(t)
		info, err := manager.Create(terminal.CreateOptions{
			Name: "delete cancelled restart", RuntimeType: terminal.RuntimeTypeSSH,
			SSHProfileID: "delete-cancelled-profile",
		})
		require.NoError(t, err)
		t.Cleanup(func() { _ = manager.Close(info.ID) })

		const blockID = "delete-cancelled-restart"
		seedBlock(t, env.db, info.ID, blockID, "success", 0)
		_, err = manager.RestartBlockTermBlock(blockID, restartRequest(preparedToken))
		require.NoError(t, err)
		_, err = manager.CancelBlockTermRestart(blockID, preparedToken)
		require.NoError(t, err)

		deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+blockID, nil)
		require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

		seedBlock(t, env.db, info.ID, blockID, "interrupted", 1)
		_, err = manager.CancelBlockTermRestart(blockID, preparedToken)
		require.ErrorIs(t, err, terminal.ErrBlockTermRestartBusy,
			"deleted block must not retain an idempotent cancellation tombstone")
	})
}

func TestBlockTermHandlerPatchRejectsRestartOwnershipMove(t *testing.T) {
	env, manager := setupBlockTermCompletionSSHHandler(t)
	info, err := manager.Create(terminal.CreateOptions{
		Name:         "restart patch source",
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: "restart-patch-profile",
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, manager.Close(info.ID)) })

	const blockID = "restart-patch-block"
	const targetTerminalID = "restart-patch-target"
	seedBlockTermTerminal(t, env.db, targetTerminalID)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         blockID,
		TerminalID: info.ID,
		LineNum:    0,
		Kind:       "command",
		Command:    "echo restart",
		Status:     "success",
		Mode:       "text",
		Renderer:   "terminal",
	}).Error)

	const token = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	_, err = manager.RestartBlockTermBlock(blockID, terminal.BlockTermRestartRequest{
		Token:          token,
		Mode:           "text",
		TermCols:       80,
		TermRows:       24,
		TermFlexRows:   true,
		TermMaxPTYSize: 4096,
	})
	require.NoError(t, err)

	for _, patch := range []map[string]any{
		{"terminal_id": targetTerminalID},
		{"line_num": 1},
	} {
		response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, patch)
		require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), "running command lifecycle")
	}

	_, err = manager.CancelBlockTermRestart(blockID, token)
	require.NoError(t, err)
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).
		Where("id = ?", blockID).
		Update("status", "running").Error)
	for _, patch := range []map[string]any{
		{"terminal_id": targetTerminalID},
		{"line_num": 1},
	} {
		response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, patch)
		require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), "running command lifecycle")
	}

	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).
		Where("id = ?", blockID).
		Update("status", "success").Error)
	response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, map[string]any{
		"terminal_id": targetTerminalID,
		"status":      "running",
	})
	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "running command lifecycle")

	response = doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, map[string]any{
		"terminal_id": targetTerminalID,
	})
	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "source terminal is still running")

	require.NoError(t, manager.Close(info.ID))
	response = doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, map[string]any{
		"terminal_id": targetTerminalID,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", blockID).Error)
	require.Equal(t, targetTerminalID, block.TerminalID)
	require.Equal(t, 0, block.LineNum)
	require.Equal(t, "success", block.Status)
}
