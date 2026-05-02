package blockterm

import (
	"bytes"
	"strings"
	"testing"
)

func TestDecoderTerminatorsAndRecovery(t *testing.T) {
	for _, terminator := range []string{"\a", "\x1b\\"} {
		raw := []byte("before\x1b]777;vibego;token;broken\x1b]777;vibego;token;start;YQ==;1" + terminator + "after")
		for split := 0; split <= len(raw); split++ {
			d := NewDecoder("token")
			var out bytes.Buffer
			var hooks []string
			output := func(b []byte) { out.Write(b) }
			hook := func(s string) { hooks = append(hooks, s) }
			d.Feed(raw[:split], output, hook)
			d.Feed(raw[split:], output, hook)
			d.Flush(output)
			if out.String() != "before\x1b]777;vibego;token;brokenafter" || len(hooks) != 1 || hooks[0] != "start;YQ==;1" {
				t.Fatalf("split %d: %q %v", split, out.String(), hooks)
			}
		}
	}
}

func TestMalformedEndMetadataDoesNotFinishCommand(t *testing.T) {
	for _, frame := range []string{"end;0;???;;;1", "end;0;;maybe;;1", "end;0;;;invalid;1", "end;invalid;;;;1"} {
		a := &activeSession{info: Session{ID: "invalid-end", Phase: "running", Cwd: "/original"}, current: &Block{ID: "block", Status: "running"}, hookSeq: 1, pendingOutput: []byte("diagnostic")}
		// No DB or VT is needed: invalid metadata must return before side effects.
		(&Service{}).hook(a, frame)
		if a.current == nil || a.current.Status != "running" || a.info.Phase != "running" || a.info.Cwd != "/original" || a.info.Seq != 0 || string(a.pendingOutput) != "diagnostic" {
			t.Fatalf("invalid frame mutated command state: %q", frame)
		}
	}
}

func TestDecoderCompleteOversizeIsNotAHook(t *testing.T) {
	raw := []byte("\x1b]777;vibego;token;" + strings.Repeat("x", 2<<20) + "\a")
	d := NewDecoder("token")
	var out bytes.Buffer
	d.Feed(raw, func(b []byte) { out.Write(b) }, func(string) { t.Fatal("oversize hook accepted") })
	if !bytes.Equal(out.Bytes(), raw) {
		t.Fatal("raw bytes changed")
	}
}

func TestInvalidPreexecDoesNotChangeLifecycle(t *testing.T) {
	s := &Service{}
	a := &activeSession{info: Session{Phase: "submitted"}, hookSeq: 4, current: &Block{Status: "submitted", Command: "next"}}
	s.hook(a, "start;!;5")
	if a.hookSeq != 4 || a.current.Status != "submitted" {
		t.Fatal("invalid preexec changed lifecycle")
	}
}

func TestAcceptedProtocolRejectsOldEndBeforeAcceptance(t *testing.T) {
	s := &Service{}
	a := &activeSession{info: Session{Phase: "submitted"}, hookSeq: 3, acceptProtocol: true, current: &Block{Status: "submitted"}}
	s.hook(a, "end;0;L3RtcA==;;;3")
	if a.info.Phase != "submitted" || a.current.Status != "submitted" {
		t.Fatal("old end completed unaccepted command")
	}
}

func FuzzDecoderChunkBoundaries(f *testing.F) {
	f.Add([]byte("before\x1b]777;vibego;token;start;YQ==;1\aafter"), uint8(7))
	f.Add([]byte("\x1b]777;vibego;token;broken\x1b]777;vibego;token;end;0;;;;1\x1b\\"), uint8(1))
	f.Fuzz(func(t *testing.T, raw []byte, width uint8) {
		if len(raw) > 65536 {
			t.Skip()
		}
		decode := func(chunk int) (string, string) {
			d := NewDecoder("token")
			var out bytes.Buffer
			var hooks []string
			for start := 0; start < len(raw); start += chunk {
				d.Feed(raw[start:min(start+chunk, len(raw))], func(b []byte) { out.Write(b) }, func(s string) { hooks = append(hooks, s) })
			}
			d.Flush(func(b []byte) { out.Write(b) })
			return out.String(), strings.Join(hooks, "\x00")
		}
		wholeOut, wholeHooks := decode(max(1, len(raw)))
		chunkOut, chunkHooks := decode(int(width) + 1)
		if wholeOut != chunkOut || wholeHooks != chunkHooks {
			t.Fatal("chunk boundaries changed decoding")
		}
	})
}
