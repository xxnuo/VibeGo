package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func seedBlockTermHistoryTerminal(t *testing.T, env blockTermTestEnv, id string) model.TerminalSession {
	t.Helper()
	terminal := model.TerminalSession{
		ID:                 id,
		Name:               "history terminal",
		Status:             model.StatusClosed,
		WorkspaceSessionID: "workspace-history",
		GroupID:            "group-history",
		UserID:             "user-history",
		RuntimeType:        "local",
	}
	require.NoError(t, env.db.Create(&terminal).Error)
	return terminal
}

func historyTarget(history model.BlockTermCommandHistory) map[string]any {
	return map[string]any{
		"id":                   history.ID,
		"terminal_id":          history.TerminalID,
		"workspace_session_id": history.WorkspaceSessionID,
		"group_id":             history.GroupID,
		"user_id":              history.UserID,
	}
}

func TestBlockTermHistoryStarredFilterAndPurgedVisibility(t *testing.T) {
	env := setupBlockTermHandler(t)
	deletedAt := int64(20)
	purgedAt := int64(30)
	require.NoError(t, env.db.Create([]model.BlockTermCommandHistory{
		{ID: "starred", TerminalID: "term", Command: "echo starred", Starred: true, CreatedAt: 5},
		{ID: "plain", TerminalID: "term", Command: "echo plain", CreatedAt: 4},
		{ID: "deleted-command", TerminalID: "term", Command: "echo deleted", BlockDeletedAt: &deletedAt, CreatedAt: 3},
		{ID: "hidden-tombstone", TerminalID: "term", Command: "", BlockDeletedAt: &deletedAt, CreatedAt: 2},
		{ID: "purged", TerminalID: "term", Command: "echo purged", Starred: true, HistoryPurgedAt: &purgedAt, CreatedAt: 1},
	}).Error)

	response := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		History []model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, []string{"starred", "plain", "deleted-command"}, []string{
		body.History[0].ID,
		body.History[1].ID,
		body.History[2].ID,
	})

	response = doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?starred=1", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Len(t, body.History, 1)
	require.Equal(t, "starred", body.History[0].ID)

	response = doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?starred=0", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, []string{"plain", "deleted-command"}, []string{body.History[0].ID, body.History[1].ID})

	invalid := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?starred=true", nil)
	require.Equal(t, http.StatusBadRequest, invalid.Code, invalid.Body.String())
}

func TestBlockTermHistoryStarredSynchronizesWithLiveBlock(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminal := seedBlockTermHistoryTerminal(t, env, "term-star-sync")
	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "history-starred-snapshot",
		"terminal_id": terminal.ID,
		"line_num":    2,
		"command":     "echo snapshot",
		"starred":     true,
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	var snapshot model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&snapshot, "id = ?", "history-starred-snapshot").Error)
	require.True(t, snapshot.Starred)

	block := model.BlockTermBlock{
		ID: "history-star-sync", TerminalID: terminal.ID, LineNum: 1,
		Command: "echo sync", CreatedAt: 10, UpdatedAt: 10,
	}
	history := blockTermCommandHistory(terminal, block)
	require.NoError(t, env.db.Create(&block).Error)
	require.NoError(t, env.db.Create(&history).Error)

	blockPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+block.ID, map[string]any{
		"starred": true,
	})
	require.Equal(t, http.StatusOK, blockPatch.Code, blockPatch.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
	require.True(t, history.Starred)

	missingStarred := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
		"terminal_id": terminal.ID,
	})
	require.Equal(t, http.StatusBadRequest, missingStarred.Code, missingStarred.Body.String())
	missingTerminal := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
		"starred": false,
	})
	require.Equal(t, http.StatusBadRequest, missingTerminal.Code, missingTerminal.Body.String())

	historyPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
		"terminal_id":          terminal.ID,
		"workspace_session_id": terminal.WorkspaceSessionID,
		"group_id":             terminal.GroupID,
		"user_id":              terminal.UserID,
		"starred":              false,
	})
	require.Equal(t, http.StatusOK, historyPatch.Code, historyPatch.Body.String())
	require.NotContains(t, historyPatch.Body.String(), "history_purged_at")
	var patchBody struct {
		History model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(historyPatch.Body.Bytes(), &patchBody))
	require.False(t, patchBody.History.Starred)
	require.NoError(t, env.db.First(&block, "id = ?", block.ID).Error)
	require.False(t, block.Starred)

	mismatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
		"terminal_id": terminal.ID,
		"group_id":    "other-group",
		"starred":     true,
	})
	require.Equal(t, http.StatusNotFound, mismatch.Code, mismatch.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
	require.False(t, history.Starred)
	for field, value := range map[string]string{
		"workspace_session_id": "other-workspace",
		"user_id":              "other-user",
	} {
		response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
			"terminal_id": terminal.ID,
			field:         value,
			"starred":     true,
		})
		require.Equal(t, http.StatusNotFound, response.Code, field+": "+response.Body.String())
	}

	idMismatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
		"id":          "other-history",
		"terminal_id": terminal.ID,
		"starred":     true,
	})
	require.Equal(t, http.StatusBadRequest, idMismatch.Code, idMismatch.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
	require.False(t, history.Starred)

	purgedAt := int64(40)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", block.ID).
		UpdateColumn("history_purged_at", purgedAt).Error)
	blockPatch = doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+block.ID, map[string]any{
		"starred": true,
	})
	require.Equal(t, http.StatusOK, blockPatch.Code, blockPatch.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
	require.True(t, history.Starred)
}

