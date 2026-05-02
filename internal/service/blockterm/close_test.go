package blockterm

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KennethanCeyer/ptyx"
)

type closeErrorPTY struct {
	ptyx.Session
	killErr, closeErr error
	calls             []string
}

type zeroExitKilledPTY struct {
	ptyx.Session
	reader *io.PipeReader
	writer *io.PipeWriter
	once   sync.Once
}

func (p *zeroExitKilledPTY) PtyReader() io.Reader { return p.reader }
func (p *zeroExitKilledPTY) PtyWriter() io.Writer { return io.Discard }
func (p *zeroExitKilledPTY) Kill() error          { p.once.Do(func() { _ = p.writer.Close() }); return nil }
func (p *zeroExitKilledPTY) Close() error         { return p.reader.Close() }
func (p *zeroExitKilledPTY) Wait() error          { return nil }

func TestCloseSessionDoesNotCompleteBlockOnZeroProcessExit(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r, w := io.Pipe()
	p := &zeroExitKilledPTY{reader: r, writer: w}
	defer w.Close()
	a := &activeSession{info: Session{ID: "killed", Phase: "running"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: p, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), done: make(chan struct{}), temp: t.TempDir(), current: &Block{ID: "block", SessionID: "killed", Status: "running", StartedAt: 1}}
	s.sessions[a.info.ID] = a
	go s.read(a)
	if err := s.CloseSession(a.info.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.done:
	case <-time.After(3 * time.Second):
		t.Fatal("terminated reader did not finish")
	}
	stored, err := s.Get(a.info.ID)
	if err != nil || stored.ExitCode == nil || *stored.ExitCode != 0 || stored.Phase != "exited" {
		t.Fatalf("process result lost: %+v %v", stored, err)
	}
	var block Block
	if err := s.db.First(&block, "id = ?", "block").Error; err != nil {
		t.Fatal(err)
	}
	if block.Status != "interrupted" || block.ExitCode != nil {
		t.Fatalf("termination falsely completed block: %+v", block)
	}
}

func TestServiceCloseCleansAllSessionsAndReportsErrors(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	killFailure, closeFailure := errors.New("kill failed"), errors.New("close failed")
	ptys := []*closeErrorPTY{{killErr: killFailure}, {closeErr: closeFailure}, {killErr: os.ErrProcessDone, closeErr: os.ErrClosed}, {}}
	for index, pty := range ptys {
		id := fmt.Sprintf("session-%d", index)
		done := make(chan struct{})
		close(done)
		s.sessions[id] = &activeSession{info: Session{ID: id, Phase: "exited"}, pty: pty, done: done}
	}
	err = s.Close()
	if !errors.Is(err, killFailure) || !errors.Is(err, closeFailure) || !strings.Contains(err.Error(), "session-0") || !strings.Contains(err.Error(), "session-1") {
		t.Fatalf("missing shutdown errors: %v", err)
	}
	if errors.Is(err, os.ErrProcessDone) || errors.Is(err, os.ErrClosed) {
		t.Fatalf("normal termination treated as error: %v", err)
	}
	for _, pty := range ptys {
		if len(pty.calls) != 2 || pty.calls[0] != "kill" || pty.calls[1] != "close" {
			t.Fatalf("cleanup skipped: %v", pty.calls)
		}
	}
	if !s.closed || db.Ping() == nil {
		t.Fatal("shutdown failed to close service/database")
	}
}

func (p *closeErrorPTY) Kill() error  { p.calls = append(p.calls, "kill"); return p.killErr }
func (p *closeErrorPTY) Close() error { p.calls = append(p.calls, "close"); return p.closeErr }

