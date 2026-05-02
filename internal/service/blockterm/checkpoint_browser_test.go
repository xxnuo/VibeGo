package blockterm

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	vt "github.com/charmbracelet/x/vt"
)

// The browser decoder consumes this exact backend-produced wire format. Keep
// the golden fixture tied to the real encoder, not a hand-written TS facsimile.
func TestBrowserCheckpointFixture(t *testing.T) {
	e := vt.NewEmulator(8, 3)
	t.Cleanup(func() { _ = e.Close() })
	_, err := e.WriteString("\x1b[31m界X\x1b[38;2;12;34;56mT\x1b[4:3mU\x1b]8;id=sample;https://example.org/\x1b\\L\x1b]8;;\x1b\\\x1b)0\x1b7\x1b[?1049hALT1234567\x1b[3g")
	if err != nil {
		t.Fatal(err)
	}
	cp, err := e.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := cp.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile("../../../ui/tests/fixtures/blockterm-checkpoint-v3.json")
	if err != nil {
		t.Fatal(err)
	}
	var actual, expected any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fixture, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("browser fixture differs from the current checkpoint encoder")
	}
	if _, err := vt.DecodeCheckpoint(fixture); err != nil {
		t.Fatal(err)
	}
	legacy, err := os.ReadFile("../../../ui/tests/fixtures/blockterm-checkpoint-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vt.DecodeCheckpoint(legacy); err != nil {
		t.Fatal(err)
	}
	v2, err := os.ReadFile("../../../ui/tests/fixtures/blockterm-checkpoint-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vt.DecodeCheckpoint(v2); err != nil {
		t.Fatal(err)
	}
}
