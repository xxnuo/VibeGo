package blockterm

import (
	"bytes"
	"encoding/json"
	"io"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/KennethanCeyer/ptyx"
)

type replyRecoveryPTY struct {
	ptyx.Session
	output  chan []byte
	written chan error
	once    sync.Once
	calls   int
	input   bytes.Buffer
}

func (p *replyRecoveryPTY) PtyReader() io.Reader { return p }
func (p *replyRecoveryPTY) PtyWriter() io.Writer { return p }
func (p *replyRecoveryPTY) Read(data []byte) (int, error) {
	chunk, ok := <-p.output
	if !ok {
		return 0, io.EOF
	}
	return copy(data, chunk), nil
}
func (p *replyRecoveryPTY) Write(data []byte) (int, error) {
	p.calls++
	if p.calls <= 2 {
		p.written <- io.ErrClosedPipe
		return 0, io.ErrClosedPipe
	}
	n, err := p.input.Write(data)
	p.written <- err
	return n, err
}
func (p *replyRecoveryPTY) Kill() error  { p.once.Do(func() { close(p.output) }); return nil }
func (p *replyRecoveryPTY) Close() error { return p.Kill() }
func (p *replyRecoveryPTY) Wait() error  { return nil }

func TestReplyFailuresDoNotStopLaterRepliesOrOutput(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pty := &replyRecoveryPTY{output: make(chan []byte, 1), written: make(chan error, 3)}
	a := &activeSession{info: Session{ID: "reply-recovery", Phase: "running"}, current: &Block{ID: "block", SessionID: "reply-recovery", Status: "running"}, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), pty: pty, done: make(chan struct{}), temp: t.TempDir()}
	s.sessions[a.info.ID] = a
	go s.read(a)
	for index := 0; index < 3; index++ {
		pty.output <- []byte("AFTER_FAILURE\x1b[5n")
		select {
		case err := <-pty.written:
			if (err == nil) != (index == 2) {
				t.Fatalf("unexpected write result %d: %v", index, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("later terminal reply stopped")
		}
	}
	_ = pty.Close()
	select {
	case <-a.done:
	case <-time.After(3 * time.Second):
		t.Fatal("cleanup stopped")
	}
	if pty.calls != 3 || pty.input.String() != "\x1b[0n" {
		t.Fatalf("reply retried or lost: calls=%d data=%q", pty.calls, pty.input.String())
	}
	warnings := 0
	var output bytes.Buffer
	for _, event := range allEvents(t, s, a.info.ID) {
		if event.Type == "output" {
			output.Write(event.Data)
		}
		if event.Type == "state" {
			var state Session
			if err := json.Unmarshal(event.Data, &state); err != nil {
				t.Fatal(err)
			}
			if state.Phase == "running" && state.Warning != "" {
				warnings++
			}
		}
	}
	if warnings != 1 || !bytes.Equal(output.Bytes(), bytes.Repeat([]byte("AFTER_FAILURE\x1b[5n"), 3)) {
		t.Fatalf("warning flood or output loss: warnings=%d bytes=%q", warnings, output.String())
	}
}