func TestBlockTermHistoryStarredDoesNotSynchronizeAcrossBlockMove(t *testing.T) {
	env := setupBlockTermHandler(t)
	source := seedBlockTermHistoryTerminal(t, env, "term-star-move-source")
	destination := model.TerminalSession{
		ID: "term-star-move-destination", Name: "destination", Status: model.StatusClosed,
		WorkspaceSessionID: "workspace-destination", GroupID: "group-destination",
		UserID: "user-destination", RuntimeType: "ssh",
	}
	require.NoError(t, env.db.Create(&destination).Error)
	block := model.BlockTermBlock{
		ID: "history-star-move", TerminalID: source.ID, LineNum: 1, Kind: "command",
		Command: "echo moved", CreatedAt: 20, UpdatedAt: 20,
	}
	history := blockTermCommandHistory(source, block)
	require.NoError(t, env.db.Create(&block).Error)
	require.NoError(t, env.db.Create(&history).Error)

	moved := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+block.ID, map[string]any{
		"terminal_id": destination.ID,
		"line_num":    2,
	})
	require.Equal(t, http.StatusOK, moved.Code, moved.Body.String())

	blockPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+block.ID, map[string]any{
		"starred": true,
	})
	require.Equal(t, http.StatusOK, blockPatch.Code, blockPatch.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", block.ID).Error)
	require.False(t, history.Starred)
	require.Equal(t, source.ID, history.TerminalID)

	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", history.ID).UpdateColumn("starred", true).Error)
	historyPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+block.ID, map[string]any{
		"id":                   block.ID,
		"terminal_id":          source.ID,
		"workspace_session_id": source.WorkspaceSessionID,
		"group_id":             source.GroupID,
		"user_id":              source.UserID,
		"starred":              false,
	})
	require.Equal(t, http.StatusOK, historyPatch.Code, historyPatch.Body.String())
	require.NoError(t, env.db.First(&block, "id = ?", block.ID).Error)
	require.Equal(t, destination.ID, block.TerminalID)
	require.True(t, block.Starred)
	require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
	require.False(t, history.Starred)
}

func TestBlockTermHistoryStarredIgnoresUnrelatedNonHistoryBlockWithReusedID(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminal := seedBlockTermHistoryTerminal(t, env, "term-star-reused-id")
	history := model.BlockTermCommandHistory{
		ID: "history-star-reused-id", TerminalID: "old-terminal", LineNum: 3,
		Command: "echo retained", Starred: false, CreatedAt: 10,
	}
	block := model.BlockTermBlock{
		ID: history.ID, TerminalID: terminal.ID, LineNum: 1, Kind: "note",
		Text: "unrelated note", Starred: false, CreatedAt: 20, UpdatedAt: 20,
	}
	require.NoError(t, env.db.Create(&history).Error)
	require.NoError(t, env.db.Create(&block).Error)

	patched := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+block.ID, map[string]any{
		"starred": true,
	})
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
	require.False(t, history.Starred)
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).UpdateColumn("starred", false).Error)

	historyPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+history.ID, map[string]any{
		"id":          history.ID,
		"terminal_id": history.TerminalID,
		"starred":     true,
	})
	require.Equal(t, http.StatusOK, historyPatch.Code, historyPatch.Body.String())
	require.NoError(t, env.db.First(&block, "id = ?", block.ID).Error)
	require.False(t, block.Starred)
}

