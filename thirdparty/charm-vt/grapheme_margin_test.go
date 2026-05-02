package vt

import (
	"fmt"
	"io"
	"testing"
)

func TestGrowingClusterPartitionMatrix(t *testing.T) {
	for _, initial := range []string{"abcdefgh", "abcdef中", "abcde中X", "ab中efgh", "中中中中"} {
		for col := 1; col <= 8; col++ {
			for _, mode := range []string{"", "\x1b[4h", "\x1b[?7l", "\x1b[4h\x1b[?7l"} {
				for _, cluster := range []string{"❤\ufe0f", "1\ufe0f\u20e3", "🇨🇳", "👩‍💻", "❤\ufe0fX", "1\ufe0f\u20e3X", "🇨🇳X", "👩‍💻X"} {
					t.Run(fmt.Sprintf("%s/%d/%q/%s", initial, col, mode, cluster), func(t *testing.T) {
						whole, split := NewEmulator(8, 3), NewEmulator(8, 3)
						defer whole.Close()
						defer split.Close()
						defer whole.InputPipe().(io.Closer).Close()
						defer split.InputPipe().(io.Closer).Close()
						prefix := initial + "\r\n12345678\x1b[1;" + fmt.Sprint(col) + "H" + mode
						_, _ = whole.WriteString(prefix)
						_, _ = split.WriteString(prefix)
						_, _ = whole.WriteString(cluster)
						for _, b := range []byte(cluster) {
							_, _ = split.Write([]byte{b})
						}
						if whole.Render() != split.Render() || whole.CursorPosition() != split.CursorPosition() {
							t.Fatalf("partition divergence: whole=%q %v split=%q %v", whole.Render(), whole.CursorPosition(), split.Render(), split.CursorPosition())
						}
					})
				}
			}
		}
	}
}

func TestNoWrapMarginCombiningAndMovement(t *testing.T) {
	for _, prefix := range []string{"", "\x1b[?1049h"} {
		t.Run(fmt.Sprintf("%q", prefix), func(t *testing.T) {
			e := NewEmulator(5, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString(prefix + "\x1b[?7labcde")
			_, _ = e.WriteString("\u0301")
			if e.scr.CellAt(3, 0).Content != "d" || e.scr.CellAt(4, 0).Content != "e\u0301" {
				t.Fatalf("combining mark attached to wrong column: %q", e.String())
			}
			_, _ = e.WriteString("❤")
			_, _ = e.WriteString("\ufe0f")
			if e.scr.CellAt(4, 0).Content != "❤" || e.scr.CellAt(4, 0).Width != 1 {
				t.Fatalf("no-wrap growth must preserve narrow base: %#v", e.scr.CellAt(4, 0))
			}
			_, _ = e.WriteString("X\u0308")
			if e.scr.CellAt(4, 0).Content != "X\u0308" || e.CursorPosition().X != 4 || e.CursorPosition().Y != 0 {
				t.Fatalf("no-wrap replacement moved cursor: %q %v", e.String(), e.CursorPosition())
			}
			_, _ = e.WriteString("\x1b[1;5H\u0301")
			if e.scr.CellAt(3, 0).Content != "d\u0301" {
				t.Fatal("explicit cursor movement must cancel margin attachment")
			}
			_, _ = e.WriteString("\rY")
			if e.scr.CellAt(0, 0).Content != "Y" || e.CursorPosition().X != 1 {
				t.Fatal("carriage return must cancel margin state")
			}
		})
	}
}
