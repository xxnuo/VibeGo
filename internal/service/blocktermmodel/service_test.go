package blocktermmodel

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newModelTestService(t *testing.T, upstream http.HandlerFunc, maxEvents int) (*Service, *gorm.DB, *httptest.Server) {
	t.Helper()
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
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: "terminal-1", Cwd: "/workspace", CurrentCwd: "/workspace/current", Status: model.StatusRunning,
		WorkspaceSessionID: "workspace-1", GroupID: "group-1", UserID: "user-1", RuntimeType: "local",
	}).Error)
	server := httptest.NewServer(upstream)
	service := NewWithOptions(db, Options{
		HTTPClient: server.Client(), AllowPrivateNetwork: true, MaxEvents: maxEvents,
	})
	baseURL := server.URL + "/v1"
	modelName := "test-model"
	maxTokens := 64
	timeout := 5
	token := "top-secret-token"
	_, err = service.SetConfig(ConfigPatch{
		BaseURL: &baseURL, Model: &modelName, MaxTokens: &maxTokens, TimeoutSecond: &timeout, APIToken: &token,
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		service.Close()
		server.Close()
		require.NoError(t, sqlDB.Close())
	})
	return service, db, server
}

func collectModelEvents(t *testing.T, subscription *Subscription) []Event {
	t.Helper()
	defer subscription.Close()
	events := append([]Event(nil), subscription.Events...)
	if len(events) > 0 && events[len(events)-1].Done {
		return events
	}
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case event, ok := <-subscription.C:
			if !ok {
				return events
			}
			events = append(events, event)
			if event.Done {
				return events
			}
		case <-timeout.C:
			t.Fatal("timed out waiting for model events")
		}
	}
}

func TestModelRunStreamsPersistsAndReconnects(t *testing.T) {
	var requestMu sync.Mutex
	var authorization string
	var requestPayload map[string]any
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		requestMu.Lock()
		authorization = r.Header.Get("Authorization")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&requestPayload))
		requestMu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"))
		flusher.Flush()
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		flusher.Flush()
	}, 16)

	lineNum := 7
	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "run-1", TerminalID: "terminal-1", LineNum: &lineNum, Command: "/chat Say hello",
		CurrentCommand: "git status --short", Prompt: "Say hello",
	})
	require.NoError(t, err)
	require.Equal(t, "streaming", block.Status)
	require.Equal(t, "renderer", block.Kind)
	require.Equal(t, "openai", block.Renderer)
	require.Equal(t, "Say hello", block.Text)
	require.Equal(t, "/chat Say hello", block.Command)
	require.JSONEq(t, `{"prompt:source":"model","model":"test-model","current_command":"git status --short"}`, block.StateJSON)

	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.GreaterOrEqual(t, len(events), 4)
	require.True(t, events[len(events)-1].Done)
	require.Equal(t, "success", events[len(events)-1].Status)
	require.Equal(t, "hello", events[len(events)-1].Text)
	require.Equal(t, "hello", events[len(events)-1].Snapshot)

	requestMu.Lock()
	require.Equal(t, "Bearer top-secret-token", authorization)
	require.Equal(t, "test-model", requestPayload["model"])
	require.Equal(t, true, requestPayload["stream"])
	messages, ok := requestPayload["messages"].([]any)
	require.True(t, ok)
	require.Len(t, messages, 1)
	message, ok := messages[0].(map[string]any)
	require.True(t, ok)
	require.Contains(t, message["content"], "currently working with the command: ```\ngit status --short\n```")
	requestMu.Unlock()

	var persisted model.BlockTermBlock
	require.NoError(t, db.First(&persisted, "id = ?", block.ID).Error)
	require.Equal(t, "success", persisted.Status)
	require.Equal(t, "hello", string(persisted.Output))
	require.NotNil(t, persisted.FinishedAt)
	require.NotNil(t, persisted.ExitCode)
	require.Equal(t, 0, *persisted.ExitCode)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "/chat Say hello", history.Command)
	require.Equal(t, persisted.Kind, history.Kind)
	require.Equal(t, persisted.Text, history.Text)
	require.Equal(t, persisted.Status, history.Status)
	require.Equal(t, persisted.Output, history.Output)
	require.Equal(t, persisted.ExitCode, history.ExitCode)
	require.Equal(t, persisted.FinishedAt, history.FinishedAt)
	require.Equal(t, persisted.Renderer, history.Renderer)
	require.Equal(t, persisted.StateJSON, history.StateJSON)
	require.Equal(t, persisted.UpdatedAt, history.SnapshotUpdatedAt)

	reconnected, err := service.Subscribe(block.ID, 2)
	require.NoError(t, err)
	replayed := collectModelEvents(t, reconnected)
	require.NotEmpty(t, replayed)
	for _, event := range replayed {
		require.Greater(t, event.Seq, int64(2))
	}
	require.True(t, replayed[len(replayed)-1].Done)
}

