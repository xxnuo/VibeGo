package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

type blockTermTestEnv struct {
	db      *gorm.DB
	manager *terminal.Manager
	router  *gin.Engine
}

type gatedRequestBody struct {
	data    []byte
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newGatedRequestBody(data string) *gatedRequestBody {
	return &gatedRequestBody{
		data:    []byte(data),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (r *gatedRequestBody) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	<-r.release
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	if len(r.data) == 0 {
		return n, io.EOF
	}
	return n, nil
}

type gatedResponseWriter struct {
	header  http.Header
	status  int
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newGatedResponseWriter() *gatedResponseWriter {
	return &gatedResponseWriter{
		header:  make(http.Header),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (w *gatedResponseWriter) Header() http.Header { return w.header }

func (w *gatedResponseWriter) WriteHeader(statusCode int) { w.status = statusCode }

func (w *gatedResponseWriter) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.release
	return len(data), nil
}

func setupBlockTermHandler(t *testing.T) blockTermTestEnv {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	require.NoError(t, db.AutoMigrate(
		&model.TerminalSession{},
		&model.TerminalHistory{},
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
		&model.BlockTermBookmark{},
		&model.BlockTermOutputSegment{},
	))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	manager := terminal.NewManager(db, &terminal.ManagerConfig{Shell: "/bin/sh"})
	NewBlockTermHandler(manager).Register(router.Group("/api"))
	return blockTermTestEnv{db: db, manager: manager, router: router}
}

func seedBlockTermTerminal(t *testing.T, db *gorm.DB, id string) {
	t.Helper()
	require.NoError(t, db.Create(&model.TerminalSession{
		ID:     id,
		Name:   "test terminal",
		Status: model.StatusClosed,
	}).Error)
}

func doBlockTermJSON(t *testing.T, router http.Handler, method, path string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(payload)
		require.NoError(t, err)
		body = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(method, path, body)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func doBlockTermOutputRequest(
	router http.Handler,
	method string,
	path string,
	body []byte,
	cursor *string,
) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if cursor != nil {
		req.Header.Set(blockTermOutputCursorHeader, *cursor)
	}
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

type blockTermRendererStateValidationCase struct {
	name         string
	renderer     *string
	stateJSON    *string
	wantStatus   int
	wantError    string
	wantRenderer string
	wantState    string
}

func blockTermString(value string) *string {
	return &value
}

func blockTermInt64(value int64) *int64 {
	return &value
}

func blockTermRendererStateValidationCases() []blockTermRendererStateValidationCase {
	maxRenderer := "a" + strings.Repeat("b", blockTermMaxRendererLen-1)
	maxState := `{"value":"` + strings.Repeat("a", blockTermMaxStateJSONLen-len(`{"value":""}`)) + `"}`
	overlongState := `{"value":"` + strings.Repeat("a", blockTermMaxStateJSONLen) + `"}`

	return []blockTermRendererStateValidationCase{
		{
			name:         "empty values",
			renderer:     blockTermString(""),
			stateJSON:    blockTermString(""),
			wantStatus:   http.StatusOK,
			wantRenderer: "",
			wantState:    "",
		},
		{
			name:         "valid renderer and object state",
			renderer:     blockTermString("markdown.preview:v1-test"),
			stateJSON:    blockTermString(`{"prompt:source":"file","prompt:file":"README.md"}`),
			wantStatus:   http.StatusOK,
			wantRenderer: "markdown.preview:v1-test",
			wantState:    `{"prompt:source":"file","prompt:file":"README.md"}`,
		},
		{
			name:         "maximum lengths",
			renderer:     &maxRenderer,
			stateJSON:    &maxState,
			wantStatus:   http.StatusOK,
			wantRenderer: maxRenderer,
			wantState:    maxState,
		},
		{
			name:       "invalid renderer name",
			renderer:   blockTermString("1markdown"),
			wantStatus: http.StatusBadRequest,
			wantError:  "invalid renderer format",
		},
		{
			name:       "renderer too long",
			renderer:   blockTermString(strings.Repeat("a", blockTermMaxRendererLen+1)),
			wantStatus: http.StatusBadRequest,
			wantError:  "renderer name too long",
		},
		{
			name:       "invalid state JSON",
			stateJSON:  blockTermString(`{"value":`),
			wantStatus: http.StatusBadRequest,
			wantError:  "state_json must be a valid JSON object",
		},
		{
			name:       "null state",
			stateJSON:  blockTermString("null"),
			wantStatus: http.StatusBadRequest,
			wantError:  "state_json must be a valid JSON object",
		},
		{
			name:       "array state",
			stateJSON:  blockTermString(`[]`),
			wantStatus: http.StatusBadRequest,
			wantError:  "state_json must be a valid JSON object",
		},
		{
			name:       "scalar state",
			stateJSON:  blockTermString(`"markdown"`),
			wantStatus: http.StatusBadRequest,
			wantError:  "state_json must be a valid JSON object",
		},
		{
			name:       "state too long",
			stateJSON:  &overlongState,
			wantStatus: http.StatusBadRequest,
			wantError:  "state_json too long",
		},
	}
}

func TestBlockTermHandlerCRUD(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-1")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-1").Updates(map[string]any{
		"workspace_session_id": "workspace-1",
		"group_id":             "group-1",
		"user_id":              "user-1",
		"runtime_type":         "local",
	}).Error)

	output := base64.StdEncoding.EncodeToString([]byte("hello\r\n"))
	create := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id": "term-1",
		"line_num":    2,
		"command":     "printf hello",
		"cwd":         "/tmp",
		"output":      output,
		"status":      "done",
		"mode":        "text",
	})
	require.Equal(t, http.StatusCreated, create.Code)
	var createBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(create.Body.Bytes(), &createBody))
	require.NotEmpty(t, createBody.Block.ID)
	require.Equal(t, "term-1", createBody.Block.TerminalID)
	require.Equal(t, []byte("hello\r\n"), createBody.Block.Output)
	blockID := createBody.Block.ID

	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, "term-1", history.TerminalID)
	require.Equal(t, "workspace-1", history.WorkspaceSessionID)
	require.Equal(t, "group-1", history.GroupID)
	require.Equal(t, "user-1", history.UserID)
	require.Equal(t, "local", history.RuntimeType)
	require.Equal(t, 2, history.LineNum)
	require.Equal(t, "printf hello", history.Command)
	require.Equal(t, "/tmp", history.Cwd)
	require.Equal(t, createBody.Block.CreatedAt, history.CreatedAt)

	list := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks?terminal_id=term-1", nil)
	require.Equal(t, http.StatusOK, list.Code)
	var listBody struct {
		Blocks          []model.BlockTermBlock `json:"blocks"`
		DeletedBlockIDs []string               `json:"deleted_block_ids"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &listBody))
	require.Len(t, listBody.Blocks, 1)
	require.Equal(t, 2, listBody.Blocks[0].LineNum)

	patch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, map[string]any{
		"command":   "printf changed",
		"cwd":       "/changed",
		"status":    "done",
		"collapsed": true,
		"exit_code": 0,
	})
	require.Equal(t, http.StatusOK, patch.Code)
	var patchBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(patch.Body.Bytes(), &patchBody))
	require.Equal(t, "done", patchBody.Block.Status)
	require.True(t, patchBody.Block.Collapsed)
	require.NotNil(t, patchBody.Block.ExitCode)
	require.Equal(t, 0, *patchBody.Block.ExitCode)
	require.NoError(t, env.db.First(&history, "id = ?", blockID).Error)
	require.Equal(t, "printf hello", history.Command)
	require.Equal(t, "/tmp", history.Cwd)

	clear := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, map[string]any{
		"exit_code": nil,
	})
	require.Equal(t, http.StatusOK, clear.Code)
	require.NoError(t, json.Unmarshal(clear.Body.Bytes(), &patchBody))
	require.Nil(t, patchBody.Block.ExitCode)

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+blockID, nil)
	require.Equal(t, http.StatusOK, deleted.Code)
	require.NoError(t, env.db.First(&history, "id = ?", blockID).Error)
	require.NotNil(t, history.BlockDeletedAt)
	listAfterDelete := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks?terminal_id=term-1", nil)
	require.Equal(t, http.StatusOK, listAfterDelete.Code, listAfterDelete.Body.String())
	require.NoError(t, json.Unmarshal(listAfterDelete.Body.Bytes(), &listBody))
	require.Empty(t, listBody.Blocks)
	require.Equal(t, []string{blockID}, listBody.DeletedBlockIDs)
	reused := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          blockID,
		"terminal_id": "term-1",
		"line_num":    3,
		"command":     "printf reused",
	})
	require.Equal(t, http.StatusConflict, reused.Code, reused.Body.String())
	var reusedCount int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Count(&reusedCount).Error)
	require.Zero(t, reusedCount)
	missing := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+blockID, nil)
	require.Equal(t, http.StatusNotFound, missing.Code)
}

func TestBlockTermDeleteCreatesHiddenTombstoneForLineAIBlock(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-line-ai-delete")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "line-ai-delete",
		TerminalID: "term-line-ai-delete",
		LineNum:    0,
		Kind:       "renderer",
		Command:    "/chat explain",
		Status:     "success",
		Renderer:   "openai",
		Archived:   true,
		StateJSON:  `{"prompt:source":"model","model":"test-model","source_block_id":"source-block"}`,
	}).Error)

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/line-ai-delete", nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	var tombstone model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&tombstone, "id = ?", "line-ai-delete").Error)
	require.Empty(t, tombstone.Command)
	require.Empty(t, tombstone.Cwd)
	require.NotNil(t, tombstone.BlockDeletedAt)

	history := doBlockTermJSON(
		t,
		env.router,
		http.MethodGet,
		"/api/blockterm/history?terminal_id=term-line-ai-delete",
		nil,
	)
	require.Equal(t, http.StatusOK, history.Code, history.Body.String())
	var historyBody struct {
		History []model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(history.Body.Bytes(), &historyBody))
	require.Empty(t, historyBody.History)

	recreated := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "line-ai-delete",
		"terminal_id": "term-line-ai-delete",
		"line_num":    1,
		"kind":        "note",
		"text":        "replayed",
	})
	require.Equal(t, http.StatusConflict, recreated.Code, recreated.Body.String())
}

func TestBlockTermDeleteNonHistoryBlockPreservesExistingCommandHistory(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-history-id-reuse")
	require.NoError(t, env.db.Create(&model.BlockTermCommandHistory{
		ID:         "reused-history-id",
		TerminalID: "old-terminal",
		LineNum:    3,
		Command:    "echo retained",
		Cwd:        "/old/cwd",
		CreatedAt:  10,
	}).Error)

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "reused-history-id",
		"terminal_id": "term-history-id-reuse",
		"line_num":    0,
		"kind":        "note",
		"text":        "temporary note",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/reused-history-id", nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", "reused-history-id").Error)
	require.Equal(t, "old-terminal", history.TerminalID)
	require.Equal(t, "echo retained", history.Command)
	require.Equal(t, "/old/cwd", history.Cwd)
	require.NotNil(t, history.BlockDeletedAt)
}

func TestBlockTermCreateRejectsTombstonedIDForNonHistoryKind(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-1")
	blockID := "tombstoned-block"

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          blockID,
		"terminal_id": "term-1",
		"line_num":    0,
		"command":     "printf old",
		"status":      "success",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+blockID, nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

	recreated := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          blockID,
		"terminal_id": "term-1",
		"line_num":    1,
		"kind":        "note",
		"text":        "replayed note",
	})
	require.Equal(t, http.StatusConflict, recreated.Code, recreated.Body.String())

	var blockCount int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Count(&blockCount).Error)
	require.Zero(t, blockCount)
	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", blockID).Error)
	require.NotNil(t, history.BlockDeletedAt)
}

func TestBlockTermCreateRejectsMovedTombstonedIDForNote(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-tombstone-source")
	seedBlockTermTerminal(t, env.db, "term-tombstone-target")
	blockID := "moved-tombstoned-block"

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          blockID,
		"terminal_id": "term-tombstone-source",
		"line_num":    0,
		"command":     "printf old",
		"status":      "success",
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	moved := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/"+blockID, map[string]any{
		"terminal_id": "term-tombstone-target",
		"line_num":    1,
	})
	require.Equal(t, http.StatusOK, moved.Code, moved.Body.String())
	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/"+blockID, nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

	// Notes do not create a command-history row, so the tombstone check must
	// reserve the stable ID globally rather than relying on an INSERT conflict.
	recreated := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          blockID,
		"terminal_id": "term-tombstone-target",
		"line_num":    2,
		"kind":        "note",
		"text":        "replayed note",
	})
	require.Equal(t, http.StatusConflict, recreated.Code, recreated.Body.String())
}

func TestBlockTermHandlerValidationAndConflict(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-1")

	missingTerminal := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks", nil)
	require.Equal(t, http.StatusBadRequest, missingTerminal.Code)
	unknownTerminal := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks?terminal_id=missing", nil)
	require.Equal(t, http.StatusNotFound, unknownTerminal.Code)
	badLine := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id": "term-1",
		"line_num":    -1,
	})
	require.Equal(t, http.StatusBadRequest, badLine.Code)

	first := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id": "term-1",
		"line_num":    0,
	})
	require.Equal(t, http.StatusCreated, first.Code)
	duplicate := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"terminal_id": "term-1",
		"line_num":    0,
	})
	require.Equal(t, http.StatusConflict, duplicate.Code)

	badPatch := doBlockTermJSON(t, env.router, http.MethodPatch, "/api/blockterm/blocks/not-found", map[string]any{
		"line_num": 1,
	})
	require.Equal(t, http.StatusNotFound, badPatch.Code)
}

func TestBlockTermCreateRendererStateValidation(t *testing.T) {
	for _, tt := range blockTermRendererStateValidationCases() {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			terminalID := "missing-terminal"
			if tt.wantStatus == http.StatusOK {
				terminalID = "term-renderer-create"
				seedBlockTermTerminal(t, env.db, terminalID)
			}
			payload := map[string]any{
				"terminal_id": terminalID,
				"line_num":    0,
			}
			if tt.renderer != nil {
				payload["renderer"] = *tt.renderer
			}
			if tt.stateJSON != nil {
				payload["state_json"] = *tt.stateJSON
			}

			response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
			wantStatus := tt.wantStatus
			if wantStatus == http.StatusOK {
				wantStatus = http.StatusCreated
			}
			require.Equal(t, wantStatus, response.Code, response.Body.String())
			if tt.wantError != "" {
				require.Contains(t, response.Body.String(), tt.wantError)
				return
			}

			var body struct {
				Block model.BlockTermBlock `json:"block"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, tt.wantRenderer, body.Block.Renderer)
			require.Equal(t, tt.wantState, body.Block.StateJSON)
		})
	}
}

