package vt

import (
	"fmt"
	"io"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/charmbracelet/x/ansi"
)

func TestGraphemeStorageBoundAcrossWritePartitions(t *testing.T) {
	input := "e" + strings.Repeat("\u0301\u200d\u0308", 2048) + "X"
	var want string
	for _, size := range []int{len(input), 1, 7, 257} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			e := NewEmulator(10, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			for start := 0; start < len(input); start += size {
				_, _ = e.WriteString(input[start:min(start+size, len(input))])
			}
			cell := e.scr.CellAt(0, 0)
			if len(cell.Content) > 256 || !utf8.ValidString(cell.Content) {
				t.Fatalf("unbounded or invalid grapheme: %d bytes", len(cell.Content))
			}
			if e.scr.CellAt(1, 0).Content != "X" {
				t.Fatal("ordinary output after capped cluster lost")
			}
			if want == "" {
				want = e.Render()
			} else if e.Render() != want {
				t.Fatal("grapheme cap depends on Write partition")
			}
		})
	}
}

func TestPendingGraphemeBufferIsBounded(t *testing.T) {
	e := NewEmulator(10, 3)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	e.handlePrint('e')
	for i := 0; i < 10000; i++ {
		e.handlePrint('\u0301')
		if len(e.grapheme) > 256 {
			t.Fatalf("pending grapheme grew to %d bytes", len(e.grapheme))
		}
	}
	e.flushGrapheme()
}

