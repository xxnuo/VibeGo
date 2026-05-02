package vt

import (
	"unicode/utf8"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

// Bound the parser's screen projection, not the caller's raw output stream.
const maxGraphemeBytes = 256

func boundedGrapheme(content string) string {
	if len(content) <= maxGraphemeBytes {
		return content
	}
	result := make([]byte, 0, maxGraphemeBytes)
	for _, r := range content {
		if len(result)+utf8.RuneLen(r) <= maxGraphemeBytes {
			result = utf8.AppendRune(result, r)
		}
	}
	return string(result)
}

// printableASCII reports whether r is a character that can never join the
// grapheme cluster beside it. No ASCII character is a combining mark, a ZWJ, a
// spacing mark or a regional indicator, and CR and LF are not printable, so a
// cluster boundary between two of these is certain without asking the
// segmenter.
func printableASCII(r rune) bool {
	return r >= ansi.SP && r < ansi.DEL
}

// handlePrint handles printable characters.
//
// A character is held back rather than printed straight away, because the one
// after it may be a combining mark that belongs to the same cluster. Printing
// "e" from "e\u0301" before the mark arrives puts the base in one cell and
// leaves the mark to become a zero-width cell of its own, which the next write
// or erase then destroys.
func (e *Emulator) handlePrint(r rune) {
	// No ASCII character can extend the cluster before it: none of them is
	// Extend, ZWJ, SpacingMark, Prepend, a regional indicator, or part of an
	// Indic conjunct. So an ASCII character arriving is proof that whatever is
	// buffered is finished, and the buffer can go out.
	//
	// This is also what keeps the buffer from being re-segmented as it grows.
	// Asking where the clusters are on every character costs the length of the
	// buffer each time, which is quadratic over a long run of combining marks
	// that never resolves into more than one cluster.
	if printableASCII(r) {
		// Two printable ASCII characters in a row is the common case by a wide
		// margin, and needs no segmenting at all.
		if len(e.grapheme) == 1 && printableASCII(rune(e.grapheme[0])) {
			e.handleGrapheme(string(e.grapheme[0]), 1)
			e.grapheme = utf8.AppendRune(e.grapheme[:0], r)
			return
		}
		e.flushGrapheme()
	}

	if len(e.grapheme)+utf8.RuneLen(r) > maxGraphemeBytes {
		e.flushGrapheme()
	}
	e.grapheme = utf8.AppendRune(e.grapheme, r)
}

// flushGrapheme flushes the current grapheme buffer, if any, and handles the
// grapheme as a single unit.
func (e *Emulator) flushGrapheme() {
	if len(e.grapheme) == 0 {
		return
	}

	// XXX: We always use [ansi.GraphemeWidth] here to report accurate widths
	// and it's up to the caller to decide how to handle Unicode vs non-Unicode
	// modes.
	method := ansi.GraphemeWidth
	graphemes := e.grapheme
	for len(graphemes) > 0 {
		cluster, width := ansi.FirstGraphemeCluster(graphemes, method)
		if len(cluster) == 0 {
			break
		}
		e.handleGrapheme(string(cluster), width)
		graphemes = graphemes[len(cluster):]
	}
	e.grapheme = e.grapheme[:0] // Reset the grapheme buffer.
}

// handleGrapheme handles UTF-8 graphemes.
func (e *Emulator) handleGrapheme(content string, width int) {
	// Map the ASCII base before joining/wrapping. A cluster may already include
	// combining marks in this Write, or receive them in the next one; both must
	// start from the same mapped glyph. Consume a single shift even for an
	// unmapped/zero-width cluster, matching its next-printable-character scope.
	single := e.gsingle
	e.gsingle = 0
	if len(content) > 0 && content[0] < utf8.RuneSelf {
		charset := e.charsets[e.gl]
		if single > 1 && single < 4 {
			charset = e.charsets[single]
		}
		if mapped, ok := charset[content[0]]; ok {
			content = boundedGrapheme(mapped + content[1:])
			width = 1
		}
	}
	awm := e.isModeSet(ansi.ModeAutoWrap)
	cell := uv.Cell{
		Content: content,
		Width:   width,
		Style:   e.scr.cursorPen(),
		Link:    e.scr.cursorLink(),
	}

	x, y := e.scr.CursorPosition()
	if width == 0 || (len(content) > 0 && content[0] >= utf8.RuneSelf) {
		// A combining mark, emoji modifier, or ZWJ continuation can arrive
		// after its base was flushed by a previous Write. Rejoin complete
		// clusters before considering automatic wrapping. ASCII stays fast.
		previous := x - 1
		if e.atPhantom {
			previous = x
		}
		for previous >= 0 {
			base := e.scr.CellAt(previous, y)
			if base == nil {
				break
			}
			if base.Width > 0 {
				if base.Content != "" {
					joined := base.Content + content
					cluster, joinedWidth := ansi.FirstGraphemeCluster([]byte(joined), ansi.GraphemeWidth)
					if width == 0 || len(cluster) == len(joined) {
						if len(joined) > maxGraphemeBytes {
							joined = boundedGrapheme(joined)
							cluster, joinedWidth = ansi.FirstGraphemeCluster([]byte(joined), ansi.GraphemeWidth)
						}
						combined := *base
						combined.Content = joined
						if len(cluster) == len(joined) && joinedWidth > base.Width {
							// With wrapping disabled, keep the original narrow glyph
							// rather than erasing it or creating an orphan wide cell.
							if previous+joinedWidth > e.Width() && !awm {
								return
							}
							combined.Width = joinedWidth
							if previous+joinedWidth > e.Width() {
								e.scr.eraseArea(uv.Rect(previous, y, base.Width, 1))
								if !awm || joinedWidth > e.Width() {
									e.setCursor(previous, y)
									return
								}
								e.index()
								_, y = e.scr.CursorPosition()
								e.scr.setWrapped(y, true)
								previous = 0
								if e.isModeSet(ansi.ANSIMode(4)) {
									e.scr.insertCells(0, y, joinedWidth)
								}
							} else if e.isModeSet(ansi.ANSIMode(4)) {
								e.scr.insertCells(previous+base.Width, y, joinedWidth-base.Width)
							}
							e.atPhantom = previous+joinedWidth >= e.Width()
							e.scr.setCursor(min(previous+joinedWidth, e.Width()-1), y, false)
						}
						e.scr.SetCell(previous, y, &combined)
						return
					}
				}
				break
			}
			previous--
		}
		if width == 0 {
			return
		}
	}
	if (e.atPhantom || x+cell.Width > e.Width()) && awm {
		if !e.atPhantom {
			e.scr.eraseArea(uv.Rect(x, y, e.Width()-x, 1))
		}
		// moves cursor down similar to [Terminal.linefeed] except it doesn't
		// respects [ansi.LNM] mode.
		// This will reset the phantom state i.e. pending wrap state.
		e.index()
		_, y = e.scr.CursorPosition()
		e.scr.setWrapped(y, true)
		x = 0
	}

	if x+cell.Width > e.Width() {
		// Resolve a complete cluster like the same codepoints arriving in
		// separate writes. In particular, a narrow base followed by an emoji
		// selector must retain its narrow form when no spacer can fit.
		if !awm && utf8.RuneCountInString(content) > 1 {
			for _, r := range content {
				part := string(r)
				_, partWidth := ansi.FirstGraphemeCluster([]byte(part), ansi.GraphemeWidth)
				e.handleGrapheme(part, partWidth)
			}
			return
		}
		// A wide glyph cannot occupy only the final cell with wrapping off.
		// Keep the right-margin position for subsequent zero-width input;
		// otherwise its continuation would corrupt the preceding column.
		e.atPhantom = !awm
		return
	}

	if cell.Width > 0 && len(content) > 0 {
		// Record the displayed base consistently whether combining marks
		// arrived with it or were joined by a later Write.
		e.lastChar, _ = utf8.DecodeRuneInString(content)
	}

	if e.isModeSet(ansi.ANSIMode(4)) && cell.Width > 0 {
		e.scr.insertCells(x, y, cell.Width)
	}
	e.scr.SetCell(x, y, &cell)

	// Handle phantom state at the end of the line
	e.atPhantom = x+cell.Width >= e.scr.Width()
	if e.atPhantom {
		x = e.scr.Width() - 1
	} else {
		x += cell.Width
	}

	// NOTE: We don't reset the phantom state here, we handle it up above.
	e.scr.setCursor(x, y, false)
}
