package handler

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestBlockTermReadSerializesWithPatch(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-block-atomicity")
	if err := env.db.Create(&model.BlockTermBlock{
		ID:         "block-block-atomicity",
		TerminalID: "term-block-atomicity",
		LineNum:    0,
		Status:     "running",
		Output:     []byte("before"),
	}).Error; err != nil {
		t.Fatalf("create block: %v", err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	const callbackName = "test:blockterm_patch_atomicity_gate"
	if err := env.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.BlockTermBlock{}).TableName() {
			return
		}
		enterOnce.Do(func() { close(entered) })
		<-release
	}); err != nil {
		t.Fatalf("register update callback: %v", err)
	}
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		if err := env.db.Callback().Update().Remove(callbackName); err != nil {
			t.Errorf("remove update callback: %v", err)
		}
	})

	patchDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		patchDone <- doBlockTermJSON(t, env.router, http.MethodPatch,
			"/api/blockterm/blocks/block-block-atomicity?include_output=0",
			map[string]any{"status": "success"})
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("patch did not reach database update")
	}

	readDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		readDone <- doBlockTermJSON(t, env.router, http.MethodGet,
			"/api/blockterm/blocks/block-block-atomicity/output", nil)
	}()
	select {
	case <-readDone:
		t.Fatal("block read bypassed the in-flight patch")
	case <-time.After(40 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(release) })
	patchResponse := <-patchDone
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("patch status = %d", patchResponse.Code)
	}
	readResponse := <-readDone
	if readResponse.Code != http.StatusOK {
		t.Fatalf("read status = %d", readResponse.Code)
	}
}

func TestBlockTermPatchAndDeleteUseManagerMutationGate(t *testing.T) {
	for _, test := range []struct {
		name   string
		method string
		body   any
		want   int
	}{
		{name: "patch", method: http.MethodPatch, body: map[string]any{"status": "success"}, want: http.StatusOK},
		{name: "delete", method: http.MethodDelete, want: http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			terminalID := "term-manager-gate-" + test.name
			blockID := "block-manager-gate-" + test.name
			seedBlockTermTerminal(t, env.db, terminalID)
			if err := env.db.Create(&model.BlockTermBlock{
				ID: blockID, TerminalID: terminalID, LineNum: 0, Kind: "command", Status: "running",
			}).Error; err != nil {
				t.Fatalf("create block: %v", err)
			}

			gate := env.manager.BlockTermMutationGate()
			gate.RLock()
			responseDone := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				responseDone <- doBlockTermJSON(
					t,
					env.router,
					test.method,
					"/api/blockterm/blocks/"+blockID+"?include_output=0",
					test.body,
				)
			}()
			select {
			case response := <-responseDone:
				gate.RUnlock()
				t.Fatalf("%s bypassed the manager mutation gate: %s", test.name, response.Body.String())
			case <-time.After(25 * time.Millisecond):
			}
			gate.RUnlock()

			select {
			case response := <-responseDone:
				if response.Code != test.want {
					t.Fatalf("%s status = %d, body = %s", test.name, response.Code, response.Body.String())
				}
			case <-time.After(time.Second):
				t.Fatalf("%s did not finish after releasing the manager mutation gate", test.name)
			}
		})
	}
}
