package vt

import (
	"bytes"
	"encoding/json"
	"image/color"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestCheckpointColorCodec(t *testing.T) {
	for _, c := range []color.Color{nil, ansi.BasicColor(1), ansi.IndexedColor(1), ansi.IndexedColor(255), ansi.TrueColor(0x123456), ansi.RGBColor{R: 12, G: 34, B: 56}, color.RGBA64{R: 1, G: 2, B: 3, A: 65535}} {
		decoded, err := decodeCheckpointColor(encodeCheckpointColor(c))
		if err != nil || !reflect.DeepEqual(decoded, c) {
			t.Fatalf("color type/value changed: %#v -> %#v: %v", c, decoded, err)
		}
	}
}

func TestCheckpointCodecValidation(t *testing.T) {
	e := checkpointTerminal(t, 8, 3)
	_, _ = e.WriteString("\x1b[31m界X\x1b[?1049hALT")
	cp, err := e.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := cp.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	again, err := cp.MarshalBinary()
	if err != nil || !bytes.Equal(encoded, again) {
		t.Fatal("encoding is not deterministic")
	}
	for name, mutate := range map[string]func(*checkpointData){
		"version":       func(d *checkpointData) { d.Version = 4 },
		"dimensions":    func(d *checkpointData) { d.Cols = 1 << 30 },
		"active":        func(d *checkpointData) { d.Active = 2 },
		"screens":       func(d *checkpointData) { d.Screens = append(d.Screens, d.Screens[0]) },
		"palette":       func(d *checkpointData) { d.Palette = append(d.Palette, nil) },
		"colors":        func(d *checkpointData) { d.Colors = nil },
		"default-color": func(d *checkpointData) { d.Colors[0] = nil },
		"charsets":      func(d *checkpointData) { d.Charsets = nil },
		"cursor":        func(d *checkpointData) { d.Screens[d.Active].Cursor.X = d.Cols },
		"rows":          func(d *checkpointData) { d.Screens[0].Rows = nil },
		"row-width":     func(d *checkpointData) { d.Screens[0].Rows[0] = nil },
		"cell-width":    func(d *checkpointData) { d.Screens[0].Rows[0][0].Width = 3 },
		"wide-spacer":   func(d *checkpointData) { d.Screens[0].Rows[0][1].Width = 1 },
		"grapheme":      func(d *checkpointData) { d.Screens[0].Rows[0][0].Content = strings.Repeat("a", 257) },
		"history":       func(d *checkpointData) { d.Screens[0].HistoryLimit = -1 },
		"region":        func(d *checkpointData) { d.Screens[0].Scroll.Max.X = d.Cols + 1 },
		"region-overflow": func(d *checkpointData) {
			d.Screens[0].Scroll.Min.X = int(^uint(0) >> 1)
			d.Screens[0].Scroll.Max.X = -d.Screens[0].Scroll.Min.X
		},
		"tabs":         func(d *checkpointData) { d.Tabs = []int{2, 2} },
		"modes":        func(d *checkpointData) { d.Modes = append(d.Modes, d.Modes[0]) },
		"color-kind":   func(d *checkpointData) { d.Colors[0].Kind = "unknown" },
		"color-range":  func(d *checkpointData) { d.Colors[0].Value[0] = 1 << 20 },
		"color-length": func(d *checkpointData) { d.Colors[0].Value = append(d.Colors[0].Value, 0) },
	} {
		t.Run(name, func(t *testing.T) {
			var d checkpointData
			if err := json.Unmarshal(encoded, &d); err != nil {
				t.Fatal(err)
			}
			mutate(&d)
			data, err := json.Marshal(d)
			if err != nil {
				t.Fatal(err)
			}
			if cp, err := DecodeCheckpoint(data); err == nil || cp != nil {
				t.Fatal("invalid checkpoint accepted")
			}
		})
	}
	for _, data := range [][]byte{nil, []byte("null"), encoded[:len(encoded)-1], append(append([]byte{}, encoded...), []byte("{}")...), append([]byte(`{"Extra":0,`), encoded[1:]...), append([]byte(`{"version":1,`), encoded[1:]...), bytes.Repeat([]byte(" "), maxCheckpointBytes+1), []byte("\xff")} {
		if cp, err := DecodeCheckpoint(data); err == nil || cp != nil {
			t.Fatal("malformed checkpoint accepted")
		}
	}
	decoded, err := DecodeCheckpoint(encoded)
	if err != nil {
		t.Fatal(err)
	}
	restored := checkpointTerminal(t, 2, 2)
	if err := restored.RestoreCheckpoint(decoded); err != nil {
		t.Fatal(err)
	}
	assertCheckpointStateEqual(t, e, restored)
}

func TestCheckpointExportRejectsLossyOrOversizedState(t *testing.T) {
	e := checkpointTerminal(t, 8, 3)
	e.title = "\xff"
	cp, _ := e.Checkpoint()
	if _, err := cp.MarshalBinary(); err == nil {
		t.Fatal("invalid UTF-8 silently replaced")
	}
	e.title = strings.Repeat("a", maxCheckpointBytes)
	cp, _ = e.Checkpoint()
	if _, err := cp.MarshalBinary(); err == nil {
		t.Fatal("oversized checkpoint accepted")
	}
	if _, err := (*Checkpoint)(nil).MarshalBinary(); err == nil {
		t.Fatal("nil checkpoint accepted")
	}
}

func FuzzDecodeCheckpoint(f *testing.F) {
	e := NewEmulator(2, 2)
	cp, _ := e.Checkpoint()
	data, _ := cp.MarshalBinary()
	_ = e.Close()
	_ = e.InputPipe().(io.Closer).Close()
	f.Add(data)
	f.Add([]byte(`{"Version":1}`))
	f.Add([]byte("null"))
	f.Add([]byte(`{"Version":1,"version":2}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		cp, err := DecodeCheckpoint(data)
		if err == nil {
			if cp == nil || cp.state == nil {
				t.Fatal("accepted empty state")
			}
			target := checkpointTerminal(t, 2, 2)
			if err := target.RestoreCheckpoint(cp); err != nil {
				t.Fatal(err)
			}
			_, _ = target.WriteString("X")
		}
	})
}
