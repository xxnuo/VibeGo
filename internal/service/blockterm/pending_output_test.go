package blockterm

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestPendingOutputSpillsAndFlushesInOrder(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{info: Session{ID: "spool"}, current: &Block{ID: "block"}, temp: t.TempDir()}
	defer a.clearPending()
	payload := bytes.Repeat([]byte("中文\x1b[31m"), maxStreamEventBytes)
	for offset := 0; offset < len(payload); {
		n := min(317, len(payload)-offset)
		if err := a.bufferPending(payload[offset : offset+n]); err != nil {
			t.Fatal(err)
		}
		if len(a.pendingOutput) > maxStreamEventBytes {
			t.Fatal("unbounded in-memory pending output")
		}
		offset += n
	}
	if a.pendingFile == nil || a.pendingOutput != nil {
		t.Fatal("large pending output did not spill")
	}
	name := a.pendingFile.Name()
	if events, err := s.Events(a.info.ID, 0); err != nil || len(events) != 0 {
		t.Fatal("speculative output was published early")
	}
	if err := s.flushPending(a); err != nil {
		t.Fatal(err)
	}
	var got []byte
	for _, event := range allEvents(t, s, a.info.ID) {
		got = append(got, event.Data...)
	}
	if !bytes.Equal(got, payload) || a.pendingFile != nil || a.pendingOutput != nil {
		t.Fatal("spool flush lost bytes or retained resources")
	}
	if _, err := os.Stat(name); !os.IsNotExist(err) {
		t.Fatalf("spool remains: %v", err)
	}
}

func TestPendingOutputDiscardRemovesSpool(t *testing.T) {
	a := &activeSession{temp: t.TempDir()}
	defer a.clearPending()
	if err := a.bufferPending(make([]byte, maxStreamEventBytes+1)); err != nil {
		t.Fatal(err)
	}
	name := a.pendingFile.Name()
	a.clearPending()
	a.clearPending()
	if _, err := os.Stat(name); !os.IsNotExist(err) {
		t.Fatalf("discard left spool: %v", err)
	}
}

func TestPendingSpoolFailurePublishesGapAndStopsRecording(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{
		info:    Session{ID: "spool-error", Phase: "submitted"},
		current: &Block{ID: "block"}, accepted: true,
		temp: filepath.Join(t.TempDir(), "missing"), vt: newEmulator(80, 24),
	}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	s.output(a, bytes.Repeat([]byte("x"), maxStreamEventBytes+1))
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 1 || events[0].Type != "gap" || a.info.Error == "" || !a.recordingStopped {
		t.Fatalf("spool failure was silent: events=%+v error=%v", events, err)
	}
	if a.pendingFile != nil || a.pendingOutput != nil {
		t.Fatal("failed spool retained resources")
	}
}

func TestPendingSpoolCommandLifecycle(t *testing.T) {
	for _, action := range []string{"start", "end", "eof", "limit"} {
		t.Run(action, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{
				info:     Session{ID: "lifecycle", Phase: "submitted"},
				current:  &Block{ID: "block", SessionID: "lifecycle", Status: "submitted"},
				accepted: true, acceptProtocol: true, hookSeq: 1,
				temp: t.TempDir(), vt: newEmulator(80, 24), decoder: NewDecoder("test"),
			}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			defer a.clearPending()
			payload := bytes.Repeat([]byte("diagnostic 中文\r\n"), 6000)
			s.output(a, payload)
			if a.pendingFile == nil {
				t.Fatal("fixture did not spill")
			}
			name := a.pendingFile.Name()
			switch action {
			case "start":
				s.hook(a, "start;ZWNobyBvaw==;1")
			case "end":
				s.hook(a, "end;2;;false;;1")
			case "eof":
				s.finishRead(a)
			case "limit":
				a.bytes = MaxSessionBytes
				s.output(a, []byte("discard"))
			}
			var got []byte
			gap := false
			for _, event := range allEvents(t, s, a.info.ID) {
				if event.Type == "gap" {
					gap = true
				}
				if event.Type == "output" {
					if gap {
						t.Fatal("output published after gap")
					}
					got = append(got, event.Data...)
				}
			}
			if action == "start" {
				if len(got) != 0 || a.current.Status != "running" {
					t.Fatal("start retained speculative echo")
				}
			} else if !bytes.Equal(got, payload) {
				t.Fatal("diagnostic output was not preserved")
			}
			if action == "limit" && !gap {
				t.Fatal("limit did not publish gap")
			}
			if action == "end" || action == "eof" {
				blocks, err := s.Blocks(a.info.ID)
				want := "not_executed"
				if action == "eof" {
					want = "interrupted"
				}
				if err != nil || len(blocks) != 1 || blocks[0].Status != want || blocks[0].ExitCode != nil {
					t.Fatalf("diagnostic flush changed command result: %+v %v", blocks, err)
				}
			}
			if a.pendingFile != nil || a.pendingOutput != nil {
				t.Fatal("lifecycle retained pending resources")
			}
			if _, err := os.Stat(name); !os.IsNotExist(err) {
				t.Fatalf("lifecycle retained file: %v", err)
			}
		})
	}
}
