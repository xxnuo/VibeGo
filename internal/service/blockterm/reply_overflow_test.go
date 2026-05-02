package blockterm

import (
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KennethanCeyer/ptyx"
)

type overflowPTY struct {
	ptyx.Session
	reader io.Reader
	closed chan struct{}
	once   sync.Once
}

func (p *overflowPTY) PtyReader() io.Reader      { return p.reader }
func (p *overflowPTY) PtyWriter() io.Writer      { return p }
func (p *overflowPTY) Write([]byte) (int, error) { <-p.closed; return 0, io.ErrClosedPipe }
func (p *overflowPTY) Kill() error               { p.once.Do(func() { close(p.closed) }); return nil }
func (p *overflowPTY) Close() error              { return p.Kill() }
func (p *overflowPTY) Wait() error               { return nil }

type lateOverflowPTY struct {
	*overflowPTY
	onWait func()
}

func (p *lateOverflowPTY) Close() error { return nil }
func (p *lateOverflowPTY) Wait() error  { p.onWait(); return nil }

func TestReplyOverflowAfterEOFPersistsExitReason(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := &lateOverflowPTY{overflowPTY: &overflowPTY{reader: strings.NewReader(""), closed: make(chan struct{})}}
	defer p.Kill()
	a := &activeSession{info: Session{ID: "late-overflow", Phase: "running", Error: "prior diagnostic"}, pty: p, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), done: make(chan struct{}), temp: t.TempDir()}
	a.owner, a.lease = "existing-controller", time.Now().Add(time.Minute)
	waiting, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(release) }) }
	defer resume()
	p.onWait = func() {
		// The PTY reader reached EOF; pending emulator replies overflow during cleanup.
		close(waiting)
		<-release
		_, _ = a.vt.Write([]byte(strings.Repeat("\x1b[5n", 20000)))
	}
	s.sessions[a.info.ID] = a
	go s.read(a)
	select {
	case <-waiting:
	case <-time.After(5 * time.Second):
		t.Fatal("reader did not reach cleanup")
	}
	if err := s.Claim(a.info.ID, "new-controller"); !errors.Is(err, ErrConflict) {
		t.Fatalf("cleanup accepted control: %v", err)
	}
	for name, operation := range map[string]func() error{
		"input":  func() error { return s.Input(a.info.ID, a.owner, []byte("x")) },
		"resize": func() error { return s.Resize(a.info.ID, a.owner, 80, 24) },
		"native": func() error { return s.BeginNative(a.info.ID, a.owner, "echo late") },
		"submit": func() error {
			_, err := s.Submit(a.info.ID, a.owner, "late-request", "echo late")
			return err
		},
	} {
		if err := operation(); !errors.Is(err, ErrConflict) {
			t.Fatalf("cleanup accepted %s: %v", name, err)
		}
	}
	for _, event := range allEvents(t, s, a.info.ID) {
		if event.Type == "state" {
			var state Session
			if err := json.Unmarshal(event.Data, &state); err != nil {
				t.Fatal(err)
			}
			if state.Phase == "exited" {
				t.Fatal("exit published before reply cleanup")
			}
		}
	}
	resume()
	select {
	case <-a.done:
	case <-time.After(5 * time.Second):
		_ = p.Kill()
		t.Fatal("late reply overflow did not finish cleanup")
	}
	stored, err := s.Get(a.info.ID)
	if err != nil || stored.Phase != "exited" || stored.Error != "prior diagnostic\n终端查询回复队列已满，会话已停止" {
		t.Fatalf("missing late overflow reason: %+v %v", stored, err)
	}
	exits := 0
	for _, event := range allEvents(t, s, a.info.ID) {
		if event.Type != "state" {
			continue
		}
		var state Session
		if err := json.Unmarshal(event.Data, &state); err != nil {
			t.Fatal(err)
		}
		if state.Phase == "exited" {
			exits++
			if state.Error != stored.Error {
				t.Fatalf("premature exit event: %+v", state)
			}
		}
	}
	if exits != 1 {
		t.Fatalf("expected one complete exit event, got %d", exits)
	}
}

func TestReplyOverflowPersistsExitReason(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := &overflowPTY{reader: strings.NewReader(strings.Repeat("\x1b[5n", 20000)), closed: make(chan struct{})}
	a := &activeSession{info: Session{ID: "overflow", Phase: "running", Error: "prior diagnostic"}, current: &Block{ID: "block", SessionID: "overflow", Status: "running"}, pty: p, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), done: make(chan struct{}), temp: t.TempDir()}
	s.sessions[a.info.ID] = a
	go s.read(a)
	select {
	case <-a.done:
	case <-time.After(5 * time.Second):
		_ = p.Close()
		t.Fatal("reply overflow did not finish cleanup")
	}
	stored, err := s.Get(a.info.ID)
	if err != nil || stored.Phase != "exited" || !strings.Contains(stored.Error, "prior diagnostic\n终端查询回复队列已满，会话已停止") {
		t.Fatalf("missing overflow reason: %+v %v", stored, err)
	}
	if _, err := s.active(a.info.ID); err == nil {
		t.Fatal("overflow session still active")
	}
}
