package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/xxnuo/vibego/internal/model"
)

type signalTestRuntime struct {
	mu        sync.Mutex
	signals   []string
	signalErr error
}

func (r *signalTestRuntime) Type() string                       { return RuntimeTypeSSH }
func (r *signalTestRuntime) Capabilities() TerminalCapabilities { return TerminalCapabilities{} }
func (r *signalTestRuntime) Read([]byte) (int, error)           { return 0, io.EOF }
func (r *signalTestRuntime) Write(data []byte) (int, error)     { return len(data), nil }
func (r *signalTestRuntime) Resize(int, int) error              { return nil }
func (r *signalTestRuntime) Close() error                       { return nil }
func (r *signalTestRuntime) ExitCode() int                      { return 0 }
func (r *signalTestRuntime) Wait(context.Context) error         { return nil }
func (r *signalTestRuntime) Signal(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.signals = append(r.signals, name)
	return r.signalErr
}

type signalFallbackRuntime struct {
	writes [][]byte
}

func (r *signalFallbackRuntime) Type() string                       { return RuntimeTypeLocal }
func (r *signalFallbackRuntime) Capabilities() TerminalCapabilities { return TerminalCapabilities{} }
func (r *signalFallbackRuntime) Read([]byte) (int, error)           { return 0, io.EOF }
func (r *signalFallbackRuntime) Write(data []byte) (int, error) {
	r.writes = append(r.writes, append([]byte(nil), data...))
	return len(data), nil
}
func (r *signalFallbackRuntime) Resize(int, int) error      { return nil }
func (r *signalFallbackRuntime) Close() error               { return nil }
func (r *signalFallbackRuntime) ExitCode() int              { return 0 }
func (r *signalFallbackRuntime) Wait(context.Context) error { return nil }

func TestNormalizeTerminalSignal(t *testing.T) {
	for input, want := range map[string]string{
		" int ":   "INT",
		"SIGTERM": "TERM",
		"kill":    "KILL",
		"sighup":  "HUP",
		"usr1":    "USR1",
		"SIGUSR2": "USR2",
	} {
		got, err := NormalizeTerminalSignal(input)
		if err != nil || got != want {
			t.Fatalf("NormalizeTerminalSignal(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	if _, err := NormalizeTerminalSignal("QUIT"); err == nil {
		t.Fatal("unsupported signal was accepted")
	}
}

func TestSignalTerminalRuntimeFallbackOnlyWritesInterrupt(t *testing.T) {
	runtime := &signalFallbackRuntime{}
	if err := SignalTerminalRuntime(runtime, "SIGINT"); err != nil {
		t.Fatalf("fallback INT: %v", err)
	}
	if len(runtime.writes) != 1 || len(runtime.writes[0]) != 1 || runtime.writes[0][0] != 3 {
		t.Fatalf("fallback writes = %v, want Ctrl-C", runtime.writes)
	}
	if err := SignalTerminalRuntime(runtime, "TERM"); !errors.Is(err, ErrTerminalSignalUnsupported) {
		t.Fatalf("fallback TERM error = %v, want unsupported", err)
	}
}

func TestManagerReadClientLoopForwardsNormalizedSignal(t *testing.T) {
	runtime := &signalTestRuntime{}
	data, err := json.Marshal(WSMessage{Type: MsgTypeSignal, Signal: "sigterm"})
	if err != nil {
		t.Fatalf("marshal signal message: %v", err)
	}
	at := &activeTerminal{Runtime: runtime, encoder: base64.StdEncoding}
	at.status.Store(model.StatusRunning)
	conn := &terminalConnection{Master: &mockMaster{readData: data}, Ctx: context.Background()}

	_ = (&Manager{}).readClientLoop(at, conn)

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.signals) != 1 || runtime.signals[0] != "TERM" {
		t.Fatalf("signals = %v, want [TERM]", runtime.signals)
	}
}

func TestManagerReadClientLoopRejectsInvalidSignal(t *testing.T) {
	runtime := &signalTestRuntime{}
	data, err := json.Marshal(WSMessage{Type: MsgTypeSignal, Signal: "QUIT"})
	if err != nil {
		t.Fatalf("marshal signal message: %v", err)
	}
	at := &activeTerminal{Runtime: runtime, encoder: base64.StdEncoding}
	at.status.Store(model.StatusRunning)
	conn := &terminalConnection{Master: &mockMaster{readData: data}, Ctx: context.Background()}

	_ = (&Manager{}).readClientLoop(at, conn)

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.signals) != 0 {
		t.Fatalf("invalid signal was forwarded: %v", runtime.signals)
	}
}

func TestManagerReadClientLoopNACKsTaggedInvalidAndStoppedSignals(t *testing.T) {
	const blockID = "tagged-signal-block"
	for _, test := range []struct {
		name   string
		signal string
		status string
		want   InputRejectedReason
	}{
		{name: "invalid", signal: "QUIT", status: model.StatusRunning, want: InputRejectedInvalidSignal},
		{name: "stopped", signal: "INT", status: model.StatusExited, want: InputRejectedTerminalNotRunning},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime := &signalTestRuntime{}
			at := newBlockTermInputActive("tagged-signal-terminal", runtime, nil)
			at.status.Store(test.status)
			_, master := runBlockTermClientMessage(t, &Manager{}, at, WSMessage{
				Type:       MsgTypeSignal,
				Signal:     test.signal,
				BlockID:    blockID,
				BlockToken: blockTermTestToken,
			})
			rejections := blockTermInputRejections(t, master)
			if len(rejections) != 1 || rejections[0].Reason != test.want ||
				rejections[0].BlockID != blockID || rejections[0].BlockToken != blockTermTestToken {
				t.Fatalf("signal rejections = %#v, want reason %q with matching binding", rejections, test.want)
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if len(runtime.signals) != 0 {
				t.Fatalf("rejected signal reached runtime: %v", runtime.signals)
			}
		})
	}
}

func TestManagerReadClientLoopReturnsUntaggedSignalFailure(t *testing.T) {
	signalErr := errors.New("signal failed")
	runtime := &signalTestRuntime{signalErr: signalErr}
	at := newBlockTermInputActive("untagged-signal-terminal", runtime, nil)
	err, _ := runBlockTermClientMessage(t, &Manager{}, at, WSMessage{
		Type:   MsgTypeSignal,
		Signal: "TERM",
	})
	if !errors.Is(err, signalErr) {
		t.Fatalf("read loop error = %v, want %v", err, signalErr)
	}
}