func TestModelRunSendsMultiTurnTrustedSourceContext(t *testing.T) {
	payloads := make(chan map[string]any, 1)
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, 16)

	lines := make([]string, 120)
	for index := range lines {
		lines[index] = fmt.Sprintf("line-%03d", index)
	}
	lines[0] = "\x1b[31mline-000\x1b[0m"
	lines[5] = "invalid-" + string([]byte{0xff}) + "-utf8"
	exitCode := 7
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "source-command", TerminalID: "terminal-1", LineNum: 40, Kind: "command",
		Command: "printf 'trusted'", Cwd: "/trusted/cwd", Status: "error", Output: []byte(strings.Join(lines, "\n")),
		ExitCode: &exitCode, StateJSON: `{"error":"\u001b[31mpermission denied\u001b[0m"}`,
		CreatedAt: now, UpdatedAt: now,
	}).Error)

	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "line-ai-run", TerminalID: "terminal-1", Command: "/chat why did it fail?",
		Messages: []RunMessage{
			{Role: "user", Content: "How do I inspect this?"},
			{Role: "assistant", Content: "Run the command and inspect its output."},
			{Role: "user", Content: "Why did it fail?"},
		},
		Context: &RunContext{
			SourceBlockID: "source-command", Command: "spoofed command", Output: "spoofed output",
			Error: "spoofed error", Status: "success", Cwd: "/spoofed",
		},
	})
	require.NoError(t, err)
	require.True(t, block.Archived)
	require.Equal(t, "Why did it fail?", block.Text)
	require.Equal(t, "/trusted/cwd", block.Cwd)

	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.Equal(t, "success", events[len(events)-1].Status)

	var payload map[string]any
	select {
	case payload = <-payloads:
	case <-time.After(time.Second):
		t.Fatal("model upstream did not receive request")
	}
	require.NotContains(t, payload, "context")
	messages, ok := payload["messages"].([]any)
	require.True(t, ok)
	require.Len(t, messages, 3)
	first := messages[0].(map[string]any)
	second := messages[1].(map[string]any)
	last := messages[2].(map[string]any)
	require.Equal(t, "user", first["role"])
	require.Equal(t, "How do I inspect this?", first["content"])
	require.Equal(t, "assistant", second["role"])
	require.Equal(t, "Run the command and inspect its output.", second["content"])
	require.Equal(t, "user", last["role"])
	lastContent := last["content"].(string)
	require.Contains(t, lastContent, `"source_block_id": "source-command"`)
	require.Contains(t, lastContent, `"command": "printf 'trusted'"`)
	require.Contains(t, lastContent, `"status": "error"`)
	require.Contains(t, lastContent, `"exit_code": 7`)
	require.Contains(t, lastContent, `"cwd": "/trusted/cwd"`)
	require.Contains(t, lastContent, "permission denied")
	require.Contains(t, lastContent, "line-000")
	require.Contains(t, lastContent, "line-009")
	require.Contains(t, lastContent, "line-110")
	require.Contains(t, lastContent, "line-119")
	require.NotContains(t, lastContent, "line-050")
	require.NotContains(t, lastContent, "spoofed")
	require.NotContains(t, lastContent, "\x1b")
	require.NotContains(t, lastContent, "�")

	var persisted model.BlockTermBlock
	require.NoError(t, db.First(&persisted, "id = ?", block.ID).Error)
	require.True(t, persisted.Archived)
	state, err := parseBlockState(persisted.StateJSON)
	require.NoError(t, err)
	require.Equal(t, "source-command", state.SourceBlockID)
	require.Len(t, state.RequestHash, sha256.Size*2)
	var historyCount int64
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", block.ID).Count(&historyCount).Error)
	require.Zero(t, historyCount)
}

func TestStableRunIDHashesMessagesAndTrustedSourceContext(t *testing.T) {
	var requestMu sync.Mutex
	requestCount := 0
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		requestMu.Lock()
		requestCount++
		requestMu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n"))
	}, 16)
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "hash-source", TerminalID: "terminal-1", LineNum: 41, Kind: "command", Command: "go test ./...",
		Cwd: "/workspace", Status: "success", Output: []byte("ok"), CreatedAt: now, UpdatedAt: now,
	}).Error)
	input := RunInput{
		ID: "hash-run", TerminalID: "terminal-1", Command: "/chat explain",
		Messages: []RunMessage{{Role: "user", Content: "question one"}, {Role: "assistant", Content: "answer one"}, {Role: "user", Content: "explain"}},
		Context:  &RunContext{SourceBlockID: "hash-source"},
	}
	first, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	subscription, err := service.Subscribe(first.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, subscription)

	second, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", first.ID).Update("archived", false).Error)
	third, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.ID, third.ID)
	requestMu.Lock()
	require.Equal(t, 1, requestCount)
	requestMu.Unlock()

	changedHistory := input
	changedHistory.Messages = append([]RunMessage(nil), input.Messages...)
	changedHistory.Messages[1].Content = "different answer"
	_, err = service.CreateRun(context.Background(), changedHistory)
	require.ErrorIs(t, err, ErrRunConflict)

	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", "hash-source").Update("output", []byte("changed")).Error)
	_, err = service.CreateRun(context.Background(), input)
	require.ErrorIs(t, err, ErrRunConflict)
}

