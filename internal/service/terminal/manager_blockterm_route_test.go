package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"

	"github.com/xxnuo/vibego/internal/model"
)

type blockRouteSignalRuntime struct {
	blockTermInputRuntime
	signalMu sync.Mutex
	signals  []string
}

func (r *blockRouteSignalRuntime) Signal(signal string) error {
	r.signalMu.Lock()
	r.signals = append(r.signals, signal)
	r.signalMu.Unlock()
	return nil
}

func (r *blockRouteSignalRuntime) signaled() []string {
	r.signalMu.Lock()
	defer r.signalMu.Unlock()
	return append([]string(nil), r.signals...)
}

func newManagerBlockRouteFixture(t *testing.T, terminalID, blockID, token string, blockRuntime TerminalRuntime) (*Manager, *activeTerminal, *blockTermInputRuntime) {
	t.Helper()
	manager := &Manager{
		blockTermRoutes: NewBlockTermRuntimeRegistry(),
		blockRuntimes:   make(map[BlockTermRuntimeRouteKey]*activeBlockRuntime),
	}
	parentRuntime := &blockTermInputRuntime{}
	at := newBlockTermInputActive(terminalID, parentRuntime, nil)
	at.Session.Cols = 80
	at.Session.Rows = 24

	handle, err := manager.blockTermRoutes.RegisterBlock(terminalID, blockID, token, blockRuntime)
	if err != nil {
		t.Fatalf("register block route: %v", err)
	}
	readDone := make(chan struct{})
	close(readDone)
	br := &activeBlockRuntime{
		manager: manager,
		key:     BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID},
		runtime: blockRuntime,
		info: BlockRuntimeInfo{
			TerminalID:  terminalID,
			BlockID:     blockID,
			BlockToken:  token,
			RuntimeType: RuntimeTypeLocal,
			Cols:        80,
			Rows:        24,
			Status:      model.StatusRunning,
		},
		buffer:      newHistoryBuffer(1024),
		bufferSize:  1024,
		encoder:     base64.StdEncoding,
		readDone:    readDone,
		done:        make(chan struct{}),
		closeDone:   make(chan struct{}),
		routeHandle: handle,
	}
	br.status.Store(model.StatusRunning)
	manager.blockRuntimes[br.key] = br
	t.Cleanup(func() {
		if err := manager.CloseBlockRuntime(terminalID, blockID, token); err != nil && !errors.Is(err, ErrBlockRuntimeNotFound) {
			t.Errorf("close block runtime: %v", err)
		}
	})
	return manager, at, parentRuntime
}

func runManagerBlockRouteMessage(t *testing.T, manager *Manager, at *activeTerminal, msg WSMessage) *mockMaster {
	t.Helper()
	raw, err := jsonMarshalWSMessage(msg)
	if err != nil {
		t.Fatalf("marshal websocket message: %v", err)
	}
	master := &mockMaster{readData: raw}
	_ = manager.readClientLoop(at, &terminalConnection{Master: master, Ctx: context.Background()})
	return master
}

// jsonMarshalWSMessage keeps this test file independent of any HTTP handler
// helper while using exactly the same wire encoding as a real client.
func jsonMarshalWSMessage(msg WSMessage) ([]byte, error) {
	return json.Marshal(msg)
}

func TestManagerExplicitBlockInputUsesIndependentRuntime(t *testing.T) {
	const terminalID = "route-input-terminal"
	const blockID = "route-input-block"
	blockRuntime := &blockTermInputRuntime{}
	manager, at, parentRuntime := newManagerBlockRouteFixture(t, terminalID, blockID, blockTermTestToken, blockRuntime)

	master := runManagerBlockRouteMessage(t, manager, at, WSMessage{
		Type:       MsgTypeInput,
		Data:       base64.StdEncoding.EncodeToString([]byte("block input")),
		RouteMode:  RouteModeBlock,
		BlockID:    blockID,
		BlockToken: blockTermTestToken,
	})
	if got := blockRuntime.written(); len(got) != 1 || string(got[0]) != "block input" {
		t.Fatalf("block runtime writes = %q, want block input", got)
	}
	if got := parentRuntime.written(); len(got) != 0 {
		t.Fatalf("parent runtime received explicit block input: %q", got)
	}
	if got := blockTermInputRejections(t, master); len(got) != 0 {
		t.Fatalf("successful block input produced NACK: %#v", got)
	}
}

