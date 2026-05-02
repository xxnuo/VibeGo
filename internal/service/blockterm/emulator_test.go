package blockterm

import (
	"bytes"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

func TestNoWrapMarginProjectionPreservesRecordedBytes(t *testing.T) {
	for _, phase := range []string{"running", "editing"} {
		t.Run(phase, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{info: Session{ID: "margin", Phase: phase}, current: &Block{ID: "block"}, gridBlock: "block", vt: newEmulator(5, 3)}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			data := []byte("\x1b[?7labcde\u0301X\u0308")
			for _, b := range data {
				s.output(a, []byte{b})
			}
			events, err := s.Events(a.info.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			var recorded bytes.Buffer
			for _, event := range events {
				recorded.Write(event.Data)
			}
			if !bytes.Equal(recorded.Bytes(), data) {
				t.Fatal("raw no-wrap output changed")
			}
			if a.vt.CellAt(3, 0).Content != "d" || a.vt.CellAt(4, 0).Content != "X\u0308" {
				t.Fatalf("margin projection: %q", a.vt.String())
			}
			if p := a.vt.CursorPosition(); p.X != 4 || p.Y != 0 {
				t.Fatalf("no-wrap cursor: %v", p)
			}
		})
	}
}

func TestGraphemeProjectionLimitPreservesRawOutputAndControls(t *testing.T) {
	for _, phase := range []string{"running", "editing"} {
		t.Run(phase, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{info: Session{ID: "grapheme", Phase: phase}, current: &Block{ID: "block"}, gridBlock: "block", vt: newEmulator(80, 24)}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			data := []byte("e" + strings.Repeat("\u0301", 10000) + "\x1b[31mX")
			s.output(a, data)
			events, err := s.Events(a.info.ID, 0)
			if err != nil || len(events) != 1 || !bytes.Equal(events[0].Data, data) {
				t.Fatalf("raw combining output changed: events=%d err=%v", len(events), err)
			}
			if len(a.vt.CellAt(0, 0).Content) > 256 {
				t.Fatal("backend cell is unbounded")
			}
			if cell := a.vt.CellAt(1, 0); cell.Content != "X" || cell.Style.Fg == nil {
				t.Fatal("control processing after capped cluster lost")
			}
			if p := a.vt.CursorPosition(); p.X != 2 || p.Y != 0 {
				t.Fatalf("cursor after capped cluster: %+v", p)
			}
		})
	}
}

func TestOversizedControlProjectionPreservesRecordedBytes(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{info: Session{ID: "oversized-control", Phase: "editing"}, vt: newEmulator(80, 24)}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	calls := 0
	a.vt.RegisterOscHandler(99, func([]byte) bool { calls++; return true })
	data := []byte("\x1b]99;" + strings.Repeat("x", (4<<20)+1024) + "\x1b\\VISIBLE")
	s.output(a, data)
	if calls != 0 || a.vt.CellAt(0, 0).Content != "V" {
		t.Fatal("oversized control applied or parser did not resume")
	}
	var recorded bytes.Buffer
	var after uint64
	for {
		events, err := s.Events(a.info.ID, after)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) == 0 {
			break
		}
		for _, event := range events {
			if event.Type != "terminal" {
				t.Fatalf("unexpected event %s", event.Type)
			}
			recorded.Write(event.Data)
			after = event.Seq
		}
	}
	if !bytes.Equal(recorded.Bytes(), data) {
		t.Fatal("raw oversized sequence was truncated in recording")
	}
}

// Screen rendering alone must not be used as the checkpoint for pruning replay events.
func TestRenderedScreenOmitsContinuationState(t *testing.T) {
	for _, tc := range []struct{ name, prefix, suffix string }{
		{"pending-rendition", "\x1b[31m", "X"},
		{"split-control-sequence", "\x1b[31", "mX"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original, restored := newEmulator(40, 24), newEmulator(40, 24)
			defer original.Close()
			defer restored.Close()
			defer original.InputPipe().(io.Closer).Close()
			defer restored.InputPipe().(io.Closer).Close()
			if _, err := original.WriteString(tc.prefix); err != nil {
				t.Fatal(err)
			}
			if _, err := restored.WriteString(original.Render() + "\x1b[H"); err != nil {
				t.Fatal(err)
			}
			if _, err := original.WriteString(tc.suffix); err != nil {
				t.Fatal(err)
			}
			if _, err := restored.WriteString(tc.suffix); err != nil {
				t.Fatal(err)
			}
			if reflect.DeepEqual(original.CellAt(0, 0), restored.CellAt(0, 0)) {
				t.Fatal("screen renderer behavior changed; reassess replay checkpoint requirements")
			}
			if original.CellAt(0, 0).Content != "X" {
				t.Fatal("fixture did not complete the original control sequence")
			}
		})
	}
}