func TestCreateRunRejectsInvalidMessagesAndUnavailableSources(t *testing.T) {
	service, db, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) {}, 16)
	_, err := service.CreateRun(context.Background(), RunInput{
		ID: "invalid-role", TerminalID: "terminal-1", Messages: []RunMessage{{Role: "system", Content: "no"}},
	})
	require.ErrorIs(t, err, ErrInvalidRunInput)
	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "large-message", TerminalID: "terminal-1", Messages: []RunMessage{{Role: "user", Content: strings.Repeat("x", MaxMessageBytes+1)}},
	})
	require.ErrorIs(t, err, ErrRunInputTooLarge)
	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "missing-context-source", TerminalID: "terminal-1", Messages: []RunMessage{{Role: "user", Content: "question"}}, Context: &RunContext{},
	})
	require.ErrorIs(t, err, ErrInvalidRunInput)
	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "missing-source", TerminalID: "terminal-1", Messages: []RunMessage{{Role: "user", Content: "question"}}, Context: &RunContext{SourceBlockID: "missing"},
	})
	require.ErrorIs(t, err, ErrSourceBlockNotFound)

	now := time.Now().Unix()
	require.NoError(t, db.Create([]model.BlockTermBlock{
		{ID: "note-source", TerminalID: "terminal-1", LineNum: 50, Kind: "note", Status: "success", CreatedAt: now, UpdatedAt: now},
		{ID: "running-source", TerminalID: "terminal-1", LineNum: 51, Kind: "command", Status: "running", CreatedAt: now, UpdatedAt: now},
		{ID: "streaming-source", TerminalID: "terminal-1", LineNum: 52, Kind: "renderer", Status: "streaming", CreatedAt: now, UpdatedAt: now},
	}).Error)
	for _, sourceID := range []string{"note-source", "running-source", "streaming-source"} {
		_, err = service.CreateRun(context.Background(), RunInput{
			ID: "reject-" + sourceID, TerminalID: "terminal-1", Messages: []RunMessage{{Role: "user", Content: "question"}},
			Context: &RunContext{SourceBlockID: sourceID},
		})
		require.ErrorIs(t, err, ErrSourceBlockUnavailable)
	}
}

func TestSanitizeTerminalTextStripsControlSequencesWithoutDroppingVisibleText(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "csi", input: "before\x1b[31mred\x1b[0mafter", want: "beforeredafter"},
		{name: "osc bel", input: "before\x1b]0;title\aafter", want: "beforeafter"},
		{name: "osc hyperlink st", input: "before\x1b]8;;https://example.test\x1b\\click here\x1b]8;;\x1b\\after", want: "beforeclick hereafter"},
		{name: "multiple osc st", input: "before\x1b]0;one\x1b\\middle\x1b]0;two\x1b\\after", want: "beforemiddleafter"},
		{name: "dcs", input: "before\x1bP1;2|DCS-PAYLOAD\x1b\\after", want: "beforeafter"},
		{name: "apc", input: "before\x1b_APC-PAYLOAD\x1b\\after", want: "beforeafter"},
		{name: "pm", input: "before\x1b^PM-PAYLOAD\x1b\\after", want: "beforeafter"},
		{name: "unterminated osc", input: "before\x1b]0;UNFINISHED-PAYLOAD after", want: "before"},
		{name: "canceled csi", input: "before\x1b[31\x18after", want: "beforeafter"},
		{name: "substituted csi", input: "before\x1b[31\x1aafter", want: "beforeafter"},
		{name: "canceled dcs", input: "before\x1bPpayload\x18after", want: "beforeafter"},
		{name: "canceled intermediate escape", input: "before\x1b \x18after", want: "beforeafter"},
		{name: "raw c1 csi", input: "before\x9b31mred\x9b0mafter", want: "beforeredafter"},
		{name: "utf8 c1 osc", input: "before\u009d0;title\u009cafter", want: "beforeafter"},
		{name: "invalid utf8", input: "before" + string([]byte{0xff}) + "after", want: "beforeafter"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			require.Equal(t, test.want, sanitizeTerminalText(test.input))
		})
	}
}

func TestTruncateTerminalOutputLinesBoundsManyShortLines(t *testing.T) {
	input := strings.Repeat("\n", 200_000)
	want := strings.Repeat("\n", 9) + "\n.\n.\n.\n" + strings.Repeat("\n", 9)
	require.Equal(t, want, truncateTerminalOutputLines(input))

	unchanged := strings.Repeat("line\n", 99)
	require.Equal(t, unchanged, truncateTerminalOutputLines(unchanged))
}

