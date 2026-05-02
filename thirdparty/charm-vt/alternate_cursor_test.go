package vt

import (
	"fmt"
	"io"
	"testing"
)

func TestAlternateScreenWithoutSavedCursor(t *testing.T) {
	for _, mode := range []int{47, 1047} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			e := NewEmulator(8, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			on, off := fmt.Sprintf("\x1b[?%dh", mode), fmt.Sprintf("\x1b[?%dl", mode)
			_, _ = e.WriteString("NORMAL\x1b[2;4H" + on)
			if p := e.CursorPosition(); !e.IsAltScreen() || p.X != 3 || p.Y != 1 {
				t.Fatalf("alternate entry changed position: alt=%v cursor=%v", e.IsAltScreen(), p)
			}
			_, _ = e.WriteString("A" + on)
			if e.scr.CellAt(3, 1).Content != "A" {
				t.Fatal("repeated mode enable cleared alternate content")
			}
			e.Resize(4, 2)
			_, _ = e.WriteString("\x1b[1;2H" + off + "X")
			if e.IsAltScreen() || e.scr.CellAt(1, 0).Content != "X" || e.CursorPosition().X != 2 {
				t.Fatalf("alternate exit restored stale cursor: %q %v", e.String(), e.CursorPosition())
			}
			_, _ = e.WriteString(on)
			if e.scr.CellAt(3, 1).Content == "A" {
				t.Fatal("new alternate screen retained old content")
			}
			_, _ = e.WriteString("\x1b[H\x1b[31mABCD" + off + "X")
			if cell := e.scr.CellAt(0, 1); cell.Content != "X" || cell.Style.Fg == nil {
				t.Fatalf("buffer switch lost pending wrap or rendition: %#v", cell)
			}
		})
	}
}
