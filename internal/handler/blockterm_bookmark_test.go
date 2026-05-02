package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestBlockTermBookmarkCRUD(t *testing.T) {
	env := setupBlockTermHandler(t)

	type foreignKeyRow struct {
		ID int `gorm:"column:id"`
	}
	var foreignKeys []foreignKeyRow
	require.NoError(t, env.db.Raw("PRAGMA foreign_key_list(blockterm_bookmarks)").Scan(&foreignKeys).Error)
	require.Empty(t, foreignKeys)

	create := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/bookmarks", map[string]any{
		"title":       "List files",
		"description": "Show hidden entries",
		"command":     "  ls -la  ",
	})
	require.Equal(t, http.StatusCreated, create.Code, create.Body.String())
	var created struct {
		Bookmark model.BlockTermBookmark `json:"bookmark"`
	}
	require.NoError(t, json.Unmarshal(create.Body.Bytes(), &created))
	require.NotEmpty(t, created.Bookmark.ID)
	require.Equal(t, "List files", created.Bookmark.Title)
	require.Equal(t, "Show hidden entries", created.Bookmark.Description)
	require.Equal(t, "  ls -la  ", created.Bookmark.Command)
	require.NotZero(t, created.Bookmark.CreatedAt)
	require.Equal(t, created.Bookmark.CreatedAt, created.Bookmark.UpdatedAt)

	patch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/bookmarks/"+created.Bookmark.ID, map[string]any{
		"title":       "List directory",
		"description": "",
		"command":     "find . -maxdepth 1",
	})
	require.Equal(t, http.StatusOK, patch.Code, patch.Body.String())
	var patched struct {
		Bookmark model.BlockTermBookmark `json:"bookmark"`
	}
	require.NoError(t, json.Unmarshal(patch.Body.Bytes(), &patched))
	require.Equal(t, created.Bookmark.ID, patched.Bookmark.ID)
	require.Equal(t, "List directory", patched.Bookmark.Title)
	require.Empty(t, patched.Bookmark.Description)
	require.Equal(t, "find . -maxdepth 1", patched.Bookmark.Command)
	require.Equal(t, created.Bookmark.CreatedAt, patched.Bookmark.CreatedAt)
	require.Greater(t, patched.Bookmark.UpdatedAt, created.Bookmark.UpdatedAt)

	list := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/bookmarks", nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var listed struct {
		Bookmarks []model.BlockTermBookmark `json:"bookmarks"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &listed))
	require.Equal(t, []model.BlockTermBookmark{patched.Bookmark}, listed.Bookmarks)

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/bookmarks/"+created.Bookmark.ID, nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	require.JSONEq(t, `{"ok":true}`, deleted.Body.String())

	missingPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/bookmarks/missing", map[string]any{
		"title": "missing",
	})
	require.Equal(t, http.StatusNotFound, missingPatch.Code, missingPatch.Body.String())
	missingDelete := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/bookmarks/missing", nil)
	require.Equal(t, http.StatusNotFound, missingDelete.Code, missingDelete.Body.String())
}

func TestBlockTermBookmarkSearchEscapesWildcardsAndSorts(t *testing.T) {
	env := setupBlockTermHandler(t)
	bookmarks := []model.BlockTermBookmark{
		{ID: "percent", Title: "percent % title", Command: "echo percent", CreatedAt: 1, UpdatedAt: 30},
		{ID: "underscore", Description: "under_score", Command: "echo underscore", CreatedAt: 2, UpdatedAt: 40},
		{ID: "backslash", Command: `printf '\\path'`, CreatedAt: 3, UpdatedAt: 20},
		{ID: "alpha", Title: "Alpha title", Command: "echo alpha", CreatedAt: 4, UpdatedAt: 50},
	}
	require.NoError(t, env.db.Create(&bookmarks).Error)

	tests := []struct {
		query string
		want  string
	}{
		{query: "%", want: "percent"},
		{query: "_", want: "underscore"},
		{query: `\`, want: "backslash"},
		{query: "Alpha", want: "alpha"},
	}
	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodGet,
				"/api/blockterm/bookmarks?q="+url.QueryEscape(tt.query), nil)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var body struct {
				Bookmarks []model.BlockTermBookmark `json:"bookmarks"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Len(t, body.Bookmarks, 1)
			require.Equal(t, tt.want, body.Bookmarks[0].ID)
		})
	}

	all := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/bookmarks", nil)
	require.Equal(t, http.StatusOK, all.Code, all.Body.String())
	var body struct {
		Bookmarks []model.BlockTermBookmark `json:"bookmarks"`
	}
	require.NoError(t, json.Unmarshal(all.Body.Bytes(), &body))
	require.Equal(t, []string{"alpha", "underscore", "percent", "backslash"}, blockTermBookmarkIDs(body.Bookmarks))
}

