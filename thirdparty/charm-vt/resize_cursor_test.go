package vt

import (
	"fmt"
	"io"
	"testing"
)

func TestSavedCursorTracksScreenResize(t *testing.T) {
	for _, saveRestore := range [][2]string{{"\x1b7", "\x1b8"}, {"\x1b[s", "\x1b[u"}} {
		for _, size := range [][2]int{{4, 2}, {12, 4}} {
			t.Run(fmt.Sprintf("%q/%v", saveRestore, size), func(t *testing.T) {
				e := NewEmulator(8, 3)
				defer e.Close()
				defer e.InputPipe().(io.Closer).Close()
				_, _ = e.WriteString("\x1b[3;1Habcdefgh" + saveRestore[0] + "\x1b[H")
				e.Resize(size[0], size[1])
				_, _ = e.WriteString(saveRestore[1])
				wantX, wantY := min(8, size[0]-1), min(2, size[1]-1)
				if p := e.CursorPosition(); p.X != wantX || p.Y != wantY || e.atPhantom {
					t.Fatalf("saved cursor after resize: %v phantom=%v, want (%d,%d)", p, e.atPhantom, wantX, wantY)
				}
				_, _ = e.WriteString("X")
				if e.scr.CellAt(wantX, wantY).Content != "X" {
					t.Fatal("restored cursor lost output or wrapped prematurely")
				}
			})
		}
	}
}

func TestAlternateResizeUpdatesSavedPrimaryCursor(t *testing.T) {
	e := NewEmulator(8, 3)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	_, _ = e.WriteString("\x1b[3;1Habcdefgh\x1b[?1049h")
	e.Resize(4, 2)
	_, _ = e.WriteString("\x1b[?1049l")
	if p := e.CursorPosition(); p.X != 3 || p.Y != 1 || e.atPhantom {
		t.Fatalf("primary restore escaped resized bounds: %v phantom=%v", p, e.atPhantom)
	}
	_, _ = e.WriteString("X")
	if e.scr.CellAt(3, 1).Content != "X" {
		t.Fatal("output after alternate-screen exit lost")
	}
}

func TestResizeClampsSavedCursorWithoutChangingAttributes(t *testing.T) {
	e := NewEmulator(8, 3)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	_, _ = e.WriteString("\x1b[3;7H\x1b[31m\x1b7\x1b[H\x1b[0m")
	e.Resize(4, 2)
	_, _ = e.WriteString("\x1b8X")
	if cell := e.scr.CellAt(3, 1); cell.Content != "X" || cell.Style.Fg == nil {
		t.Fatalf("ordinary saved cursor or attributes lost: %#v", cell)
	}
}
