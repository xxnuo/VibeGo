package vt

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSavedCharsetContinuation(t *testing.T) {
	for name, pair := range map[string][2]string{
		"esc": {"\x1b7", "\x1b8"}, "csi": {"\x1b[s", "\x1b[u"},
		"1048": {"\x1b[?1048h", "\x1b[?1048l"}, "1049": {"\x1b[?1049h", "\x1b[?1049l"},
	} {
		for mode, parts := range map[string][3]string{
			"G0":      {"\x1b(0", "\x1b(B", "q"},
			"G1":      {"\x1b)0\x0e", "\x1b)B\x0f", "q\x0fq\x0eq"},
			"G2":      {"\x1b*0\x1bn", "\x1b*B\x0f", "q"},
			"G3":      {"\x1b+0\x1bo", "\x1b+B\x0f", "q"},
			"single2": {"\x1b*0\x1bN", "\x1b*B", "qq"},
			"single3": {"\x1b+0\x1bO", "\x1b+B", "qq"},
		} {
			t.Run(name+"/"+mode, func(t *testing.T) {
				original := checkpointTerminal(t, 12, 3)
				prefix := parts[0] + pair[0] + parts[1]
				for _, b := range []byte(prefix) {
					_, _ = original.Write([]byte{b})
				}
				cp, err := original.Checkpoint()
				if err != nil {
					t.Fatal(err)
				}
				data, err := cp.MarshalBinary()
				if err != nil {
					t.Fatal(err)
				}
				decoded, err := DecodeCheckpoint(data)
				if err != nil {
					t.Fatal(err)
				}
				restored := checkpointTerminal(t, 12, 3)
				if err := restored.RestoreCheckpoint(decoded); err != nil {
					t.Fatal(err)
				}
				suffix := pair[1] + parts[2]
				_, _ = original.WriteString(suffix)
				for _, b := range []byte(suffix) {
					_, _ = restored.Write([]byte{b})
				}
				assertCheckpointStateEqual(t, original, restored)
				want := "─"
				if mode == "G1" {
					want = "─q─"
				}
				if strings.HasPrefix(mode, "single") {
					want = "─q"
				}
				if !strings.HasPrefix(original.String(), want) {
					t.Fatalf("charset continuation: %q, want %q", original.String(), want)
				}
			})
		}
	}
}

func TestSavedCharsetIsolationAndReset(t *testing.T) {
	e := checkpointTerminal(t, 12, 3)
	e.charsets[0] = CharSet{'q': "─"}
	e.saveCursor()
	e.charsets[0]['q'] = "changed"
	e.restoreCursor()
	if e.charsets[0]['q'] != "─" {
		t.Fatal("saved map aliases current map")
	}
	e.charsets[0]['q'] = "again"
	e.restoreCursor()
	if e.charsets[0]['q'] != "─" {
		t.Fatal("restored map aliases saved map")
	}
	cp, err := e.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	e.scr.savedCharset.Charsets[0]['q'] = "mutated"
	if err := e.RestoreCheckpoint(cp); err != nil {
		t.Fatal(err)
	}
	e.restoreCursor()
	if e.charsets[0]['q'] != "─" {
		t.Fatal("checkpoint aliases saved map")
	}
	for _, reset := range []string{"\x1b[!p", "\x1bc"} {
		_, _ = e.WriteString("\x1b(0\x1b7" + reset + "\x1b8q")
		if e.CellAt(0, 0).Content != "q" || e.gl != 0 || e.gr != 1 {
			t.Fatal("reset retained saved charset")
		}
	}
}

func TestSavedCharsetCodecVersions(t *testing.T) {
	e := checkpointTerminal(t, 8, 3)
	_, _ = e.WriteString("\x1b(0\x1b7\x1b(B")
	cp, _ := e.Checkpoint()
	data, err := cp.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	var d checkpointData
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	if d.Version != 3 || len(d.SavedCharsets) != 2 || d.SavedCharsets[0].Charsets[0]['q'] != "─" {
		t.Fatal("saved charset absent")
	}
	for _, mutate := range []func(*checkpointData){
		func(v *checkpointData) { v.SavedCharsets = nil },
		func(v *checkpointData) { v.SavedCharsets[0].Charsets = nil },
		func(v *checkpointData) { v.SavedCharsets[0].GL = 4 },
		func(v *checkpointData) { v.SavedCharsets[0].Single = 1 },
		func(v *checkpointData) { v.SavedCharsets[0].Charsets[0]['q'] = strings.Repeat("x", 257) },
	} {
		var bad checkpointData
		_ = json.Unmarshal(data, &bad)
		mutate(&bad)
		encoded, _ := json.Marshal(bad)
		if _, err := DecodeCheckpoint(encoded); err == nil {
			t.Fatal("invalid saved charset accepted")
		}
	}
	d.Version, d.SavedCharsets = 1, nil
	d.Wraps = nil
	legacy, _ := json.Marshal(d)
	old, err := DecodeCheckpoint(legacy)
	if err != nil {
		t.Fatal(err)
	}
	// Version 1 never recorded this state. Preserve its prior no-op restore
	// semantics, and encode missing information explicitly when exporting v3.
	if err := e.RestoreCheckpoint(old); err != nil {
		t.Fatal(err)
	}
	_, _ = e.WriteString("\x1b8q")
	if e.CellAt(0, 0).Content != "q" {
		t.Fatal("invented a legacy saved designation")
	}
	upgraded, err := old.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	var upgradedData checkpointData
	_ = json.Unmarshal(upgraded, &upgradedData)
	if upgradedData.Version != 3 || len(upgradedData.SavedCharsets) != 2 || upgradedData.SavedCharsets[0] != nil {
		t.Fatal("unknown legacy state was not preserved")
	}
}
