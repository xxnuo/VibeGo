package blockterm

import (
	"io"
	"testing"
)

func TestSavedCursorExtendedStyle(t *testing.T) {
	for name, pair := range map[string][2]string{
		"esc": {"\x1b7", "\x1b8"}, "csi": {"\x1b[s", "\x1b[u"},
		"1048": {"\x1b[?1048h", "\x1b[?1048l"}, "1049": {"\x1b[?1049h", "\x1b[?1049l"},
	} {
		for _, split := range []bool{false, true} {
			t.Run(name+map[bool]string{true: "/split", false: "/whole"}[split], func(t *testing.T) {
				e := newEmulator(8, 3)
				defer e.Close()
				defer e.InputPipe().(io.Closer).Close()
				data := "\x1b[4:3;58;2;12;34;56m\x1b]8;id=first;https://first.example/\x1b\\A" + pair[0] +
					"\x1b[4:5;58;5;123m\x1b]8;id=second;https://second.example/\x1b\\B" + pair[1] + "X"
				if split {
					for _, b := range []byte(data) {
						_, _ = e.Write([]byte{b})
					}
				} else {
					_, _ = e.WriteString(data)
				}
				cell := e.CellAt(1, 0)
				if cell.Content != "X" || cell.Style.Underline != 3 || cell.Style.UnderlineColor == nil || cell.Link.URL != "https://first.example/" || cell.Link.Params != "id=first" {
					t.Fatalf("saved extended pen not restored: %#v", cell)
				}
				r, g, b, _ := cell.Style.UnderlineColor.RGBA()
				if r != 12*257 || g != 34*257 || b != 56*257 {
					t.Fatalf("underline color: %d,%d,%d", r, g, b)
				}
			})
		}
	}
}