func TestBlockTermPatchRendererStateValidation(t *testing.T) {
	for _, tt := range blockTermRendererStateValidationCases() {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			blockID := "missing-block"
			if tt.wantStatus == http.StatusOK {
				seedBlockTermTerminal(t, env.db, "term-renderer-patch")
				blockID = "block-renderer-patch"
				kind := blockTermKindCommand
				renderer := ""
				if tt.renderer != nil && *tt.renderer != "" {
					kind = blockTermKindRenderer
					renderer = "old.renderer"
				}
				require.NoError(t, env.db.Create(&model.BlockTermBlock{
					ID:         blockID,
					TerminalID: "term-renderer-patch",
					LineNum:    0,
					Kind:       kind,
					Renderer:   renderer,
					StateJSON:  `{"old":true}`,
				}).Error)
			}
			payload := make(map[string]any)
			if tt.renderer != nil {
				payload["renderer"] = *tt.renderer
			}
			if tt.stateJSON != nil {
				payload["state_json"] = *tt.stateJSON
			}

			response := doBlockTermJSON(
				t,
				env.router,
				http.MethodPatch,
				"/api/blockterm/blocks/"+blockID,
				payload,
			)
			require.Equal(t, tt.wantStatus, response.Code, response.Body.String())
			if tt.wantError != "" {
				require.Contains(t, response.Body.String(), tt.wantError)
				return
			}

			var body struct {
				Block model.BlockTermBlock `json:"block"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, tt.wantRenderer, body.Block.Renderer)
			require.Equal(t, tt.wantState, body.Block.StateJSON)
		})
	}
}

func TestBlockTermCreateIsIdempotentForClientProvidedID(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-idempotent")
	seedBlockTermTerminal(t, env.db, "term-idempotent-other")
	payload := map[string]any{
		"id":          "block-idempotent",
		"terminal_id": "term-idempotent",
		"line_num":    0,
		"command":     "printf hello",
	}

	first := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
	require.Equal(t, http.StatusCreated, first.Code, first.Body.String())
	retry := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", payload)
	require.Equal(t, http.StatusCreated, retry.Code, retry.Body.String())
	for _, conflictPayload := range []map[string]any{
		{
			"id":          "block-idempotent",
			"terminal_id": "term-idempotent",
			"line_num":    0,
			"command":     "printf changed",
		},
		{
			"id":          "block-idempotent",
			"terminal_id": "term-idempotent",
			"line_num":    1,
			"command":     "printf hello",
		},
		{
			"id":          "block-idempotent",
			"terminal_id": "term-idempotent-other",
			"line_num":    0,
			"command":     "printf hello",
		},
	} {
		conflict := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", conflictPayload)
		require.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
	}

	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", "block-idempotent").Count(&count).Error)
	require.EqualValues(t, 1, count)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "block-idempotent").Count(&count).Error)
	require.EqualValues(t, 1, count)
	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", "block-idempotent").Error)
	require.Equal(t, "printf hello", history.Command)
}

func TestBlockTermCreateBackfillsMissingHistoryOnIdempotentRetry(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-backfill")
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-backfill").Updates(map[string]any{
		"workspace_session_id": "workspace-backfill",
		"group_id":             "group-backfill",
		"user_id":              "user-backfill",
		"runtime_type":         "local",
	}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-backfill",
		TerminalID: "term-backfill",
		LineNum:    7,
		Command:    "echo restored",
		Cwd:        "/workspace",
		CreatedAt:  123,
		UpdatedAt:  456,
	}).Error)

	retry := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "block-backfill",
		"terminal_id": "term-backfill",
		"line_num":    7,
		"command":     "echo restored",
	})
	require.Equal(t, http.StatusCreated, retry.Code, retry.Body.String())

	var history model.BlockTermCommandHistory
	require.NoError(t, env.db.First(&history, "id = ?", "block-backfill").Error)
	require.Equal(t, "workspace-backfill", history.WorkspaceSessionID)
	require.Equal(t, "group-backfill", history.GroupID)
	require.Equal(t, "user-backfill", history.UserID)
	require.Equal(t, "local", history.RuntimeType)
	require.Equal(t, 7, history.LineNum)
	require.Equal(t, "echo restored", history.Command)
	require.Equal(t, "/workspace", history.Cwd)
	require.EqualValues(t, 123, history.CreatedAt)
}

func TestBlockTermCreateRollsBackWhenHistoryInsertFails(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-rollback")

	const callbackName = "test:blockterm_history_create_failure"
	require.NoError(t, env.db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermCommandHistory{}).TableName() {
			tx.AddError(errors.New("forced history insert failure"))
		}
	}))
	t.Cleanup(func() { _ = env.db.Callback().Create().Remove(callbackName) })

	response := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "block-rollback",
		"terminal_id": "term-rollback",
		"line_num":    0,
		"command":     "echo rollback",
	})
	require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "forced history insert failure")

	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", "block-rollback").Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "block-rollback").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermHistoryQuery(t *testing.T) {
	env := setupBlockTermHandler(t)
	history := []model.BlockTermCommandHistory{
		{ID: "history-old", TerminalID: "deleted-terminal", Command: "echo old", CreatedAt: 1, WorkspaceSessionID: "ws-old", GroupID: "group-old", RuntimeType: "ssh"},
		{ID: "history-b", TerminalID: "term-a", Command: "echo under_score", CreatedAt: 3},
		{ID: "history-c", TerminalID: "term-a", Command: "printf '100%'", CreatedAt: 3},
		{ID: "history-path", TerminalID: "term-b", Command: `cat path\name`, CreatedAt: 2},
		{ID: "history-new", TerminalID: "term-b", Command: "printf '100x'", CreatedAt: 4},
	}
	require.NoError(t, env.db.Create(&history).Error)

	response := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?limit=3", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		History []model.BlockTermCommandHistory `json:"history"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, []string{"history-new", "history-c", "history-b"}, []string{
		body.History[0].ID,
		body.History[1].ID,
		body.History[2].ID,
	})

	terminalResponse := doBlockTermJSON(
		t,
		env.router,
		http.MethodGet,
		"/api/blockterm/history?terminal_id=deleted-terminal",
		nil,
	)
	require.Equal(t, http.StatusOK, terminalResponse.Code, terminalResponse.Body.String())
	require.NoError(t, json.Unmarshal(terminalResponse.Body.Bytes(), &body))
	require.Len(t, body.History, 1)
	require.Equal(t, "history-old", body.History[0].ID)
	for _, query := range []string{
		"workspace_session_id=ws-old",
		"group_id=group-old",
		"runtime_type=ssh",
	} {
		filtered := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?"+query, nil)
		require.Equal(t, http.StatusOK, filtered.Code, filtered.Body.String())
		require.NoError(t, json.Unmarshal(filtered.Body.Bytes(), &body))
		require.Len(t, body.History, 1)
		require.Equal(t, "history-old", body.History[0].ID)
	}

	for _, tt := range []struct {
		query string
		id    string
	}{
		{query: "%", id: "history-c"},
		{query: "_", id: "history-b"},
		{query: `\`, id: "history-path"},
	} {
		t.Run("literal "+tt.query, func(t *testing.T) {
			searchResponse := doBlockTermJSON(
				t,
				env.router,
				http.MethodGet,
				"/api/blockterm/history?q="+url.QueryEscape(tt.query),
				nil,
			)
			require.Equal(t, http.StatusOK, searchResponse.Code, searchResponse.Body.String())
			require.NoError(t, json.Unmarshal(searchResponse.Body.Bytes(), &body))
			require.Len(t, body.History, 1)
			require.Equal(t, tt.id, body.History[0].ID)
		})
	}

	invalid := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?limit=invalid", nil)
	require.Equal(t, http.StatusBadRequest, invalid.Code, invalid.Body.String())
	zero := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/history?limit=0", nil)
	require.Equal(t, http.StatusBadRequest, zero.Code, zero.Body.String())
}

func TestBlockTermHistoryLimitDefaultsAndCaps(t *testing.T) {
	env := setupBlockTermHandler(t)
	history := make([]model.BlockTermCommandHistory, 0, blockTermHistoryMaxLimit+5)
	for i := 0; i < blockTermHistoryMaxLimit+5; i++ {
		history = append(history, model.BlockTermCommandHistory{
			ID:         fmt.Sprintf("history-%03d", i),
			TerminalID: "term-limit",
			Command:    fmt.Sprintf("command %d", i),
			CreatedAt:  int64(i + 1),
		})
	}
	require.NoError(t, env.db.CreateInBatches(history, 50).Error)

	for _, tt := range []struct {
		name string
		path string
		want int
	}{
		{name: "default", path: "/api/blockterm/history", want: blockTermHistoryLimit},
		{name: "maximum", path: "/api/blockterm/history?limit=999", want: blockTermHistoryMaxLimit},
	} {
		t.Run(tt.name, func(t *testing.T) {
			response := doBlockTermJSON(t, env.router, http.MethodGet, tt.path, nil)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var body struct {
				History []model.BlockTermCommandHistory `json:"history"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Len(t, body.History, tt.want)
			require.Equal(t, "history-204", body.History[0].ID)
		})
	}
}

