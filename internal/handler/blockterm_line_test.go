package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestBlockTermNoteMetadataAndHistorySemantics(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-note")

	presentation := `{"height":320,"sidebar":{"open":true,"width":"320px"},"terminal":{"cols":80,"rows":24}}`
	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":                "note-1",
		"terminal_id":       "term-note",
		"line_num":          0,
		"kind":              "note",
		"text":              "a durable note",
		"presentation_json": presentation,
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	var createdBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &createdBody))
	require.Equal(t, "note", createdBody.Block.Kind)
	require.Equal(t, "a durable note", createdBody.Block.Text)
	require.Equal(t, presentation, createdBody.Block.PresentationJSON)

	retry := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":                "note-1",
		"terminal_id":       "term-note",
		"line_num":          0,
		"kind":              "note",
		"text":              "a durable note",
		"presentation_json": presentation,
	})
	require.Equal(t, http.StatusCreated, retry.Code, retry.Body.String())

	var historyCount int64
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Count(&historyCount).Error)
	require.Zero(t, historyCount)

	list := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks?terminal_id=term-note&include_output=0", nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var listBody struct {
		Blocks []blockTermMetadata `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &listBody))
	require.Len(t, listBody.Blocks, 1)
	require.Equal(t, "note", listBody.Blocks[0].Kind)
	require.Equal(t, "a durable note", listBody.Blocks[0].Text)
	require.Equal(t, presentation, listBody.Blocks[0].PresentationJSON)

	patchedPresentation := `{"height":-1,"sidebar":false,"terminal_cols":100,"terminal_rows":30}`
	patched := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/note-1", map[string]any{
		"text":              "updated note",
		"presentation_json": patchedPresentation,
	})
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())
	require.NoError(t, json.Unmarshal(patched.Body.Bytes(), &createdBody))
	require.Equal(t, "updated note", createdBody.Block.Text)
	require.Equal(t, patchedPresentation, createdBody.Block.PresentationJSON)

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/note-1", nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Count(&historyCount).Error)
	require.EqualValues(t, 1, historyCount)
	var tombstone model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&tombstone, "id = ?", "note-1").Error)
	require.Empty(t, tombstone.Command)
	require.NotNil(t, tombstone.BlockDeletedAt)

	history := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?terminal_id=term-note", nil)
	require.Equal(t, http.StatusOK, history.Code, history.Body.String())
	var historyBody struct {
		History []model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(history.Body.Bytes(), &historyBody))
	require.Empty(t, historyBody.History)
}

func TestBlockTermRendererKindCompatibilityAndIdempotency(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-renderer-kind")
	payload := map[string]any{
		"id":          "renderer-1",
		"terminal_id": "term-renderer-kind",
		"line_num":    0,
		"command":     "codeview README.md",
		"renderer":    "code",
		"state_json":  `{"prompt:source":"file"}`,
	}
	first := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
	require.Equal(t, http.StatusCreated, first.Code, first.Body.String())
	var firstBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &firstBody))
	require.Equal(t, "renderer", firstBody.Block.Kind)

	retry := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
	require.Equal(t, http.StatusCreated, retry.Code, retry.Body.String())
	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", "renderer-1").Count(&count).Error)
	require.EqualValues(t, 1, count)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "renderer-1").Count(&count).Error)
	require.EqualValues(t, 1, count)

	conflict := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "renderer-1",
		"terminal_id": "term-renderer-kind",
		"line_num":    0,
		"command":     "codeview README.md",
		"renderer":    "code",
		"state_json":  `{"prompt:source":"file"}`,
		"text":        "different presentation text",
	})
	require.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
}

func TestBlockTermLineMetadataValidation(t *testing.T) {
	cases := []struct {
		name    string
		payload map[string]any
		error   string
	}{
		{
			name:    "invalid kind",
			payload: map[string]any{"kind": "comment"},
			error:   "kind must be command, note, or renderer",
		},
		{
			name:    "text too long",
			payload: map[string]any{"kind": "note", "text": strings.Repeat("x", blockTermMaxTextLen+1)},
			error:   "text too long",
		},
		{
			name:    "presentation must be object",
			payload: map[string]any{"presentation_json": `[]`},
			error:   "presentation_json must be a valid JSON object",
		},
		{
			name:    "presentation rejects unknown key",
			payload: map[string]any{"presentation_json": `{"color":"red"}`},
			error:   "presentation_json.color is not supported",
		},
		{
			name:    "height out of range",
			payload: map[string]any{"presentation_json": `{"height":10001}`},
			error:   "presentation_json.height must be between",
		},
		{
			name:    "terminal cols out of range",
			payload: map[string]any{"presentation_json": `{"terminal":{"cols":9}}`},
			error:   "presentation_json.terminal.cols must be between",
		},
		{
			name:    "terminal rows out of range",
			payload: map[string]any{"presentation_json": `{"terminal_rows":1025}`},
			error:   "presentation_json.terminal_rows must be between",
		},
		{
			name:    "sidebar width out of range",
			payload: map[string]any{"presentation_json": `{"sidebar":{"width":"101%"}}`},
			error:   "presentation_json.sidebar.width must be a bounded",
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			seedBlockTermTerminal(t, env.db, "term-validation")
			payload := map[string]any{
				"terminal_id": "term-validation",
				"line_num":    0,
			}
			for key, value := range tt.payload {
				payload[key] = value
			}
			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), tt.error)
		})
	}
}

func TestBlockTermLineMetadataBodyLimit(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-body-limit")
	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id":       "term-body-limit",
		"line_num":          0,
		"presentation_json": `{"height":1}`,
		"text":              strings.Repeat("x", blockTermMaxBodyBytes),
	})
	require.Equal(t, http.StatusRequestEntityTooLarge, response.Code, response.Body.String())
}

func TestBlockTermLineMetadataValidationHelpers(t *testing.T) {
	require.NoError(t, validateBlockTermPresentationJSON(`{"height":-1,"sidebar":true,"terminal":{"cols":10,"rows":2}}`))
	require.NoError(t, validateBlockTermPresentationJSON(`{"sidebar":{"open":false,"width":"100%","sidebarlineid":"line-1"}}`))
	require.NoError(t, validateBlockTermMetadata("note", "note", "", "", `{"height":0}`))
	require.Error(t, validateBlockTermMetadata("unknown", "", "", "", ""))
}

func TestBlockTermPresentationRejectsNullAndNonIntegerNumbers(t *testing.T) {
	cases := []struct {
		name         string
		presentation string
		error        string
	}{
		{name: "height null", presentation: `{"height":null}`, error: "presentation_json.height must be an integer"},
		{name: "height decimal", presentation: `{"height":1.0}`, error: "presentation_json.height must be an integer"},
		{name: "height exponent", presentation: `{"height":1e2}`, error: "presentation_json.height must be an integer"},
		{name: "terminal cols null", presentation: `{"terminal_cols":null}`, error: "presentation_json.terminal_cols must be an integer"},
		{name: "terminal cols decimal", presentation: `{"terminal":{"cols":10.0}}`, error: "presentation_json.terminal.cols must be an integer"},
		{name: "terminal rows exponent", presentation: `{"terminal":{"rows":2e0}}`, error: "presentation_json.terminal.rows must be an integer"},
		{name: "sidebar null", presentation: `{"sidebar":null}`, error: "presentation_json.sidebar must be a boolean or object"},
		{name: "sidebar open null", presentation: `{"sidebar":{"open":null}}`, error: "presentation_json.sidebar.open must be a boolean"},
		{name: "sidebar width null", presentation: `{"sidebar":{"width":null}}`, error: "presentation_json.sidebar.width must be a bounded px or percent value"},
		{name: "sidebar line id null", presentation: `{"sidebar":{"line_id":null}}`, error: "presentation_json.sidebar.line_id is invalid"},
		{name: "terminal null", presentation: `{"terminal":null}`, error: "presentation_json.terminal must be an object"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := validateBlockTermPresentationJSON(tt.presentation)
			require.EqualError(t, err, tt.error)
		})
	}
}

func TestBlockTermCommandLifecycleMetadataRoundTrip(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-command-metadata")
	before := `{"cwd":"/before","shellType":"bash","shellState":"ready","shellIntegration":true}`
	after := `{"cwd":"/after","shellType":"bash","shellState":"ready","shellIntegration":true,"lastCommandExitCode":0}`
	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":                "command-metadata",
		"terminal_id":       "term-command-metadata",
		"line_num":          0,
		"command":           "cd /after",
		"cmd_pid":           1234,
		"term_cols":         132,
		"term_rows":         41,
		"term_flex_rows":    true,
		"term_max_pty_size": blockTermMaxOutputBytes,
		"before_state_json": before,
		"status":            "running",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	// Lifecycle fields are mutable and may be absent on a retry from an older client.
	retry := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "command-metadata",
		"terminal_id": "term-command-metadata",
		"line_num":    0,
		"command":     "cd /after",
	})
	require.Equal(t, http.StatusCreated, retry.Code, retry.Body.String())
	var retryBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(retry.Body.Bytes(), &retryBody))
	require.Equal(t, int64(1234), *retryBody.Block.CmdPID)
	require.Nil(t, retryBody.Block.RemotePID)
	require.Equal(t, before, retryBody.Block.BeforeStateJSON)
	require.Empty(t, retryBody.Block.AfterStateJSON)

	patched := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/command-metadata?include_output=0", map[string]any{
		"cmd_pid":          nil,
		"remote_pid":       5678,
		"after_state_json": after,
		"status":           "success",
		"exit_code":        0,
	})
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())
	var patchedBody struct {
		Block blockTermMetadata `json:"block"`
	}
	require.NoError(t, json.Unmarshal(patched.Body.Bytes(), &patchedBody))
	require.Nil(t, patchedBody.Block.CmdPID)
	require.Equal(t, int64(5678), *patchedBody.Block.RemotePID)
	require.Equal(t, 132, patchedBody.Block.TermCols)
	require.Equal(t, 41, patchedBody.Block.TermRows)
	require.True(t, patchedBody.Block.TermFlexRows)
	require.Equal(t, blockTermMaxOutputBytes, patchedBody.Block.TermMaxPTYSize)
	require.Equal(t, before, patchedBody.Block.BeforeStateJSON)
	require.Equal(t, after, patchedBody.Block.AfterStateJSON)

	listed := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks?terminal_id=term-command-metadata&include_output=0", nil)
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	var listBody struct {
		Blocks []blockTermMetadata `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &listBody))
	require.Len(t, listBody.Blocks, 1)
	require.Equal(t, patchedBody.Block, listBody.Blocks[0])
}

