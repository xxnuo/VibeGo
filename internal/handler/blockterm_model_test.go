package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermmodel"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupBlockTermModelHandler(t *testing.T, upstream http.HandlerFunc) (*gin.Engine, *gorm.DB, *blocktermmodel.Service, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open("file:"+uuid.NewString()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(
		&model.UserSetting{}, &model.TerminalSession{}, &model.BlockTermBlock{}, &model.BlockTermCommandHistory{},
	))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "terminal-1", Status: model.StatusRunning}).Error)
	server := httptest.NewServer(upstream)
	manager := terminal.NewManager(db, &terminal.ManagerConfig{Shell: "/bin/sh"})
	service := blocktermmodel.NewWithOptions(db, blocktermmodel.Options{
		HTTPClient: server.Client(), AllowPrivateNetwork: true, MutationGate: manager.BlockTermMutationGate(),
	})
	router := gin.New()
	NewBlockTermHandler(manager).Register(router.Group("/api"))
	NewBlockTermModelHandler(service).Register(router.Group("/api"))
	t.Cleanup(func() {
		service.Close()
		server.Close()
		require.NoError(t, sqlDB.Close())
	})
	return router, db, service, server.URL
}

func TestBlockTermModelConfigNeverReturnsToken(t *testing.T) {
	router, _, _, _ := setupBlockTermModelHandler(t, func(http.ResponseWriter, *http.Request) {})
	body := `{"base_url":"http://127.0.0.1:12345/v1","model":"private-model","max_tokens":32,"timeout_seconds":7,"allow_private_network":true,"api_token":"never-return-this"}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/blockterm/model/config", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "never-return-this")
	require.NotContains(t, recorder.Body.String(), "api_token\"")
	var response map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Equal(t, true, response["api_token_set"])
	require.Equal(t, true, response["allow_private_network"])
	require.Len(t, response, 6)

	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/blockterm/model/config", nil))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "never-return-this")

	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/api/blockterm/model/config", nil))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"api_token_set":false`)
}

