package handler

import (
	"net/http"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestBlockTermRawOutputFallsBackToLegacyOutput(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-raw-fallback")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:           "block-raw-fallback",
		TerminalID:   "term-raw-fallback",
		LineNum:      0,
		Output:       []byte{0x1b, '[', '2', 'J', 0x00, 0xff},
		OutputCursor: blockTermInt64(6),
	}).Error)

	response := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-raw-fallback/raw-output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, []byte{0x1b, '[', '2', 'J', 0x00, 0xff}, response.Body.Bytes())
	require.Empty(t, response.Header().Get(blockTermOutputStartHeader))
	require.Empty(t, response.Header().Get(blockTermOutputEndHeader))
	require.Empty(t, response.Header().Get(blockTermOutputCursorHeader))
}

func TestBlockTermRawOutputReadsFromTerminalCursor(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-raw-cursor")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "block-raw-cursor", TerminalID: "term-raw-cursor", LineNum: 0,
	}).Error)
	require.NoError(t, env.db.Create([]model.BlockTermOutputSegment{
		{
			ID: "segment-raw-cursor-1", TerminalID: "term-raw-cursor", BlockID: "block-raw-cursor",
			StartCursor: 10, EndCursor: 14, Data: []byte("abcd"), CreatedAt: 1,
		},
		{
			ID: "segment-raw-cursor-2", TerminalID: "term-raw-cursor", BlockID: "block-raw-cursor",
			StartCursor: 18, EndCursor: 22, Data: []byte("efgh"), CreatedAt: 2,
		},
		{
			// Same block ID is not sufficient to authorize a raw segment read.
			ID: "segment-raw-cursor-foreign", TerminalID: "term-raw-foreign", BlockID: "block-raw-cursor",
			StartCursor: 10, EndCursor: 17, Data: []byte("secret!!"), CreatedAt: 3,
		},
	}).Error)

	tests := []struct {
		name        string
		query       string
		body        string
		startCursor string
		endCursor   string
	}{
		{name: "full retained tail", body: "abcdefgh", startCursor: "10", endCursor: "22"},
		{name: "old cursor", query: "?cursor=3", body: "abcdefgh", startCursor: "10", endCursor: "22"},
		{name: "cursor in segment", query: "?cursor=12", body: "cdefgh", startCursor: "12", endCursor: "22"},
		{name: "cursor in managed osc gap", query: "?cursor=16", body: "efgh", startCursor: "18", endCursor: "22"},
		{name: "cursor at retained end", query: "?cursor=22", body: "", startCursor: "22", endCursor: "22"},
		{name: "new cursor", query: "?cursor=30", body: "", startCursor: "22", endCursor: "22"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := doBlockTermOutputRequest(
				env.router,
				http.MethodGet,
				"/api/blockterm/blocks/block-raw-cursor/raw-output"+test.query,
				nil,
				nil,
			)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.Equal(t, test.body, response.Body.String())
			require.Equal(t, test.startCursor, response.Header().Get(blockTermOutputStartHeader))
			require.Equal(t, test.endCursor, response.Header().Get(blockTermOutputEndHeader))
			require.Equal(t, test.endCursor, response.Header().Get(blockTermOutputCursorHeader))
			require.Equal(t, strconv.Itoa(len(test.body)), response.Header().Get("Content-Length"))
			require.Equal(t, len(test.body), response.Body.Len())
		})
	}
}

func TestBlockTermRawOutputRejectsInvalidCursor(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-raw-invalid-cursor")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "block-raw-invalid-cursor", TerminalID: "term-raw-invalid-cursor", LineNum: 0,
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermOutputSegment{
		ID: "segment-raw-invalid-cursor", TerminalID: "term-raw-invalid-cursor", BlockID: "block-raw-invalid-cursor",
		StartCursor: 1, EndCursor: 2, Data: []byte("x"), CreatedAt: 1,
	}).Error)

	for _, query := range []string{"?cursor=", "?cursor=-1", "?cursor=abc", "?cursor=18446744073709551616"} {
		response := doBlockTermOutputRequest(
			env.router,
			http.MethodGet,
			"/api/blockterm/blocks/block-raw-invalid-cursor/raw-output"+query,
			nil,
			nil,
		)
		require.Equal(t, http.StatusBadRequest, response.Code, query+": "+response.Body.String())
	}
}

