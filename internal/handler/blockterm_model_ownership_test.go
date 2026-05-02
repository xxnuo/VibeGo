package handler

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestGenericBlockCreateRejectsModelRenderer(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "model-create-terminal")

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "generic-model-create",
		"terminal_id": "model-create-terminal",
		"line_num":    0,
		"kind":        "renderer",
		"renderer":    "openai",
		"status":      "streaming",
		"state_json":  `{"prompt:source":"model","model":"test-model"}`,
	})
	require.Equal(t, http.StatusConflict, response.Code)
	require.Contains(t, response.Body.String(), errBlockTermModelOwned.Error())

	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", "generic-model-create").Count(&count).Error)
	require.Zero(t, count)
}

func TestGenericBlockWritesPreserveModelOwnedLifecycle(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "model-owned-terminal")
	now := time.Now().Unix()
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "model-owned-block",
		TerminalID: "model-owned-terminal",
		LineNum:    0,
		Kind:       "renderer",
		Command:    "/chat explain",
		Text:       "explain",
		Status:     "streaming",
		Mode:       "text",
		Output:     []byte("provider output"),
		Renderer:   blockTermRendererOpenAI,
		StateJSON:  `{"prompt:source":"model","model":"test-model"}`,
		StartedAt:  &now,
		CreatedAt:  now,
		UpdatedAt:  now,
	}).Error)

	for name, patch := range map[string]map[string]any{
		"status":   {"status": "success"},
		"output":   {"output": []byte("forged")},
		"renderer": {"renderer": "markdown"},
		"state":    {"state_json": `{"prompt:source":"pty"}`},
		"identity": {"text": "changed prompt"},
	} {
		t.Run(name, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/model-owned-block", patch)
			require.Equal(t, http.StatusConflict, response.Code)
			require.Contains(t, response.Body.String(), errBlockTermModelOwned.Error())
		})
	}

	cursor := "1"
	outputResponse := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/model-owned-block/output",
		[]byte("forged output"),
		&cursor,
	)
	require.Equal(t, http.StatusConflict, outputResponse.Code)

	metadataResponse := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/model-owned-block", map[string]any{
		"collapsed":         true,
		"pinned":            true,
		"starred":           true,
		"presentation_json": `{"height":120}`,
	})
	require.Equal(t, http.StatusOK, metadataResponse.Code)

	var persisted model.BlockTermBlock
	require.NoError(t, env.db.First(&persisted, "id = ?", "model-owned-block").Error)
	require.Equal(t, "streaming", persisted.Status)
	require.Equal(t, blockTermRendererOpenAI, persisted.Renderer)
	require.Equal(t, "explain", persisted.Text)
	require.Equal(t, "provider output", string(persisted.Output))
	require.JSONEq(t, `{"prompt:source":"model","model":"test-model"}`, persisted.StateJSON)
	require.True(t, persisted.Collapsed)
	require.True(t, persisted.Pinned)
	require.True(t, persisted.Starred)
	require.JSONEq(t, `{"height":120}`, persisted.PresentationJSON)
}
