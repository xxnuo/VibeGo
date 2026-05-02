package vt

import (
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/exp/ordered"
)

// Screen represents a virtual terminal screen.
type Screen struct {
	// cb is the callbacks struct to use.
	cb *Callbacks
	// The buffer of the screen.
	buf *uv.RenderBuffer
	// wrapped marks rows continued from their predecessor. Nil means unknown
	// layout (legacy checkpoints or unsupported horizontal/reflow operations).
	wrapped []bool
	// The cur of the screen.
	cur, saved   Cursor
	savedPhantom bool
	savedCharset *savedCharsetState
	// scroll is the scroll region.
	scroll uv.Rectangle
	// scrollback is the scrollback buffer for lines scrolled off the top.
	scrollback *Scrollback
}

// NewScreen creates a new screen.
func NewScreen(w, h int) *Screen {
	s := Screen{
		savedCharset: &savedCharsetState{GR: 1},
		buf:          uv.NewRenderBuffer(w, h),
		wrapped:      make([]bool, h),
		scrollback:   NewScrollback(DefaultScrollbackSize),
	}
	s.scroll = s.buf.Bounds()
	return &s
}

// Reset resets the screen.
// It clears the screen, sets the cursor to the top left corner, reset the
// cursor styles, and resets the scroll region.
func (s *Screen) Reset() {
	s.buf.Clear()
	s.wrapped = make([]bool, s.Height())
	s.cur = Cursor{}
	s.saved = Cursor{}
	s.savedPhantom = false
	s.savedCharset = &savedCharsetState{GR: 1}
	s.scroll = s.buf.Bounds()
	s.buf.Touched = nil
}

// Bounds returns the bounds of the screen.
func (s *Screen) Bounds() uv.Rectangle {
	return s.buf.Bounds()
}

// Touched returns touched lines in the screen buffer.
func (s *Screen) Touched() []*uv.LineData {
	return s.buf.Touched
}

// ClearTouched clears the touched state.
func (s *Screen) ClearTouched() {
	s.buf.Touched = nil
}

// CellAt returns the cell at the given x, y position.
func (s *Screen) CellAt(x int, y int) *uv.Cell {
	return s.buf.CellAt(x, y)
}

// SetCell sets the cell at the given x, y position.
func (s *Screen) SetCell(x, y int, c *uv.Cell) {
	s.buf.SetCell(x, y, c)
}

// Height returns the height of the screen.
func (s *Screen) Height() int {
	return s.buf.Height()
}

// Resize resizes the screen.
func (s *Screen) Resize(width int, height int) {
	if s.buf != nil && width != s.Width() {
		// Width reflow needs logical-line reconstruction; do not invent flags.
		s.wrapped = nil
	} else if s.wrapped != nil {
		rows := make([]bool, height)
		copy(rows, s.wrapped)
		s.wrapped = rows
	}
	if s.buf != nil && width != s.buf.Width() && s.savedPhantom {
		// A saved right-margin position is logically one column after the
		// visible cursor. Materialize that position before clamping it to the
		// new geometry, rather than restoring a stale pending-wrap flag.
		s.saved.X++
		s.savedPhantom = false
	}
	s.saved.X = max(0, min(s.saved.X, width-1))
	s.saved.Y = max(0, min(s.saved.Y, height-1))
	if s.buf == nil {
		s.buf = uv.NewRenderBuffer(width, height)
	} else {
		s.buf.Resize(width, height)
		s.buf.Touched = nil
	}
	s.scroll = s.buf.Bounds()
}

// Width returns the width of the screen.
func (s *Screen) Width() int {
	return s.buf.Width()
}

// Clear clears the screen with blank cells.
func (s *Screen) Clear() {
	s.ClearArea(s.Bounds())
}

// ClearWithScrollback saves all non-empty lines to scrollback before clearing.
// This is used for operations like ED 2 (erase screen) where content should
// be preserved in history.
func (s *Screen) ClearWithScrollback() {
	if s.scrollback != nil {
		// Save all lines that have content before clearing
		for y := 0; y < s.buf.Height(); y++ {
			line := s.buf.Line(y)
			if line != nil && !s.isLineEmpty(line) {
				s.scrollback.pushWrapped(line, s.isWrapped(y), s.wrapped != nil)
			}
		}
	}
	s.Clear()
}

// isLineEmpty returns true if the line contains only empty/space cells.
func (s *Screen) isLineEmpty(line uv.Line) bool {
	for _, cell := range line {
		if cell.Content != "" && cell.Content != " " {
			return false
		}
	}
	return true
}

// ClearArea clears the given area.
func (s *Screen) ClearArea(area uv.Rectangle) {
	s.clearWraps(area)
	s.buf.ClearArea(area)
	s.touchArea(area)
}

