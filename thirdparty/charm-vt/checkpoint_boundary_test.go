package vt

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

// Compare all checkpoint-owned state, not only the currently rendered screen.
func assertCheckpointStateEqual(t *testing.T, a, b *Emulator) {
	t.Helper()
	left, err := a.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	right, err := b.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(left.state, right.state) {
		t.Fatalf("checkpoint continuation differs: original=%q %v restored=%q %v", a.Render(), a.CursorPosition(), b.Render(), b.CursorPosition())
	}
}

func TestCheckpointEveryByteBoundary(t *testing.T) {
	accepted, rejected := 0, 0
	for index, input := range []string{
		"\x1b[31m界\u0301\x1b[0mX",
		"\x1b]0;title界\a\x1b]7;file://host/tmp\aX",
		"\x1bPqignored\x1b\\X",
		"\x1b(0qx\x1b(B\x1b*0\x1bNqX",
		"MAIN\x1b[?1049hTUI\x1b7\x1b[H\x1b8X\x1b[?1049lY",
		"abc\x1b[2;3r\x1b[?6h\x1b[2;2HX\x1b[?6l",
		"\x1b]4;1;rgb:12/34/56\a\x1b[31mX",
		"\x1b[3g\x1b[1;4H\x1bH\r\tX",
		"abcdefgh\x1b7\r\x1b8\u0301X",
	} {
		for cut := 0; cut <= len(input); cut++ {
			t.Run(fmt.Sprintf("%d/%d", index, cut), func(t *testing.T) {
				original := checkpointTerminal(t, 8, 3)
				_, _ = original.WriteString(input[:cut])
				checkpoint, err := original.Checkpoint()
				if errors.Is(err, ErrCheckpointIncomplete) {
					rejected++
					if checkpoint != nil {
						t.Fatal("unsafe boundary returned a checkpoint")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				accepted++
				encoded, err := checkpoint.MarshalBinary()
				if err != nil {
					t.Fatal(err)
				}
				checkpoint, err = DecodeCheckpoint(encoded)
				if err != nil {
					t.Fatal(err)
				}
				restored := checkpointTerminal(t, 3, 2)
				if err := restored.RestoreCheckpoint(checkpoint); err != nil {
					t.Fatal(err)
				}
				_, _ = original.WriteString(input[cut:])
				for _, b := range []byte(input[cut:]) {
					_, _ = restored.Write([]byte{b})
				}
				assertCheckpointStateEqual(t, original, restored)
			})
		}
	}
	if accepted == 0 || rejected == 0 {
		t.Fatal("boundary corpus did not exercise both outcomes")
	}
	t.Logf("safe boundaries=%d rejected incomplete boundaries=%d", accepted, rejected)
}

func TestCheckpointReplacesPartialTargetParser(t *testing.T) {
	for _, dirty := range []string{"\x1b", "\x1b[31", "\x1b]0;old", "\x1bPqold", "\x1b_old", "\x1b^old", "\x1bXold", "\xe4\xb8"} {
		t.Run(fmt.Sprintf("%q", dirty), func(t *testing.T) {
			original, target := checkpointTerminal(t, 8, 3), checkpointTerminal(t, 8, 3)
			_, _ = original.WriteString("\x1b[32mA")
			checkpoint, err := original.Checkpoint()
			if err != nil {
				t.Fatal(err)
			}
			_, _ = target.WriteString(dirty)
			if err := target.RestoreCheckpoint(checkpoint); err != nil {
				t.Fatal(err)
			}
			for _, terminal := range []*Emulator{original, target} {
				_, _ = terminal.WriteString("\x1b]0;new\a界\x1b[0mX")
			}
			assertCheckpointStateEqual(t, original, target)
		})
	}
}