func TestBlockTermCommandLifecycleMetadataValidation(t *testing.T) {
	for _, tt := range []struct {
		name  string
		field string
		value any
		error string
	}{
		{name: "pid", field: "cmd_pid", value: 0, error: "cmd_pid must be a positive integer"},
		{name: "cols", field: "term_cols", value: 9, error: "term_cols must be between"},
		{name: "rows", field: "term_rows", value: 1025, error: "term_rows must be between"},
		{name: "max pty", field: "term_max_pty_size", value: blockTermMaxOutputBytes + 1, error: "term_max_pty_size must be between"},
		{name: "state type", field: "before_state_json", value: `[]`, error: "before_state_json must be a valid JSON object"},
		{name: "state length", field: "after_state_json", value: `{"value":"` + strings.Repeat("x", blockTermMaxCommandStateLen) + `"}`, error: "after_state_json too long"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			seedBlockTermTerminal(t, env.db, "term-command-metadata-validation")
			payload := map[string]any{
				"terminal_id": "term-command-metadata-validation",
				"line_num":    0,
				"command":     "true",
				tt.field:      tt.value,
			}
			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), tt.error)
		})
	}
}

func TestBlockTermPatchValidatesCompleteMetadataCombination(t *testing.T) {
	cases := []struct {
		name    string
		initial model.BlockTermBlock
		patch   map[string]any
		error   string
	}{
		{
			name: "note cannot retain renderer",
			initial: model.BlockTermBlock{
				Kind:     "note",
				Renderer: "code",
			},
			patch: map[string]any{
				"kind": "note",
			},
			error: "renderer is not valid for note blocks",
		},
		{
			name: "renderer kind requires renderer",
			initial: model.BlockTermBlock{
				Kind:     "renderer",
				Renderer: "code",
			},
			patch: map[string]any{
				"kind":     "renderer",
				"renderer": "",
			},
			error: "renderer kind requires a renderer",
		},
		{
			name: "command rejects unknown renderer",
			initial: model.BlockTermBlock{
				Kind: "command",
			},
			patch: map[string]any{
				"kind":     "command",
				"renderer": "legacy-unknown",
			},
			error: "is not available for command blocks",
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			seedBlockTermTerminal(t, env.db, "term-patch-combination")
			tt.initial.ID = "patch-combination"
			tt.initial.TerminalID = "term-patch-combination"
			tt.initial.LineNum = 0
			require.NoError(t, env.db.Create(&tt.initial).Error)

			response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/patch-combination", tt.patch)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), tt.error)
		})
	}
}

