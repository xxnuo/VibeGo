package vt

import (
	"bytes"
	"encoding/json"
	"errors"
	"image/color"
	"io"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

const maxCheckpointBytes = 8 << 20
const maxCheckpointCells = 1 << 16

var errCheckpointFormat = errors.New("invalid or unsupported terminal checkpoint format")

type checkpointColorData struct {
	Kind  string
	Value []uint32
}
type checkpointStyleData struct {
	Fg, Bg, UnderlineColor *checkpointColorData
	Underline              uv.Underline
	Attrs                  uint8
}
type checkpointCellData struct {
	Content string
	Width   int
	Style   checkpointStyleData
	Link    uv.Link
}
type checkpointCursorData struct {
	X, Y           int
	Pen            checkpointStyleData
	Link           uv.Link
	Style          CursorStyle
	Steady, Hidden bool
}
type checkpointScreenData struct {
	Cursor, Saved checkpointCursorData
	SavedPhantom  bool
	Scroll        uv.Rectangle
	Rows, History [][]checkpointCellData
	HistoryLimit  int
}
type checkpointModeData struct {
	Private bool
	Number  int
	Setting ansi.ModeSetting
}
type checkpointCharsetData struct {
	Charsets       []CharSet
	GL, GR, Single int
}
type checkpointData struct {
	Version, Cols, Rows, Active int
	Phantom                     bool
	Screens                     []checkpointScreenData
	Charsets                    []CharSet
	GL, GR, Single              int
	Last                        rune
	Modes                       []checkpointModeData
	Tabs                        []int
	Palette                     []*checkpointColorData
	Colors                      []*checkpointColorData
	Title, Icon, Cwd            string
	SavedCharsets               []*checkpointCharsetData `json:",omitempty"`
	Wraps                       []checkpointWraps        `json:",omitempty"`
}

// A null layout represents unknown legacy state, never an all-hard-line layout.
type checkpointWraps []bool

func (w *checkpointWraps) UnmarshalJSON(data []byte) error {
	var values []*bool
	if err := json.Unmarshal(data, &values); err != nil {
		return errCheckpointFormat
	}
	if values == nil {
		*w = nil
		return nil
	}
	*w = make([]bool, len(values))
	for i, value := range values {
		if value == nil {
			return errCheckpointFormat
		}
		(*w)[i] = *value
	}
	return nil
}

func encodeCheckpointColor(c color.Color) *checkpointColorData {
	if c == nil {
		return nil
	}
	d := &checkpointColorData{Value: make([]uint32, 4)}
	switch v := c.(type) {
	case ansi.BasicColor:
		d.Kind, d.Value[0] = "basic", uint32(v)
	case ansi.IndexedColor:
		d.Kind, d.Value[0] = "indexed", uint32(v)
	case ansi.TrueColor:
		d.Kind, d.Value[0] = "true", uint32(v)
	case ansi.RGBColor:
		d.Kind, d.Value = "rgb", []uint32{uint32(v.R), uint32(v.G), uint32(v.B), 0}
	default:
		d.Kind = "rgba16"
		d.Value[0], d.Value[1], d.Value[2], d.Value[3] = c.RGBA()
	}
	return d
}

func decodeCheckpointColor(d *checkpointColorData) (color.Color, error) {
	if d == nil {
		return nil, nil
	}
	v := d.Value
	if len(v) != 4 {
		return nil, errCheckpointFormat
	}
	switch d.Kind {
	case "basic", "indexed", "true":
		if v[1] != 0 || v[2] != 0 || v[3] != 0 {
			break
		}
		if d.Kind == "basic" && v[0] <= 15 {
			return ansi.BasicColor(v[0]), nil
		}
		if d.Kind == "indexed" && v[0] <= 255 {
			return ansi.IndexedColor(v[0]), nil
		}
		if d.Kind == "true" && v[0] <= 0xffffff {
			return ansi.TrueColor(v[0]), nil
		}
	case "rgb":
		if v[0] <= 255 && v[1] <= 255 && v[2] <= 255 && v[3] == 0 {
			return ansi.RGBColor{R: uint8(v[0]), G: uint8(v[1]), B: uint8(v[2])}, nil
		}
	case "rgba16":
		if v[0] <= 65535 && v[1] <= 65535 && v[2] <= 65535 && v[3] <= 65535 {
			return color.RGBA64{R: uint16(v[0]), G: uint16(v[1]), B: uint16(v[2]), A: uint16(v[3])}, nil
		}
	}
	return nil, errCheckpointFormat
}

func encodeCheckpointStyle(s uv.Style) checkpointStyleData {
	return checkpointStyleData{encodeCheckpointColor(s.Fg), encodeCheckpointColor(s.Bg), encodeCheckpointColor(s.UnderlineColor), s.Underline, s.Attrs}
}
func decodeCheckpointStyle(d checkpointStyleData) (s uv.Style, err error) {
	if d.Underline < uv.UnderlineNone || d.Underline > uv.UnderlineDashed {
		return s, errCheckpointFormat
	}
	s.Underline, s.Attrs = d.Underline, d.Attrs
	if s.Fg, err = decodeCheckpointColor(d.Fg); err != nil {
		return
	}
	if s.Bg, err = decodeCheckpointColor(d.Bg); err != nil {
		return
	}
	s.UnderlineColor, err = decodeCheckpointColor(d.UnderlineColor)
	return
}
func encodeCheckpointCursor(c Cursor) checkpointCursorData {
	return checkpointCursorData{c.X, c.Y, encodeCheckpointStyle(c.Pen), c.Link, c.Style, c.Steady, c.Hidden}
}
func decodeCheckpointCursor(d checkpointCursorData, cols, rows int) (c Cursor, err error) {
	if d.X < 0 || d.X >= cols || d.Y < 0 || d.Y >= rows || d.Style < CursorBlock || d.Style > CursorBar {
		return c, errCheckpointFormat
	}
	c.Position = uv.Pos(d.X, d.Y)
	c.Link, c.Style, c.Steady, c.Hidden = d.Link, d.Style, d.Steady, d.Hidden
	c.Pen, err = decodeCheckpointStyle(d.Pen)
	return
}

// MarshalBinary encodes version 3 JSON. This is a backend checkpoint format,
// not an ANSI replay stream or a browser import protocol.
func (c *Checkpoint) MarshalBinary() ([]byte, error) {
	if c == nil || c.state == nil {
		return nil, errCheckpointFormat
	}
	e := c.state
	if e.Width() < 1 || e.Width() > 4096 || e.Height() < 1 || e.Height() > 4096 || e.Width()*e.Height()*2 > maxCheckpointCells || len(e.modes) == 0 || len(e.modes) > 4096 {
		return nil, errCheckpointFormat
	}
	d := checkpointData{Version: 3, Cols: e.Width(), Rows: e.Height(), Phantom: e.atPhantom, Charsets: e.charsets[:], GL: e.gl, GR: e.gr, Single: e.gsingle, Last: e.lastChar, Title: e.title, Icon: e.iconName, Cwd: e.cwd, Screens: make([]checkpointScreenData, 2), Palette: make([]*checkpointColorData, 256), Colors: make([]*checkpointColorData, 6), SavedCharsets: make([]*checkpointCharsetData, 2), Wraps: make([]checkpointWraps, 2)}
	if e.IsAltScreen() {
		d.Active = 1
	}
	// Bound expansion before constructing JSON, including repeated OSC links.
	budget, cells := int64(16384), 0
	validStrings := true
	charge := func(s string) { budget += 6 * int64(len(s)); validStrings = validStrings && utf8.ValidString(s) }
	for _, s := range []string{d.Title, d.Icon, d.Cwd} {
		charge(s)
	}
	for _, set := range d.Charsets {
		for _, s := range set {
			charge(s)
		}
	}
	if budget > maxCheckpointBytes || !validStrings {
		return nil, errCheckpointFormat
	}
	for i := range e.scrs {
		s := &e.scrs[i]
		if s.scrollback != nil && (len(s.scrollback.lines) > maxCheckpointCells || s.scrollback.maxLines > maxCheckpointCells) {
			return nil, errCheckpointFormat
		}
		if len(s.wrapped) == s.Height() && (s.scrollback == nil || len(s.scrollback.wrapped) == len(s.scrollback.lines)) {
			if s.scrollback != nil {
				d.Wraps[i] = append(d.Wraps[i], s.scrollback.wrapped...)
			}
			d.Wraps[i] = append(d.Wraps[i], s.wrapped...)
			budget += int64(len(d.Wraps[i])) * 6
		}
		if saved := s.savedCharset; saved != nil {
			d.SavedCharsets[i] = &checkpointCharsetData{saved.Charsets[:], saved.GL, saved.GR, saved.Single}
			for _, set := range saved.Charsets {
				for _, text := range set {
					charge(text)
				}
			}
		}
		v := checkpointScreenData{Cursor: encodeCheckpointCursor(s.cur), Saved: encodeCheckpointCursor(s.saved), SavedPhantom: s.savedPhantom, Scroll: s.scroll}
		for _, link := range []uv.Link{s.cur.Link, s.saved.Link} {
			charge(link.URL)
			charge(link.Params)
		}
		encodeLines := func(lines []uv.Line) [][]checkpointCellData {
			result := make([][]checkpointCellData, len(lines))
			for y, line := range lines {
				cells += len(line)
				budget += int64(len(line)) * 512
				if cells > maxCheckpointCells || budget > maxCheckpointBytes {
					return nil
				}
				result[y] = make([]checkpointCellData, len(line))
				for x, cell := range line {
					charge(cell.Content)
					charge(cell.Link.URL)
					charge(cell.Link.Params)
					if budget > maxCheckpointBytes {
						return nil
					}
					result[y][x] = checkpointCellData{cell.Content, cell.Width, encodeCheckpointStyle(cell.Style), cell.Link}
				}
			}
			return result
		}
		v.Rows = encodeLines(s.buf.Lines)
		if s.scrollback != nil {
			v.HistoryLimit = s.scrollback.maxLines
			v.History = encodeLines(s.scrollback.lines)
		}
		if budget > maxCheckpointBytes || cells > maxCheckpointCells {
			return nil, errCheckpointFormat
		}
		d.Screens[i] = v
	}
	for mode, setting := range e.modes {
		switch m := mode.(type) {
		case ansi.DECMode:
			d.Modes = append(d.Modes, checkpointModeData{true, int(m), setting})
		case ansi.ANSIMode:
			d.Modes = append(d.Modes, checkpointModeData{false, int(m), setting})
		default:
			return nil, errCheckpointFormat
		}
	}
	sort.Slice(d.Modes, func(i, j int) bool {
		a, b := d.Modes[i], d.Modes[j]
		if a.Private != b.Private {
			return !a.Private
		}
		return a.Number < b.Number
	})
	for x := range e.tabstops.Width() {
		if e.tabstops.IsStop(x) {
			d.Tabs = append(d.Tabs, x)
		}
	}
	for i, v := range e.colors {
		d.Palette[i] = encodeCheckpointColor(v)
	}
	for i, v := range []color.Color{e.defaultFg, e.defaultBg, e.defaultCur, e.fgColor, e.bgColor, e.curColor} {
		d.Colors[i] = encodeCheckpointColor(v)
	}
	if !validStrings {
		return nil, errCheckpointFormat
	}
	data, err := json.Marshal(d)
	if len(data) > maxCheckpointBytes {
		return nil, errCheckpointFormat
	}
	if err != nil {
		return nil, err
	}
	// Share import validation so exported payloads never silently exceed the
	// supported schema, even for unusual modes installed by callers.
	if _, err = DecodeCheckpoint(data); err != nil {
		return nil, err
	}
	return data, nil
}

// DecodeCheckpoint validates a versioned payload into isolated terminal state.
// Decoding is side-effect free; an error cannot modify a running Emulator.
func DecodeCheckpoint(data []byte) (*Checkpoint, error) {
	if len(data) == 0 || len(data) > maxCheckpointBytes || !utf8.Valid(data) {
		return nil, errCheckpointFormat
	}
	// Limit tokens and nesting before decoding potentially huge arrays of tiny objects.
	probe := json.NewDecoder(bytes.NewReader(data))
	depth, tokens := 0, 0
	type frame struct {
		keys map[string]bool
		key  bool
	}
	var stack []frame
	for {
		token, err := probe.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errCheckpointFormat
		}
		tokens++
		if tokens > 1<<20 {
			return nil, errCheckpointFormat
		}
		if len(stack) > 0 {
			f := &stack[len(stack)-1]
			closing := token == json.Delim('}') || token == json.Delim(']')
			if f.keys != nil && !closing {
				if f.key {
					key, ok := token.(string)
					if !ok {
						return nil, errCheckpointFormat
					}
					key = strings.ToLower(key)
					if f.keys[key] {
						return nil, errCheckpointFormat
					}
					f.keys[key] = true
				}
				f.key = !f.key
			}
		}
		if d, ok := token.(json.Delim); ok {
			if d == '{' || d == '[' {
				depth++
				f := frame{}
				if d == '{' {
					f.keys = make(map[string]bool)
					f.key = true
				}
				stack = append(stack, f)
			} else {
				depth--
				if len(stack) == 0 {
					return nil, errCheckpointFormat
				}
				stack = stack[:len(stack)-1]
			}
			if depth > 32 {
				return nil, errCheckpointFormat
			}
		}
	}
	var d checkpointData
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&d); err != nil {
		return nil, errCheckpointFormat
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errCheckpointFormat
	}
	if (d.Version < 1 || d.Version > 3) || d.Cols < 1 || d.Cols > 4096 || d.Rows < 1 || d.Rows > 4096 || d.Cols*d.Rows*2 > maxCheckpointCells || d.Active < 0 || d.Active > 1 || d.GL < 0 || d.GL > 3 || d.GR < 0 || d.GR > 3 || (d.Single != 0 && d.Single != 2 && d.Single != 3) || !utf8.ValidRune(d.Last) || len(d.Modes) == 0 || len(d.Modes) > 4096 {
		return nil, errCheckpointFormat
	}
	if (d.Version == 1 && len(d.SavedCharsets) != 0) || (d.Version >= 2 && len(d.SavedCharsets) != 2) {
		return nil, errCheckpointFormat
	}
	if (d.Version < 3 && d.Wraps != nil) || (d.Version == 3 && len(d.Wraps) != 2) {
		return nil, errCheckpointFormat
	}
	if len(d.Screens) != 2 || len(d.Charsets) != 4 || len(d.Palette) != 256 || len(d.Colors) != 6 {
		return nil, errCheckpointFormat
	}
	if d.Colors[0] == nil || d.Colors[1] == nil || d.Colors[2] == nil {
		return nil, errCheckpointFormat
	}
	e := &Emulator{gl: d.GL, gr: d.GR, gsingle: d.Single, lastChar: d.Last, atPhantom: d.Phantom, title: d.Title, iconName: d.Icon, cwd: d.Cwd, modes: make(ansi.Modes)}
	copy(e.charsets[:], d.Charsets)
	for i, saved := range d.SavedCharsets {
		if saved == nil {
			// Explicitly unknown state from a v1 checkpoint.
			continue
		}
		if len(saved.Charsets) != 4 || saved.GL < 0 || saved.GL > 3 || saved.GR < 0 || saved.GR > 3 || (saved.Single != 0 && saved.Single != 2 && saved.Single != 3) {
			return nil, errCheckpointFormat
		}
		state := &savedCharsetState{GL: saved.GL, GR: saved.GR, Single: saved.Single}
		for n, set := range saved.Charsets {
			for _, text := range set {
				if len(text) > maxGraphemeBytes {
					return nil, errCheckpointFormat
				}
			}
			state.Charsets[n] = set
		}
		e.scrs[i].savedCharset = state
	}
	for _, set := range d.Charsets {
		for _, s := range set {
			if len(s) > maxGraphemeBytes {
				return nil, errCheckpointFormat
			}
		}
	}
	for _, m := range d.Modes {
		if m.Number < 0 || m.Number > 65535 || m.Setting > ansi.ModePermanentlyReset {
			return nil, errCheckpointFormat
		}
		var key ansi.Mode = ansi.ANSIMode(m.Number)
		if m.Private {
			key = ansi.DECMode(m.Number)
		}
		if _, exists := e.modes[key]; exists {
			return nil, errCheckpointFormat
		}
		e.modes[key] = m.Setting
	}
	e.tabstops = uv.DefaultTabStops(d.Cols)
	e.tabstops.Clear()
	last := -1
	for _, x := range d.Tabs {
		if x <= last || x >= d.Cols {
			return nil, errCheckpointFormat
		}
		e.tabstops.Set(x)
		last = x
	}
	var err error
	for i, v := range d.Palette {
		if e.colors[i], err = decodeCheckpointColor(v); err != nil {
			return nil, err
		}
	}
	colors := []*color.Color{&e.defaultFg, &e.defaultBg, &e.defaultCur, &e.fgColor, &e.bgColor, &e.curColor}
	for i, v := range d.Colors {
		if *colors[i], err = decodeCheckpointColor(v); err != nil {
			return nil, err
		}
	}
	cells := 0
	for i, s := range d.Screens {
		if len(s.Rows) != d.Rows || s.HistoryLimit < 0 || s.HistoryLimit > maxCheckpointCells || len(s.History) > s.HistoryLimit || s.Scroll.Min.X < 0 || s.Scroll.Min.Y < 0 || s.Scroll.Min.X >= d.Cols || s.Scroll.Min.Y >= d.Rows || s.Scroll.Max.X <= 0 || s.Scroll.Max.Y <= 0 || s.Scroll.Max.X > d.Cols || s.Scroll.Max.Y > d.Rows || s.Scroll.Dx() < 1 || s.Scroll.Dy() < 1 {
			return nil, errCheckpointFormat
		}
		target := &e.scrs[i]
		// An inactive cursor may still reference its pre-resize geometry.
		cols, rows := d.Cols, d.Rows
		if i != d.Active {
			cols, rows = 4096, 4096
		}
		if target.cur, err = decodeCheckpointCursor(s.Cursor, cols, rows); err != nil {
			return nil, err
		}
		if target.saved, err = decodeCheckpointCursor(s.Saved, d.Cols, d.Rows); err != nil {
			return nil, err
		}
		target.savedPhantom, target.scroll = s.SavedPhantom, s.Scroll
		decodeLines := func(lines [][]checkpointCellData, screen bool) ([]uv.Line, error) {
			result := make([]uv.Line, len(lines))
			for y, line := range lines {
				cells += len(line)
				if cells > maxCheckpointCells || (screen && len(line) != d.Cols) || len(line) > 4096 {
					return nil, errCheckpointFormat
				}
				result[y] = make(uv.Line, len(line))
				for x, c := range line {
					if c.Width < 0 || c.Width > 2 || len(c.Content) > maxGraphemeBytes {
						return nil, errCheckpointFormat
					}
					// Scrollback trims trailing empty spacer cells; a visible
					// screen row must still contain the complete wide pair.
					badWide := c.Width == 2 && ((x+1 == len(line) && screen) || (x+1 < len(line) && (line[x+1].Width != 0 || line[x+1].Content != "")))
					if (c.Width == 0 && c.Content != "") || badWide {
						return nil, errCheckpointFormat
					}
					style, err := decodeCheckpointStyle(c.Style)
					if err != nil {
						return nil, err
					}
					result[y][x] = uv.Cell{Content: c.Content, Width: c.Width, Style: style, Link: c.Link}
				}
			}
			return result, nil
		}
		lines, err := decodeLines(s.Rows, true)
		if err != nil {
			return nil, err
		}
		history, err := decodeLines(s.History, false)
		if err != nil {
			return nil, err
		}
		target.buf = uv.NewRenderBuffer(d.Cols, d.Rows)
		for y, line := range lines {
			copy(target.buf.Lines[y], line)
		}
		target.scrollback = &Scrollback{maxLines: s.HistoryLimit, lines: history}
		if d.Version == 3 && d.Wraps[i] != nil {
			layout := d.Wraps[i]
			if len(layout) != len(history)+d.Rows {
				return nil, errCheckpointFormat
			}
			target.scrollback.wrapped = slices.Clone([]bool(layout[:len(history)]))
			target.wrapped = slices.Clone([]bool(layout[len(history):]))
		}
	}
	e.scr = &e.scrs[d.Active]
	return &Checkpoint{state: e}, nil
}