func TestModelRunCancelWaitsForUpstreamAndPersistsInterrupted(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(canceled)
	}, 16)
	lineNum := 1
	_, err := service.CreateRun(context.Background(), RunInput{
		ID: "cancel-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "wait",
	})
	require.NoError(t, err)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request did not start")
	}
	require.NoError(t, service.Cancel("cancel-run"))
	require.NoError(t, service.Cancel("cancel-run"))
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not canceled")
	}
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", "cancel-run").Error)
	require.Equal(t, "interrupted", block.Status)
	require.NotNil(t, block.FinishedAt)
}

func TestDeletedModelBlockIsNotRecreatedByLateRun(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(canceled)
	}, 16)
	lineNum := 2
	_, err := service.CreateRun(context.Background(), RunInput{
		ID: "deleted-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "wait",
	})
	require.NoError(t, err)
	<-started
	require.NoError(t, db.Delete(&model.BlockTermBlock{}, "id = ?", "deleted-run").Error)
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("deleting the block did not cancel the upstream request")
	}
	var count int64
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", "deleted-run").Count(&count).Error)
	require.Zero(t, count)
	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "deleted-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "wait",
	})
	require.ErrorIs(t, err, ErrRunConflict)
}

func TestCompletedModelJobIDCannotBeReusedAfterDirectRowDelete(t *testing.T) {
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, 16)
	lineNum := 3
	input := RunInput{ID: "deleted-completed-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "done"}
	block, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, subscription)
	require.NoError(t, db.Delete(&model.BlockTermBlock{}, "id = ?", block.ID).Error)

	_, err = service.CreateRun(context.Background(), input)
	require.ErrorIs(t, err, ErrRunConflict)
	var count int64
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Count(&count).Error)
	require.Zero(t, count)
}

func TestModelRunUpstreamErrorsBecomeDurableError(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{name: "non-2xx", handler: func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "provider unavailable: top-secret-token", http.StatusServiceUnavailable)
		}},
		{name: "malformed SSE", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {not-json}\n\n"))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, db, _ := newModelTestService(t, test.handler, 16)
			lineNum := 3
			block, err := service.CreateRun(context.Background(), RunInput{
				ID: "error-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "fail",
			})
			require.NoError(t, err)
			subscription, err := service.Subscribe(block.ID, 0)
			require.NoError(t, err)
			events := collectModelEvents(t, subscription)
			last := events[len(events)-1]
			require.True(t, last.Done)
			require.Equal(t, "error", last.Status)
			require.NotEmpty(t, last.Error)
			require.NotContains(t, last.Error, "top-secret-token")
			var persisted model.BlockTermBlock
			require.NoError(t, db.First(&persisted, "id = ?", block.ID).Error)
			require.Equal(t, "error", persisted.Status)
			state, stateErr := parseBlockState(persisted.StateJSON)
			require.NoError(t, stateErr)
			require.NotEmpty(t, state.Error)
			require.NotContains(t, state.Error, "top-secret-token")

			service.mu.Lock()
			delete(service.jobs, block.ID)
			service.mu.Unlock()
			persistedSubscription, subscribeErr := service.Subscribe(block.ID, 0)
			require.NoError(t, subscribeErr)
			persistedEvents := collectModelEvents(t, persistedSubscription)
			require.Equal(t, state.Error, persistedEvents[len(persistedEvents)-1].Error)
		})
	}
}

func TestModelEventRetentionFallsBackToSnapshot(t *testing.T) {
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, value := range []string{"a", "b", "c", "d"} {
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", value)
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, 2)
	lineNum := 4
	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "retained-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "letters",
	})
	require.NoError(t, err)
	initial, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, initial)
	reconnected, err := service.Subscribe(block.ID, 1)
	require.NoError(t, err)
	events := collectModelEvents(t, reconnected)
	require.Len(t, events, 1)
	require.Equal(t, "snapshot", events[0].Type)
	require.Equal(t, "abcd", events[0].Snapshot)
	require.True(t, events[0].Done)
}

func TestPersistedSubscriptionConvergesWithOldLiveSequence(t *testing.T) {
	service, db, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) {}, 16)
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "persisted-run", TerminalID: "terminal-1", LineNum: 9, Kind: "renderer", Renderer: "openai",
		Status: "success", Output: []byte("saved"), CreatedAt: now, UpdatedAt: now,
	}).Error)
	subscription, err := service.Subscribe("persisted-run", 42)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.Len(t, events, 1)
	require.Equal(t, int64(43), events[0].Seq)
	require.Equal(t, "saved", events[0].Snapshot)
	require.True(t, events[0].Done)
}

func TestParseSSEHandlesMultipleChunksAndDone(t *testing.T) {
	input := strings.Join([]string{
		": ping\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"one\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"two\"}}]}\n\n",
		"data: [DONE]\n\n",
	}, "")
	var output bytes.Buffer
	require.NoError(t, parseSSE(strings.NewReader(input), func(delta string) error {
		_, err := output.WriteString(delta)
		return err
	}))
	require.Equal(t, "onetwo", output.String())
}