func TestBlockTermPatchKeepsKindImmutableAndPreservesNoteHistory(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-patch-kind-immutable")

	createdNote := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "patch-note-kind",
		"terminal_id": "term-patch-kind-immutable",
		"line_num":    0,
		"kind":        "note",
		"text":        "keep this note",
	})
	require.Equal(t, http.StatusCreated, createdNote.Code, createdNote.Body.String())

	// Legacy clients may send renderer even for non-renderer blocks. Clearing
	// it must not silently reinterpret a note as a command.
	clearRenderer := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/patch-note-kind", map[string]any{
		"renderer": "",
	})
	require.Equal(t, http.StatusOK, clearRenderer.Code, clearRenderer.Body.String())
	var body struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(clearRenderer.Body.Bytes(), &body))
	require.Equal(t, "note", body.Block.Kind)
	require.Empty(t, body.Block.Renderer)

	changedKind := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/patch-note-kind", map[string]any{
		"kind":    "command",
		"command": "echo should-not-change",
	})
	require.Equal(t, http.StatusBadRequest, changedKind.Code, changedKind.Body.String())
	require.Contains(t, changedKind.Body.String(), "kind cannot be changed")

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/patch-note-kind", nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	var historyCount int64
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Count(&historyCount).Error)
	require.EqualValues(t, 1, historyCount)
	var tombstone model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&tombstone, "id = ?", "patch-note-kind").Error)
	require.Empty(t, tombstone.Command)
	require.NotNil(t, tombstone.BlockDeletedAt)

	history := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?terminal_id=term-patch-kind-immutable", nil)
	require.Equal(t, http.StatusOK, history.Code, history.Body.String())
	var historyBody struct {
		History []model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(history.Body.Bytes(), &historyBody))
	require.Empty(t, historyBody.History)
}

