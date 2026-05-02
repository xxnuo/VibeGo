package vt

import (
	"strings"
	"testing"
)

func TestCharsetGraphemeWriteBoundaries(t *testing.T) {
	for _, prefix := range []string{"\x1b(0", "\x1b)0\x0e", "\x1b*0\x1bN", "\x1b+0\x1bO"} {
		for _, text := range []string{"q\u0301", "q\u0301\u0308", "q\u0301X"} {
			data := []byte(prefix + text)
			whole := checkpointTerminal(t, 12, 3)
			_, _ = whole.Write(data)
			if whole.CellAt(0, 0).Content != "─\u0301" && whole.CellAt(0, 0).Content != "─\u0301\u0308" {
				t.Errorf("whole mapping missing: %q", whole.CellAt(0, 0).Content)
			}
			for cut := 0; cut <= len(data); cut++ {
				split := checkpointTerminal(t, 12, 3)
				_, _ = split.Write(data[:cut])
				_, _ = split.Write(data[cut:])
				assertCheckpointStateEqual(t, whole, split)
				if !whole.CellAt(0, 0).Equal(split.CellAt(0, 0)) {
					t.Errorf("cut %d differs: %q / %q", cut, whole.CellAt(0, 0).Content, split.CellAt(0, 0).Content)
				}
			}
		}
	}
}

func TestCharsetCombiningMarginAndRepeat(t *testing.T) {
	for _, mode := range []string{"", "\x1b[?7l"} {
		data := []byte(mode + "abcd\x1b(0q\u0301X")
		whole := checkpointTerminal(t, 5, 3)
		_, _ = whole.Write(data)
		for cut := 0; cut <= len(data); cut++ {
			split := checkpointTerminal(t, 5, 3)
			_, _ = split.Write(data[:cut])
			_, _ = split.Write(data[cut:])
			assertCheckpointStateEqual(t, whole, split)
		}
		want := "─\u0301"
		if mode != "" {
			want = "X"
		}
		if whole.CellAt(4, 0).Content != want {
			t.Fatalf("margin: %q", whole.String())
		}
	}
	e := checkpointTerminal(t, 8, 3)
	_, _ = e.WriteString("\x1b(0q\x1b(B\x1b[2b")
	for x := 0; x < 3; x++ {
		if e.CellAt(x, 0).Content != "─" {
			t.Fatalf("REP lost mapped glyph: %q", e.String())
		}
	}
}

func TestSingleShiftConsumedByCombiningContinuation(t *testing.T) {
	e := checkpointTerminal(t, 8, 3)
	_, _ = e.WriteString("A\x1b*0\x1bN\u0301q")
	if e.CellAt(0, 0).Content != "A\u0301" || e.CellAt(1, 0).Content != "q" {
		t.Fatalf("single shift leaked: %q", e.String())
	}
}

func TestMappedGraphemeLimit(t *testing.T) {
	for _, count := range []int{126, 127, 200} {
		data := []byte("\x1b(0q" + strings.Repeat("\u0301", count) + "X")
		whole := checkpointTerminal(t, 8, 3)
		_, _ = whole.Write(data)
		split := checkpointTerminal(t, 8, 3)
		for _, b := range data {
			_, _ = split.Write([]byte{b})
		}
		assertCheckpointStateEqual(t, whole, split)
		want := "─" + strings.Repeat("\u0301", 126)
		if whole.CellAt(0, 0).Content != want || whole.CellAt(1, 0).Content != "X" {
			t.Fatal("mapped projection limit or following text changed")
		}
	}
}
