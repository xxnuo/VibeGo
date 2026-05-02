package vt

import (
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

// softReset restores input defaults without erasing either screen or leaving
// the alternate screen. Preserve the current cursor, unlike a hard reset.
func (e *Emulator) softReset() {
	x, y := e.scr.CursorPosition()
	phantom := e.atPhantom
	e.scr.scroll = e.scr.Bounds()
	for _, mode := range []ansi.Mode{
		ansi.ANSIMode(4), ansi.ModeCursorKeys, ansi.ModeNumericKeypad,
		ansi.ModeOrigin, ansi.ModeLeftRightMargin, ansi.ModeBracketedPaste,
		ansi.ModeFocusEvent, ansi.DECMode(45), ansi.DECMode(2026),
	} {
		e.setMode(mode, ansi.ModeReset)
	}
	e.setMode(ansi.ModeAutoWrap, ansi.ModeSet)
	e.setMode(ansi.ModeTextCursorEnable, ansi.ModeSet)
	e.scr.cur.Pen = uv.Style{}
	e.scr.cur.Link = uv.Link{}
	e.scr.saved = Cursor{}
	e.scr.savedPhantom = false
	e.gl, e.gr, e.gsingle = 0, 1, 0
	e.scr.savedCharset = &savedCharsetState{GR: 1}
	e.charsets = [4]CharSet{}
	e.setCursor(x, y)
	e.atPhantom = phantom
}