func TestBlockTermCommandRendererSwitching(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-renderer-switch")
	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "renderer-switch",
		"terminal_id": "term-renderer-switch",
		"line_num":    0,
		"kind":        "command",
		"command":     "printf '# title\\n'",
		"status":      "success",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	for _, renderer := range []string{"markdown", "code", "csv", "image", "pdf", "media", "mustache"} {
		response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/renderer-switch", map[string]any{
			"renderer":   renderer,
			"state_json": `{"prompt:source":"pty"}`,
		})
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var body struct {
			Block model.BlockTermBlock `json:"block"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
		require.Equal(t, "command", body.Block.Kind)
		require.Equal(t, renderer, body.Block.Renderer)
		require.Equal(t, `{"prompt:source":"pty"}`, body.Block.StateJSON)
	}

	for _, renderer := range []string{"terminal", "none"} {
		response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/renderer-switch", map[string]any{
			"renderer":   renderer,
			"state_json": "",
		})
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var body struct {
			Block model.BlockTermBlock `json:"block"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
		require.Equal(t, "command", body.Block.Kind)
		require.Equal(t, renderer, body.Block.Renderer)
		require.Empty(t, body.Block.StateJSON)
	}
}

func TestBlockTermCommandRendererSwitchValidation(t *testing.T) {
	for _, tt := range []struct {
		name      string
		kind      string
		renderer  string
		stateJSON string
		error     string
	}{
		{
			name:      "unknown command renderer",
			kind:      "command",
			renderer:  "legacy-unknown",
			stateJSON: `{"prompt:source":"pty"}`,
			error:     "is not available for command blocks",
		},
		{
			name:      "command renderer cannot read a file",
			kind:      "command",
			renderer:  "markdown",
			stateJSON: `{"prompt:source":"file","prompt:file":"README.md"}`,
			error:     "prompt:source must be pty for command renderers",
		},
		{
			name:      "command renderer rejects a file without source",
			kind:      "command",
			renderer:  "markdown",
			stateJSON: `{"prompt:file":"README.md"}`,
			error:     "prompt:file is not valid for command renderers",
		},
		{
			name:      "terminal rejects stale state",
			kind:      "command",
			renderer:  "terminal",
			stateJSON: `{"prompt:source":"pty"}`,
			error:     "state_json must be empty",
		},
		{
			name:      "note rejects renderer",
			kind:      "note",
			renderer:  "markdown",
			stateJSON: `{"prompt:source":"pty"}`,
			error:     "renderer is not valid for note blocks",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			seedBlockTermTerminal(t, env.db, "term-renderer-switch-validation")
			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
				"terminal_id": "term-renderer-switch-validation",
				"line_num":    0,
				"kind":        tt.kind,
				"renderer":    tt.renderer,
				"state_json":  tt.stateJSON,
			})
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), tt.error)
		})
	}
}