func TestCloseSessionPreservesTerminationErrors(t *testing.T) {
	killFailure, closeFailure := errors.New("kill failed"), errors.New("close failed")
	for _, killErr := range []error{nil, killFailure, fmt.Errorf("wrapped: %w", os.ErrProcessDone)} {
		for _, closeErr := range []error{nil, closeFailure, fmt.Errorf("wrapped: %w", os.ErrClosed)} {
			t.Run(fmt.Sprintf("kill=%v/close=%v", killErr, closeErr), func(t *testing.T) {
				p := &closeErrorPTY{killErr: killErr, closeErr: closeErr}
				a := &activeSession{info: Session{ID: "close", Phase: "running"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: p}
				s := &Service{sessions: map[string]*activeSession{"close": a}}
				if err := s.CloseSession("close", "other"); !errors.Is(err, ErrConflict) || len(p.calls) != 0 {
					t.Fatal("non-owner terminated PTY")
				}
				err := s.CloseSession("close", "owner")
				if errors.Is(err, killFailure) != (killErr == killFailure) || errors.Is(err, closeFailure) != (closeErr == closeFailure) {
					t.Fatalf("lost termination error: %v", err)
				}
				if killErr != killFailure && closeErr != closeFailure && err != nil {
					t.Fatalf("normal close reported failure: %v", err)
				}
				if len(p.calls) != 2 || p.calls[0] != "kill" || p.calls[1] != "close" {
					t.Fatalf("cleanup skipped: %v", p.calls)
				}
			})
		}
	}
}

func TestServiceCloseTimeoutAllowsFinalPersistenceAndRetry(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	killFailure := errors.New("termination denied")
	p := &closeErrorPTY{killErr: killFailure}
	a := &activeSession{info: Session{ID: "slow-exit", Phase: "running"}, pty: p, done: make(chan struct{})}
	s.sessions[a.info.ID] = a
	// Keep the reader's completion signal pending through the real shutdown timeout.
	err = s.Close()
	if !errors.Is(err, killFailure) || !strings.Contains(err.Error(), "PTY slow-exit did not stop") {
		t.Fatalf("timeout lost termination context: %v", err)
	}
	if !s.closed || db.Ping() != nil {
		t.Fatal("timeout closed a database still needed by the reader")
	}
	if _, err := s.Create("group", t.TempDir(), "bash", 80, 24); err == nil || err.Error() != "service closed" {
		t.Fatalf("shutdown accepted a new session: %v", err)
	}
	// Model the delayed reader persisting its final state before announcing done.
	a.info.Phase = "exited"
	s.state(a)
	stored, err := s.Get(a.info.ID)
	if err != nil || stored.Phase != "exited" || stored.Seq != 1 {
		t.Fatalf("late final state was not persisted: %+v %v", stored, err)
	}
	s.mu.Lock()
	delete(s.sessions, a.info.ID)
	s.mu.Unlock()
	close(a.done)
	if err := s.Close(); err != nil {
		t.Fatalf("cleanup retry failed: %v", err)
	}
	if db.Ping() == nil || len(p.calls) != 2 {
		t.Fatal("retry did not close database or touched an already reaped PTY")
	}
}

func TestClosingServiceRejectsNewPTYOperations(t *testing.T) {
	lease := time.Now().Add(time.Minute)
	a := &activeSession{info: Session{ID: "closing", Phase: "ready"}, owner: "owner", lease: lease}
	// A nil PTY/DB makes any operation past the shutdown gate fail the test.
	s := &Service{closed: true, sessions: map[string]*activeSession{"closing": a}}
	for name, operation := range map[string]func() error{
		"claim":  func() error { return s.Claim("closing", "owner") },
		"input":  func() error { return s.Input("closing", "owner", []byte("x")) },
		"resize": func() error { return s.Resize("closing", "owner", 90, 30) },
		"close":  func() error { return s.CloseSession("closing", "owner") },
		"native": func() error { return s.BeginNative("closing", "owner", "echo") },
		"submit": func() error { _, err := s.Submit("closing", "owner", "request", "echo hello"); return err },
	} {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, ErrConflict) {
				t.Fatalf("operation accepted during shutdown: %v", err)
			}
		})
	}
	s.Release("closing", "owner")
	if a.owner != "owner" || !a.lease.Equal(lease) || a.info.Phase != "ready" || a.current != nil {
		t.Fatal("shutdown gate allowed state changes")
	}
}