func TestValidateBaseURLRejectsLocalTargets(t *testing.T) {
	require.Error(t, ValidateBaseURL("http://127.0.0.1:8080/v1", false))
	require.Error(t, ValidateBaseURL("http://[::1]:8080/v1", false))
	require.NoError(t, ValidateBaseURL("https://1.1.1.1/v1", false))
}

func TestAllowPrivateNetworkConfigUsesLocalUpstream(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+uuid.NewString()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.UserSetting{}, &model.TerminalSession{}, &model.BlockTermBlock{}))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "local-terminal", Status: model.StatusRunning}).Error)
	received := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received <- struct{}{}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()
	service := New(db)
	defer service.Close()
	baseURL := server.URL + "/v1"
	token := "local-token"
	allowPrivate := true
	_, err = service.SetConfig(ConfigPatch{BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate})
	require.NoError(t, err)
	lineNum := 0
	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "local-run", TerminalID: "local-terminal", LineNum: &lineNum, Prompt: "local",
	})
	require.NoError(t, err)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.Equal(t, "success", events[len(events)-1].Status)
	select {
	case <-received:
	case <-time.After(time.Second):
		t.Fatal("local model upstream did not receive request")
	}
}

func TestStableRunIDRejectsDifferentModelOverride(t *testing.T) {
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, 16)
	lineNum := 11
	first, err := service.CreateRun(context.Background(), RunInput{
		ID: "stable-model-run", TerminalID: "terminal-1", LineNum: &lineNum,
		CurrentCommand: "git status", Prompt: "same", Model: "model-a",
	})
	require.NoError(t, err)
	subscription, err := service.Subscribe(first.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, subscription)
	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "stable-model-run", TerminalID: "terminal-1", LineNum: &lineNum,
		CurrentCommand: "git status", Prompt: "same", Model: "model-b",
	})
	require.ErrorIs(t, err, ErrRunConflict)
	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "stable-model-run", TerminalID: "terminal-1", LineNum: &lineNum,
		CurrentCommand: "git diff", Prompt: "same", Model: "model-a",
	})
	require.ErrorIs(t, err, ErrRunConflict)
}

func TestCreateRunRejectsOversizedCurrentCommand(t *testing.T) {
	service, _, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) {}, 16)
	_, err := service.CreateRun(context.Background(), RunInput{
		ID: "oversized-current-command", TerminalID: "terminal-1",
		CurrentCommand: strings.Repeat("x", MaxCurrentCommandBytes+1), Prompt: "test",
	})
	require.ErrorContains(t, err, "current command is too large")
	require.ErrorIs(t, err, ErrRunInputTooLarge)
}

func TestCreateRunRejectsInvalidInputWithStableCategories(t *testing.T) {
	service, _, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) {}, 16)
	tests := []struct {
		name  string
		input RunInput
		want  error
		text  string
	}{
		{
			name:  "missing terminal",
			input: RunInput{ID: "missing-terminal", Prompt: "test"},
			want:  ErrInvalidRunInput,
			text:  "terminal_id is required",
		},
		{
			name:  "missing prompt",
			input: RunInput{ID: "missing-prompt", TerminalID: "terminal-1"},
			want:  ErrInvalidRunInput,
			text:  "prompt is required",
		},
		{
			name:  "negative line",
			input: RunInput{ID: "negative-line", TerminalID: "terminal-1", Prompt: "test", LineNum: func() *int { value := -1; return &value }()},
			want:  ErrInvalidRunInput,
			text:  "line_num must be a non-negative integer",
		},
		{
			name:  "oversized prompt",
			input: RunInput{ID: "oversized-prompt", TerminalID: "terminal-1", Prompt: strings.Repeat("x", MaxPromptBytes+1)},
			want:  ErrRunInputTooLarge,
			text:  "prompt is too large",
		},
		{
			name:  "oversized model name",
			input: RunInput{ID: "oversized-model", TerminalID: "terminal-1", Prompt: "test", Model: strings.Repeat("x", MaxModelBytes+1)},
			want:  ErrInvalidRunInput,
			text:  "model is too long",
		},
		{
			name:  "oversized id",
			input: RunInput{ID: strings.Repeat("x", MaxRunIDBytes+1), TerminalID: "terminal-1", Prompt: "test"},
			want:  ErrInvalidRunInput,
			text:  "id is invalid",
		},
		{
			name:  "oversized terminal id",
			input: RunInput{ID: "oversized-terminal", TerminalID: strings.Repeat("x", MaxTerminalIDBytes+1), Prompt: "test"},
			want:  ErrInvalidRunInput,
			text:  "terminal_id is invalid",
		},
		{
			name:  "oversized command",
			input: RunInput{ID: "oversized-command", TerminalID: "terminal-1", Command: strings.Repeat("x", MaxRunCommandBytes+1), Prompt: "test"},
			want:  ErrRunInputTooLarge,
			text:  "command is too large",
		},
		{
			name:  "oversized cwd",
			input: RunInput{ID: "oversized-cwd", TerminalID: "terminal-1", Cwd: strings.Repeat("x", MaxRunCwdBytes+1), Prompt: "test"},
			want:  ErrRunInputTooLarge,
			text:  "cwd is too large",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.CreateRun(context.Background(), test.input)
			require.Error(t, err)
			require.ErrorIs(t, err, test.want)
			require.ErrorContains(t, err, test.text)
		})
	}
}

