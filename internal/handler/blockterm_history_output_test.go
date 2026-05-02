package handler

import (
	"bytes"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func blockTermHistoryOutputPath(history model.BlockTermCommandHistory) string {
	query := url.Values{}
	query.Set("terminal_id", history.TerminalID)
	query.Set("workspace_session_id", history.WorkspaceSessionID)
	query.Set("group_id", history.GroupID)
	query.Set("user_id", history.UserID)
	return "/api/blockterm/history/" + url.PathEscape(history.ID) + "/output?" + query.Encode()
}

func TestBlockTermHistorySnapshotTracksOutputPatchAndDelete(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminal := seedBlockTermHistoryTerminal(t, env, "history-snapshot-api-terminal")
	terminal.RuntimeType = "ssh"
	terminal.SSHProfileID = "history-snapshot-profile"
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).Updates(map[string]any{
		"runtime_type":   terminal.RuntimeType,
		"ssh_profile_id": terminal.SSHProfileID,
	}).Error)

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "history-snapshot-api-block",
		"terminal_id": terminal.ID,
		"line_num":    7,
		"kind":        "command",
		"command":     "echo original",
		"cwd":         "/original",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).Updates(map[string]any{
		"runtime_type":   "local",
		"ssh_profile_id": "replacement-profile",
	}).Error)

	output := append([]byte("\x1b[31mhistory\r\n"), 0, 7, 0xff)
	cursor := "29"
	put := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/history-snapshot-api-block/output",
		output,
		&cursor,
	)
	require.Equal(t, http.StatusNoContent, put.Code, put.Body.String())

	patched := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/history-snapshot-api-block", map[string]any{
		"command":           "echo changed",
		"cwd":               "/changed",
		"text":              "rendered output",
		"status":            "failed",
		"mode":              "shell",
		"cmd_pid":           101,
		"remote_pid":        202,
		"term_cols":         120,
		"term_rows":         30,
		"term_flex_rows":    true,
		"term_max_pty_size": 4096,
		"before_state_json": `{"cwd":"/before"}`,
		"after_state_json":  `{"cwd":"/after"}`,
		"exit_code":         17,
		"started_at":        100,
		"finished_at":       120,
		"renderer":          "markdown",
		"state_json":        `{"prompt:source":"pty"}`,
		"presentation_json": `{"height":280,"terminal":{"cols":120,"rows":30}}`,
	})
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())

	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", "history-snapshot-api-block").Error)
	require.Equal(t, "echo original", history.Command)
	require.Equal(t, "/original", history.Cwd)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "history-snapshot-profile", history.SSHProfileID)
	require.Equal(t, output, history.Output)
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, 29, *history.OutputCursor)
	require.Equal(t, "markdown", history.Renderer)
	require.Equal(t, `{"prompt:source":"pty"}`, history.StateJSON)
	require.Equal(t, `{"height":280,"terminal":{"cols":120,"rows":30}}`, history.PresentationJSON)
	require.NotNil(t, history.RemotePID)
	require.EqualValues(t, 202, *history.RemotePID)

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+history.ID, nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", history.ID).Count(&count).Error)
	require.Zero(t, count)

	require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
	require.NotNil(t, history.BlockDeletedAt)
	require.Equal(t, output, history.Output)
	require.Equal(t, "markdown", history.Renderer)
	require.NotNil(t, history.RemotePID)
	require.EqualValues(t, 202, *history.RemotePID)

	response := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(history), nil, nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "application/octet-stream", response.Header().Get("Content-Type"))
	require.Equal(t, "29", response.Header().Get(blockTermOutputCursorHeader))
	require.Equal(t, output, response.Body.Bytes())
}

