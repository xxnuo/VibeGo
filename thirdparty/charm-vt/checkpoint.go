package vt

import (
	"errors"
	"image/color"
	"io"
	"maps"
	"slices"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
)

// ErrCheckpointIncomplete means a control sequence or UTF-8 rune is unfinished.
var ErrCheckpointIncomplete = errors.New("terminal checkpoint requires a complete parser boundary")

// Checkpoint is an immutable, in-memory continuation of built-in terminal state.
// It does not capture I/O, callbacks or application-defined handler state, and
// can be encoded with MarshalBinary. Callers must serialize access to an Emulator.
type Checkpoint struct {
	state *Emulator
}

// Dimensions reports the saved grid geometry, or zeroes for an invalid value.
func (c *Checkpoint) Dimensions() (cols, rows int) {
	if c == nil || c.state == nil {
		return 0, 0
	}
	return c.state.Width(), c.state.Height()
}

// Checkpoint captures both screens, scrollback and non-visible continuation
// state. It never silently drops a partially received escape sequence or rune.
func (e *Emulator) Checkpoint() (*Checkpoint, error) {
	if e.closed {
		return nil, io.ErrClosedPipe
	}
	if e.parser.State() != parser.GroundState || len(e.grapheme) != 0 {
		return nil, ErrCheckpointIncomplete
	}
	return &Checkpoint{state: e.copyCheckpointState()}, nil
}

// RestoreCheckpoint replaces terminal state while retaining this instance's
// I/O, registered handlers and callbacks. It emits no replies or callbacks.
// Each restore makes independent copies; a checkpoint can be restored repeatedly.
func (e *Emulator) RestoreCheckpoint(checkpoint *Checkpoint) error {
	if e.closed {
		return io.ErrClosedPipe
	}
	if checkpoint == nil || checkpoint.state == nil {
		return errors.New("invalid terminal checkpoint")
	}
	state := checkpoint.state.copyCheckpointState()
	state.parser, state.pr, state.pw = e.parser, e.pr, e.pw
	state.handlers, state.cb, state.logger = e.handlers, e.cb, e.logger
	*e = *state
	for i := range e.scrs {
		e.scrs[i].cb = &e.cb
		for y := range e.scrs[i].Height() {
			e.scrs[i].buf.TouchLine(0, y, e.scrs[i].Width())
		}
	}
	// The screen pointer in state points into that temporary copy's array.
	if state.scr == &state.scrs[1] {
		e.scr = &e.scrs[1]
	} else {
		e.scr = &e.scrs[0]
	}
	e.parser.Reset()
	return nil
}

func (e *Emulator) copyCheckpointState() *Emulator {
	state := *e
	state.parser, state.pr, state.pw = nil, nil, nil
	state.handlers, state.cb, state.logger = handlers{}, Callbacks{}, nil
	state.grapheme = nil
	state.modes = maps.Clone(e.modes)
	for i, charset := range e.charsets {
		state.charsets[i] = maps.Clone(charset)
	}
	state.tabstops = uv.DefaultTabStops(e.tabstops.Width())
	state.tabstops.Clear()
	for x := range e.tabstops.Width() {
		if e.tabstops.IsStop(x) {
			state.tabstops.Set(x)
		}
	}
	for i, c := range e.colors {
		state.colors[i] = checkpointColor(c)
	}
	state.defaultFg, state.defaultBg, state.defaultCur = checkpointColor(e.defaultFg), checkpointColor(e.defaultBg), checkpointColor(e.defaultCur)
	state.fgColor, state.bgColor, state.curColor = checkpointColor(e.fgColor), checkpointColor(e.bgColor), checkpointColor(e.curColor)
	for i := range e.scrs {
		source, target := &e.scrs[i], &state.scrs[i]
		target.cb = nil
		target.savedCharset = source.savedCharset.clone()
		target.wrapped = slices.Clone(source.wrapped)
		target.cur.Pen, target.saved.Pen = checkpointStyle(source.cur.Pen), checkpointStyle(source.saved.Pen)
		target.buf = uv.NewRenderBuffer(source.Width(), source.Height())
		for y, line := range source.buf.Lines {
			copy(target.buf.Lines[y], checkpointLine(line))
		}
		if source.scrollback != nil {
			target.scrollback = &Scrollback{maxLines: source.scrollback.maxLines, lines: make([]uv.Line, len(source.scrollback.lines))}
			target.scrollback.wrapped = slices.Clone(source.scrollback.wrapped)
			for y, line := range source.scrollback.lines {
				target.scrollback.lines[y] = checkpointLine(line)
			}
		}
	}
	if e.scr == &e.scrs[1] {
		state.scr = &state.scrs[1]
	} else {
		state.scr = &state.scrs[0]
	}
	return &state
}

func checkpointLine(line uv.Line) uv.Line {
	result := make(uv.Line, len(line))
	for x, cell := range line {
		result[x] = cell
		result[x].Style = checkpointStyle(cell.Style)
	}
	return result
}

func checkpointStyle(style uv.Style) uv.Style {
	style.Fg, style.Bg, style.UnderlineColor = checkpointColor(style.Fg), checkpointColor(style.Bg), checkpointColor(style.UnderlineColor)
	return style
}

func checkpointColor(c color.Color) color.Color {
	switch c.(type) {
	case nil, ansi.BasicColor, ansi.IndexedColor, ansi.TrueColor, ansi.RGBColor:
		return c
	default:
		r, g, b, a := c.RGBA()
		return color.RGBA64{R: uint16(r), G: uint16(g), B: uint16(b), A: uint16(a)}
	}
}