func TestBlockTermBookmarkListBounds(t *testing.T) {
	env := setupBlockTermHandler(t)
	bookmarks := make([]model.BlockTermBookmark, 0, blockTermBookmarkMaxLimit+5)
	for index := 0; index < blockTermBookmarkMaxLimit+5; index++ {
		bookmarks = append(bookmarks, model.BlockTermBookmark{
			ID:        "bookmark-" + strconv.Itoa(index),
			Command:   "echo bounded",
			CreatedAt: int64(index + 1),
			UpdatedAt: int64(index + 1),
		})
	}
	require.NoError(t, env.db.CreateInBatches(&bookmarks, 50).Error)

	defaultResponse := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/bookmarks", nil)
	require.Equal(t, http.StatusOK, defaultResponse.Code, defaultResponse.Body.String())
	var defaultBody struct {
		Bookmarks []model.BlockTermBookmark `json:"bookmarks"`
	}
	require.NoError(t, json.Unmarshal(defaultResponse.Body.Bytes(), &defaultBody))
	require.Len(t, defaultBody.Bookmarks, blockTermBookmarkDefaultLimit)

	maximumResponse := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/bookmarks?limit=999", nil)
	require.Equal(t, http.StatusOK, maximumResponse.Code, maximumResponse.Body.String())
	var maximumBody struct {
		Bookmarks []model.BlockTermBookmark `json:"bookmarks"`
	}
	require.NoError(t, json.Unmarshal(maximumResponse.Body.Bytes(), &maximumBody))
	require.Len(t, maximumBody.Bookmarks, blockTermBookmarkMaxLimit)

	for _, path := range []string{
		"/api/blockterm/bookmarks?limit=0",
		"/api/blockterm/bookmarks?limit=invalid",
		"/api/blockterm/bookmarks?q=" + strings.Repeat("x", blockTermBookmarkMaxQueryLen+1),
	} {
		response := doBlockTermJSON(t, env.router, http.MethodGet, path, nil)
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	}
}

func TestBlockTermBookmarkValidationAndBodyLimit(t *testing.T) {
	env := setupBlockTermHandler(t)

	valid := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/bookmarks", map[string]any{
		"title":       strings.Repeat("t", blockTermBookmarkMaxTitleLen),
		"description": strings.Repeat("d", blockTermBookmarkMaxDescriptionLen),
		"command":     strings.Repeat("c", blockTermBookmarkMaxCommandLen),
	})
	require.Equal(t, http.StatusCreated, valid.Code, valid.Body.String())

	tests := []struct {
		name    string
		payload map[string]any
		error   string
	}{
		{name: "missing command", payload: map[string]any{}, error: "command is required"},
		{name: "blank command", payload: map[string]any{"command": " \t\n"}, error: "command is required"},
		{name: "long title", payload: map[string]any{"title": strings.Repeat("t", blockTermBookmarkMaxTitleLen+1), "command": "true"}, error: "title is too long"},
		{name: "long description", payload: map[string]any{"description": strings.Repeat("d", blockTermBookmarkMaxDescriptionLen+1), "command": "true"}, error: "description is too long"},
		{name: "long command", payload: map[string]any{"command": strings.Repeat("c", blockTermBookmarkMaxCommandLen+1)}, error: "command is too long"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/bookmarks", tt.payload)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), tt.error)
		})
	}

	var validBody struct {
		Bookmark model.BlockTermBookmark `json:"bookmark"`
	}
	require.NoError(t, json.Unmarshal(valid.Body.Bytes(), &validBody))
	patchCases := []struct {
		payload map[string]any
		error   string
	}{
		{payload: map[string]any{}, error: "at least one field is required"},
		{payload: map[string]any{"command": "  "}, error: "command is required"},
		{payload: map[string]any{"title": strings.Repeat("t", blockTermBookmarkMaxTitleLen+1)}, error: "title is too long"},
		{payload: map[string]any{"description": strings.Repeat("d", blockTermBookmarkMaxDescriptionLen+1)}, error: "description is too long"},
		{payload: map[string]any{"command": strings.Repeat("c", blockTermBookmarkMaxCommandLen+1)}, error: "command is too long"},
	}
	for _, tt := range patchCases {
		response := doBlockTermJSON(t, env.router, http.MethodPatch,
			"/api/blockterm/bookmarks/"+validBody.Bookmark.ID, tt.payload)
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), tt.error)
	}

	invalidJSON := httptest.NewRequest(http.MethodPost, "/api/blockterm/bookmarks", strings.NewReader(`{"command":`))
	invalidJSON.Header.Set("Content-Type", "application/json")
	invalidResponse := httptest.NewRecorder()
	env.router.ServeHTTP(invalidResponse, invalidJSON)
	require.Equal(t, http.StatusBadRequest, invalidResponse.Code, invalidResponse.Body.String())

	oversizedJSON := `{"command":"` + strings.Repeat("x", blockTermBookmarkMaxBodyBytes) + `"}`
	oversizedRequest := httptest.NewRequest(http.MethodPost, "/api/blockterm/bookmarks", strings.NewReader(oversizedJSON))
	oversizedRequest.Header.Set("Content-Type", "application/json")
	oversizedResponse := httptest.NewRecorder()
	env.router.ServeHTTP(oversizedResponse, oversizedRequest)
	require.Equal(t, http.StatusRequestEntityTooLarge, oversizedResponse.Code, oversizedResponse.Body.String())
}

func blockTermBookmarkIDs(bookmarks []model.BlockTermBookmark) []string {
	ids := make([]string, 0, len(bookmarks))
	for _, bookmark := range bookmarks {
		ids = append(ids, bookmark.ID)
	}
	return ids
}
