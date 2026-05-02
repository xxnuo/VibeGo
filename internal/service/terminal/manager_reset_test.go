package terminal

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"

	"github.com/xxnuo/vibego/internal/model"
)

func TestManagerResetLocalPreservesTerminalDataAndCursor(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "reset-local", Cwd: os.TempDir(), Cols: 90, Rows: 31})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	defer manager.Close(info.ID)

	at, ok := manager.getActive(info.ID)
	if !ok {
		t.Fatal("created terminal is not active")
	}
	oldRuntime := at.Runtime
	at.historyMu.Lock()
	at.historyBuffer.Restore([]byte("preserved-before-reset"), 100)
	at.historyMu.Unlock()

	const viewJSON = `{"sidebar":{"open":false,"width":"50%","block_id":null}}`
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", info.ID).
		Updates(map[string]any{"blockterm_view_json": viewJSON, "last_command": "before-reset"}).Error; err != nil {
		t.Fatalf("seed terminal metadata: %v", err)
	}
	blockID := "reset-preserved-" + info.ID
	if err := db.Create(&model.BlockTermBlock{
		ID:         blockID,
		TerminalID: info.ID,
		LineNum:    7,
		Kind:       "command",
		Command:    "printf preserved",
		Status:     "success",
	}).Error; err != nil {
		t.Fatalf("seed block: %v", err)
	}

	resetInfo, err := manager.Reset(info.ID)
	if err != nil {
		t.Fatalf("reset terminal: %v", err)
	}
	if resetInfo.ID != info.ID || resetInfo.Status != model.StatusRunning || resetInfo.Readonly {
		t.Fatalf("unexpected reset info: %+v", resetInfo)
	}

	resetActive, ok := manager.getActive(info.ID)
	if !ok {
		t.Fatal("reset terminal is not active")
	}
	if resetActive.Runtime == oldRuntime {
		t.Fatal("reset reused the old runtime")
	}
	resetActive.historyMu.RLock()
	history := resetActive.historyBuffer.Read()
	_, cursor := resetActive.historyBuffer.CursorRange()
	resetActive.historyMu.RUnlock()
	if cursor < 100 {
		t.Fatalf("reset cursor = %d, want at least 100", cursor)
	}
	if !bytes.Contains(history, []byte("preserved-before-reset")) {
		t.Fatalf("reset history lost prior output: %q", history)
	}

	var stored model.TerminalSession
	if err := db.First(&stored, "id = ?", info.ID).Error; err != nil {
		t.Fatalf("load reset terminal: %v", err)
	}
	if stored.BlockTermViewJSON != viewJSON || stored.LastCommand != "" || stored.Status != model.StatusRunning {
		t.Fatalf("unexpected stored reset terminal: %+v", stored)
	}
	var block model.BlockTermBlock
	if err := db.First(&block, "id = ?", blockID).Error; err != nil {
		t.Fatalf("reset removed durable block: %v", err)
	}
}

func TestManagerResetRejectsActiveBlockWithoutClosingTerminal(t *testing.T) {
	db := setupTestDB(t)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	info, err := manager.Create(CreateOptions{Name: "reset-busy", Cwd: os.TempDir()})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	defer manager.Close(info.ID)
	at, _ := manager.getActive(info.ID)
	oldRuntime := at.Runtime
	if err := db.Create(&model.BlockTermBlock{
		ID:         "reset-running-" + info.ID,
		TerminalID: info.ID,
		LineNum:    1,
		Kind:       "command",
		Command:    "sleep 30",
		Status:     "running",
	}).Error; err != nil {
		t.Fatalf("seed running block: %v", err)
	}

	_, err = manager.Reset(info.ID)
	if !errors.Is(err, ErrTerminalResetBusy) {
		t.Fatalf("Reset() error = %v, want ErrTerminalResetBusy", err)
	}
	current, ok := manager.getActive(info.ID)
	if !ok || current.Runtime != oldRuntime || current.status.Load().(string) != model.StatusRunning {
		t.Fatalf("busy reset changed active terminal: %+v", current)
	}
}

func TestManagerResetRejectsRemoteRuntime(t *testing.T) {
	db := setupTestDB(t)
	runtime := newResetRemoteRuntime()
	manager := NewManager(db, &ManagerConfig{
		Shell: "/bin/sh",
		RuntimeFactory: runtimeFactoryFunc(func(_ RuntimeCreateRequest) (TerminalRuntime, error) {
			return runtime, nil
		}),
	})

	info, err := manager.Create(CreateOptions{RuntimeType: RuntimeTypeSSH, SSHProfileID: "profile-1"})
	if err != nil {
		t.Fatalf("create remote terminal: %v", err)
	}
	defer manager.Close(info.ID)

	_, err = manager.Reset(info.ID)
	if !errors.Is(err, ErrTerminalResetUnsupported) {
		t.Fatalf("Reset() error = %v, want ErrTerminalResetUnsupported", err)
	}
}

type runtimeFactoryFunc func(RuntimeCreateRequest) (TerminalRuntime, error)

func (fn runtimeFactoryFunc) CreateRuntime(_ context.Context, request RuntimeCreateRequest) (TerminalRuntime, error) {
	return fn(request)
}

type resetRemoteRuntime struct {
	done chan struct{}
	once sync.Once
}

func newResetRemoteRuntime() *resetRemoteRuntime {
	return &resetRemoteRuntime{done: make(chan struct{})}
}

func (*resetRemoteRuntime) Type() string { return RuntimeTypeSSH }
func (*resetRemoteRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}
func (runtime *resetRemoteRuntime) Read([]byte) (int, error) {
	<-runtime.done
	return 0, io.EOF
}
func (*resetRemoteRuntime) Write(data []byte) (int, error) { return len(data), nil }
func (*resetRemoteRuntime) Resize(int, int) error          { return nil }
func (runtime *resetRemoteRuntime) Close() error {
	runtime.once.Do(func() { close(runtime.done) })
	return nil
}
func (*resetRemoteRuntime) ExitCode() int { return 0 }
func (runtime *resetRemoteRuntime) Wait(context.Context) error {
	<-runtime.done
	return nil
}