func TestOversizedControlStringsAreRejectedRatherThanTruncated(t *testing.T) {
	for _, kind := range []string{"osc", "dcs", "apc", "pm", "sos"} {
		t.Run(kind, func(t *testing.T) {
			e := NewEmulator(10, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			calls := 0
			handler := func([]byte) bool { calls++; return true }
			prefix := ""
			switch kind {
			case "osc":
				prefix = "\x1b]99;"
				e.RegisterOscHandler(99, handler)
			case "dcs":
				prefix = "\x1bPq"
				e.RegisterDcsHandler('q', func(_ ansi.Params, data []byte) bool { return handler(data) })
			case "apc":
				prefix = "\x1b_"
				e.RegisterApcHandler(handler)
			case "pm":
				prefix = "\x1b^"
				e.RegisterPmHandler(handler)
			case "sos":
				prefix = "\x1bX"
				e.RegisterSosHandler(handler)
			}
			_, _ = e.WriteString(prefix)
			chunk := strings.Repeat("x", 64<<10)
			for i := 0; i < 65; i++ {
				_, _ = e.WriteString(chunk)
			}
			if calls != 0 {
				t.Fatal("unfinished string dispatched")
			}
			_, _ = e.WriteString("\x1b\\X")
			if calls != 0 {
				t.Fatal("truncated oversized string dispatched")
			}
			if e.scr.CellAt(0, 0).Content != "X" {
				t.Fatal("parser did not resume after oversized string")
			}
			_, _ = e.WriteString(prefix + "ok\x1b\\Y")
			if calls != 1 || e.scr.CellAt(1, 0).Content != "Y" {
				t.Fatal("valid sequence after overflow lost")
			}
			for _, delta := range []int{-1, 0, 1} {
				calls = 0
				length := maxControlStringBytes + delta
				if kind == "osc" {
					length -= len("99;") // OSC includes its numeric command in data.
				}
				_, _ = e.WriteString(prefix + strings.Repeat("x", length) + "\x1b\\")
				want := 1
				if delta > 0 {
					want = 0
				}
				if calls != want {
					t.Fatalf("boundary delta %d: %d handlers, want %d", delta, calls, want)
				}
			}
		})
	}
}

func TestSoftResetPreservesScreenAndRestoresInputDefaults(t *testing.T) {
	for _, alternate := range []bool{false, true} {
		t.Run(fmt.Sprintf("alternate=%t", alternate), func(t *testing.T) {
			e := NewEmulator(20, 10)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			e.DisableScrollback()
			if alternate {
				_, _ = e.WriteString("\x1b[?1049h")
			}
			_, _ = e.WriteString("KEEP\x1b[3;8r\x1b[?6h\x1b[?25l\x1b[?2004h\x1b[?1h\x1b[?7l\x1b[31m\x1b[2;4H\x1b7")
			before, position := e.Render(), e.CursorPosition()
			_, _ = e.WriteString("\x1b[!p")
			if e.Render() != before || e.CursorPosition() != position || e.IsAltScreen() != alternate {
				t.Fatal("soft reset changed screen or cursor")
			}
			if e.isModeSet(ansi.ModeOrigin) || e.isModeSet(ansi.ModeBracketedPaste) || e.isModeSet(ansi.ModeCursorKeys) || !e.isModeSet(ansi.ModeAutoWrap) || e.scr.cur.Hidden {
				t.Fatal("soft reset retained input modes")
			}
			if e.scr.scroll != e.scr.Bounds() || e.scr.cur.Pen.Fg != nil {
				t.Fatal("soft reset retained region or pen")
			}
			_, _ = e.WriteString("\x1b8X")
			if e.CellAt(0, 0).Content != "X" || e.CellAt(0, 0).Style.Fg != nil {
				t.Fatal("soft reset retained saved cursor")
			}
			for i := range e.scrs {
				if e.scrs[i].Scrollback() != nil {
					t.Fatal("reset reallocated history")
				}
			}
		})
	}
}

func TestEraseWideCharacterBoundaries(t *testing.T) {
	for _, tc := range []struct {
		sequence string
		column   int
		want     string
	}{
		{"\x1b[1J", 2, "   B"},
		{"\x1b[J", 3, "A"},
		{"\x1b[1K", 2, "   B"},
		{"\x1b[K", 3, "A"},
		{"\x1b[X", 2, "A  B"},
		{"\x1b[X", 3, "A  B"},
	} {
		t.Run(fmt.Sprintf("%q-column-%d", tc.sequence, tc.column), func(t *testing.T) {
			e := NewEmulator(10, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString(fmt.Sprintf("A中B\x1b[1;%dH\x1b[44m%s", tc.column, tc.sequence))
			line := strings.Split(e.String(), "\n")[0]
			if strings.TrimRight(line, " ") != tc.want {
				t.Fatalf("wide erase produced %q, want %q", line, tc.want)
			}
			for _, x := range []int{1, 2} {
				c := e.CellAt(x, 0)
				if c.Width != 1 || c.Style.Bg == nil {
					t.Fatalf("wide cell %d not fully erased with current background: %+v", x, c)
				}
			}
			if cursor := e.CursorPosition(); cursor.X != tc.column-1 || cursor.Y != 0 {
				t.Fatalf("erase moved cursor: %+v", cursor)
			}
			_, _ = e.WriteString("X")
			if e.CellAt(tc.column-1, 0).Content != "X" {
				t.Fatal("subsequent output did not use the unchanged cursor")
			}
		})
	}
}

func TestDisabledHistoryOnBothScreens(t *testing.T) {
	e := NewEmulator(40, 12)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	e.DisableScrollback()
	for _, prefix := range []string{"", "\x1b[?1049h", "\x1b[?1049l", "\x1b[?1049h"} {
		_, _ = e.WriteString(prefix + strings.Repeat("中文 output\r\n", 20000) + "TAIL")
		if !strings.Contains(e.String(), "TAIL") {
			t.Fatal("visible output lost")
		}
		e.Resize(32, 10)
		for i := range e.scrs {
			if e.scrs[i].Scrollback() != nil {
				t.Fatalf("screen %d recreated history", i)
			}
		}
	}
}

func TestEraseAbovePreservesRightOfCursor(t *testing.T) {
	for _, prefix := range []string{"", "\x1b[?1049h"} {
		e := NewEmulator(20, 5)
		_, _ = e.WriteString(prefix + "above\r\nABCDE\r\nbelow\x1b[2;3H\x1b[44m\x1b[1J")
		if got := strings.TrimSpace(e.String()); got != "DE\n"+"below" {
			t.Fatalf("ED 1 result %q", got)
		}
		if e.CellAt(0, 0).Style.Bg == nil || e.CellAt(2, 1).Style.Bg == nil || e.CellAt(3, 1).Style.Bg != nil {
			t.Fatal("erase background crossed cursor boundary")
		}
		_, _ = e.WriteString("X")
		if e.CellAt(2, 1).Content != "X" {
			t.Fatal("erase moved cursor")
		}
		_ = e.InputPipe().(io.Closer).Close()
		_ = e.Close()
	}
}

func TestEraseSavedLinesTargetsActiveScreen(t *testing.T) {
	e := NewEmulator(20, 5)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	_, _ = e.WriteString(strings.Repeat("main\r\n", 20))
	mainHistory := e.scrs[0].Scrollback().Len()
	_, _ = e.WriteString("\x1b[?1049h" + strings.Repeat("alternate\r\n", 20) + "TAIL")
	if mainHistory == 0 || e.scrs[1].Scrollback().Len() == 0 {
		t.Fatal("history fixture is empty")
	}
	before := e.Render()
	_, _ = e.WriteString("\x1b[3J")
	if e.Render() != before || e.scrs[1].Scrollback().Len() != 0 || e.scrs[0].Scrollback().Len() != mainHistory {
		t.Fatal("ED 3 changed visible screen or the wrong history buffer")
	}
}

func TestAlternateScreenAndResetPreserveState(t *testing.T) {
	e := NewEmulator(20, 5)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	e.DisableScrollback()
	_, _ = e.WriteString("\x1b[2;4H\x1b[31m\x1b[?1049hALT\x1b[?1049lX")
	if e.IsAltScreen() || e.CellAt(3, 1).Content != "X" {
		t.Fatal("alternate-screen exit did not restore the main cursor")
	}
	if e.CellAt(3, 1).Style.Fg == nil {
		t.Fatal("alternate-screen exit lost the main rendition")
	}
	// A save inside the alternate screen must not replace the main screen's save.
	_, _ = e.WriteString("\x1b[?1049h\x1b[4;8H\x1b7\x1b[?1049lY")
	if e.CellAt(4, 1).Content != "Y" {
		t.Fatal("alternate-screen save overwrote the main saved cursor")
	}
	_, _ = e.WriteString("\x1b[?1049h\x1bcZ")
	if e.IsAltScreen() || e.CellAt(0, 0).Content != "Z" || e.CellAt(0, 0).Style.Fg != nil {
		t.Fatal("reset did not return to a clean main screen")
	}
	for i := range e.scrs {
		if e.scrs[i].Scrollback() != nil {
			t.Fatal("reset recreated disabled history")
		}
	}
}

func TestSavedCursorRestoresPendingWrap(t *testing.T) {
	for _, sequence := range []string{
		"\x1b[s\x1b[1;1H\x1b[u",
		"\x1b7\x1b[1;1H\x1b8",
		"\x1b[?1048h\x1b[1;1H\x1b[?1048l",
		"\x1b[?1049hALT\x1b[?1049l",
	} {
		t.Run(fmt.Sprintf("%q", sequence), func(t *testing.T) {
			e := NewEmulator(5, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString("ABCDE" + sequence + "X")
			if e.CellAt(4, 0).Content != "E" || e.CellAt(0, 1).Content != "X" {
				t.Fatalf("saved wrap lost: %q", e.String())
			}
		})
	}
}

func TestANSICursorRestoreDoesNotHandlePrivateKeyboardSequences(t *testing.T) {
	e := NewEmulator(20, 5)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	_, _ = e.WriteString("\x1b[2;3H\x1b[31m\x1b[s\x1b[4;6H\x1b[0m\x1b[>1uX")
	if e.CellAt(5, 3).Content != "X" {
		t.Fatal("private keyboard sequence restored cursor")
	}
	_, _ = e.WriteString("\x1b[uY")
	if e.CellAt(2, 1).Content != "Y" || e.CellAt(2, 1).Style.Fg == nil {
		t.Fatal("ANSI restore lost cursor position or rendition")
	}
}

func TestSavedCursorClearsUnrelatedPendingWrap(t *testing.T) {
	e := NewEmulator(5, 3)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	_, _ = e.WriteString("AB\x1b7\x1b[2;1H12345\x1b8X")
	if e.CellAt(2, 0).Content != "X" || e.CellAt(0, 1).Content != "1" {
		t.Fatalf("restore retained unrelated pending wrap: %q", e.String())
	}
}

func TestOriginModeHomesCursorAndHVPMatchesCUP(t *testing.T) {
	e := NewEmulator(20, 10)
	defer e.Close()
	defer e.InputPipe().(io.Closer).Close()
	_, _ = e.WriteString("\x1b[3;8r\x1b[9;9H\x1b[?6h")
	if p := e.CursorPosition(); p.X != 0 || p.Y != 2 {
		t.Fatalf("origin enable did not home: %+v", p)
	}
	for _, position := range []string{"1;1", "2;4", "99;99", "0;0"} {
		_, _ = e.WriteString("\x1b[" + position + "H")
		want := e.CursorPosition()
		_, _ = e.WriteString("\x1b[" + position + "f")
		if got := e.CursorPosition(); got != want {
			t.Fatalf("HVP %s = %+v; CUP = %+v", position, got, want)
		}
	}
	_, _ = e.WriteString("\x1b[?6l")
	if p := e.CursorPosition(); p.X != 0 || p.Y != 0 {
		t.Fatalf("origin disable did not home: %+v", p)
	}
}

func TestRelativeCursorStopsAtOppositeScrollMargin(t *testing.T) {
	for _, tc := range []struct {
		row      int
		movement string
		want     int
	}{
		{1, "99B", 7}, {10, "99A", 2},
		{1, "99A", 0}, {10, "99B", 9},
		{5, "99A", 2}, {5, "99B", 7},
	} {
		t.Run(fmt.Sprintf("row-%d-%s", tc.row, tc.movement), func(t *testing.T) {
			e := NewEmulator(20, 10)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString(fmt.Sprintf("\x1b[3;8r\x1b[%d;4H\x1b[%s", tc.row, tc.movement))
			if p := e.CursorPosition(); p.X != 3 || p.Y != tc.want {
				t.Fatalf("unexpected relative cursor: %+v", p)
			}
		})
	}
}

func TestInsertModeShiftsExistingOutput(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"abcde\x1b[1;3H\x1b[4hX", "abXcde"},
		{"abcde\x1b[1;3H\x1b[4h中", "ab中cde"},
		{"abcde\x1b[1;3H\x1b[4hX\x1b[4lY", "abXYde"},
		{"abcdefgh\x1b[1;3H\x1b[4hX", "abXcdefg"},
		{"abcde\x1b[1;3H\x1b[4h\x1b[!pX", "abXde"},
		{"A中BC\x1b[1;3H\x1b[4hX", "A X BC"},
		{"abcdef中\x1b[1;3H\x1b[4hX", "abXcdef"},
		{"ab中efgh\x1b[1;3H\x1b[@X", "abX中efg"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			e := NewEmulator(8, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString(tc.input)
			if got := strings.TrimSpace(e.String()); got != tc.want {
				t.Fatalf("insert result %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWideGlyphWrapAtRightEdge(t *testing.T) {
	for _, tc := range []struct{ input, first, second string }{
		{"abc中X", "abc中", "X"},
		{"abcd中X", "abcd", "中X"},
		{"abc中\x1b7\x1b[1;1H\x1b8X", "abc中", "X"},
		{"\x1b[?7labcd中X", "abcdX", ""},
	} {
		t.Run(tc.input, func(t *testing.T) {
			e := NewEmulator(5, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString(tc.input)
			lines := strings.Split(e.String(), "\n")
			if lines[0] != tc.first || lines[1] != tc.second {
				t.Fatalf("wide wrap result: %q", e.String())
			}
		})
	}
}

func TestCombiningMarksAcrossWriteBoundaries(t *testing.T) {
	for _, base := range []string{"e", "中", "abcde", "abc中"} {
		t.Run(base, func(t *testing.T) {
			whole, split := NewEmulator(5, 3), NewEmulator(5, 3)
			defer whole.Close()
			defer split.Close()
			defer whole.InputPipe().(io.Closer).Close()
			defer split.InputPipe().(io.Closer).Close()
			input := base + "\u0301\u0308X"
			_, _ = whole.WriteString(input)
			for _, b := range []byte(input) {
				_, _ = split.Write([]byte{b})
			}
			if whole.Render() != split.Render() || whole.CursorPosition() != split.CursorPosition() {
				t.Fatalf("split combining input diverged: whole=%q split=%q", whole.String(), split.String())
			}
		})
	}
}

func TestEmojiClustersAcrossWriteBoundaries(t *testing.T) {
	for _, cluster := range []string{"👋🏿", "👩‍💻", "👨‍👩‍👧‍👦", "👋💻"} {
		for _, prefix := range []string{"", "abc"} {
			t.Run(prefix+cluster, func(t *testing.T) {
				whole, split := NewEmulator(5, 3), NewEmulator(5, 3)
				defer whole.Close()
				defer split.Close()
				defer whole.InputPipe().(io.Closer).Close()
				defer split.InputPipe().(io.Closer).Close()
				input := prefix + cluster + "X"
				_, _ = whole.WriteString(input)
				for _, b := range []byte(input) {
					_, _ = split.Write([]byte{b})
				}
				if whole.Render() != split.Render() || whole.CursorPosition() != split.CursorPosition() {
					t.Fatalf("split emoji diverged: whole=%q split=%q", whole.String(), split.String())
				}
			})
		}
	}
}

func TestGrowingGraphemeAcrossWriteBoundaries(t *testing.T) {
	for _, cluster := range []string{"\u2764\ufe0f", "\U0001f1e8\U0001f1f3", "1\ufe0f\u20e3"} {
		for _, prefix := range []string{"", "abc", "abcd", "first\r\nnext\r\nabcd"} {
			t.Run(prefix+cluster, func(t *testing.T) {
				whole, split := NewEmulator(5, 3), NewEmulator(5, 3)
				defer whole.Close()
				defer split.Close()
				defer whole.InputPipe().(io.Closer).Close()
				defer split.InputPipe().(io.Closer).Close()
				input := prefix + cluster + "X"
				_, _ = whole.WriteString(input)
				for _, b := range []byte(input) {
					_, _ = split.Write([]byte{b})
				}
				if whole.Render() != split.Render() || whole.CursorPosition() != split.CursorPosition() {
					t.Fatalf("width change diverged: whole=%q split=%q", whole.String(), split.String())
				}
			})
		}
	}
}

func TestTextPresentationAcrossWriteBoundaries(t *testing.T) {
	for _, cluster := range []string{"\u231a\ufe0e", "\u2615\ufe0e", "\u2764\ufe0f\ufe0e"} {
		for _, prefix := range []string{"", "abc", "abcd"} {
			t.Run(prefix+cluster, func(t *testing.T) {
				whole, split := NewEmulator(5, 3), NewEmulator(5, 3)
				defer whole.Close()
				defer split.Close()
				defer whole.InputPipe().(io.Closer).Close()
				defer split.InputPipe().(io.Closer).Close()
				input := prefix + cluster + "X"
				_, _ = whole.WriteString(input)
				for _, b := range []byte(input) {
					_, _ = split.Write([]byte{b})
				}
				if whole.Render() != split.Render() || whole.CursorPosition() != split.CursorPosition() {
					t.Fatalf("text presentation diverged: whole=%q split=%q", whole.String(), split.String())
				}
			})
		}
	}
}

func TestGrowingGraphemeInsertionPreservesWideBoundary(t *testing.T) {
	for _, initial := range []string{"abcdef中", "abcde中X", "ab中efgh"} {
		t.Run(initial, func(t *testing.T) {
			whole, split := NewEmulator(8, 3), NewEmulator(8, 3)
			defer whole.Close()
			defer split.Close()
			defer whole.InputPipe().(io.Closer).Close()
			defer split.InputPipe().(io.Closer).Close()
			prefix := initial + "\x1b[1;3H\x1b[4h"
			_, _ = whole.WriteString(prefix + "\u2764\ufe0f")
			_, _ = split.WriteString(prefix + "\u2764")
			_, _ = split.WriteString("\ufe0f")
			if whole.Render() != split.Render() || whole.CursorPosition() != split.CursorPosition() {
				t.Fatalf("growing insertion diverged: whole=%q split=%q", whole.String(), split.String())
			}
		})
	}
}

func TestDeleteCellsPreservesWideBoundaries(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"ab中efgh\x1b[1;2H\x1b[P", "a中efgh"},
		{"ab中efgh\x1b[1;3H\x1b[P", "ab efgh"},
		{"ab中efgh\x1b[1;4H\x1b[P", "ab efgh"},
		{"ab中efgh\x1b[1;3H\x1b[2P", "abefgh"},
	} {
		t.Run(tc.want+tc.input, func(t *testing.T) {
			e := NewEmulator(8, 3)
			defer e.Close()
			defer e.InputPipe().(io.Closer).Close()
			_, _ = e.WriteString(tc.input)
			if got := strings.TrimSpace(e.String()); got != tc.want {
				t.Fatalf("delete got %q, want %q", got, tc.want)
			}
		})
	}
}
