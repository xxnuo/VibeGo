package vt

import "github.com/charmbracelet/x/ansi"

const maxControlStringBytes = 4 << 20

// handleDcs handles a DCS escape sequence.
func (e *Emulator) handleDcs(cmd ansi.Cmd, params ansi.Params, data []byte) {
	e.flushGrapheme() // Flush any pending grapheme before handling DCS sequences.
	if len(data) > maxControlStringBytes {
		return
	}
	if !e.handlers.handleDcs(cmd, params, data) {
		e.logf("unhandled sequence: DCS %q %q", paramsString(cmd, params), data)
	}
}

// handleApc handles an APC escape sequence.
func (e *Emulator) handleApc(data []byte) {
	e.flushGrapheme() // Flush any pending grapheme before handling APC sequences.
	if len(data) > maxControlStringBytes {
		return
	}
	if !e.handlers.handleApc(data) {
		e.logf("unhandled sequence: APC %q", data)
	}
}

// handleSos handles an SOS escape sequence.
func (e *Emulator) handleSos(data []byte) {
	e.flushGrapheme() // Flush any pending grapheme before handling SOS sequences.
	if len(data) > maxControlStringBytes {
		return
	}
	if !e.handlers.handleSos(data) {
		e.logf("unhandled sequence: SOS %q", data)
	}
}

// handlePm handles a PM escape sequence.
func (e *Emulator) handlePm(data []byte) {
	e.flushGrapheme() // Flush any pending grapheme before handling PM sequences.
	if len(data) > maxControlStringBytes {
		return
	}
	if !e.handlers.handlePm(data) {
		e.logf("unhandled sequence: PM %q", data)
	}
}
