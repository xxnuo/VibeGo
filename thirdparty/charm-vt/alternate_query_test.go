package vt

import (
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestAlternateModeQueriesFollowActiveScreen(t *testing.T) {
	for _, enter := range []int{47, 1047, 1049} {
		for _, leave := range []int{47, 1047, 1049} {
			t.Run(fmt.Sprintf("%d/%d", enter, leave), func(t *testing.T) {
				e := NewEmulator(8, 3)
				defer e.Close()
				defer e.InputPipe().(io.Closer).Close()
				var script, expected strings.Builder
				query := func(state int) {
					for _, mode := range []int{47, 1047, 1049} {
						fmt.Fprintf(&script, "\x1b[?%d$p", mode)
						fmt.Fprintf(&expected, "\x1b[?%d;%d$y", mode, state)
					}
				}
				query(2)
				fmt.Fprintf(&script, "\x1b[?%dh", enter)
				query(1)
				fmt.Fprintf(&script, "\x1b[?%dl", leave)
				query(2)
				replies := make(chan string, 1)
				go func() {
					data := make([]byte, expected.Len())
					n, _ := io.ReadFull(e, data)
					replies <- string(data[:n])
				}()
				_, _ = e.WriteString(script.String())
				if got := <-replies; got != expected.String() {
					t.Fatalf("mode queries disagree with active screen: got %q want %q", got, expected.String())
				}
			})
		}
	}
}
