package terminal

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermmodel"
)

type modelCloseInterleaveRuntime struct {
	readStarted  chan struct{}
	readRelease  chan struct{}
	closeStarted chan struct{}
	closeRelease chan struct{}
	readOnce     sync.Once
	closeOnce    sync.Once
	releaseOnce  sync.Once
}

func newModelCloseInterleaveRuntime() *modelCloseInterleaveRuntime {
	return &modelCloseInterleaveRuntime{
		readStarted: make(chan struct{}), readRelease: make(chan struct{}),
		closeStarted: make(chan struct{}), closeRelease: make(chan struct{}),
	}
}

func (r *modelCloseInterleaveRuntime) Type() string { return "test" }

func (r *modelCloseInterleaveRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}

func (r *modelCloseInterleaveRuntime) Read([]byte) (int, error) {
	r.readOnce.Do(func() { close(r.readStarted) })
	<-r.readRelease
	return 0, io.EOF
}

func (r *modelCloseInterleaveRuntime) Write(p []byte) (int, error) { return len(p), nil }

func (r *modelCloseInterleaveRuntime) Resize(int, int) error { return nil }

func (r *modelCloseInterleaveRuntime) Close() error {
	r.closeOnce.Do(func() {
		close(r.closeStarted)
		close(r.readRelease)
	})
	<-r.closeRelease
	return nil
}

func (r *modelCloseInterleaveRuntime) ExitCode() int { return 0 }

func (r *modelCloseInterleaveRuntime) Wait(context.Context) error { return nil }

func (r *modelCloseInterleaveRuntime) releaseClose() {
	r.releaseOnce.Do(func() { close(r.closeRelease) })
}

func TestModelRunAdmissionUsesLiveTerminalStateDuringClose(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	terminalID := "model-close-interleave-" + uuid.NewString()
	require.NoError(t, db.Create(&model.TerminalSession{ID: terminalID, Status: model.StatusRunning}).Error)
	runtime := newModelCloseInterleaveRuntime()
	t.Cleanup(runtime.releaseClose)
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-runtime.readStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal reader did not start")
	}

	service := blocktermmodel.NewWithOptions(db, blocktermmodel.Options{
		MutationGate:     manager.BlockTermMutationGate(),
		TerminalMutation: manager.WithRunningTerminal,
		TerminalRunning: func(id string) bool {
			info, ok := manager.Get(id)
			return ok && info.Status == model.StatusRunning && !info.Readonly
		},
	})
	t.Cleanup(service.Close)

	closeDone := make(chan error, 1)
	go func() { closeDone <- manager.Close(terminalID) }()
	select {
	case <-runtime.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal close did not reach runtime")
	}

	var durableTerminal model.TerminalSession
	require.NoError(t, db.First(&durableTerminal, "id = ?", terminalID).Error)
	require.Equal(t, model.StatusRunning, durableTerminal.Status)
	blockID := "closing-terminal-model-run-" + uuid.NewString()
	_, err := service.CreateRun(context.Background(), blocktermmodel.RunInput{
		ID: blockID, TerminalID: terminalID, Prompt: "test",
	})
	require.ErrorIs(t, err, blocktermmodel.ErrTerminalNotRunning)
	var count int64
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", blockID).Count(&count).Error)
	require.Zero(t, count)

	runtime.releaseClose()
	select {
	case err := <-closeDone:
		require.True(t, err == nil || errors.Is(err, context.Canceled))
	case <-time.After(2 * time.Second):
		t.Fatal("terminal close did not finish")
	}
}

func TestModelRunFinalizationObservesCloseBeforeDurableTerminalUpdate(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.UserSetting{}))
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	terminalID := "model-finalize-close-interleave-" + uuid.NewString()
	require.NoError(t, db.Create(&model.TerminalSession{ID: terminalID, Status: model.StatusRunning}).Error)

	runtime := newModelCloseInterleaveRuntime()
	t.Cleanup(runtime.releaseClose)
	at := newTestActiveTerminalForDrain(terminalID, runtime, manager)
	go manager.ptyReadLoop(at)
	select {
	case <-runtime.readStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal reader did not start")
	}

	providerRelease := make(chan struct{})
	providerDone := make(chan struct{})
	var providerReleaseOnce sync.Once
	releaseProvider := func() { providerReleaseOnce.Do(func() { close(providerRelease) }) }
	t.Cleanup(releaseProvider)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"))
		flusher.Flush()
		<-providerRelease
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		flusher.Flush()
		close(providerDone)
	}))
	t.Cleanup(server.Close)

	service := blocktermmodel.NewWithOptions(db, blocktermmodel.Options{
		HTTPClient:          server.Client(),
		AllowPrivateNetwork: true,
		MutationGate:        manager.BlockTermMutationGate(),
		TerminalMutation:    manager.WithRunningTerminal,
	})
	t.Cleanup(service.Close)
	t.Cleanup(func() {
		releaseProvider()
		runtime.releaseClose()
	})
	baseURL := server.URL + "/v1"
	modelName := "test-model"
	token := "test-token"
	timeout := 5
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, Model: &modelName, APIToken: &token, TimeoutSecond: &timeout,
	})
	require.NoError(t, err)

	blockID := "closing-terminal-model-finalize-" + uuid.NewString()
	block, err := service.CreateRun(context.Background(), blocktermmodel.RunInput{
		ID: blockID, TerminalID: terminalID, Prompt: "test",
	})
	require.NoError(t, err)
	subscription, err := service.Subscribe(block.ID, 0)
	require.NoError(t, err)
	defer subscription.Close()

	sawDelta := false
	for _, event := range subscription.Events {
		if event.Delta == "partial" {
			sawDelta = true
		}
	}
	for !sawDelta {
		select {
		case event, ok := <-subscription.C:
			if !ok {
				t.Fatal("model event stream closed before delta")
			}
			sawDelta = event.Delta == "partial"
		case <-time.After(2 * time.Second):
			t.Fatal("model delta did not arrive")
		}
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- manager.Close(terminalID) }()
	select {
	case <-runtime.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal close did not reach runtime")
	}

	var durableTerminal model.TerminalSession
	require.NoError(t, db.First(&durableTerminal, "id = ?", terminalID).Error)
	require.Equal(t, model.StatusRunning, durableTerminal.Status)
	info, ok := manager.Get(terminalID)
	require.True(t, ok)
	require.Equal(t, model.StatusClosed, info.Status)

	releaseProvider()
	select {
	case <-providerDone:
	case <-time.After(time.Second):
		t.Fatal("model provider did not finish")
	}

	var finalEvent blocktermmodel.Event
	for !finalEvent.Done {
		select {
		case event, ok := <-subscription.C:
			if !ok {
				t.Fatal("model event stream closed before final event")
			}
			if event.Done {
				finalEvent = event
			}
		case <-time.After(2 * time.Second):
			t.Fatal("model run did not finalize while terminal close was blocked")
		}
	}
	require.Equal(t, "interrupted", finalEvent.Status)
	require.Empty(t, finalEvent.Error)
	require.Equal(t, "partial", finalEvent.Snapshot)

	var durableBlock model.BlockTermBlock
	require.NoError(t, db.First(&durableBlock, "id = ?", block.ID).Error)
	require.Equal(t, "interrupted", durableBlock.Status)
	require.Nil(t, durableBlock.ExitCode)
	require.Equal(t, "partial", string(durableBlock.Output))

	runtime.releaseClose()
	select {
	case err := <-closeDone:
		require.True(t, err == nil || errors.Is(err, context.Canceled))
	case <-time.After(2 * time.Second):
		t.Fatal("terminal close did not finish")
	}
}
