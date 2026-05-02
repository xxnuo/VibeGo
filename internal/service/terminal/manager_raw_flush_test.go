package terminal

import (
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

func TestFlushTerminalOutputSerializesWithDeliveryGate(t *testing.T) {
	db := setupTestDB(t)
	if err := db.AutoMigrate(&model.BlockTermOutputSegment{}); err != nil {
		t.Fatalf("migrate raw output segments: %v", err)
	}
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	const terminalID = "raw-flush-delivery-gate"
	if err := db.Create(&model.TerminalSession{ID: terminalID, Status: model.StatusRunning}).Error; err != nil {
		t.Fatalf("create terminal session: %v", err)
	}
	recorder := newBlockTermOutputRecorder(db, terminalID)
	if recorder == nil {
		t.Fatal("raw output recorder was not created")
	}
	at := &activeTerminal{
		ID:             terminalID,
		Session:        &model.TerminalSession{ID: terminalID, Status: model.StatusRunning},
		readDone:       make(chan struct{}),
		outputRecorder: recorder,
	}
	at.status.Store(model.StatusRunning)
	manager.terminals.Store(terminalID, at)
	t.Cleanup(func() {
		recorder.CloseInput()
		if err := recorder.Wait(); err != nil {
			t.Errorf("recorder cleanup: %v", err)
		}
		manager.terminals.Delete(terminalID)
	})

	at.deliveryMu.Lock()
	released := false
	defer func() {
		if !released {
			at.deliveryMu.Unlock()
		}
	}()

	flushed := make(chan error, 1)
	go func() { flushed <- manager.FlushTerminalOutput(terminalID) }()
	select {
	case err := <-flushed:
		t.Fatalf("raw flush bypassed delivery gate: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	at.deliveryMu.Unlock()
	released = true
	select {
	case err := <-flushed:
		if err != nil {
			t.Fatalf("raw flush failed after delivery gate release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("raw flush did not finish after delivery gate release")
	}
}