// Fill fills the screen or part of it.
func (s *Screen) Fill(c *uv.Cell) {
	s.FillArea(c, s.Bounds())
}

// FillArea fills the given area with the given cell.
func (s *Screen) FillArea(c *uv.Cell, area uv.Rectangle) {
	s.clearWraps(area)
	s.buf.FillArea(c, area)
	s.touchArea(area)
}

// eraseArea erases complete glyphs at either edge using the current erase
// background, including a wide glyph's half outside the requested area.
func (s *Screen) eraseArea(area uv.Rectangle) {
	area = area.Intersect(s.Bounds())
	if area.Empty() {
		return
	}
	for y := area.Min.Y; y < area.Max.Y; y++ {
		left, right := area.Min.X, area.Max.X
		for left > 0 && s.CellAt(left, y).Width == 0 {
			left--
		}
		for right < s.Width() && s.CellAt(right, y).Width == 0 {
			right++
		}
		// Cell erasure alone (ECH, wide-cell repair) does not sever a logical
		// line. ED/EL handlers explicitly clear wrap metadata where required.
		rect := uv.Rect(left, y, right-left, 1)
		s.buf.FillArea(s.blankCell(), rect)
		s.touchArea(rect)
	}
}

// setHorizontalMargins sets the horizontal margins.
func (s *Screen) setHorizontalMargins(left, right int) {
	s.scroll.Min.X = left
	s.scroll.Max.X = right
}

// setVerticalMargins sets the vertical margins.
func (s *Screen) setVerticalMargins(top, bottom int) {
	s.scroll.Min.Y = top
	s.scroll.Max.Y = bottom
}

// setCursorX sets the cursor X position. If margins is true, the cursor is
// only set if it is within the scroll margins.
func (s *Screen) setCursorX(x int, margins bool) {
	s.setCursor(x, s.cur.Y, margins)
}

// setCursor sets the cursor position. If margins is true, the cursor is only
// set if it is within the scroll margins. This follows how [ansi.CUP] works.
func (s *Screen) setCursor(x, y int, margins bool) {
	old := s.cur.Position
	if !margins {
		y = ordered.Clamp(y, 0, s.buf.Height()-1)
		x = ordered.Clamp(x, 0, s.buf.Width()-1)
	} else {
		y = ordered.Clamp(s.scroll.Min.Y+y, s.scroll.Min.Y, s.scroll.Max.Y-1)
		x = ordered.Clamp(s.scroll.Min.X+x, s.scroll.Min.X, s.scroll.Max.X-1)
	}
	s.cur.X, s.cur.Y = x, y

	if s.cb.CursorPosition != nil && (old.X != x || old.Y != y) {
		s.cb.CursorPosition(old, uv.Pos(x, y))
	}
}

// moveCursor moves the cursor by the given x and y deltas. Each scroll margin
// bounds movement unless the cursor is already outside that side, in which
// case that side uses the screen edge instead.
// This follows how [ansi.CUU], [ansi.CUD], [ansi.CUF], [ansi.CUB], [ansi.CNL],
// [ansi.CPL].
func (s *Screen) moveCursor(dx, dy int) {
	scroll := s.scroll
	old := s.cur.Position
	if old.X < scroll.Min.X {
		scroll.Min.X = 0
	}
	if old.X >= scroll.Max.X {
		scroll.Max.X = s.buf.Width()
	}

	// Outside one margin, only relax that side. Moving back across the
	// region must still stop at its opposite margin.
	if old.Y < scroll.Min.Y {
		scroll.Min.Y = 0
	}
	if old.Y >= scroll.Max.Y {
		scroll.Max.Y = s.buf.Height()
	}
	pt := uv.Pos(s.cur.X+dx, s.cur.Y+dy)
	x := ordered.Clamp(pt.X, scroll.Min.X, scroll.Max.X-1)
	y := ordered.Clamp(pt.Y, scroll.Min.Y, scroll.Max.Y-1)

	s.cur.X, s.cur.Y = x, y

	if s.cb.CursorPosition != nil && (old.X != x || old.Y != y) {
		s.cb.CursorPosition(old, uv.Pos(x, y))
	}
}

// Cursor returns the cursor.
func (s *Screen) Cursor() Cursor {
	return s.cur
}

// CursorPosition returns the cursor position.
func (s *Screen) CursorPosition() (x, y int) {
	return s.cur.X, s.cur.Y
}

// ScrollRegion returns the scroll region.
func (s *Screen) ScrollRegion() uv.Rectangle {
	return s.scroll
}

// SaveCursor saves the cursor.
func (s *Screen) SaveCursor() {
	s.saved = s.cur
}