func TestManagerExplicitBlockRouteRejectsMalformedAndUnknownRequests(t *testing.T) {
	tests := []struct {
		name       string
		message    func(blockID string) WSMessage
		wantReason InputRejectedReason
		wantToken  string
	}{
		{
			name: "missing fields",
			message: func(blockID string) WSMessage {
				return WSMessage{Type: MsgTypeInput, Data: base64.StdEncoding.EncodeToString([]byte("x")), RouteMode: RouteModeBlock, BlockID: blockID}
			},
			wantReason: InputRejectedRouteRequired,
		},
		{
			name: "token mismatch",
			message: func(blockID string) WSMessage {
				return WSMessage{Type: MsgTypeInput, Data: base64.StdEncoding.EncodeToString([]byte("x")), RouteMode: RouteModeBlock, BlockID: blockID, BlockToken: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabce"}
			},
			wantReason: InputRejectedTokenMismatch,
			wantToken:  "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabce",
		},
		{
			name: "unknown block",
			message: func(string) WSMessage {
				return WSMessage{Type: MsgTypeInput, Data: base64.StdEncoding.EncodeToString([]byte("x")), RouteMode: RouteModeBlock, BlockID: "route-unknown-block", BlockToken: blockTermTestToken}
			},
			wantReason: InputRejectedRouteNotFound,
			wantToken:  blockTermTestToken,
		},
		{
			name: "legacy with block fields",
			message: func(blockID string) WSMessage {
				return WSMessage{Type: MsgTypeInput, Data: base64.StdEncoding.EncodeToString([]byte("x")), RouteMode: RouteModeLegacy, BlockID: blockID, BlockToken: blockTermTestToken}
			},
			wantReason: InputRejectedInvalidRoute,
			wantToken:  blockTermTestToken,
		},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			blockRuntime := &blockTermInputRuntime{}
			manager, at, parentRuntime := newManagerBlockRouteFixture(t, fmt.Sprintf("route-reject-%d", index), "route-reject-block", blockTermTestToken, blockRuntime)
			message := test.message("route-reject-block")
			master := runManagerBlockRouteMessage(t, manager, at, message)
			rejections := blockTermInputRejections(t, master)
			if len(rejections) != 1 {
				t.Fatalf("NACKs = %#v, want one", rejections)
			}
			nack := rejections[0]
			if nack.RouteMode != message.RouteMode || nack.BlockID != message.BlockID || nack.BlockToken != message.BlockToken || nack.Reason != test.wantReason {
				t.Fatalf("NACK = %+v, want mode=%q block=%q token=%q reason=%q", nack, message.RouteMode, message.BlockID, message.BlockToken, test.wantReason)
			}
			if test.wantToken != "" && nack.BlockToken != test.wantToken {
				t.Fatalf("NACK token = %q, want %q", nack.BlockToken, test.wantToken)
			}
			if len(blockRuntime.written()) != 0 || len(parentRuntime.written()) != 0 {
				t.Fatalf("rejected request reached a runtime: block=%q parent=%q", blockRuntime.written(), parentRuntime.written())
			}
		})
	}
}

func TestManagerExplicitBlockResizeDoesNotChangeSessionGeometry(t *testing.T) {
	blockRuntime := &blockTermInputRuntime{}
	manager, at, parentRuntime := newManagerBlockRouteFixture(t, "route-resize-terminal", "route-resize-block", blockTermTestToken, blockRuntime)

	master := runManagerBlockRouteMessage(t, manager, at, WSMessage{
		Type:       MsgTypeResize,
		RouteMode:  RouteModeBlock,
		BlockID:    "route-resize-block",
		BlockToken: blockTermTestToken,
		Cols:       132,
		Rows:       43,
	})
	if got := blockRuntime.resized(); len(got) != 1 || got[0] != [2]int{132, 43} {
		t.Fatalf("block runtime resizes = %v, want 132x43", got)
	}
	if got := parentRuntime.resized(); len(got) != 0 {
		t.Fatalf("parent runtime received block resize: %v", got)
	}
	if at.Session.Cols != 80 || at.Session.Rows != 24 {
		t.Fatalf("session geometry changed after block resize: %dx%d", at.Session.Cols, at.Session.Rows)
	}
	if got := blockTermInputRejections(t, master); len(got) != 0 {
		t.Fatalf("successful block resize produced NACK: %#v", got)
	}
}

func TestManagerTaggedResizeWithoutModeRequiresRoute(t *testing.T) {
	blockRuntime := &blockTermInputRuntime{}
	manager, at, parentRuntime := newManagerBlockRouteFixture(t, "route-resize-required-terminal", "route-resize-required-block", blockTermTestToken, blockRuntime)
	message := WSMessage{
		Type:       MsgTypeResize,
		BlockID:    "route-resize-required-block",
		BlockToken: blockTermTestToken,
		Cols:       100,
		Rows:       30,
	}
	master := runManagerBlockRouteMessage(t, manager, at, message)
	rejections := blockTermInputRejections(t, master)
	if len(rejections) != 1 || rejections[0].Reason != InputRejectedRouteRequired || rejections[0].BlockID != message.BlockID || rejections[0].BlockToken != message.BlockToken || rejections[0].RouteMode != "" {
		t.Fatalf("resize route-required NACK = %#v", rejections)
	}
	if len(blockRuntime.resized()) != 0 || len(parentRuntime.resized()) != 0 {
		t.Fatalf("route-required resize reached a runtime: block=%v parent=%v", blockRuntime.resized(), parentRuntime.resized())
	}
}

func TestManagerExplicitBlockSignalUsesIndependentRuntime(t *testing.T) {
	blockRuntime := &blockRouteSignalRuntime{}
	manager, at, parentRuntime := newManagerBlockRouteFixture(t, "route-signal-terminal", "route-signal-block", blockTermTestToken, blockRuntime)
	master := runManagerBlockRouteMessage(t, manager, at, WSMessage{
		Type:       MsgTypeSignal,
		Signal:     "TERM",
		RouteMode:  RouteModeBlock,
		BlockID:    "route-signal-block",
		BlockToken: blockTermTestToken,
	})
	if got := blockRuntime.signaled(); len(got) != 1 || got[0] != "TERM" {
		t.Fatalf("block runtime signals = %v, want TERM", got)
	}
	if len(parentRuntime.written()) != 0 {
		t.Fatalf("parent runtime received explicit block signal: %q", parentRuntime.written())
	}
	if got := blockTermInputRejections(t, master); len(got) != 0 {
		t.Fatalf("successful block signal produced NACK: %#v", got)
	}
}

var _ TerminalRuntime = (*blockRouteSignalRuntime)(nil)
var _ io.Reader = (*blockTermInputRuntime)(nil)