func TestBlockTermHandlerListOrdering(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-1")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{ID: "b2", TerminalID: "term-1", LineNum: 2, CreatedAt: 10, UpdatedAt: 10}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{ID: "b1", TerminalID: "term-1", LineNum: 1, CreatedAt: 20, UpdatedAt: 20}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{ID: "b3", TerminalID: "term-1", LineNum: 3, CreatedAt: 5, UpdatedAt: 5}).Error)

	list := doBlockTermJSON(t, env.router, http.MethodGet, "/api/blockterm/blocks?terminal_id=term-1", nil)
	require.Equal(t, http.StatusOK, list.Code)
	var body struct {
		Blocks []model.BlockTermBlock `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &body))
	require.Equal(t, []string{"b1", "b2", "b3"}, []string{body.Blocks[0].ID, body.Blocks[1].ID, body.Blocks[2].ID})
}

func TestBlockTermRemovedWhenTerminalDeleted(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-delete")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{ID: "block-delete", TerminalID: "term-delete", LineNum: 0}).Error)
	require.NoError(t, env.db.Create(&model.BlockTermCommandHistory{
		ID:         "block-delete",
		TerminalID: "term-delete",
		Command:    "echo retained",
	}).Error)

	require.NoError(t, env.manager.Delete("term-delete"))

	var blocks int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("terminal_id = ?", "term-delete").Count(&blocks).Error)
	require.Zero(t, blocks)
	var sessions int64
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-delete").Count(&sessions).Error)
	require.Zero(t, sessions)
	var history int64
	require.NoError(t, env.db.Model(&model.BlockTermCommandHistory{}).Where("terminal_id = ?", "term-delete").Count(&history).Error)
	require.EqualValues(t, 1, history)
}

func TestBlockTermCreateSerializesWithTerminalDelete(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-delete-race")

	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
	})
	const callbackName = "test:blockterm_create_gate"
	require.NoError(t, env.db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		enterOnce.Do(func() { close(entered) })
		<-release
	}))
	t.Cleanup(func() {
		_ = env.db.Callback().Create().Remove(callbackName)
	})

	createDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		createDone <- doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
			"terminal_id": "term-delete-race",
			"line_num":    0,
		})
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("block create did not reach database callback")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- env.manager.Delete("term-delete-race")
	}()

	select {
	case err := <-deleteDone:
		t.Fatalf("terminal delete bypassed in-flight block create: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(release) })
	create := <-createDone
	require.Equal(t, http.StatusCreated, create.Code, create.Body.String())
	require.NoError(t, <-deleteDone)

	var count int64
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-delete-race").Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("terminal_id = ?", "term-delete-race").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermMutationDoesNotHoldLifecycleWhileReadingRequestBody(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		path       string
		body       string
		seed       func(*testing.T, blockTermTestEnv)
		terminalID string
		cursor     *string
	}{
		{
			name:       "create",
			method:     http.MethodPost,
			path:       "/api/blockterm/blocks",
			body:       `{"terminal_id":"term-slow-create","line_num":0}`,
			seed:       func(t *testing.T, env blockTermTestEnv) { seedBlockTermTerminal(t, env.db, "term-slow-create") },
			terminalID: "term-slow-create",
		},
		{
			name:       "patch",
			method:     http.MethodPatch,
			path:       "/api/blockterm/blocks/block-slow-patch",
			body:       `{"status":"success"}`,
			terminalID: "term-slow-patch",
			seed: func(t *testing.T, env blockTermTestEnv) {
				seedBlockTermTerminal(t, env.db, "term-slow-patch")
				require.NoError(t, env.db.Create(&model.BlockTermBlock{
					ID:         "block-slow-patch",
					TerminalID: "term-slow-patch",
					LineNum:    0,
				}).Error)
			},
		},
		{
			name:       "output put",
			method:     http.MethodPut,
			path:       "/api/blockterm/blocks/block-slow-output/output",
			body:       "snapshot",
			terminalID: "term-slow-output",
			cursor:     blockTermString("1"),
			seed: func(t *testing.T, env blockTermTestEnv) {
				seedBlockTermTerminal(t, env.db, "term-slow-output")
				require.NoError(t, env.db.Create(&model.BlockTermBlock{
					ID:         "block-slow-output",
					TerminalID: "term-slow-output",
					LineNum:    0,
				}).Error)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			tt.seed(t, env)
			body := newGatedRequestBody(tt.body)
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(body.release) }) })

			req := httptest.NewRequest(tt.method, tt.path, body)
			if tt.method == http.MethodPut {
				req.Header.Set("Content-Type", "application/octet-stream")
				req.Header.Set(blockTermOutputCursorHeader, *tt.cursor)
			} else {
				req.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			handlerDone := make(chan struct{})
			go func() {
				env.router.ServeHTTP(response, req)
				close(handlerDone)
			}()

			select {
			case <-body.started:
			case <-time.After(time.Second):
				t.Fatal("handler did not start reading the request body")
			}

			deleteDone := make(chan error, 1)
			go func() { deleteDone <- env.manager.Delete(tt.terminalID) }()
			select {
			case err := <-deleteDone:
				require.NoError(t, err)
			case <-time.After(time.Second):
				t.Fatal("terminal delete was blocked by request body I/O")
			}

			releaseOnce.Do(func() { close(body.release) })
			select {
			case <-handlerDone:
			case <-time.After(time.Second):
				t.Fatal("handler did not finish after releasing the request body")
			}
			require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
		})
	}
}

func TestBlockTermCreateDoesNotHoldLifecycleWhileWritingResponse(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-slow-response")

	payload, err := json.Marshal(map[string]any{
		"terminal_id": "term-slow-response",
		"line_num":    0,
	})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/blockterm/blocks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	response := newGatedResponseWriter()
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(response.release) }) })

	handlerDone := make(chan struct{})
	go func() {
		env.router.ServeHTTP(response, req)
		close(handlerDone)
	}()
	select {
	case <-response.started:
	case <-time.After(time.Second):
		t.Fatal("handler did not start writing the response")
	}

	deleteDone := make(chan error, 1)
	go func() { deleteDone <- env.manager.Delete("term-slow-response") }()
	select {
	case err := <-deleteDone:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("terminal delete was blocked by response I/O")
	}

	releaseOnce.Do(func() { close(response.release) })
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("handler did not finish after releasing the response writer")
	}
	require.Equal(t, http.StatusCreated, response.status)

	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("terminal_id = ?", "term-slow-response").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermTerminalPatchSerializesWithTerminalDelete(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-source")
	seedBlockTermTerminal(t, env.db, "term-target")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-move",
		TerminalID: "term-source",
		LineNum:    0,
	}).Error)

	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	const callbackName = "test:blockterm_patch_gate"
	require.NoError(t, env.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		enterOnce.Do(func() {
			close(entered)
			<-release
		})
	}))
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		_ = env.db.Callback().Update().Remove(callbackName)
	})

	payload, err := json.Marshal(map[string]any{"terminal_id": "term-target"})
	require.NoError(t, err)
	patchDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPatch, "/api/blockterm/blocks/block-move", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		env.router.ServeHTTP(w, req)
		patchDone <- w
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("block patch did not reach database callback")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- env.manager.Delete("term-target")
	}()

	select {
	case err := <-deleteDone:
		t.Fatalf("terminal delete bypassed in-flight block patch: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(release) })
	patch := <-patchDone
	require.Equal(t, http.StatusOK, patch.Code, patch.Body.String())
	require.NoError(t, <-deleteDone)

	var count int64
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-target").Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, env.db.Model(&model.TerminalSession{}).Where("id = ?", "term-source").Count(&count).Error)
	require.EqualValues(t, 1, count)
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).Where("id = ?", "block-move").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermListMetadataOmitsOutput(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-metadata")
	largeOutput := bytes.Repeat([]byte{0xff}, blockTermMaxOutputBytes)
	require.NoError(t, env.db.Create([]model.BlockTermBlock{
		{
			ID:         "block-empty",
			TerminalID: "term-metadata",
			LineNum:    0,
			Output:     nil,
			CreatedAt:  1,
			UpdatedAt:  1,
		},
		{
			ID:           "block-large",
			TerminalID:   "term-metadata",
			LineNum:      1,
			Output:       largeOutput,
			OutputCursor: blockTermInt64(37),
			CreatedAt:    2,
			UpdatedAt:    2,
		},
	}).Error)

	response := doBlockTermJSON(
		t,
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks?terminal_id=term-metadata&include_output=0",
		nil,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Less(t, response.Body.Len(), 4096)

	var body struct {
		Blocks []map[string]json.RawMessage `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Len(t, body.Blocks, 2)
	for _, block := range body.Blocks {
		_, hasOutput := block["output"]
		require.False(t, hasOutput)
	}
	require.Equal(t, "0", string(body.Blocks[0]["output_size"]))
	require.Equal(t, "null", string(body.Blocks[0]["output_cursor"]))
	require.Equal(t, fmt.Sprintf("%d", len(largeOutput)), string(body.Blocks[1]["output_size"]))
	require.Equal(t, "37", string(body.Blocks[1]["output_cursor"]))
}

func TestBlockTermCreateJSONSupportsMaximumOutputSnapshot(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-create-output-limit")
	maximum := bytes.Repeat([]byte("x"), blockTermMaxOutputBytes)

	created := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "block-create-output-limit",
		"terminal_id": "term-create-output-limit",
		"line_num":    0,
		"output":      maximum,
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", "block-create-output-limit").Error)
	require.Equal(t, maximum, block.Output)

	overLimit := doBlockTermJSON(t, env.router, http.MethodPost, "/api/blockterm/blocks", map[string]any{
		"id":          "block-create-output-over-limit",
		"terminal_id": "term-create-output-limit",
		"line_num":    1,
		"output":      bytes.Repeat([]byte("y"), blockTermMaxOutputBytes+1),
	})
	require.Equal(t, http.StatusRequestEntityTooLarge, overLimit.Code, overLimit.Body.String())
	require.Contains(t, overLimit.Body.String(), "output is too large")
}

func TestBlockTermPatchJSONSupportsMaximumOutputSnapshot(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-patch-output-limit")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-patch-output-limit",
		TerminalID: "term-patch-output-limit",
		LineNum:    0,
	}).Error)
	maximum := bytes.Repeat([]byte("x"), blockTermMaxOutputBytes)

	patched := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-patch-output-limit",
		map[string]any{"output": maximum},
	)
	require.Equal(t, http.StatusOK, patched.Code, patched.Body.String())

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", "block-patch-output-limit").Error)
	require.Equal(t, maximum, block.Output)

	overLimit := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-patch-output-limit",
		map[string]any{"output": bytes.Repeat([]byte("y"), blockTermMaxOutputBytes+1)},
	)
	require.Equal(t, http.StatusRequestEntityTooLarge, overLimit.Code, overLimit.Body.String())
	require.Contains(t, overLimit.Body.String(), "output is too large")
	require.NoError(t, env.db.First(&block, "id = ?", "block-patch-output-limit").Error)
	require.Equal(t, maximum, block.Output)
}

