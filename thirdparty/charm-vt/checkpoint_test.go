package vt

import (
	"errors"
	"image/color"
	"io"
	"maps"
	"strings"
	"testing"
)

func checkpointTerminal(t *testing.T, cols, rows int) *Emulator {
	t.Helper()
	e := NewEmulator(cols, rows)
	t.Cleanup(func() { _ = e.Close(); _ = e.InputPipe().(io.Closer).Close() })
	return e
}

func TestCheckpointContinuation(t *testing.T) {
	for _, tc := range []struct{ name, prefix, suffix string }{
		{"rendition", "\x1b[31;48;5;27;4m", "界X"},
		{"saved-wrap", "abcdefgh\x1b7\r", "\x1b8\u0301X"},
		{"charset", "\x1b(0", "qx\x1b(BX"},
		{"single-shift", "\x1b*0\x1bN", "qX"},
		{"tab-stops", "\x1b[3g\x1b[1;4H\x1bH\r", "\tX"},
		{"margins-origin", "\x1b[2;3r\x1b[?6h", "\x1b[2;3HX\nY"},
		{"no-wrap", "\x1b[?7labcdefgh", "\u0301X"},
		{"alternate", "MAIN\x1b[?1049hALT", "界\x1b[?1049lX"},
		{"scrollback", strings.Repeat("history\r\n", 10), "next\r\n"},
		{"wide-scrollback", strings.Repeat("abcdef界\r\n", 10), "next\r\n"},
		{"insert", "abcdef\r\x1b[4h", "界X"},
		{"hyperlink", "\x1b]8;;https://example.test/\x1b\\", "X\x1b]8;;\x1b\\Y"},
		{"repeat", "A", "\x1b[3b"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := checkpointTerminal(t, 8, 3)
			_, _ = original.WriteString(tc.prefix)
			checkpoint, err := original.Checkpoint()
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := checkpoint.MarshalBinary()
			if err != nil {
				t.Fatal(err)
			}
			checkpoint, err = DecodeCheckpoint(encoded)
			if err != nil {
				t.Fatal(err)
			}
			restored := checkpointTerminal(t, 3, 2)
			_, _ = restored.WriteString("\x1b[31")
			if err := restored.RestoreCheckpoint(checkpoint); err != nil {
				t.Fatal(err)
			}
			_, _ = original.WriteString(tc.suffix)
			for _, b := range []byte(tc.suffix) {
				_, _ = restored.Write([]byte{b})
			}
			if original.Render() != restored.Render() || original.CursorPosition() != restored.CursorPosition() || original.atPhantom != restored.atPhantom || !maps.Equal(original.modes, restored.modes) {
				t.Fatalf("continuation differs: original=%q %v restored=%q %v", original.Render(), original.CursorPosition(), restored.Render(), restored.CursorPosition())
			}
			for i := range original.scrs {
				a, b := &original.scrs[i], &restored.scrs[i]
				for y := range a.Height() {
					for x := range a.Width() {
						if !a.CellAt(x, y).Equal(b.CellAt(x, y)) {
							t.Fatalf("screen %d cell %d,%d differs", i, x, y)
						}
					}
				}
				if a.scrollback.Len() != b.scrollback.Len() {
					t.Fatal("scrollback count differs")
				}
				for y, line := range a.scrollback.lines {
					for x := range line {
						if !line[x].Equal(&b.scrollback.lines[y][x]) {
							t.Fatal("scrollback cell differs")
						}
					}
				}
			}
		})
	}
}

func TestCheckpointRejectsPartialInput(t *testing.T) {
	for _, prefix := range []string{"\x1b", "\x1b[31", "\x1b]0;title", "\x1bPqdata", "\xe4\xb8"} {
		e := checkpointTerminal(t, 8, 3)
		_, _ = e.WriteString(prefix)
		if checkpoint, err := e.Checkpoint(); checkpoint != nil || !errors.Is(err, ErrCheckpointIncomplete) {
			t.Fatalf("partial input %q accepted: %v", prefix, err)
		}
	}
}

func TestCheckpointOwnershipAndTargetHandlers(t *testing.T) {
	original := checkpointTerminal(t, 8, 3)
	mutable := &color.RGBA{R: 123, A: 255}
	original.defaultFg = mutable
	original.scr.cur.Pen.Fg = mutable
	_, _ = original.WriteString("A")
	checkpoint, err := original.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	mutable.R = 42
	_, _ = original.WriteString("\rZ")
	_ = original.Close()
	first, second := checkpointTerminal(t, 2, 2), checkpointTerminal(t, 2, 2)
	for _, target := range []*Emulator{first, second} {
		if err := target.RestoreCheckpoint(checkpoint); err != nil {
			t.Fatal(err)
		}
		if target.CellAt(0, 0).Content != "A" {
			t.Fatal("snapshot aliased original screen")
		}
		r, _, _, _ := target.CellAt(0, 0).Style.Fg.RGBA()
		if r != 123*257 {
			t.Fatal("snapshot aliased mutable color")
		}
	}
	_, _ = first.WriteString("\rQ")
	if second.CellAt(0, 0).Content != "A" {
		t.Fatal("restores share screen storage")
	}
	called := 0
	bells := 0
	first.SetCallbacks(Callbacks{Bell: func() { bells++ }})
	first.RegisterOscHandler(99, func([]byte) bool { called++; return true })
	if err := first.RestoreCheckpoint(checkpoint); err != nil {
		t.Fatal(err)
	}
	if bells != 0 {
		t.Fatal("restore emitted callbacks")
	}
	for _, line := range first.Touched() {
		if line == nil {
			t.Fatal("restored screen not marked dirty")
		}
	}
	_, _ = first.WriteString("\x1b]99;test\a")
	if called != 1 || first.CellAt(0, 0).Content != "A" {
		t.Fatal("restore lost target handlers or mutated checkpoint")
	}
	_, _ = first.WriteString("\a")
	if bells != 1 {
		t.Fatal("target callback lost")
	}
	replies := make(chan string, 1)
	go func() {
		data := make([]byte, len("\x1b[1;2R"))
		n, _ := io.ReadFull(first, data)
		replies <- string(data[:n])
	}()
	_, _ = first.WriteString("\x1b[6n")
	if got := <-replies; got != "\x1b[1;2R" {
		t.Fatalf("target query pipe lost: %q", got)
	}
	if err := first.RestoreCheckpoint(nil); err == nil {
		t.Fatal("nil checkpoint accepted")
	}
	if _, err := original.Checkpoint(); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("closed source accepted")
	}
	if err := original.RestoreCheckpoint(checkpoint); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("closed target reopened")
	}
}
