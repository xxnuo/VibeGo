package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestBlockTermRuntimeSelectionCreateListPatchRoundTrip(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "runtime-selection-terminal")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).
		Where("id = ?", "runtime-selection-terminal").Updates(map[string]any{
		"runtime_type":   "ssh",
		"ssh_profile_id": "parent-profile",
	}).Error)

	// An omitted selection inherits the terminal's durable defaults.
	inherited := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id": "runtime-selection-terminal",
		"line_num":    1,
		"command":     "echo inherited",
	})
	require.Equal(t, http.StatusCreated, inherited.Code, inherited.Body.String())
	var inheritedBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(inherited.Body.Bytes(), &inheritedBody))
	require.Equal(t, "ssh", inheritedBody.Block.RuntimeType)
	require.Equal(t, "parent-profile", inheritedBody.Block.SSHProfileID)

	explicit := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id":    "runtime-selection-terminal",
		"line_num":       2,
		"command":        "echo explicit",
		"runtime_type":   "local",
		"ssh_profile_id": "",
	})
	require.Equal(t, http.StatusCreated, explicit.Code, explicit.Body.String())
	var explicitBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(explicit.Body.Bytes(), &explicitBody))
	require.Equal(t, "local", explicitBody.Block.RuntimeType)
	require.Empty(t, explicitBody.Block.SSHProfileID)

	var inheritedHistory model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&inheritedHistory, "id = ?", inheritedBody.Block.ID).Error)
	require.Equal(t, "ssh", inheritedHistory.RuntimeType)
	require.Equal(t, "parent-profile", inheritedHistory.SSHProfileID)
	var explicitHistory model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&explicitHistory, "id = ?", explicitBody.Block.ID).Error)
	require.Equal(t, "local", explicitHistory.RuntimeType)
	require.Empty(t, explicitHistory.SSHProfileID)

	list := doBlockTermJSON(t, env.router, http.MethodGet,
		"/api/blockterm/blocks?terminal_id=runtime-selection-terminal", nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var listBody struct {
		Blocks []model.BlockTermBlock `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &listBody))
	require.Len(t, listBody.Blocks, 2)
	byID := make(map[string]model.BlockTermBlock, len(listBody.Blocks))
	for _, block := range listBody.Blocks {
		byID[block.ID] = block
	}
	require.Equal(t, "ssh", byID[inheritedBody.Block.ID].RuntimeType)
	require.Equal(t, "parent-profile", byID[inheritedBody.Block.ID].SSHProfileID)
	require.Equal(t, "local", byID[explicitBody.Block.ID].RuntimeType)
	require.Empty(t, byID[explicitBody.Block.ID].SSHProfileID)

	newRuntime := "ssh"
	newProfile := "child-profile"
	patched := doBlockTermJSON(t, env.router, http.MethodPatch,
		"/api/blockterm/blocks/"+explicitBody.Block.ID, map[string]any{
			"runtime_type":   newRuntime,
			"ssh_profile_id": newProfile,
		})
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())
	require.NoError(t, json.Unmarshal(patched.Body.Bytes(), &explicitBody))
	require.Equal(t, "ssh", explicitBody.Block.RuntimeType)
	require.Equal(t, "child-profile", explicitBody.Block.SSHProfileID)
	require.NoError(t, env.db.First(&explicitHistory, "id = ?", explicitBody.Block.ID).Error)
	require.Equal(t, "ssh", explicitHistory.RuntimeType)
	require.Equal(t, "child-profile", explicitHistory.SSHProfileID)
}

func TestBlockTermRuntimeSelectionRejectsInvalidCombinations(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "runtime-validation-terminal")

	cases := []struct {
		name    string
		payload map[string]any
	}{
		{
			name: "local with profile",
			payload: map[string]any{
				"terminal_id":    "runtime-validation-terminal",
				"line_num":       1,
				"runtime_type":   "local",
				"ssh_profile_id": "profile",
			},
		},
		{
			name: "ssh without profile",
			payload: map[string]any{
				"terminal_id":  "runtime-validation-terminal",
				"line_num":     2,
				"runtime_type": "ssh",
			},
		},
		{
			name: "unknown runtime",
			payload: map[string]any{
				"terminal_id":  "runtime-validation-terminal",
				"line_num":     3,
				"runtime_type": "container",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", tc.payload)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id":  "runtime-validation-terminal",
		"line_num":     4,
		"runtime_type": "local",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	var createdBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &createdBody))

	profile := "profile"
	patchProfile := doBlockTermJSON(t, env.router, http.MethodPatch,
		"/api/blockterm/blocks/"+createdBody.Block.ID, map[string]any{
			"ssh_profile_id": profile,
		})
	require.Equal(t, http.StatusBadRequest, patchProfile.Code, patchProfile.Body.String())
	patchRuntime := doBlockTermJSON(t, env.router, http.MethodPatch,
		"/api/blockterm/blocks/"+createdBody.Block.ID, map[string]any{
			"runtime_type": "ssh",
		})
	require.Equal(t, http.StatusBadRequest, patchRuntime.Code, patchRuntime.Body.String())
}

func TestBlockTermIdempotentCreateReportsInvalidLegacySelection(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "runtime-invalid-existing-terminal")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "runtime-invalid-existing-block", TerminalID: "runtime-invalid-existing-terminal",
		LineNum: 1, Command: "echo existing", RuntimeType: "container",
		CreatedAt: 10, UpdatedAt: 10,
	}).Error)

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":           "runtime-invalid-existing-block",
		"terminal_id":  "runtime-invalid-existing-terminal",
		"line_num":     1,
		"command":      "echo existing",
		"runtime_type": "local",
	})
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "runtime_type must be local or ssh")
	require.NotContains(t, strings.ToLower(response.Body.String()), "unique constraint")
}