func TestBlockTermLegacyRendererKeepsUnknownPluginCompatibility(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-legacy-renderer")
	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id": "term-legacy-renderer",
		"line_num":    0,
		"kind":        "renderer",
		"renderer":    "legacy.preview:v1",
		"state_json":  `{"prompt:source":"file","prompt:file":"README.md"}`,
	})
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
}

func TestBlockTermPatchRejectsCommandToNoteConversion(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-patch-command-kind")
	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "patch-command-kind",
		"terminal_id": "term-patch-command-kind",
		"line_num":    0,
		"command":     "echo durable",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	var historyCount int64
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "patch-command-kind").Count(&historyCount).Error)
	require.EqualValues(t, 1, historyCount)

	changedKind := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/patch-command-kind", map[string]any{
		"kind": "note",
		"text": "should-not-change",
	})
	require.Equal(t, http.StatusBadRequest, changedKind.Code, changedKind.Body.String())
	require.Contains(t, changedKind.Body.String(), "kind cannot be changed")
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "patch-command-kind").Count(&historyCount).Error)
	require.EqualValues(t, 1, historyCount)
}

func TestBlockTermPatchRejectsCommandRendererConversions(t *testing.T) {
	for _, tt := range []struct {
		name         string
		blockID      string
		lineNum      int
		create       map[string]any
		patch        map[string]any
		originalKind string
		originalRend string
	}{
		{
			name:    "command to renderer",
			blockID: "patch-command-renderer-kind",
			lineNum: 0,
			create: map[string]any{
				"command": "echo durable",
			},
			patch: map[string]any{
				"kind":     "renderer",
				"renderer": "code",
			},
			originalKind: "command",
		},
		{
			name:    "renderer to command",
			blockID: "patch-renderer-command-kind",
			lineNum: 1,
			create: map[string]any{
				"kind":     "renderer",
				"command":  "codeview README.md",
				"renderer": "code",
			},
			patch: map[string]any{
				"kind":     "command",
				"renderer": "",
			},
			originalKind: "renderer",
			originalRend: "code",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			seedBlockTermTerminal(t, env.db, "term-patch-command-renderer-kind")
			create := map[string]any{
				"id":          tt.blockID,
				"terminal_id": "term-patch-command-renderer-kind",
				"line_num":    tt.lineNum,
			}
			for key, value := range tt.create {
				create[key] = value
			}

			created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", create)
			require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

			changedKind := doBlockTermJSON(
				t,
				env.router,
				http.MethodPatch,
				"/api/blockterm/blocks/"+tt.blockID,
				tt.patch,
			)
			require.Equal(t, http.StatusBadRequest, changedKind.Code, changedKind.Body.String())
			require.Contains(t, changedKind.Body.String(), "kind cannot be changed")

			var block model.BlockTermBlock
			require.NoError(t, env.db.First(&block, "id = ?", tt.blockID).Error)
			require.Equal(t, tt.originalKind, block.Kind)
			require.Equal(t, tt.originalRend, block.Renderer)

			var historyCount int64
			require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", tt.blockID).Count(&historyCount).Error)
			require.EqualValues(t, 1, historyCount)
		})
	}
}