func TestStableRunIDRetryDoesNotStartSecondUpstreamRequest(t *testing.T) {
	var mu sync.Mutex
	requestCount := 0
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		requestCount++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, 16)
	lineNum := 13
	input := RunInput{ID: "stable-retry-run", TerminalID: "terminal-1", LineNum: &lineNum, Command: "/chat same", Prompt: "same"}
	first, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	subscription, err := service.Subscribe(first.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, subscription)
	second, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID)
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	require.Equal(t, 1, requestCount)
	mu.Unlock()
}

func TestStableRunIDRetryIgnoresChangedDefaultModelAndMissingToken(t *testing.T) {
	var mu sync.Mutex
	requestCount := 0
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		requestCount++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"saved\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, 16)
	lineNum := 14
	input := RunInput{ID: "stable-default-run", TerminalID: "terminal-1", LineNum: &lineNum, Command: "/chat same", Prompt: "same"}
	first, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	subscription, err := service.Subscribe(first.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, subscription)

	changedModel := "changed-default"
	emptyToken := ""
	_, err = service.SetConfig(ConfigPatch{Model: &changedModel, APIToken: &emptyToken})
	require.NoError(t, err)
	second, err := service.CreateRun(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID)
	require.JSONEq(t, `{"prompt:source":"model","model":"test-model"}`, second.StateJSON)
	mu.Lock()
	require.Equal(t, 1, requestCount)
	mu.Unlock()
}

func TestClosedTerminalCancelsModelRun(t *testing.T) {
	started := make(chan struct{})
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}, 16)
	lineNum := 12
	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "closed-terminal-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "wait",
	})
	require.NoError(t, err)
	<-started
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").Update("status", model.StatusClosed).Error)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.Equal(t, "interrupted", events[len(events)-1].Status)
}

func TestCancelContextReturnsWhenCallerStopsWaiting(t *testing.T) {
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, 16)
	lineNum := 10
	_, err := service.CreateRun(context.Background(), RunInput{
		ID: "context-cancel-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "wait",
	})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = service.CancelContext(ctx, "context-cancel-run")
	require.True(t, err == nil || errors.Is(err, context.Canceled))
}

func TestModelRunTimeoutIsDurable(t *testing.T) {
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, 16)
	timeout := 1
	_, err := service.SetConfig(ConfigPatch{TimeoutSecond: &timeout})
	require.NoError(t, err)
	lineNum := 15
	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "timeout-run", TerminalID: "terminal-1", LineNum: &lineNum, Prompt: "wait",
	})
	require.NoError(t, err)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	last := events[len(events)-1]
	require.Equal(t, "error", last.Status)
	require.Equal(t, "model request timed out", last.Error)
	var persisted model.BlockTermBlock
	require.NoError(t, db.First(&persisted, "id = ?", block.ID).Error)
	state, err := parseBlockState(persisted.StateJSON)
	require.NoError(t, err)
	require.Equal(t, last.Error, state.Error)
}

func TestCompletionPayloadWithoutChoicesIsRejected(t *testing.T) {
	require.ErrorContains(t, parseCompletionJSON([]byte(`{"id":"empty"}`), func(string) error { return nil }), "no completion choices")
	require.ErrorContains(t, parseCompletionJSON([]byte(`{"choices":[]}`), func(string) error { return nil }), "no completion choices")
	require.ErrorContains(t, parseSSE(strings.NewReader("data: [DONE]\n\n"), func(string) error { return nil }), "no completion choices")
}

func TestCompletionPayloadUsesOnlyFirstChoice(t *testing.T) {
	var output strings.Builder
	require.NoError(t, parseCompletionJSON([]byte(`{"choices":[{"delta":{"content":"first"}},{"delta":{"content":"second"}}]}`), func(delta string) error {
		output.WriteString(delta)
		return nil
	}))
	require.Equal(t, "first", output.String())
}

func TestParseSSERequiresDoneAndPreservesWhitespace(t *testing.T) {
	var output strings.Builder
	err := parseSSE(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\" \\n\"}}]}\n\n"), func(delta string) error {
		output.WriteString(delta)
		return nil
	})
	require.ErrorContains(t, err, "before [DONE]")
	require.Equal(t, " \n", output.String())

	output.Reset()
	require.NoError(t, parseSSE(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\" \\n\"}}]}\n\ndata: [DONE]\n\n"), func(delta string) error {
		output.WriteString(delta)
		return nil
	}))
	require.Equal(t, " \n", output.String())
}

