package vt

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func checkpointLayout(t *testing.T, e *Emulator) checkpointData {
	t.Helper()
	cp, err := e.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	data, err := cp.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	var d checkpointData
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestWrapCheckpointTransitions(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		want        checkpointWraps
	}{
		{"pending", "abcd", checkpointWraps{false, false, false}},
		{"soft", "abcdE", checkpointWraps{false, true, false}},
		{"hard", "abcd\r\nE", checkpointWraps{false, false, false}},
		{"history", "abcdefghijklm", checkpointWraps{false, true, true, true}},
		{"wide", "abc界X", checkpointWraps{false, true, false}},
		{"selector", "abc☀️X", checkpointWraps{false, true, false}},
		{"linefeed clears", "abcdE\x1b[1;1H\n", checkpointWraps{false, false, false}},
		{"insert", "abcdE\x1b[1;1H\x1b[L", checkpointWraps{false, false, true}},
		{"delete", "abcdE\x1b[2;1H\x1b[M", checkpointWraps{false, false, false}},
		{"erase line", "abcdE\x1b[2K", checkpointWraps{false, false, false}},
		{"erase left preserves", "abcdE\x1b[1K", checkpointWraps{false, true, false}},
		{"erase chars preserves", "abcdE\r\x1b[4X", checkpointWraps{false, true, false}},
		{"erase right clears", "abcdE\r\x1b[K", checkpointWraps{false, false, false}},
		{"erase above clears", "abcdefghi\x1b[2;4H\x1b[1J", checkpointWraps{false, false, false}},
		{"erase display", "abcdE\x1b[2J", checkpointWraps{false, false, false}},
		{"no wrap", "\x1b[?7labcdEF", checkpointWraps{false, false, false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for cut := 0; cut <= len(tc.input); cut++ {
				e := checkpointTerminal(t, 4, 3)
				_, _ = e.WriteString(tc.input[:cut])
				_, _ = e.WriteString(tc.input[cut:])
				d := checkpointLayout(t, e)
				if !reflect.DeepEqual(d.Wraps[0], tc.want) {
					t.Fatalf("cut %d: %v != %v", cut, d.Wraps[0], tc.want)
				}
				encoded, _ := json.Marshal(d)
				cp, err := DecodeCheckpoint(encoded)
				if err != nil {
					t.Fatal(err)
				}
				restored := checkpointTerminal(t, 4, 3)
				if err := restored.RestoreCheckpoint(cp); err != nil {
					t.Fatal(err)
				}
				_, _ = restored.WriteString("Z12345\r\nX")
				_, _ = e.WriteString("Z12345\r\nX")
				if !reflect.DeepEqual(checkpointLayout(t, restored), checkpointLayout(t, e)) {
					t.Fatal("continuation diverged")
				}
			}
		})
	}
}

func TestWrapCheckpointLegacyAndInvalid(t *testing.T) {
	e := checkpointTerminal(t, 4, 3)
	_, _ = e.WriteString("abcdefghijklm")
	d := checkpointLayout(t, e)
	for _, version := range []int{1, 2} {
		old := d
		old.Version = version
		old.Wraps = nil
		if version == 1 {
			old.SavedCharsets = nil
		}
		data, _ := json.Marshal(old)
		cp, err := DecodeCheckpoint(data)
		if err != nil {
			t.Fatal(err)
		}
		if err := e.RestoreCheckpoint(cp); err != nil {
			t.Fatal(err)
		}
		_, _ = e.WriteString("more output")
		if got := checkpointLayout(t, e); got.Wraps[0] != nil || got.Wraps[1] != nil {
			t.Fatal("invented legacy layout")
		}
	}
	for _, wraps := range [][]checkpointWraps{nil, {{false}}, {{}, {}}, {{false, false, false}, nil}} {
		bad := d
		bad.Wraps = wraps
		data, _ := json.Marshal(bad)
		if _, err := DecodeCheckpoint(data); err == nil {
			t.Fatalf("accepted invalid layout %v", wraps)
		}
	}
	var layout checkpointWraps
	if err := json.Unmarshal([]byte(`[true,null]`), &layout); err == nil {
		t.Fatal("null flag accepted")
	}
}

func TestWrapCheckpointOwnershipAndUnsupportedGeometry(t *testing.T) {
	e := checkpointTerminal(t, 4, 3)
	_, _ = e.WriteString("abcdefghijklm")
	cp, _ := e.Checkpoint()
	e.scr.wrapped[0] = false
	e.scr.scrollback.wrapped[0] = true
	if !cp.state.scr.wrapped[0] || cp.state.scr.scrollback.wrapped[0] {
		t.Fatal("capture aliases live flags")
	}
	if err := e.RestoreCheckpoint(cp); err != nil {
		t.Fatal(err)
	}
	e.scr.scrollback.SetMaxLines(1)
	_, _ = e.WriteString("NOPQRSTUVWXYZ")
	if len(e.scr.scrollback.wrapped) != 1 || !e.scr.scrollback.wrapped[0] {
		t.Fatal("history trim lost flags")
	}
	e.Resize(5, 3)
	if checkpointLayout(t, e).Wraps[0] != nil {
		t.Fatal("width reflow pretended known")
	}
	_, _ = e.WriteString("\x1bc")
	if checkpointLayout(t, e).Wraps[0] == nil {
		t.Fatal("reset did not restore known layout")
	}
}

func TestWrapCheckpointScreensAndHistory(t *testing.T) {
	e := checkpointTerminal(t, 4, 3)
	_, _ = e.WriteString("abcdefghijklm\x1b[?1049hABCDZ")
	d := checkpointLayout(t, e)
	if !reflect.DeepEqual(d.Wraps, []checkpointWraps{{false, true, true, true}, {false, true, false}}) {
		t.Fatal(d.Wraps)
	}
	_, _ = e.WriteString("\x1b[?1049l\x1b[3J")
	if got := checkpointLayout(t, e).Wraps[0]; !reflect.DeepEqual(got, checkpointWraps{true, true, true}) {
		t.Fatal(got)
	}
	_, _ = e.WriteString("\x1b[?69h\x1b[2;3s\x1b[1;2H\x1b[L")
	if checkpointLayout(t, e).Wraps[0] != nil {
		t.Fatal("partial-width line movement guessed a layout")
	}
}

func TestEraseDisplayPreservesExistingHistoryAndBackground(t *testing.T) {
	e := checkpointTerminal(t, 4, 3)
	_, _ = e.WriteString("abcdefghijklm")
	before := checkpointLayout(t, e)
	_, _ = e.WriteString("\x1b[44m\x1b[2J")
	after := checkpointLayout(t, e)
	if !reflect.DeepEqual(before.Screens[0].History, after.Screens[0].History) {
		t.Fatal("ED2 modified existing history")
	}
	if !reflect.DeepEqual(after.Wraps[0], checkpointWraps{false, false, false, false}) {
		t.Fatal(after.Wraps[0])
	}
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			cell := e.CellAt(x, y)
			if (cell.Content != "" && cell.Content != " ") || cell.Style.Bg != ansi.BasicColor(4) {
				t.Fatalf("wrong erase cell: %#v", cell)
			}
		}
	}
}