func TestBlockTermHistoryPurgePreservesLiveBlockAndOutput(t *testing.T) {
	env := setupBlockTermHandler(t)
	terminal := seedBlockTermHistoryTerminal(t, env, "term-purge")
	block := model.BlockTermBlock{
		ID: "history-purge", TerminalID: terminal.ID, LineNum: 1,
		Command: "echo purge", CreatedAt: 10, UpdatedAt: 10,
	}
	history := blockTermCommandHistory(terminal, block)
	segment := model.BlockTermOutputSegment{
		ID: "history-purge-output", TerminalID: terminal.ID, BlockID: block.ID,
		StartCursor: 0, EndCursor: 6, Data: []byte("output"), CreatedAt: 11,
	}
	require.NoError(t, env.db.Create(&block).Error)
	require.NoError(t, env.db.Create(&history).Error)
	require.NoError(t, env.db.Create(&segment).Error)

	response := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/history", map[string]any{
		"targets": []any{historyTarget(history)},
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		PurgedIDs []string `json:"purged_ids"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, []string{history.ID}, body.PurgedIDs)

	require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
	require.NotNil(t, history.HistoryPurgedAt)
	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Count(&count).Error)
	require.EqualValues(t, 1, count)
	require.NoError(t, env.db.Model(&model.BlockTermOutputSegment{}).Where("id = ?", segment.ID).Count(&count).Error)
	require.EqualValues(t, 1, count)

	visible := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?terminal_id="+terminal.ID, nil)
	require.Equal(t, http.StatusOK, visible.Code, visible.Body.String())
	var visibleBody struct {
		History []model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(visible.Body.Bytes(), &visibleBody))
	require.Empty(t, visibleBody.History)
	patchPurged := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+history.ID, map[string]any{
		"terminal_id": terminal.ID,
		"starred":     true,
	})
	require.Equal(t, http.StatusNotFound, patchPurged.Code, patchPurged.Body.String())

	deleteBlock := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+block.ID, nil)
	require.Equal(t, http.StatusOK, deleteBlock.Code, deleteBlock.Body.String())
	require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
	require.NotNil(t, history.HistoryPurgedAt)
	require.NotNil(t, history.BlockDeletedAt)
}

func TestBlockTermHistoryPurgeIsAtomicAcrossScopeMismatch(t *testing.T) {
	env := setupBlockTermHandler(t)
	histories := []model.BlockTermCommandHistory{
		{ID: "purge-atomic-a", TerminalID: "term-a", WorkspaceSessionID: "ws-a", GroupID: "group-a", UserID: "user-a", Command: "echo a", CreatedAt: 2},
		{ID: "purge-atomic-b", TerminalID: "term-b", WorkspaceSessionID: "ws-b", GroupID: "group-b", UserID: "user-b", Command: "echo b", CreatedAt: 1},
	}
	require.NoError(t, env.db.Create(&histories).Error)
	second := historyTarget(histories[1])
	second["group_id"] = "wrong-group"
	response := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/history", map[string]any{
		"targets": []any{historyTarget(histories[0]), second},
	})
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	for _, history := range histories {
		require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
		require.Nil(t, history.HistoryPurgedAt)
	}

	purgedAt := int64(90)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", histories[1].ID).
		UpdateColumn("history_purged_at", purgedAt).Error)
	response = doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/history", map[string]any{
		"targets": []any{historyTarget(histories[0]), historyTarget(histories[1])},
	})
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	require.NoError(t, env.db.First(&histories[0], "id = ?", histories[0].ID).Error)
	require.Nil(t, histories[0].HistoryPurgedAt)
}

func TestBlockTermHistoryPurgeValidatesTargets(t *testing.T) {
	env := setupBlockTermHandler(t)
	tests := []struct {
		name    string
		payload any
	}{
		{name: "empty", payload: map[string]any{"targets": []any{}}},
		{name: "missing id", payload: map[string]any{"targets": []any{map[string]any{"terminal_id": "term"}}}},
		{name: "missing terminal", payload: map[string]any{"targets": []any{map[string]any{"id": "history"}}}},
		{name: "duplicate", payload: map[string]any{"targets": []any{
			map[string]any{"id": "history", "terminal_id": "term-a"},
			map[string]any{"id": "history", "terminal_id": "term-b"},
		}}},
	}
	tooMany := make([]any, blockTermHistoryPurgeMaxTargets+1)
	for i := range tooMany {
		tooMany[i] = map[string]any{"id": fmt.Sprintf("history-%d", i), "terminal_id": "term"}
	}
	tests = append(tests, struct {
		name    string
		payload any
	}{name: "too many", payload: map[string]any{"targets": tooMany}})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/history", tt.payload)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}
}

func TestBlockTermHistoryPurgeAcceptsMaximumBatch(t *testing.T) {
	env := setupBlockTermHandler(t)
	histories := make([]model.BlockTermCommandHistory, blockTermHistoryPurgeMaxTargets)
	targets := make([]any, blockTermHistoryPurgeMaxTargets)
	expectedIDs := make([]string, blockTermHistoryPurgeMaxTargets)
	for i := range histories {
		histories[i] = model.BlockTermCommandHistory{
			ID: fmt.Sprintf("history-max-%03d", i), TerminalID: "term-max",
			Command: fmt.Sprintf("echo %d", i), CreatedAt: int64(i + 1),
		}
		targets[i] = historyTarget(histories[i])
		expectedIDs[i] = histories[i].ID
	}
	require.NoError(t, env.db.Create(&histories).Error)

	response := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/history", map[string]any{
		"targets": targets,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var responseBody struct {
		PurgedIDs []string `json:"purged_ids"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &responseBody))
	require.Equal(t, expectedIDs, responseBody.PurgedIDs)
	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).
		Where("history_purged_at IS NOT NULL").Count(&count).Error)
	require.EqualValues(t, blockTermHistoryPurgeMaxTargets, count)
}

