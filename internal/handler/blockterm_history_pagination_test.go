package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

type blockTermHistoryPageResponse struct {
	History    []model.BlockTermCommandHistory `json:"history"`
	Offset     int                             `json:"offset"`
	Limit      int                             `json:"limit"`
	HasMore    bool                            `json:"has_more"`
	NextOffset int                             `json:"next_offset"`
}

func TestBlockTermHistoryOffsetPagination(t *testing.T) {
	env := setupBlockTermHandler(t)
	require.NoError(t, env.db.Create([]model.BlockTermCommandHistory{
		{ID: "history-a", TerminalID: "term-a", Command: "echo a", CreatedAt: 1},
		{ID: "history-b", TerminalID: "term-a", Command: "echo b", CreatedAt: 2},
		{ID: "history-c", TerminalID: "term-a", Command: "echo c", CreatedAt: 3},
		{ID: "history-d", TerminalID: "term-b", Command: "echo d", CreatedAt: 4},
		{ID: "history-e", TerminalID: "term-b", Command: "echo e", CreatedAt: 5},
	}).Error)

	for _, tt := range []struct {
		name       string
		path       string
		wantIDs    []string
		wantOffset int
		wantLimit  int
		wantMore   bool
		wantNext   int
	}{
		{
			name:       "first page",
			path:       "/api/blockterm/history?limit=2",
			wantIDs:    []string{"history-e", "history-d"},
			wantOffset: 0,
			wantLimit:  2,
			wantMore:   true,
			wantNext:   2,
		},
		{
			name:       "middle page",
			path:       "/api/blockterm/history?limit=2&offset=2",
			wantIDs:    []string{"history-c", "history-b"},
			wantOffset: 2,
			wantLimit:  2,
			wantMore:   true,
			wantNext:   4,
		},
		{
			name:       "last page",
			path:       "/api/blockterm/history?limit=2&offset=4",
			wantIDs:    []string{"history-a"},
			wantOffset: 4,
			wantLimit:  2,
			wantMore:   false,
			wantNext:   5,
		},
		{
			name:       "filtered page",
			path:       "/api/blockterm/history?terminal_id=term-a&q=echo&limit=1&offset=1",
			wantIDs:    []string{"history-b"},
			wantOffset: 1,
			wantLimit:  1,
			wantMore:   true,
			wantNext:   2,
		},
		{
			name:       "past end",
			path:       "/api/blockterm/history?limit=2&offset=99",
			wantIDs:    []string{},
			wantOffset: 99,
			wantLimit:  2,
			wantMore:   false,
			wantNext:   99,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodGet, tt.path, nil)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())

			var body blockTermHistoryPageResponse
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			ids := make([]string, 0, len(body.History))
			for _, item := range body.History {
				ids = append(ids, item.ID)
			}
			require.Equal(t, tt.wantIDs, ids)
			require.Equal(t, tt.wantOffset, body.Offset)
			require.Equal(t, tt.wantLimit, body.Limit)
			require.Equal(t, tt.wantMore, body.HasMore)
			require.Equal(t, tt.wantNext, body.NextOffset)
		})
	}
}

func TestBlockTermHistoryOffsetValidation(t *testing.T) {
	env := setupBlockTermHandler(t)
	for _, path := range []string{
		"/api/blockterm/history?offset=-1",
		"/api/blockterm/history?offset=invalid",
	} {
		response := doBlockTermJSON(t, env.router, http.MethodGet, path, nil)
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), "offset must be a non-negative integer")
	}
}