func TestBlockTermListDefaultsToMetadata(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-full-output")
	output := []byte("hello\x00\x1b[31m世界")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:           "block-full-output",
		TerminalID:   "term-full-output",
		LineNum:      0,
		Output:       output,
		OutputCursor: blockTermInt64(8),
	}).Error)

	response := doBlockTermJSON(
		t,
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks?terminal_id=term-full-output",
		nil,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		Blocks []struct {
			Output       *string `json:"output"`
			OutputSize   int64   `json:"output_size"`
			OutputCursor *int64  `json:"output_cursor"`
		} `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Len(t, body.Blocks, 1)
	require.Nil(t, body.Blocks[0].Output)
	require.EqualValues(t, len(output), body.Blocks[0].OutputSize)
	require.Equal(t, blockTermInt64(8), body.Blocks[0].OutputCursor)
}

func TestBlockTermListIncludesFullOutputWhenExplicitlyRequested(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-full-output-explicit")
	output := []byte("hello\x00\x1b[31m世界")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:           "block-full-output-explicit",
		TerminalID:   "term-full-output-explicit",
		LineNum:      0,
		Output:       output,
		OutputCursor: blockTermInt64(8),
	}).Error)

	response := doBlockTermJSON(
		t,
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks?terminal_id=term-full-output-explicit&include_output=1",
		nil,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		Blocks []struct {
			Output       string `json:"output"`
			OutputCursor *int64 `json:"output_cursor"`
		} `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Len(t, body.Blocks, 1)
	require.Equal(t, base64.StdEncoding.EncodeToString(output), body.Blocks[0].Output)
	require.Equal(t, blockTermInt64(8), body.Blocks[0].OutputCursor)
}