func TestCreateRunRejectsStoppedAndReadOnlyTerminals(t *testing.T) {
	var requests int
	service, db, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) { requests++ }, 16)

	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").Updates(map[string]any{
		"status": model.StatusExited, "readonly": false,
	}).Error)
	_, err := service.CreateRun(context.Background(), RunInput{ID: "stopped-run", TerminalID: "terminal-1", Prompt: "test"})
	require.ErrorIs(t, err, ErrTerminalNotRunning)

	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").Updates(map[string]any{
		"status": model.StatusRunning, "readonly": true,
	}).Error)
	_, err = service.CreateRun(context.Background(), RunInput{ID: "readonly-run", TerminalID: "terminal-1", Prompt: "test"})
	require.ErrorIs(t, err, ErrTerminalNotRunning)
	require.Zero(t, requests)
}

func TestCreateRunRequiresDurableTerminalStateWhenLiveAdapterReportsRunning(t *testing.T) {
	tests := []struct {
		name     string
		status   string
		readonly bool
	}{
		{name: "exited", status: model.StatusExited},
		{name: "readonly", status: model.StatusRunning, readonly: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requests int
			service, db, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) { requests++ }, 16)
			service.terminalMutation = func(_ string, mutation func(bool) error) error {
				return mutation(true)
			}
			// Match production wiring, where the fast running check reads the
			// manager's live projection rather than the durable terminal row.
			service.terminalRunning = func(string) bool { return true }
			require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").Updates(map[string]any{
				"status": test.status, "readonly": test.readonly,
			}).Error)

			_, err := service.CreateRun(context.Background(), RunInput{
				ID: "durable-admission-" + test.name, TerminalID: "terminal-1", Prompt: "test",
			})
			require.ErrorIs(t, err, ErrTerminalNotRunning)
			require.Zero(t, requests)
		})
	}
}

func TestPersistFinalDowngradesWhenTerminalIsNotDurablyRunning(t *testing.T) {
	tests := []struct {
		name     string
		live     bool
		status   string
		readonly bool
	}{
		{name: "active missing", live: false, status: model.StatusRunning},
		{name: "durable exited", live: true, status: model.StatusExited},
		{name: "durable readonly", live: true, status: model.StatusRunning, readonly: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, db, _ := newModelTestService(t, func(http.ResponseWriter, *http.Request) {}, 16)
			service.terminalMutation = func(_ string, mutation func(bool) error) error {
				return mutation(test.live)
			}
			service.terminalRunning = func(string) bool { return test.live }
			require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").Updates(map[string]any{
				"status": test.status, "readonly": test.readonly,
			}).Error)

			now := time.Now().Unix()
			block := model.BlockTermBlock{
				ID: "durable-final-" + strings.ReplaceAll(test.name, " ", "-"), TerminalID: "terminal-1", LineNum: 20,
				Kind: "renderer", Status: "streaming", Renderer: "openai",
				StateJSON: `{"prompt:source":"model","model":"test-model"}`, CreatedAt: now, UpdatedAt: now,
			}
			require.NoError(t, db.Create(&block).Error)
			current := &job{ctx: context.Background(), owner: service}

			status, message, err := service.persistFinal(current, block, "partial", "success", "")
			require.NoError(t, err)
			require.Equal(t, "interrupted", status)
			require.Empty(t, message)

			var durable model.BlockTermBlock
			require.NoError(t, db.First(&durable, "id = ?", block.ID).Error)
			require.Equal(t, "interrupted", durable.Status)
			require.Equal(t, "partial", string(durable.Output))
			require.Nil(t, durable.ExitCode)
		})
	}
}