func TestBlockTermCreateAndPatchTrimExistingRawOutputSegments(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-raw-retention")
	require.NoError(t, env.db.Create([]model.BlockTermOutputSegment{
		{
			ID: "segment-before-block", TerminalID: "term-raw-retention", BlockID: "block-raw-retention",
			StartCursor: 10, EndCursor: 16, Data: []byte("abcdef"), CreatedAt: 1,
		},
		{
			// A segment with the same block ID from another terminal must remain
			// isolated from creation, trimming, and raw-output reads.
			ID: "segment-before-block-foreign", TerminalID: "term-raw-foreign", BlockID: "block-raw-retention",
			StartCursor: 10, EndCursor: 17, Data: []byte("secret!"), CreatedAt: 1,
		},
	}).Error)

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":                "block-raw-retention",
		"terminal_id":       "term-raw-retention",
		"line_num":          0,
		"command":           "printf abcdef",
		"term_max_pty_size": 4,
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	var segment model.BlockTermOutputSegment
	require.NoError(t, env.db.First(&segment, "id = ?", "segment-before-block").Error)
	require.Equal(t, "term-raw-retention", segment.TerminalID)
	require.Equal(t, uint64(12), segment.StartCursor)
	require.Equal(t, []byte("cdef"), segment.Data)
	var foreign model.BlockTermOutputSegment
	require.NoError(t, env.db.First(&foreign, "id = ?", "segment-before-block-foreign").Error)
	require.Equal(t, "term-raw-foreign", foreign.TerminalID)
	require.Equal(t, uint64(10), foreign.StartCursor)
	require.Equal(t, []byte("secret!"), foreign.Data)

	patched := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/block-raw-retention", map[string]any{
		"term_max_pty_size": 2,
	})
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())
	require.NoError(t, env.db.First(&segment, "id = ?", "segment-before-block").Error)
	require.Equal(t, uint64(14), segment.StartCursor)
	require.Equal(t, []byte("ef"), segment.Data)
	require.NoError(t, env.db.First(&foreign, "id = ?", "segment-before-block-foreign").Error)
	require.Equal(t, uint64(10), foreign.StartCursor)
	require.Equal(t, []byte("secret!"), foreign.Data)

	retained := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-raw-retention/raw-output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, retained.Code, retained.Body.String())
	require.Equal(t, []byte("ef"), retained.Body.Bytes())
	require.Equal(t, "14", retained.Header().Get(blockTermOutputStartHeader))
	require.Equal(t, "16", retained.Header().Get(blockTermOutputEndHeader))
	require.Equal(t, "16", retained.Header().Get(blockTermOutputCursorHeader))
}

func TestBlockTermPatchMovesRawOutputSegmentsToNewTerminal(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-raw-source")
	seedBlockTermTerminal(t, env.db, "term-raw-target")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID: "block-raw-move", TerminalID: "term-raw-source", LineNum: 0,
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermOutputSegment{
		ID: "segment-raw-move", TerminalID: "term-raw-source", BlockID: "block-raw-move",
		StartCursor: 10, EndCursor: 13, Data: []byte("raw"), CreatedAt: 1,
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermOutputSegment{
		ID: "segment-raw-move-foreign", TerminalID: "term-raw-foreign", BlockID: "block-raw-move",
		StartCursor: 10, EndCursor: 17, Data: []byte("secret!!"), CreatedAt: 1,
	}).Error)

	response := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/block-raw-move", map[string]any{
		"terminal_id": "term-raw-target",
		"line_num":    1,
	})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	var segment model.BlockTermOutputSegment
	require.NoError(t, env.db.First(&segment, "id = ?", "segment-raw-move").Error)
	require.Equal(t, "term-raw-target", segment.TerminalID)
	var foreign model.BlockTermOutputSegment
	require.NoError(t, env.db.First(&foreign, "id = ?", "segment-raw-move-foreign").Error)
	require.Equal(t, "term-raw-foreign", foreign.TerminalID)
	require.Equal(t, []byte("secret!!"), foreign.Data)

	raw := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-raw-move/raw-output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, raw.Code, raw.Body.String())
	require.Equal(t, []byte("raw"), raw.Body.Bytes())
}