func TestBlockTermOutputGetReturnsRawBytesAndNullableCursor(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-get")
	rawOutput := append([]byte("\x1b[31m中文\r\n"), 0, 7, 0xff)
	require.NoError(t, env.db.Create([]model.BlockTermBlock{
		{
			ID:           "block-output-raw",
			TerminalID:   "term-output-get",
			LineNum:      0,
			Output:       rawOutput,
			OutputCursor: blockTermInt64(23),
		},
		{
			ID:         "block-output-empty",
			TerminalID: "term-output-get",
			LineNum:    1,
			Output:     []byte{},
		},
	}).Error)

	rawResponse := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-output-raw/output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, rawResponse.Code, rawResponse.Body.String())
	require.Equal(t, "application/octet-stream", rawResponse.Header().Get("Content-Type"))
	require.Equal(t, "23", rawResponse.Header().Get(blockTermOutputCursorHeader))
	require.Equal(t, rawOutput, rawResponse.Body.Bytes())

	emptyResponse := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-output-empty/output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, emptyResponse.Code, emptyResponse.Body.String())
	require.Equal(t, "application/octet-stream", emptyResponse.Header().Get("Content-Type"))
	require.Empty(t, emptyResponse.Header().Values(blockTermOutputCursorHeader))
	require.Empty(t, emptyResponse.Body.Bytes())

	missing := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/missing/output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())
}