func TestBlockTermHistoryOutputRequiresCompleteExactOwnerScope(t *testing.T) {
	env := setupBlockTermHandler(t)
	cursor := int64(8)
	history := model.BlockTermCommandHistory{
		ID: "history-output-owner", TerminalID: "owner-terminal",
		WorkspaceSessionID: "", GroupID: "", UserID: "",
		Command: "echo owner", Output: []byte("owner\x00output"), OutputCursor: &cursor, CreatedAt: 1,
	}
	require.NoError(t, env.db.Create(&history).Error)

	success := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(history), nil, nil)
	require.Equal(t, http.StatusOK, success.Code, success.Body.String())
	require.Equal(t, history.Output, success.Body.Bytes())
	require.Equal(t, "8", success.Header().Get(blockTermOutputCursorHeader))

	fields := []string{"terminal_id", "workspace_session_id", "group_id", "user_id"}
	for _, missingField := range fields {
		t.Run("missing "+missingField, func(t *testing.T) {
			query := url.Values{}
			for _, field := range fields {
				if field == missingField {
					continue
				}
				switch field {
				case "terminal_id":
					query.Set(field, history.TerminalID)
				case "workspace_session_id":
					query.Set(field, history.WorkspaceSessionID)
				case "group_id":
					query.Set(field, history.GroupID)
				case "user_id":
					query.Set(field, history.UserID)
				}
			}
			path := "/api/blockterm/history/" + history.ID + "/output?" + query.Encode()
			response := doBlockTermOutputRequest(env.router, http.MethodGet, path, nil, nil)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}

	for _, mismatchField := range fields {
		t.Run("mismatch "+mismatchField, func(t *testing.T) {
			query := url.Values{}
			query.Set("terminal_id", history.TerminalID)
			query.Set("workspace_session_id", history.WorkspaceSessionID)
			query.Set("group_id", history.GroupID)
			query.Set("user_id", history.UserID)
			query.Set(mismatchField, "mismatch")
			path := "/api/blockterm/history/" + history.ID + "/output?" + query.Encode()
			response := doBlockTermOutputRequest(env.router, http.MethodGet, path, nil, nil)
			require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
		})
	}

	purgedAt := int64(2)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", history.ID).
		UpdateColumn("history_purged_at", purgedAt).Error)
	purged := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(history), nil, nil)
	require.Equal(t, http.StatusNotFound, purged.Code, purged.Body.String())

	deletedAt := int64(3)
	tombstone := model.BlockTermCommandHistory{
		ID: "history-output-tombstone", TerminalID: "owner-terminal",
		Command: "", Output: []byte("hidden"), BlockDeletedAt: &deletedAt, CreatedAt: 2,
	}
	require.NoError(t, env.db.Create(&tombstone).Error)
	hidden := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(tombstone), nil, nil)
	require.Equal(t, http.StatusNotFound, hidden.Code, hidden.Body.String())
}

func TestBlockTermHistoryOutputSupportsMaximumSnapshot(t *testing.T) {
	env := setupBlockTermHandler(t)
	maximum := bytes.Repeat([]byte("x"), blockTermMaxOutputBytes)
	cursor := int64(len(maximum))
	history := model.BlockTermCommandHistory{
		ID: "history-output-maximum", TerminalID: "maximum-terminal",
		WorkspaceSessionID: "maximum-workspace", GroupID: "maximum-group", UserID: "maximum-user",
		Command: "emit maximum", Output: maximum, OutputCursor: &cursor, CreatedAt: 1,
	}
	require.NoError(t, env.db.Create(&history).Error)

	response := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(history), nil, nil)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, maximum, response.Body.Bytes())
	require.Equal(t, "16777216", response.Header().Get(blockTermOutputCursorHeader))
}