// RestoreCursor restores the cursor.
func (s *Screen) RestoreCursor() {
	old := s.cur.Position
	s.cur = s.saved

	if s.cb.CursorPosition != nil && (old.X != s.cur.X || old.Y != s.cur.Y) {
		s.cb.CursorPosition(old, s.cur.Position)
	}
}

// setCursorHidden sets the cursor hidden.
func (s *Screen) setCursorHidden(hidden bool) {
	changed := s.cur.Hidden != hidden
	s.cur.Hidden = hidden
	if changed && s.cb.CursorVisibility != nil {
		s.cb.CursorVisibility(!hidden)
	}
}

// setCursorStyle sets the cursor style.
func (s *Screen) setCursorStyle(style CursorStyle, blink bool) {
	changed := s.cur.Style != style || s.cur.Steady != !blink
	s.cur.Style = style
	s.cur.Steady = !blink
	if changed && s.cb.CursorStyle != nil {
		s.cb.CursorStyle(style, !blink)
	}
}

// cursorPen returns the cursor pen.
func (s *Screen) cursorPen() uv.Style {
	return s.cur.Pen
}

// cursorLink returns the cursor link.
func (s *Screen) cursorLink() uv.Link {
	return s.cur.Link
}

// ShowCursor shows the cursor.
func (s *Screen) ShowCursor() {
	s.setCursorHidden(false)
}

// HideCursor hides the cursor.
func (s *Screen) HideCursor() {
	s.setCursorHidden(true)
}

// InsertCell inserts n blank characters at the cursor position pushing out
// cells to the right and out of the screen.
func (s *Screen) InsertCell(n int) {
	s.insertCells(s.cur.X, s.cur.Y, n)
}

func (s *Screen) insertCells(x, y, n int) {
	area := s.scroll.Intersect(s.Bounds())
	if n <= 0 || !uv.Pos(x, y).In(area) {
		return
	}
	n = min(n, area.Max.X-x)
	if s.CellAt(x, y).Width == 0 {
		s.eraseArea(uv.Rect(x, y, 1, 1))
	}
	cut := area.Max.X - n
	if cut > x && s.CellAt(cut, y).Width == 0 {
		s.eraseArea(uv.Rect(cut, y, 1, 1))
	}
	line := s.buf.Lines[y]
	copy(line[x+n:area.Max.X], line[x:area.Max.X-n])
	blank := uv.EmptyCell
	if cell := s.blankCell(); cell != nil {
		blank = *cell
	}
	// The old insertion cells can still contain wide-glyph heads. Using
	// SetCell here would erase their already-shifted neighbors a second time.
	for i := x; i < x+n; i++ {
		line[i] = blank
	}
	s.touchArea(uv.Rect(x, y, area.Max.X-x, 1))
}

// DeleteCell deletes n cells at the cursor position moving cells to the left.
// This has no effect if the cursor is outside the scroll region.
func (s *Screen) DeleteCell(n int) {
	x, y := s.cur.X, s.cur.Y
	area := s.scroll.Intersect(s.Bounds())
	if n <= 0 || !uv.Pos(x, y).In(area) {
		return
	}
	n = min(n, area.Max.X-x)
	if s.CellAt(x, y).Width == 0 {
		s.eraseArea(uv.Rect(x, y, 1, 1))
	}
	if end := x + n; end < area.Max.X && s.CellAt(end, y).Width == 0 {
		s.eraseArea(uv.Rect(end, y, 1, 1))
	}
	line := s.buf.Lines[y]
	copy(line[x:area.Max.X-n], line[x+n:area.Max.X])
	blank := uv.EmptyCell
	if cell := s.blankCell(); cell != nil {
		blank = *cell
	}
	for i := area.Max.X - n; i < area.Max.X; i++ {
		line[i] = blank
	}
	s.touchArea(uv.Rect(x, y, area.Max.X-x, 1))
}

// ScrollUp scrolls the content up n lines within the given region. Lines
// scrolled past the top margin are lost. This is equivalent to [ansi.SU] which
// moves the cursor to the top margin and performs a [ansi.DL] operation.
func (s *Screen) ScrollUp(n int) {
	x, y := s.CursorPosition()
	s.setCursor(s.cur.X, 0, true)
	s.DeleteLine(n)
	s.setCursor(x, y, false)
}

// ScrollDown scrolls the content down n lines within the given region. Lines
// scrolled past the bottom margin are lost. This is equivalent to [ansi.SD]
// which moves the cursor to top margin and performs a [ansi.IL] operation.
func (s *Screen) ScrollDown(n int) {
	x, y := s.CursorPosition()
	s.setCursor(s.cur.X, 0, true)
	s.InsertLine(n)
	s.setCursor(x, y, false)
}

