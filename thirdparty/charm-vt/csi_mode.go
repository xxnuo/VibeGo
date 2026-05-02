package vt

import (
	"io"

	"github.com/charmbracelet/x/ansi"
)

func (e *Emulator) handleMode(params ansi.Params, set, isAnsi bool) {
	for _, p := range params {
		param := p.Param(-1)
		if param == -1 {
			// Missing parameter, ignore
			continue
		}

		var mode ansi.Mode = ansi.DECMode(param)
		if isAnsi {
			mode = ansi.ANSIMode(param)
		}

		setting := e.modes[mode]
		if setting == ansi.ModePermanentlyReset || setting == ansi.ModePermanentlySet {
			// Permanently set modes are ignored.
			continue
		}

		setting = ansi.ModeReset
		if set {
			setting = ansi.ModeSet
		}

		e.setMode(mode, setting)
	}
}

// setAltScreenMode sets the alternate screen mode.
func (e *Emulator) setAltScreenMode(on bool) {
	if (on && e.scr == &e.scrs[1]) || (!on && e.scr == &e.scrs[0]) {
		// Already in alternate screen mode, or normal screen, do nothing.
		return
	}
	if on {
		e.scr = &e.scrs[1]
		e.scrs[1].cur = e.scrs[0].cur
		e.scr.Clear()
		e.scr.ClearTouched()
	} else {
		e.scrs[0].cur = e.scrs[1].cur
		e.scr = &e.scrs[0]
	}
	if e.cb.AltScreen != nil {
		e.cb.AltScreen(on)
	}
	if e.cb.CursorVisibility != nil {
		e.cb.CursorVisibility(!e.scr.cur.Hidden)
	}
}

// saveCursor saves the cursor position.
func (e *Emulator) saveCursor() {
	e.scr.SaveCursor()
	e.scr.savedPhantom = e.atPhantom
	e.scr.savedCharset = (&savedCharsetState{e.charsets, e.gl, e.gr, e.gsingle}).clone()
}

// restoreCursor restores the cursor position.
func (e *Emulator) restoreCursor() {
	e.scr.RestoreCursor()
	e.atPhantom = e.scr.savedPhantom
	if state := e.scr.savedCharset.clone(); state != nil {
		e.charsets, e.gl, e.gr, e.gsingle = state.Charsets, state.GL, state.GR, state.Single
	}
}

// setMode sets the mode to the given value.
func (e *Emulator) setMode(mode ansi.Mode, setting ansi.ModeSetting) {
	e.logf("setting mode %T(%v) to %v", mode, mode, setting)
	e.modes[mode] = setting
	switch mode {
	case ansi.ModeOrigin:
		e.setCursorPosition(0, 0)
	case ansi.ModeTextCursorEnable:
		e.scr.setCursorHidden(!setting.IsSet())
	case ansi.ModeAltScreen, ansi.DECMode(47):
		e.setAltScreenMode(setting.IsSet())
	case ansi.ModeSaveCursor:
		if setting.IsSet() {
			e.saveCursor()
		} else {
			e.restoreCursor()
		}
	case ansi.ModeAltScreenSaveCursor: // Alternate Screen Save Cursor (1047 & 1048)
		// Save primary screen cursor position
		// Switch to alternate screen
		// Doesn't support scrollback
		wasAlternate := e.IsAltScreen()
		if setting.IsSet() && !wasAlternate {
			e.saveCursor()
		}
		e.setAltScreenMode(setting.IsSet())
		if setting.IsSet() && !wasAlternate {
			e.setCursor(0, 0)
		}
		if !setting.IsSet() && wasAlternate {
			e.restoreCursor()
		}
	case ansi.ModeInBandResize:
		if setting.IsSet() {
			_, _ = io.WriteString(e.pw, ansi.InBandResize(e.Height(), e.Width(), 0, 0))
		}
	}
	if setting.IsSet() {
		if e.cb.EnableMode != nil {
			e.cb.EnableMode(mode)
		}
	} else if setting.IsReset() {
		if e.cb.DisableMode != nil {
			e.cb.DisableMode(mode)
		}
	}
}

// isModeSet returns true if the mode is set.
func (e *Emulator) isModeSet(mode ansi.Mode) bool {
	m, ok := e.modes[mode]
	return ok && m.IsSet()
}