func TestBlockTermHistoryMutationBodyLimit(t *testing.T) {
	env := setupBlockTermHandler(t)
	oversized := strings.Repeat("x", blockTermHistoryMutationMaxBodyBytes)
	for _, request := range []struct {
		method string
		path   string
		body   any
	}{
		{
			method: http.MethodPatch,
			path:   "/api/blockterm/history/history-body-limit",
			body: map[string]any{
				"id": "history-body-limit", "terminal_id": "term", "starred": true, "extra": oversized,
			},
		},
		{
			method: http.MethodDelete,
			path:   "/api/blockterm/history",
			body: map[string]any{
				"targets": []any{map[string]any{"id": "history-body-limit", "terminal_id": "term", "extra": oversized}},
			},
		},
	} {
		response := doBlockTermJSON(t, env.router, request.method, request.path, request.body)
		require.Equal(t, http.StatusRequestEntityTooLarge, response.Code, response.Body.String())
	}
}

func TestBlockTermHistoryMutationFailuresRollback(t *testing.T) {
	t.Run("history patch rolls back when live block sync fails", func(t *testing.T) {
		env := setupBlockTermHandler(t)
		terminal := seedBlockTermHistoryTerminal(t, env, "term-history-patch-rollback")
		block := model.BlockTermBlock{
			ID: "history-patch-rollback", TerminalID: terminal.ID, LineNum: 1, Kind: "command",
			Command: "echo rollback", CreatedAt: 10, UpdatedAt: 10,
		}
		history := blockTermCommandHistory(terminal, block)
		require.NoError(t, env.db.Create(&block).Error)
		require.NoError(t, env.db.Create(&history).Error)

		forcedErr := errors.New("forced live block sync failure")
		const callbackName = "test:blockterm_history_patch_rollback"
		require.NoError(t, env.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
			if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermBlock{}).TableName() {
				tx.AddError(forcedErr)
			}
		}))
		callbackRegistered := true
		t.Cleanup(func() {
			if callbackRegistered {
				_ = env.db.Callback().Update().Remove(callbackName)
			}
		})

		response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/history/"+history.ID, map[string]any{
			"id": history.ID, "terminal_id": terminal.ID, "starred": true,
		})
		require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), forcedErr.Error())
		require.NoError(t, env.db.Callback().Update().Remove(callbackName))
		callbackRegistered = false

		require.NoError(t, env.db.First(&history, "id = ?", history.ID).Error)
		require.False(t, history.Starred)
		require.NoError(t, env.db.First(&block, "id = ?", block.ID).Error)
		require.False(t, block.Starred)
	})

	t.Run("purge rolls back on database update failure", func(t *testing.T) {
		env := setupBlockTermHandler(t)
		histories := []model.BlockTermCommandHistory{
			{ID: "history-purge-rollback-a", TerminalID: "term", Command: "echo a", CreatedAt: 2},
			{ID: "history-purge-rollback-b", TerminalID: "term", Command: "echo b", CreatedAt: 1},
		}
		require.NoError(t, env.db.Create(&histories).Error)

		forcedErr := errors.New("forced history purge failure")
		const callbackName = "test:blockterm_history_purge_rollback"
		require.NoError(t, env.db.Callback().Update().After("gorm:update").Register(callbackName, func(tx *gorm.DB) {
			if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermCommandHistory{}).TableName() {
				tx.AddError(forcedErr)
			}
		}))
		callbackRegistered := true
		t.Cleanup(func() {
			if callbackRegistered {
				_ = env.db.Callback().Update().Remove(callbackName)
			}
		})

		response := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/history", map[string]any{
			"targets": []any{historyTarget(histories[0]), historyTarget(histories[1])},
		})
		require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), forcedErr.Error())
		require.NoError(t, env.db.Callback().Update().Remove(callbackName))
		callbackRegistered = false

		for i := range histories {
			require.NoError(t, env.db.First(&histories[i], "id = ?", histories[i].ID).Error)
			require.Nil(t, histories[i].HistoryPurgedAt)
		}
	})
}
