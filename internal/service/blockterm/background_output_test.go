package blockterm

import (
	"bytes"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestBackgroundControlBoundaries(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	controls := "\x1b[31m\x1b]0;title text\x07\x1bPignored payload\x1b\\\x07"
	input := []byte(controls + "中文😀background\x1b[0m")
	for split := 0; split <= len(input); split++ {
		t.Run(fmt.Sprint(split), func(t *testing.T) {
			a := &activeSession{info: Session{ID: fmt.Sprintf("split-%d", split), Phase: "ready"}, vt: newEmulator(80, 24)}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			s.output(a, input[:split])
			if split <= len(controls) && a.background != nil {
				t.Fatal("control-only prefix created a background block")
			}
			s.output(a, input[split:])
			events, err := s.Events(a.info.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			var raw, output bytes.Buffer
			blocks := 0
			for _, event := range events {
				switch event.Type {
				case "block":
					blocks++
				case "terminal", "output":
					raw.Write(event.Data)
					if event.Type == "output" {
						output.Write(event.Data)
					}
				}
			}
			if blocks != 1 || !bytes.Equal(raw.Bytes(), input) || output.String() != "中文😀background\x1b[0m" {
				t.Fatalf("incorrect routing: blocks=%d raw=%q output=%q", blocks, raw.String(), output.String())
			}
			if !strings.Contains(a.vt.String(), "中文😀background") {
				t.Fatalf("grid reset split a control sequence or UTF-8: %q", a.vt.String())
			}
		})
	}
}

func TestBackgroundControlOnlyBytewise(t *testing.T) {
	a := &activeSession{}
	input := "\x1b[?2004h\x1b]0;" + strings.Repeat("title", 20000) + "\x1b\\\x1b[0m\r\n\x07"
	for _, ch := range []byte(input) {
		if a.backgroundTextStart([]byte{ch}) != -1 {
			t.Fatalf("control payload treated as text at %q", ch)
		}
	}
	if a.backgroundTextStart([]byte("hello")) != 0 {
		t.Fatal("text after controls not detected")
	}
}

func TestSelectGridPreservesNormalAttributes(t *testing.T) {
	a := &activeSession{vt: newEmulator(80, 24)}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	_, _ = a.vt.WriteString("\x1b[31mA")
	want := a.vt.CellAt(0, 0).Style.Fg
	if want == nil {
		t.Fatal("fixture did not set a foreground color")
	}
	(&Service{}).selectGrid(a, "background")
	_, _ = a.vt.WriteString("B")
	if got := a.vt.CellAt(0, 0); got.Content != "B" || !reflect.DeepEqual(got.Style.Fg, want) {
		t.Fatalf("grid switch lost text attributes: %+v, want foreground %v", got, want)
	}
}