func TestBackendCheckpointPreservesContinuation(t *testing.T) {
	original, restored := newEmulator(40, 24), newEmulator(20, 12)
	defer original.Close()
	defer restored.Close()
	defer original.InputPipe().(io.Closer).Close()
	defer restored.InputPipe().(io.Closer).Close()
	_, _ = original.WriteString("\x1b[31m\x1b[3;4H\x1b7\x1b[H")
	checkpoint, err := original.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := checkpoint.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err = vt.DecodeCheckpoint(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := restored.RestoreCheckpoint(checkpoint); err != nil {
		t.Fatal(err)
	}
	for _, terminal := range []*vt.Emulator{original, restored} {
		_, _ = terminal.WriteString("\x1b8X")
	}
	if original.Render() != restored.Render() || original.CursorPosition() != restored.CursorPosition() {
		t.Fatal("backend checkpoint lost rendition or saved cursor")
	}
	if restored.ScrollbackLen() != 0 {
		t.Fatal("restore introduced duplicate backend history")
	}
	reply := make(chan string, 1)
	go func() { data := make([]byte, 4); n, _ := io.ReadFull(restored, data); reply <- string(data[:n]) }()
	_, _ = restored.WriteString("\x1b[5n")
	if got := <-reply; got != "\x1b[0n" {
		t.Fatalf("backend query override lost: %q", got)
	}
}

func TestEmulatorStatusAndCursorReports(t *testing.T) {
	emulator := newEmulator(40, 24)
	defer emulator.Close()
	defer emulator.InputPipe().(io.Closer).Close()
	want := "\x1b[0n\x1b[1;4R" + ansi.ExtendedCursorPositionReport(1, 4, 0)
	result := make(chan string, 1)
	go func() {
		data := make([]byte, len(want))
		_, err := io.ReadFull(emulator, data)
		if err != nil {
			result <- err.Error()
			return
		}
		result <- string(data)
	}()
	if _, err := emulator.WriteString("abc\x1b[5n\x1b[6n\x1b[?6n"); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got != want {
			t.Fatalf("reports %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("terminal queries did not complete")
	}
}

func TestBackendEmulatorBoundsRedundantOutputHistory(t *testing.T) {
	emulator := newEmulator(80, 24)
	defer emulator.Close()
	defer emulator.InputPipe().(io.Closer).Close()
	if _, err := emulator.WriteString(strings.Repeat("line 中文\r\n", 20000) + "TAIL"); err != nil {
		t.Fatal(err)
	}
	if emulator.ScrollbackLen() != 0 {
		t.Fatalf("backend retained %d history rows", emulator.ScrollbackLen())
	}
	if !strings.Contains(emulator.String(), "TAIL") || emulator.Height() != 24 {
		t.Fatal("live screen lost while bounding history")
	}
	emulator.Resize(40, 12)
	if emulator.ScrollbackLen() != 0 || emulator.Height() != 12 {
		t.Fatal("resize changed backend history bound")
	}
}

func TestEraseSavedLinesPreservesLiveScreen(t *testing.T) {
	for _, alternate := range []bool{false, true} {
		t.Run(fmt.Sprintf("alternate=%t", alternate), func(t *testing.T) {
			emulator := newEmulator(40, 12)
			defer emulator.Close()
			defer emulator.InputPipe().(io.Closer).Close()
			emulator.SetScrollbackSize(1) // Explicit history fixture; production disables it.
			write := func(data string) {
				t.Helper()
				if _, err := emulator.WriteString(data); err != nil {
					t.Fatal(err)
				}
			}
			write(strings.Repeat("history\r\n", 20) + "MAIN")
			mainScreen, history := emulator.String(), emulator.ScrollbackLen()
			if history == 0 {
				t.Fatal("fixture did not create history")
			}
			if alternate {
				write("\x1b[?1049h")
			}
			write("\x1b[2;3H\x1b[31m中文\x1b[4;5H")
			before := emulator.Render()
			// Exercise a sequence split across PTY reads as well.
			write("\x1b[3")
			write("J")
			if emulator.Render() != before {
				t.Fatal("erasing saved lines changed the live screen")
			}
			write("X")
			if cell := emulator.CellAt(4, 3); cell.Content != "X" || cell.Style.Fg == nil {
				t.Fatalf("erasing saved lines changed cursor or rendition: %+v", cell)
			}
			if alternate {
				write("\x1b[?1049l")
				if emulator.String() != mainScreen || emulator.ScrollbackLen() != history {
					t.Fatal("alternate-screen erase changed the main screen or its history")
				}
			} else if emulator.ScrollbackLen() != 0 {
				t.Fatal("saved main-screen lines were not erased")
			}
		})
	}
}

func TestEraseDisplayStillDelegatesVisibleClears(t *testing.T) {
	for _, tc := range []struct{ sequence, remaining string }{
		{"\x1b[J", "AB"},
		{"\x1b[0J", "AB"},
		{"\x1b[1J", "DE"},
		{"\x1b[2J", ""},
	} {
		t.Run(fmt.Sprintf("%q", tc.sequence), func(t *testing.T) {
			emulator := newEmulator(40, 12)
			defer emulator.Close()
			defer emulator.InputPipe().(io.Closer).Close()
			// Separate rows avoid conflating this regression with partial-line ED 1.
			if _, err := emulator.WriteString("AB\r\nC\r\nDE\x1b[2;1H" + tc.sequence); err != nil {
				t.Fatal(err)
			}
			if got := strings.TrimSpace(emulator.String()); got != tc.remaining {
				t.Fatalf("visible clear produced %q, want %q", got, tc.remaining)
			}
		})
	}
}

func TestCommandCompletionRestoresCursorAndMouseModes(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{info: Session{ID: "cursor", Phase: "running"}, current: &Block{ID: "cursor-block", SessionID: "cursor", Status: "running"}, vt: newEmulator(40, 24), temp: t.TempDir(), hookSeq: 1}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	want := "\x1b[?25;2$y\x1b[?9;1$y\x1b[?1001;1$y\x1b[?25;1$y\x1b[?9;2$y\x1b[?1001;2$y"
	result := make(chan string, 1)
	go func() {
		data := make([]byte, len(want))
		_, err := io.ReadFull(a.vt, data)
		if err != nil {
			result <- err.Error()
			return
		}
		result <- string(data)
	}()
	_, _ = a.vt.WriteString("\x1b[?1049h\x1b[?25l\x1b[?9h\x1b[?1001h\x1b[?25$p\x1b[?9$p\x1b[?1001$p")
	s.hook(a, "end;0;;true;0;1")
	_, _ = a.vt.WriteString("\x1b[?25$p\x1b[?9$p\x1b[?1001$p")
	select {
	case got := <-result:
		if got != want {
			t.Fatalf("completion mode reports %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("completion mode query timed out")
	}
}

func TestCommandCompletionPreservesNormalCursorAttributes(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &activeSession{info: Session{ID: "attributes", Phase: "running"}, current: &Block{ID: "attributes-block", SessionID: "attributes", Status: "running"}, vt: newEmulator(40, 24), temp: t.TempDir(), hookSeq: 1}
	defer a.vt.Close()
	defer a.vt.InputPipe().(io.Closer).Close()
	_, _ = a.vt.WriteString("\x1b[31mA")
	want := a.vt.CellAt(0, 0).Style.Fg
	s.hook(a, "end;0;;true;0;1")
	_, _ = a.vt.WriteString("B")
	if got := a.vt.CellAt(1, 0); got.Content != "B" || !reflect.DeepEqual(got.Style.Fg, want) {
		t.Fatalf("completion restored stale cursor attributes: %+v, screen %q", got, a.vt.String())
	}
}

func TestTerminalQueriesReturnToPTYWithoutBrowser(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Bash PTY fixture")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("queries", t.TempDir(), "bash", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "query-test"); err != nil {
		t.Fatal(err)
	}
	for _, modes := range [][3]int{{47, 1049, 1047}, {1047, 47, 1049}, {1049, 1047, 47}} {
		command := fmt.Sprintf(`printf '\033[?%dh\033[?%d$p'; IFS= read -r -s -t 2 -d y reply; printf '\033[?%dl'; [[ "$reply" == $'\033[?%d;1$' ]] || exit 31; printf '\033[?%d$p'; IFS= read -r -s -t 2 -d y reply; [[ "$reply" == $'\033[?%d;2$' ]] || exit 32; printf '\r\nALT_MODE_QUERY_OK\n'`, modes[0], modes[1], modes[2], modes[1], modes[0], modes[0])
		assertQueryCommand(t, s, info.ID, fmt.Sprintf("alternate-modes-%d", modes[0]), command, "ALT_MODE_QUERY_OK")
	}
	for _, size := range [][2]int{{80, 24}, {32, 12}, {120, 40}, {40, 16}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			if err := s.Resize(info.ID, "query-test", size[0], size[1]); err != nil {
				t.Fatal(err)
			}
			// Check the kernel PTY size and the parser's bottom-right cursor in
			// the same command, without a browser answering either query.
			command := fmt.Sprintf(`[[ "$(stty size)" == '%d %d' ]] || exit 23; printf '\033[999;999H\033[6n'; IFS= read -r -s -t 2 -d R reply && [[ "$reply" == $'\033[%d;%d' ]] || exit 24; printf '\r\nRESIZE_QUERY_OK\n'`, size[1], size[0], size[1], size[0])
			assertQueryCommand(t, s, info.ID, fmt.Sprintf("resize-%dx%d", size[0], size[1]), command, "RESIZE_QUERY_OK")
			alternate := fmt.Sprintf(`printf '\033[?1049h\033[999;999H\033[6n'; IFS= read -r -s -t 2 -d R reply; printf '\033[?1049l'; [[ "$reply" == $'\033[%d;%d' ]] || exit 25; printf '\r\nALT_QUERY_OK\n'`, size[1], size[0])
			assertQueryCommand(t, s, info.ID, fmt.Sprintf("alternate-%dx%d", size[0], size[1]), alternate, "ALT_QUERY_OK")
		})
		if t.Failed() {
			return
		}
	}
	command := `printf '\033[5n'; IFS= read -r -s -t 2 -d n reply && [[ "$reply" == $'\033[0' ]] || exit 21; printf '\033[2;3H\033[6n'; IFS= read -r -s -t 2 -d R reply && [[ "$reply" == $'\033[2;3' ]] || exit 22; printf '\r\nPTY_QUERY_OK\n'`
	assertQueryCommand(t, s, info.ID, "queries", command, "PTY_QUERY_OK")
	command = `printf '\033[2;3H\033[s\033[4;6H\033[u\033[6n'; IFS= read -r -s -t 2 -d R reply && [[ "$reply" == $'\033[2;3' ]] || exit 26; printf '\r\nCURSOR_RESTORE_OK\n'`
	assertQueryCommand(t, s, info.ID, "cursor-restore", command, "CURSOR_RESTORE_OK")
	command = `printf '\033[3;8r\033[?6h\033[2;4f\033[6n'; IFS= read -r -s -t 2 -d R reply; printf '\033[?6l\033[r'; [[ "$reply" == $'\033[4;4' ]] || exit 27; printf '\r\nORIGIN_QUERY_OK\n'`
	assertQueryCommand(t, s, info.ID, "origin-query", command, "ORIGIN_QUERY_OK")
	command = `printf '\033[3;8r\033[1;4H\033[99B\033[6n'; IFS= read -r -s -t 2 -d R reply; printf '\033[r'; [[ "$reply" == $'\033[8;4' ]] || exit 28; printf '\r\nMARGIN_QUERY_OK\n'`
	assertQueryCommand(t, s, info.ID, "margin-query", command, "MARGIN_QUERY_OK")
	command = `printf '\033[2;3H\033[31m\033[!p\033[6n'; IFS= read -r -s -t 2 -d R reply && [[ "$reply" == $'\033[2;3' ]] || exit 29; printf '\r\nSOFT_RESET_OK\n'`
	assertQueryCommand(t, s, info.ID, "soft-reset", command, "SOFT_RESET_OK")
	command = `printf '\033[2;39H中X\033[6n'; IFS= read -r -s -t 2 -d R reply && [[ "$reply" == $'\033[3;2' ]] || exit 30; printf '\r\nWIDE_WRAP_OK\n'`
	assertQueryCommand(t, s, info.ID, "wide-wrap", command, "WIDE_WRAP_OK")
}

func assertQueryCommand(t *testing.T, s *Service, sessionID, requestID, command, marker string) {
	t.Helper()
	block, err := s.Submit(sessionID, "query-test", requestID, command)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, sessionID)
	var output strings.Builder
	for _, event := range allEvents(t, s, sessionID) {
		if event.Type == "output" && event.BlockID == block.ID {
			output.Write(event.Data)
		}
	}
	if !strings.Contains(output.String(), marker) {
		t.Fatalf("query round trip failed: %q", output.String())
	}
	blocks, err := s.Blocks(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, completed := range blocks {
		if completed.ID == block.ID {
			if completed.Status != "done" || completed.ExitCode == nil || *completed.ExitCode != 0 {
				t.Fatalf("query command state: %+v", completed)
			}
			return
		}
	}
	t.Fatal("query command block missing")
}