func TestBlockTermOutputPutValidatesCursorAndBodyLimit(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-put-limit")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-output-put-limit",
		TerminalID: "term-output-put-limit",
		LineNum:    0,
		Output:     []byte("original"),
	}).Error)

	invalidCursors := []struct {
		name   string
		cursor *string
	}{
		{name: "missing"},
		{name: "invalid", cursor: blockTermString("invalid")},
		{name: "negative", cursor: blockTermString("-1")},
		{name: "overflow", cursor: blockTermString("9223372036854775808")},
	}
	for _, tt := range invalidCursors {
		t.Run(tt.name, func(t *testing.T) {
			response := doBlockTermOutputRequest(
				env.router,
				http.MethodPut,
				"/api/blockterm/blocks/block-output-put-limit/output",
				[]byte("ignored"),
				tt.cursor,
			)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}

	empty := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-put-limit/output",
		nil,
		blockTermString("0"),
	)
	require.Equal(t, http.StatusNoContent, empty.Code, empty.Body.String())

	maximum := bytes.Repeat([]byte("x"), blockTermMaxOutputBytes)
	maxResponse := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-put-limit/output",
		maximum,
		blockTermString("1"),
	)
	require.Equal(t, http.StatusNoContent, maxResponse.Code, maxResponse.Body.String())

	overLimit := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-put-limit/output",
		bytes.Repeat([]byte("y"), blockTermMaxOutputBytes+1),
		blockTermString("2"),
	)
	require.Equal(t, http.StatusRequestEntityTooLarge, overLimit.Code, overLimit.Body.String())

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", "block-output-put-limit").Error)
	require.Equal(t, maximum, block.Output)
	require.Equal(t, blockTermInt64(1), block.OutputCursor)
}