func TestBlockTermModelRunAndSSEContract(t *testing.T) {
	router, db, service, upstreamURL := setupBlockTermModelHandler(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer handler-token", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	})
	baseURL := upstreamURL + "/v1"
	token := "handler-token"
	allowPrivate := true
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate,
	})
	require.NoError(t, err)

	runBody := `{"id":"handler-run","terminal_id":"terminal-1","line_num":4,"command":"/chat question","current_command":"go test ./...","prompt":"question","model":"override-model"}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", bytes.NewBufferString(runBody))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "handler-token")

	deadline := time.Now().Add(3 * time.Second)
	for {
		var block model.BlockTermBlock
		require.NoError(t, db.First(&block, "id = ?", "handler-run").Error)
		if block.Status != "streaming" {
			require.Equal(t, "success", block.Status)
			require.Equal(t, "/chat question", block.Command)
			require.Equal(t, "answer", string(block.Output))
			require.JSONEq(t, `{"prompt:source":"model","model":"override-model","current_command":"go test ./..."}`, block.StateJSON)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("model run did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}

	recorder = httptest.NewRecorder()
	eventsRequest := httptest.NewRequest(http.MethodGet, "/api/blockterm/model/runs/handler-run/events", nil)
	eventsRequest.Header.Set("Last-Event-ID", "99")
	router.ServeHTTP(recorder, eventsRequest)
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Header().Get("Content-Type"), "text/event-stream")
	require.Contains(t, recorder.Body.String(), "id: 100\n")
	require.Contains(t, recorder.Body.String(), `"seq":100`)
	require.Contains(t, recorder.Body.String(), `"snapshot":"answer"`)
	require.Contains(t, recorder.Body.String(), `"done":true`)
	require.True(t, strings.HasPrefix(recorder.Body.String(), "id: 100\ndata: "))
}

func TestBlockTermModelRunAcceptsMessagesAndTrustedSourceBlock(t *testing.T) {
	payloads := make(chan map[string]any, 1)
	router, db, service, upstreamURL := setupBlockTermModelHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n"))
	})
	baseURL := upstreamURL + "/v1"
	token := "handler-token"
	allowPrivate := true
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate,
	})
	require.NoError(t, err)
	exitCode := 9
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "handler-source", TerminalID: "terminal-1", LineNum: 10, Kind: "command",
		Command: "go test ./...", Cwd: "/trusted", Status: "error", Output: []byte("\x1b[31mfailed\x1b[0m"),
		ExitCode: &exitCode, StateJSON: `{"error":"tests failed"}`, CreatedAt: now, UpdatedAt: now,
	}).Error)

	body, err := json.Marshal(map[string]any{
		"id":          "handler-line-ai",
		"terminal_id": "terminal-1",
		"command":     "/chat explain",
		"messages": []map[string]string{
			{"role": "user", "content": "first"},
			{"role": "assistant", "content": "previous answer"},
			{"role": "user", "content": "explain the failure"},
		},
		"context": map[string]any{
			"source_block_id": "handler-source",
			"command":         "spoofed",
			"output":          "spoofed",
			"status":          "success",
			"exit_code":       0,
			"cwd":             "/spoofed",
		},
	})
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"archived":true`)

	deadline := time.Now().Add(3 * time.Second)
	for {
		var block model.BlockTermBlock
		require.NoError(t, db.First(&block, "id = ?", "handler-line-ai").Error)
		if block.Status != "streaming" {
			require.Equal(t, "success", block.Status)
			require.True(t, block.Archived)
			require.Equal(t, "/trusted", block.Cwd)
			var state map[string]any
			require.NoError(t, json.Unmarshal([]byte(block.StateJSON), &state))
			require.Equal(t, "handler-source", state["source_block_id"])
			require.NotEmpty(t, state["request_hash"])
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("model run did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}

	var payload map[string]any
	select {
	case payload = <-payloads:
	case <-time.After(time.Second):
		t.Fatal("model upstream did not receive request")
	}
	require.NotContains(t, payload, "context")
	messages := payload["messages"].([]any)
	require.Len(t, messages, 3)
	require.Equal(t, "first", messages[0].(map[string]any)["content"])
	require.Equal(t, "previous answer", messages[1].(map[string]any)["content"])
	lastContent := messages[2].(map[string]any)["content"].(string)
	require.Contains(t, lastContent, "go test ./...")
	require.Contains(t, lastContent, "failed")
	require.Contains(t, lastContent, `"exit_code": 9`)
	require.NotContains(t, lastContent, "spoofed")
	require.NotContains(t, lastContent, "\x1b")
	var historyCount int64
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "handler-line-ai").Count(&historyCount).Error)
	require.Zero(t, historyCount)
}

func TestDeletingActiveLineAIRunReservesStableID(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	router, db, service, upstreamURL := setupBlockTermModelHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(canceled)
	})
	baseURL := upstreamURL + "/v1"
	token := "handler-token"
	allowPrivate := true
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate,
	})
	require.NoError(t, err)
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "active-line-ai-source", TerminalID: "terminal-1", LineNum: 1, Kind: "command",
		Command: "go test ./...", Status: "success", CreatedAt: now, UpdatedAt: now,
	}).Error)

	runBody := `{"id":"active-line-ai","terminal_id":"terminal-1","line_num":2,"command":"/chat explain","messages":[{"role":"user","content":"explain"}],"context":{"source_block_id":"active-line-ai-source"}}`
	created := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", strings.NewReader(runBody))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(created, request)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("model upstream did not start")
	}

	deleted := httptest.NewRecorder()
	router.ServeHTTP(deleted, httptest.NewRequest(http.MethodDelete, "/api/blockterm/blocks/active-line-ai", nil))
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("deleting the active Line AI block did not cancel upstream")
	}

	recreated := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", strings.NewReader(runBody))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recreated, request)
	require.Equal(t, http.StatusConflict, recreated.Code, recreated.Body.String())
	require.Contains(t, recreated.Body.String(), blocktermmodel.ErrBlockDeleted.Error())

	var blockCount int64
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", "active-line-ai").Count(&blockCount).Error)
	require.Zero(t, blockCount)
	var tombstone model.BlockTermCommandHistory
	require.NoError(t, db.First(&tombstone, "id = ?", "active-line-ai").Error)
	require.Empty(t, tombstone.Command)
	require.NotNil(t, tombstone.BlockDeletedAt)

	history := httptest.NewRecorder()
	router.ServeHTTP(history, httptest.NewRequest(http.MethodGet, "/api/blockterm/history?terminal_id=terminal-1", nil))
	require.Equal(t, http.StatusOK, history.Code, history.Body.String())
	require.NotContains(t, history.Body.String(), "active-line-ai")
}