func TestCancelCannotObserveCreateBeforeJobRegistration(t *testing.T) {
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, 16)
	createdRow := make(chan struct{})
	releaseCreate := make(chan struct{})
	var once sync.Once
	callbackName := "test:model_create_registration_gate"
	require.NoError(t, db.Callback().Create().After("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == "blockterm_blocks" {
			once.Do(func() {
				close(createdRow)
				<-releaseCreate
			})
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	createDone := make(chan error, 1)
	go func() {
		_, err := service.CreateRun(context.Background(), RunInput{ID: "atomic-create-run", TerminalID: "terminal-1", Prompt: "wait"})
		createDone <- err
	}()
	<-createdRow
	cancelDone := make(chan error, 1)
	go func() { cancelDone <- service.Cancel("atomic-create-run") }()
	select {
	case err := <-cancelDone:
		t.Fatalf("cancel passed admission gate before registration: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseCreate)
	require.NoError(t, <-createDone)
	require.NoError(t, <-cancelDone)
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", "atomic-create-run").Error)
	require.Equal(t, "interrupted", block.Status)
}

func TestDeltaPersistenceAndEventSequenceAreAtomic(t *testing.T) {
	sendDelta := make(chan struct{})
	sendDone := make(chan struct{})
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		<-sendDelta
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"))
		flusher.Flush()
		<-sendDone
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		flusher.Flush()
	}, 16)
	persisted := make(chan struct{})
	releasePersist := make(chan struct{})
	var once sync.Once
	callbackName := "test:model_delta_atomicity"
	require.NoError(t, db.Callback().Update().After("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if tx.Statement.Table == "blockterm_blocks" && ok && values["status"] == nil && values["output"] != nil {
			once.Do(func() {
				close(persisted)
				<-releasePersist
			})
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	block, err := service.CreateRun(context.Background(), RunInput{ID: "atomic-delta-run", TerminalID: "terminal-1", Prompt: "test"})
	require.NoError(t, err)
	close(sendDelta)
	<-persisted
	subscribeDone := make(chan *Subscription, 1)
	subscribeErr := make(chan error, 1)
	go func() {
		subscription, err := service.Subscribe(block.ID, 1)
		if err != nil {
			subscribeErr <- err
			return
		}
		subscribeDone <- subscription
	}()
	select {
	case <-subscribeDone:
		t.Fatal("subscribe observed persisted output before its event sequence")
	case err := <-subscribeErr:
		t.Fatalf("subscribe failed before atomic commit: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(releasePersist)
	var subscription *Subscription
	select {
	case subscription = <-subscribeDone:
	case err := <-subscribeErr:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("subscribe did not resume after atomic commit")
	}
	require.Len(t, subscription.Events, 1)
	require.Equal(t, int64(2), subscription.Events[0].Seq)
	require.Equal(t, "x", subscription.Events[0].Delta)
	subscription.Close()
	var durable model.BlockTermBlock
	require.NoError(t, db.First(&durable, "id = ?", block.ID).Error)
	require.Equal(t, "x", string(durable.Output))
	close(sendDone)
	final, err := service.Subscribe(block.ID, 2)
	require.NoError(t, err)
	_ = collectModelEvents(t, final)
}

func TestFinalPersistenceFallsBackWithoutLeavingStreaming(t *testing.T) {
	service, db, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n"))
	}, 16)
	callbackName := "test:model_final_update_failure"
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if tx.Statement.Table == "blockterm_blocks" && ok && values["status"] != nil {
			tx.AddError(errors.New("forced final update failure"))
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	block, err := service.CreateRun(context.Background(), RunInput{ID: "final-fallback-run", TerminalID: "terminal-1", Prompt: "test"})
	require.NoError(t, err)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.Equal(t, "success", events[len(events)-1].Status)
	var durable model.BlockTermBlock
	require.NoError(t, db.First(&durable, "id = ?", block.ID).Error)
	require.Equal(t, "success", durable.Status)
	require.NotNil(t, durable.FinishedAt)
}

func TestAheadEventCursorIsRejectedWithoutMutatingSequence(t *testing.T) {
	require.Equal(t, int64(9007199254740990), MaxEventCursor)
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, 16)
	block, err := service.CreateRun(context.Background(), RunInput{ID: "cursor-run", TerminalID: "terminal-1", Prompt: "wait"})
	require.NoError(t, err)
	service.mu.Lock()
	current := service.jobs[block.ID]
	service.mu.Unlock()
	current.mu.Lock()
	before := current.nextSeq
	current.mu.Unlock()

	_, err = service.Subscribe(block.ID, before+1)
	require.ErrorIs(t, err, ErrInvalidEventCursor)
	_, err = service.Subscribe(block.ID, MaxEventCursor+1)
	require.ErrorIs(t, err, ErrInvalidEventCursor)
	current.mu.Lock()
	require.Equal(t, before, current.nextSeq)
	current.mu.Unlock()
	require.NoError(t, service.Cancel(block.ID))
}

func TestCompletedRunAheadCursorReturnsPrivateSnapshotWithoutMutatingSequence(t *testing.T) {
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"saved\"}}]}\n\ndata: [DONE]\n\n"))
	}, 16)
	block, err := service.CreateRun(context.Background(), RunInput{ID: "completed-cursor-run", TerminalID: "terminal-1", Prompt: "test"})
	require.NoError(t, err)
	initial, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	_ = collectModelEvents(t, initial)
	service.mu.Lock()
	current := service.jobs[block.ID]
	service.mu.Unlock()
	current.mu.Lock()
	before := current.nextSeq
	current.mu.Unlock()

	after := before + 100
	subscription, err := service.Subscribe(block.ID, after)
	require.NoError(t, err)
	events := collectModelEvents(t, subscription)
	require.Len(t, events, 1)
	require.Equal(t, after+1, events[0].Seq)
	require.Equal(t, "saved", events[0].Snapshot)
	require.True(t, events[0].Done)
	current.mu.Lock()
	require.Equal(t, before, current.nextSeq)
	current.mu.Unlock()
}

func TestSubscriptionCloseIsConcurrentSafe(t *testing.T) {
	service, _, _ := newModelTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, 16)
	block, err := service.CreateRun(context.Background(), RunInput{ID: "close-run", TerminalID: "terminal-1", Prompt: "wait"})
	require.NoError(t, err)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			subscription.Close()
		}()
	}
	wg.Wait()
	require.NoError(t, service.Cancel(block.ID))
}