func TestBlockTermOutputPutEnforcesMonotonicCursor(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-cursor")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:           "block-output-cursor",
		TerminalID:   "term-output-cursor",
		LineNum:      0,
		Output:       []byte("cursor-10"),
		OutputCursor: blockTermInt64(10),
	}).Error)

	updated := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-cursor/output",
		[]byte("cursor-11"),
		blockTermString("11"),
	)
	require.Equal(t, http.StatusNoContent, updated.Code, updated.Body.String())

	stale := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-cursor/output",
		[]byte("stale"),
		blockTermString("10"),
	)
	require.Equal(t, http.StatusConflict, stale.Code, stale.Body.String())

	idempotent := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-cursor/output",
		[]byte("cursor-11"),
		blockTermString("11"),
	)
	require.Equal(t, http.StatusNoContent, idempotent.Code, idempotent.Body.String())

	equalCursorDifferentOutput := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-cursor/output",
		[]byte("different"),
		blockTermString("11"),
	)
	require.Equal(t, http.StatusConflict, equalCursorDifferentOutput.Code, equalCursorDifferentOutput.Body.String())

	missing := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/missing/output",
		[]byte("missing"),
		blockTermString("12"),
	)
	require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", "block-output-cursor").Error)
	require.Equal(t, []byte("cursor-11"), block.Output)
	require.Equal(t, blockTermInt64(11), block.OutputCursor)
}