func TestBlockTermModelEventsRejectsInvalidAfter(t *testing.T) {
	router, _, _, _ := setupBlockTermModelHandler(t, func(http.ResponseWriter, *http.Request) {})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/blockterm/model/runs/missing/events?after=-1", nil))
	require.Equal(t, http.StatusBadRequest, recorder.Code)

	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/blockterm/model/runs/missing/events?after=9007199254740991", nil))
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestBlockTermModelEventsRejectsAheadCursorForLiveRun(t *testing.T) {
	started := make(chan struct{})
	router, _, service, upstreamURL := setupBlockTermModelHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	})
	baseURL := upstreamURL + "/v1"
	token := "handler-token"
	allowPrivate := true
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate,
	})
	require.NoError(t, err)
	_, err = service.CreateRun(context.Background(), blocktermmodel.RunInput{
		ID: "live-cursor-run", TerminalID: "terminal-1", Prompt: "wait",
	})
	require.NoError(t, err)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("model upstream did not start")
	}

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/blockterm/model/runs/live-cursor-run/events?after=99", nil))
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	require.Contains(t, recorder.Body.String(), blocktermmodel.ErrInvalidEventCursor.Error())
}

func TestBlockTermModelCreateRunMapsValidationErrors(t *testing.T) {
	router, _, service, upstreamURL := setupBlockTermModelHandler(t, func(http.ResponseWriter, *http.Request) {})
	baseURL := upstreamURL + "/v1"
	token := "handler-token"
	allowPrivate := true
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate,
	})
	require.NoError(t, err)

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantError  string
	}{
		{
			name:       "missing prompt",
			body:       `{"id":"missing-prompt","terminal_id":"terminal-1"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "prompt is required",
		},
		{
			name:       "negative line",
			body:       `{"id":"negative-line","terminal_id":"terminal-1","line_num":-1,"prompt":"test"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "line_num must be a non-negative integer",
		},
		{
			name:       "oversized prompt",
			body:       `{"id":"oversized-prompt","terminal_id":"terminal-1","prompt":"` + strings.Repeat("x", blocktermmodel.MaxPromptBytes+1) + `"}`,
			wantStatus: http.StatusRequestEntityTooLarge,
			wantError:  "prompt is too large",
		},
		{
			name:       "invalid message role",
			body:       `{"id":"invalid-role","terminal_id":"terminal-1","messages":[{"role":"system","content":"no"}]}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "role must be user or assistant",
		},
		{
			name:       "oversized message",
			body:       `{"id":"oversized-message","terminal_id":"terminal-1","messages":[{"role":"user","content":"` + strings.Repeat("x", blocktermmodel.MaxMessageBytes+1) + `"}]}`,
			wantStatus: http.StatusRequestEntityTooLarge,
			wantError:  "content is too large",
		},
		{
			name:       "missing source block",
			body:       `{"id":"missing-source","terminal_id":"terminal-1","messages":[{"role":"user","content":"question"}],"context":{"source_block_id":"missing"}}`,
			wantStatus: http.StatusNotFound,
			wantError:  blocktermmodel.ErrSourceBlockNotFound.Error(),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", bytes.NewBufferString(test.body))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)
			require.Equal(t, test.wantStatus, recorder.Code)
			require.Contains(t, recorder.Body.String(), test.wantError)
		})
	}
}

func TestBlockTermModelCreateRunRejectsOversizedBody(t *testing.T) {
	router, _, _, _ := setupBlockTermModelHandler(t, func(http.ResponseWriter, *http.Request) {})
	require.Less(t, blockTermModelMaxBodyBytes, blocktermmodel.MaxContextOutputBytes)
	body := `{"terminal_id":"terminal-1","prompt":"` + strings.Repeat("x", blockTermModelMaxBodyBytes) + `"}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code)
	require.Contains(t, recorder.Body.String(), "request body is too large")
}