func TestBlockTermHistoryOutputSurvivesTerminalAndWorkspaceDeletion(t *testing.T) {
	tests := []struct {
		name   string
		delete func(t *testing.T, env blockTermTestEnv, terminal model.TerminalSession)
	}{
		{
			name: "terminal",
			delete: func(t *testing.T, env blockTermTestEnv, terminal model.TerminalSession) {
				require.NoError(t, env.manager.Delete(terminal.ID))
			},
		},
		{
			name: "workspace",
			delete: func(t *testing.T, env blockTermTestEnv, terminal model.TerminalSession) {
				require.NoError(t, env.db.AutoMigrate(&model.UserSession{}))
				require.NoError(t, env.db.Create(&model.UserSession{
					ID: terminal.WorkspaceSessionID, Name: "history workspace", State: "{}",
				}).Error)
				require.NoError(t, env.manager.DeleteWorkspace(terminal.WorkspaceSessionID))
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			terminal := seedBlockTermHistoryTerminal(t, env, "history-delete-"+tt.name+"-terminal")
			terminal.WorkspaceSessionID = "history-delete-" + tt.name + "-workspace"
			require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).
				UpdateColumn("workspace_session_id", terminal.WorkspaceSessionID).Error)

			displayCursor := int64(14)
			displayOutput := []byte("display\x00output")
			retainedOutput := []byte("durable\x00output")
			retainedCursor := int64(28)
			block := model.BlockTermBlock{
				ID: "history-delete-" + tt.name + "-block", TerminalID: terminal.ID, LineNum: 1,
				Kind: "command", Command: "echo durable", Status: "success", Output: displayOutput,
				OutputCursor: &displayCursor, RemotePID: blockTermInt64(404), Renderer: "terminal",
				CreatedAt: 10, UpdatedAt: 20,
			}
			history := blockTermCommandHistory(terminal, block)
			history.Output = append([]byte(nil), displayOutput...)
			history.OutputCursor = &displayCursor
			require.NoError(t, env.db.Create(&block).Error)
			require.NoError(t, env.db.Create(&history).Error)
			require.NoError(t, env.db.Create([]model.BlockTermOutputSegment{
				{ID: block.ID + "-tail", TerminalID: terminal.ID, BlockID: block.ID,
					StartCursor: 22, EndCursor: 22 + uint64(len("output")), Data: []byte("output"), CreatedAt: 12},
				{ID: block.ID + "-head", TerminalID: terminal.ID, BlockID: block.ID,
					StartCursor: 14, EndCursor: 22, Data: []byte("durable\x00"), CreatedAt: 11},
			}).Error)

			tt.delete(t, env, terminal)

			var count int64
			require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Count(&count).Error)
			require.Zero(t, count)
			require.NoError(t, env.db.Model(&model.BlockTermOutputSegment{}).Where("block_id = ?", block.ID).Count(&count).Error)
			require.Zero(t, count)
			require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).Count(&count).Error)
			require.Zero(t, count)

			require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
			require.Equal(t, retainedOutput, history.Output)
			require.Equal(t, &retainedCursor, history.OutputCursor)
			require.Equal(t, block.RemotePID, history.RemotePID)
			require.Equal(t, block.Renderer, history.Renderer)

			response := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(history), nil, nil)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.Equal(t, retainedOutput, response.Body.Bytes())
			require.Equal(t, "28", response.Header().Get(blockTermOutputCursorHeader))
		})
	}
}

func TestBlockTermDeleteMaterializesRecorderTailBeforeRemovingSegments(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminal := seedBlockTermHistoryTerminal(t, env, "history-delete-tail-terminal")
	terminal.RuntimeType = "ssh"
	terminal.SSHProfileID = "history-delete-tail-profile"
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).Updates(map[string]any{
		"runtime_type":   terminal.RuntimeType,
		"ssh_profile_id": terminal.SSHProfileID,
	}).Error)

	displayCursor := int64(8)
	displayOutput := []byte("stale")
	block := model.BlockTermBlock{
		ID: "history-delete-tail-block", TerminalID: terminal.ID, LineNum: 2,
		Kind: "command", Command: "printf retained", Cwd: "/retained",
		Status: "success", Output: displayOutput, OutputCursor: &displayCursor,
		RemotePID: blockTermInt64(909), Renderer: "markdown", CreatedAt: 10, UpdatedAt: 20,
	}
	history := blockTermCommandHistory(terminal, block)
	require.NoError(t, env.db.Create(&block).Error)
	require.NoError(t, env.db.Create(&history).Error)
	// Insert out of order to assert that materialization uses cursor ordering,
	// rather than insertion order or segment IDs alone.
	require.NoError(t, env.db.Create([]model.BlockTermOutputSegment{
		{ID: "history-delete-tail-z", TerminalID: terminal.ID, BlockID: block.ID,
			StartCursor: 16, EndCursor: 22, Data: []byte("output"), CreatedAt: 12},
		{ID: "history-delete-tail-a", TerminalID: terminal.ID, BlockID: block.ID,
			StartCursor: 8, EndCursor: 16, Data: []byte("durable\x00"), CreatedAt: 11},
	}).Error)

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+block.ID, nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermOutputSegment{}).Where("block_id = ?", block.ID).Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, []byte("durable\x00output"), history.Output)
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, 22, *history.OutputCursor)
	require.Equal(t, "markdown", history.Renderer)
	require.Equal(t, block.RemotePID, history.RemotePID)
	require.NotNil(t, history.BlockDeletedAt)

	response := doBlockTermOutputRequest(env.router, http.MethodGet, blockTermHistoryOutputPath(history), nil, nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, []byte("durable\x00output"), response.Body.Bytes())
	require.Equal(t, "22", response.Header().Get(blockTermOutputCursorHeader))
}
