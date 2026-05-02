package blockterm

import (
	"bytes"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestRecordingLimitStillAllowsRealPTYInterrupt(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("quota-interrupt", t.TempDir(), "bash", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	a, err := s.active(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.bytes = MaxSessionBytes
	a.mu.Unlock()
	block, err := s.Submit(info.ID, "owner", "quota-command", "printf 'QUOTA_MARKER\\n'; sleep 20")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		current, err := s.Get(info.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.Phase == "running" && current.Error != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("quota command did not start: %+v", current)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := s.Input(info.ID, "owner", []byte("y\r")); err == nil {
		t.Fatal("blind input accepted")
	}
	if err := s.Input(info.ID, "owner", []byte{3}); err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	var finished Block
	if err := s.db.First(&finished, "id = ?", block.ID).Error; err != nil {
		t.Fatal(err)
	}
	if finished.Status != "done" || finished.ExitCode == nil || *finished.ExitCode != 130 {
		t.Fatalf("interrupt not finalized: %+v", finished)
	}
}

func TestStoppedRecordingRejectsBlindInputButAllowsInterrupt(t *testing.T) {
	for _, phase := range []string{"submitted", "running", "editing"} {
		for _, failure := range []string{"quota", "database"} {
			t.Run(phase+"/"+failure, func(t *testing.T) {
				s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
				if err != nil {
					t.Fatal(err)
				}
				pty := &nativeRecordingPTY{}
				a := &activeSession{info: Session{ID: "stopped-input", Phase: phase}, owner: "owner", lease: time.Now().Add(time.Minute), pty: pty, vt: newEmulator(80, 24), bytes: MaxSessionBytes}
				s.sessions[a.info.ID] = a
				t.Cleanup(func() { delete(s.sessions, a.info.ID); a.vt.InputPipe().(io.Closer).Close(); a.vt.Close(); s.Close() })
				if failure == "database" {
					if err := s.db.Migrator().DropTable(&Event{}); err != nil {
						t.Fatal(err)
					}
					_ = s.append(a, "terminal", "", []byte("lost"))
				} else {
					s.output(a, []byte("over quota"))
				}
				if !a.recordingStopped {
					t.Fatal("fixture did not stop recording")
				}
				for _, data := range [][]byte{[]byte("y\r"), []byte("\x1b[200~command\x1b[201~"), {3, 'x'}, {'x', 3}, {4}} {
					if err := s.Input(a.info.ID, "owner", data); err == nil {
						t.Fatalf("blind input accepted: %q", data)
					}
				}
				if pty.input.Len() != 0 || a.cancelRequested {
					t.Fatal("rejected input mutated PTY or cancellation state")
				}
				if err := s.Input(a.info.ID, "other", []byte{3}); !errors.Is(err, ErrConflict) {
					t.Fatalf("non-owner interrupt: %v", err)
				}
				if err := s.Input(a.info.ID, "owner", []byte{3}); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(pty.input.Bytes(), []byte{3}) || a.cancelRequested != (phase == "submitted") {
					t.Fatal("interrupt was not preserved")
				}
			})
		}
	}
}

func TestInputErrorDoesNotDisableOutputRecording(t *testing.T) {
	for _, phase := range []string{"running", "editing"} {
		t.Run(phase, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{info: Session{ID: "input-error", Phase: phase, Error: "input result uncertain"}, vt: newEmulator(80, 24), current: &Block{ID: "block"}, gridBlock: "block"}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			s.output(a, []byte("later output\r\n"))
			s.output(a, []byte("still observable"))
			events, err := s.Events(a.info.ID, 0)
			kind := "output"
			if phase == "editing" {
				kind = "terminal"
			}
			if err != nil || len(events) != 2 || events[0].Type != kind || events[1].Type != kind || string(events[0].Data) != "later output\r\n" || string(events[1].Data) != "still observable" {
				t.Fatalf("output lost after input error: %+v %v", events, err)
			}
			stored, err := s.Get(a.info.ID)
			if err != nil || stored.Error != "input result uncertain" {
				t.Fatalf("input warning lost: %+v %v", stored, err)
			}
		})
	}
}

func TestInputWarningDoesNotDisableObservableInput(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	pty := &nativeRecordingPTY{}
	a := &activeSession{info: Session{ID: "warning-input", Phase: "running", Error: "previous input uncertain"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: pty}
	s.sessions[a.info.ID] = a
	t.Cleanup(func() { delete(s.sessions, a.info.ID); s.Close() })
	if err := s.Input(a.info.ID, "owner", []byte("answer\r")); err != nil {
		t.Fatal(err)
	}
	if pty.input.String() != "answer\r" {
		t.Fatal("observable input was discarded")
	}
}

func TestRecordingLimitRetainsExactPrefix(t *testing.T) {
	for _, phase := range []string{"running", "editing"} {
		t.Run(phase, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{info: Session{ID: "prefix", Phase: phase}, bytes: MaxSessionBytes - 5, vt: newEmulator(80, 24), current: &Block{ID: "block"}, gridBlock: "block"}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			reply := make(chan string, 1)
			go func() {
				data := make([]byte, 64)
				n, _ := a.vt.Read(data)
				reply <- string(data[:n])
			}()
			// The quota ends inside CSI; the parser must still receive its suffix.
			data := []byte("abc\x1b[5nTAIL")
			s.output(a, data)
			s.output(a, []byte("discarded"))
			select {
			case got := <-reply:
				if got != "\x1b[0n" {
					t.Fatalf("query reply %q", got)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("split query did not receive a reply")
			}
			events, err := s.Events(a.info.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			kind := "output"
			if phase == "editing" {
				kind = "terminal"
			}
			if len(events) != 2 || events[0].Type != kind || !bytes.Equal(events[0].Data, data[:5]) || events[0].Seq != 1 || events[1].Type != "gap" || events[1].Seq != 2 {
				t.Fatalf("expected exact prefix then one gap, got %+v", events)
			}
		})
	}
}

func TestRecordingLimitPreservesTerminalReplies(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{info: Session{ID: "limit", Phase: "running"}, bytes: MaxSessionBytes, vt: newEmulator(80, 24)}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	for index := 0; index < 2; index++ {
		reply := make(chan string, 1)
		go func() {
			data := make([]byte, 64)
			n, err := a.vt.Read(data)
			if err != nil {
				reply <- err.Error()
			} else {
				reply <- string(data[:n])
			}
		}()
		s.output(a, []byte("\x1b[5n"))
		select {
		case result := <-reply:
			if result != "\x1b[0n" {
				t.Fatalf("query reply %q", result)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("recording limit stopped terminal replies")
		}
	}
	events, err := s.Events("limit", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "gap" {
		t.Fatalf("expected one durable gap, got %+v", events)
	}
	stored, err := s.Get("limit")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Error == "" || stored.Seq != 1 {
		t.Fatalf("recording limit not persisted: %+v", stored)
	}
}

func TestRecordingLimitFlushesAcceptedOutputBeforeGap(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{
		info:  Session{ID: "accepted-limit", Phase: "submitted"},
		bytes: MaxSessionBytes - 5, accepted: true,
		current: &Block{ID: "pending", SessionID: "accepted-limit", Status: "submitted"},
		vt:      newEmulator(80, 24),
		decoder: &Decoder{},
	}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	s.output(a, []byte("ABCDEdiscarded"))
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 2 || events[0].Type != "output" || string(events[0].Data) != "ABCDE" || events[1].Type != "gap" {
		t.Fatalf("retained accepted prefix must precede gap: %+v %v", events, err)
	}
	if a.pendingOutput != nil {
		t.Fatal("quota stop retained pending output memory")
	}
	s.finishRead(a)
	events, err = s.Events(a.info.ID, events[1].Seq)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == "output" {
			t.Fatal("finalization duplicated output after the gap")
		}
	}
}

func TestBackgroundPersistenceFailurePreservesTerminalReplies(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.db.Migrator().DropTable(&Block{}); err != nil {
		t.Fatal(err)
	}
	a := &activeSession{info: Session{ID: "background-failure", Phase: "ready"}, vt: newEmulator(80, 24)}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	for _, chunk := range []string{"background\x1b[5n", "later\x1b[5n"} {
		reply := make(chan string, 1)
		go func() {
			data := make([]byte, 64)
			n, _ := a.vt.Read(data)
			reply <- string(data[:n])
		}()
		s.output(a, []byte(chunk))
		select {
		case got := <-reply:
			if got != "\x1b[0n" {
				t.Fatalf("query reply %q", got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("background persistence failure swallowed terminal query")
		}
	}
	if !a.recordingStopped || a.info.Error == "" || a.info.Seq != 0 {
		t.Fatalf("recording failure not retained: %+v", a.info)
	}
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 0 {
		t.Fatalf("failed block must not publish events: %+v %v", events, err)
	}
}