func TestBlockTermOutputPutConcurrentWritesKeepHighestCursor(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-concurrent")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-output-concurrent",
		TerminalID: "term-output-concurrent",
		LineNum:    0,
	}).Error)

	type putResult struct {
		cursor int
		status int
	}
	start := make(chan struct{})
	results := make(chan putResult, 2)
	for cursor := 1; cursor <= 2; cursor++ {
		cursor := cursor
		go func() {
			<-start
			cursorHeader := fmt.Sprintf("%d", cursor)
			response := doBlockTermOutputRequest(
				env.router,
				http.MethodPut,
				"/api/blockterm/blocks/block-output-concurrent/output",
				[]byte(fmt.Sprintf("cursor-%d", cursor)),
				&cursorHeader,
			)
			results <- putResult{cursor: cursor, status: response.Code}
		}()
	}
	close(start)
	statuses := make(map[int]int, 2)
	for range 2 {
		result := <-results
		statuses[result.cursor] = result.status
	}
	require.Equal(t, http.StatusNoContent, statuses[2])
	require.Contains(t, []int{http.StatusNoContent, http.StatusConflict}, statuses[1])

	var block model.BlockTermBlock
	require.NoError(t, env.db.First(&block, "id = ?", "block-output-concurrent").Error)
	require.Equal(t, []byte("cursor-2"), block.Output)
	require.Equal(t, blockTermInt64(2), block.OutputCursor)
}

func TestBlockTermPatchOutputResponseModesAndLegacyCursorReset(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-patch-output")
	missing := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/missing?include_output=0",
		map[string]any{"terminal_id": "missing-terminal"},
	)
	require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())
	require.Contains(t, missing.Body.String(), "block not found")

	output := bytes.Repeat([]byte("z"), 256*1024)
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:           "block-patch-output",
		TerminalID:   "term-patch-output",
		LineNum:      0,
		Output:       output,
		OutputCursor: blockTermInt64(17),
	}).Error)

	metadataResponse := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-patch-output?include_output=0",
		map[string]any{"status": "done"},
	)
	require.Equal(t, http.StatusOK, metadataResponse.Code, metadataResponse.Body.String())
	require.Less(t, metadataResponse.Body.Len(), 2048)
	var metadataBody struct {
		Block map[string]json.RawMessage `json:"block"`
	}
	require.NoError(t, json.Unmarshal(metadataResponse.Body.Bytes(), &metadataBody))
	_, hasOutput := metadataBody.Block["output"]
	require.False(t, hasOutput)
	require.Equal(t, fmt.Sprintf("%d", len(output)), string(metadataBody.Block["output_size"]))
	require.Equal(t, "17", string(metadataBody.Block["output_cursor"]))

	fullResponse := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-patch-output?include_output=1",
		map[string]any{"command": "updated"},
	)
	require.Equal(t, http.StatusOK, fullResponse.Code, fullResponse.Body.String())
	var fullBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(fullResponse.Body.Bytes(), &fullBody))
	require.Equal(t, output, fullBody.Block.Output)
	require.Equal(t, blockTermInt64(17), fullBody.Block.OutputCursor)

	legacyOutput := []byte("legacy-json-output")
	legacyResponse := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-patch-output?include_output=1",
		map[string]any{"output": legacyOutput},
	)
	require.Equal(t, http.StatusOK, legacyResponse.Code, legacyResponse.Body.String())
	var legacyBody struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(legacyResponse.Body.Bytes(), &legacyBody))
	require.Equal(t, legacyOutput, legacyBody.Block.Output)
	require.Nil(t, legacyBody.Block.OutputCursor)

	var persisted model.BlockTermBlock
	require.NoError(t, env.db.First(&persisted, "id = ?", "block-patch-output").Error)
	require.Equal(t, legacyOutput, persisted.Output)
	require.Nil(t, persisted.OutputCursor)
}

func TestBlockTermOutputPutAndBlockDeleteDoNotResurrectBlock(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-delete-race")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-output-delete-race",
		TerminalID: "term-output-delete-race",
		LineNum:    0,
	}).Error)

	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	const callbackName = "test:blockterm_output_put_gate"
	require.NoError(t, env.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		enterOnce.Do(func() {
			close(entered)
			<-release
		})
	}))
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		_ = env.db.Callback().Update().Remove(callbackName)
	})

	putDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		putDone <- doBlockTermOutputRequest(
			env.router,
			http.MethodPut,
			"/api/blockterm/blocks/block-output-delete-race/output",
			[]byte("snapshot"),
			blockTermString("1"),
		)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("output PUT did not reach database callback")
	}

	deleteDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		deleteDone <- doBlockTermOutputRequest(
			env.router,
			http.MethodDelete,
			"/api/blockterm/blocks/block-output-delete-race",
			nil,
			nil,
		)
	}()
	select {
	case response := <-deleteDone:
		t.Fatalf("block delete bypassed in-flight output PUT: %s", response.Body.String())
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(release) })
	putResponse := <-putDone
	require.Equal(t, http.StatusNoContent, putResponse.Code, putResponse.Body.String())
	deleteResponse := <-deleteDone
	require.Equal(t, http.StatusOK, deleteResponse.Code, deleteResponse.Body.String())

	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).
		Where("id = ?", "block-output-delete-race").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermOutputPutSerializesWithTerminalDelete(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-terminal-delete")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-output-terminal-delete",
		TerminalID: "term-output-terminal-delete",
		LineNum:    0,
	}).Error)

	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	const callbackName = "test:blockterm_output_terminal_delete_gate"
	require.NoError(t, env.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		enterOnce.Do(func() {
			close(entered)
			<-release
		})
	}))
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		_ = env.db.Callback().Update().Remove(callbackName)
	})

	putDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		putDone <- doBlockTermOutputRequest(
			env.router,
			http.MethodPut,
			"/api/blockterm/blocks/block-output-terminal-delete/output",
			[]byte("snapshot"),
			blockTermString("1"),
		)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("output PUT did not reach database callback")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- env.manager.Delete("term-output-terminal-delete")
	}()
	select {
	case err := <-deleteDone:
		t.Fatalf("terminal delete bypassed in-flight output PUT: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(release) })
	putResponse := <-putDone
	require.Equal(t, http.StatusNoContent, putResponse.Code, putResponse.Body.String())
	require.NoError(t, <-deleteDone)

	var count int64
	require.NoError(t, env.db.Model(&model.TerminalSession{}).
		Where("id = ?", "term-output-terminal-delete").Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, env.db.Model(&model.BlockTermBlock{}).
		Where("id = ?", "block-output-terminal-delete").Count(&count).Error)
	require.Zero(t, count)
}
