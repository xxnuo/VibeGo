package blockterm

import (
	"bytes"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestCSIFilterReadBoundaries(t *testing.T) {
	input := []byte("echo 中文\x1b[?2004lmore\x1b[31mtext\x1b[0m\x1b[1 q\r\n")
	want := "\x1b[?2004l\x1b[31m\x1b[0m\x1b[1 q"
	for split := 0; split <= len(input); split++ {
		var filter csiFilter
		got := append(filter.feed(input[:split]), filter.feed(input[split:])...)
		if string(got) != want {
			t.Fatalf("split %d: %q", split, got)
		}
	}
	var filter csiFilter
	var got []byte
	for _, ch := range input {
		got = append(got, filter.feed([]byte{ch})...)
	}
	if string(got) != want {
		t.Fatalf("bytewise: %q", got)
	}
}

func TestCSIFilterRecoveryAndBound(t *testing.T) {
	for _, input := range []string{
		"\x1b[12\x18m", "\x1b[1 2m", "\x1b[" + strings.Repeat("1", 10000) + "m",
	} {
		var filter csiFilter
		if got := filter.feed([]byte(input)); len(got) != 0 {
			t.Fatalf("invalid CSI escaped: %q", got)
		}
		if len(filter.pending) > 4096 {
			t.Fatal("unbounded pending sequence")
		}
		if got := filter.feed([]byte("\x1b[?2004h")); string(got) != "\x1b[?2004h" {
			t.Fatalf("did not recover: %q", got)
		}
	}
	var filter csiFilter
	filter.feed([]byte("\x1b[?2004"))
	filter.reset()
	if got := filter.feed([]byte("l")); len(got) != 0 {
		t.Fatalf("sequence crossed command boundary: %q", got)
	}
}

func TestCSIFilterEmbeddedControls(t *testing.T) {
	for _, control := range []byte{0, 7, 8, 9, 10, 13, 0x7f} {
		var escapeFilter csiFilter
		escaped := append([]byte{0x1b, control}, []byte("[?2004l")...)
		var escapeOutput []byte
		for _, ch := range escaped {
			escapeOutput = append(escapeOutput, escapeFilter.feed([]byte{ch})...)
		}
		if !bytes.Equal(escapeOutput, escaped) {
			t.Fatalf("control %x cancelled escape: %q", control, escapeOutput)
		}
		input := append([]byte("\x1b[?20"), control)
		input = append(input, []byte("04l")...)
		for split := 0; split <= len(input); split++ {
			var filter csiFilter
			got := append(filter.feed(input[:split]), filter.feed(input[split:])...)
			if !bytes.Equal(got, input) {
				t.Fatalf("control %x split %d: %q", control, split, got)
			}
		}
	}
	for _, cancel := range []byte{0x18, 0x1a} {
		var filter csiFilter
		input := append([]byte("\x1b[?20"), cancel)
		input = append(input, []byte("04l\x1b[?2004h")...)
		if got := filter.feed(input); string(got) != "\x1b[?2004h" {
			t.Fatalf("cancel %x did not discard CSI: %q", cancel, got)
		}
	}
}

func TestSubmittedOutputPreservesSplitControls(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{info: Session{ID: "split-echo", Phase: "submitted"}, current: &Block{ID: "command"}, vt: newEmulator(80, 24), accepted: true}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	input := []byte("echo hello\x1b[?2004l\r\n")
	for _, ch := range input {
		s.output(a, []byte{ch})
	}
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 1 || events[0].Type != "terminal" || string(events[0].Data) != "\x1b[?2004l" {
		t.Fatalf("split CSI lost or echo published: %+v %v", events, err)
	}
	if !bytes.Equal(a.pendingOutput, input) {
		t.Fatalf("pending diagnostic bytes changed: %q", a.pendingOutput)
	}
}