// InsertLine inserts n blank lines at the cursor position Y coordinate.
// Only operates if cursor is within scroll region. Lines below cursor Y
// are moved down, with those past bottom margin being discarded.
// It returns true if the operation was successful.
func (s *Screen) InsertLine(n int) bool {
	if n <= 0 {
		return false
	}

	x, y := s.cur.X, s.cur.Y

	// Only operate if cursor Y is within scroll region
	if y < s.scroll.Min.Y || y >= s.scroll.Max.Y ||
		x < s.scroll.Min.X || x >= s.scroll.Max.X {
		return false
	}

	s.buf.InsertLineArea(y, n, s.blankCell(), s.scroll)
	s.shiftWraps(y, min(n, s.scroll.Max.Y-y), false)

	return true
}

// DeleteLine deletes n lines at the cursor position Y coordinate.
// Only operates if cursor is within scroll region. Lines below cursor Y
// are moved up, with blank lines inserted at the bottom of scroll region.
// If scrollback is enabled and cursor is at top of scroll region, lines
// are saved to the scrollback buffer before deletion.
// It returns true if the operation was successful.
func (s *Screen) DeleteLine(n int) bool {
	if n <= 0 {
		return false
	}

	scroll := s.scroll
	x, y := s.cur.X, s.cur.Y

	// Only operate if cursor Y is within scroll region
	if y < scroll.Min.Y || y >= scroll.Max.Y ||
		x < scroll.Min.X || x >= scroll.Max.X {
		return false
	}

	// Save lines to scrollback if we're at the top of the scroll region
	// and the scroll region uses the full width (typical terminal scroll).
	// This captures lines that would be lost during scroll up operations.
	if s.scrollback != nil && y == scroll.Min.Y &&
		scroll.Min.X == 0 && scroll.Max.X == s.buf.Width() {
		// Save lines that will be deleted
		linesToSave := min(n, scroll.Max.Y-y)
		for row := y; row < y+linesToSave; row++ {
			s.scrollback.pushWrapped(s.buf.Line(row), s.isWrapped(row), s.wrapped != nil)
		}
	}

	s.buf.DeleteLineArea(y, n, s.blankCell(), scroll)
	s.shiftWraps(y, min(n, scroll.Max.Y-y), true)

	return true
}

func (s *Screen) isWrapped(y int) bool {
	return y >= 0 && y < len(s.wrapped) && s.wrapped[y]
}

func (s *Screen) setWrapped(y int, wrapped bool) {
	if y >= 0 && y < len(s.wrapped) {
		s.wrapped[y] = wrapped
	}
}

func (s *Screen) clearWraps(area uv.Rectangle) {
	area = area.Intersect(s.Bounds())
	if area.Min.X == 0 {
		for y := area.Min.Y; y < area.Max.Y; y++ {
			s.setWrapped(y, false)
		}
	}
}

func (s *Screen) shiftWraps(y, n int, up bool) {
	if s.scroll.Min.X != 0 || s.scroll.Max.X != s.Width() {
		s.wrapped = nil
		return
	}
	if s.wrapped == nil {
		return
	}
	end := s.scroll.Max.Y
	if up {
		copy(s.wrapped[y:end-n], s.wrapped[y+n:end])
		clear(s.wrapped[end-n : end])
	} else {
		copy(s.wrapped[y+n:end], s.wrapped[y:end-n])
		clear(s.wrapped[y : y+n])
	}
}

// blankCell returns the cursor blank cell with the background color set to the
// current pen background color. If the pen background color is nil, the return
// value is nil.
func (s *Screen) blankCell() *uv.Cell {
	if s.cur.Pen.Bg == nil {
		return nil
	}

	c := uv.EmptyCell
	c.Style.Bg = s.cur.Pen.Bg
	return &c
}

// touchArea marks all lines in the given area as touched.
func (s *Screen) touchArea(area uv.Rectangle) {
	for y := area.Min.Y; y < area.Max.Y; y++ {
		s.buf.TouchLine(area.Min.X, y, area.Max.X-area.Min.X)
	}
}

// Scrollback returns the screen's scrollback buffer.
func (s *Screen) Scrollback() *Scrollback {
	return s.scrollback
}

// SetScrollback sets the screen's scrollback buffer.
// Pass nil to disable scrollback.
func (s *Screen) SetScrollback(sb *Scrollback) {
	s.scrollback = sb
}

// SetScrollbackSize sets the maximum number of lines in the scrollback buffer.
func (s *Screen) SetScrollbackSize(maxLines int) {
	if s.scrollback == nil {
		s.scrollback = NewScrollback(maxLines)
	} else {
		s.scrollback.SetMaxLines(maxLines)
	}
}
