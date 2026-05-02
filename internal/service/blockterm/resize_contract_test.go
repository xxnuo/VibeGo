package blockterm

import (
	"io"
	"testing"

	"github.com/charmbracelet/x/vt"
)

// The backend must not advertise reflow-v1 until its parser and query positions
// agree with the client's logical reflow. This records the current screen mode.
func TestServerVTUsesScreenResizeCoordinates(t *testing.T) {
	terminal := vt.NewEmulator(40, 24)
	defer terminal.Close()
	defer terminal.InputPipe().(io.Closer).Close()
	if _, err := terminal.WriteString("first second"); err != nil {
		t.Fatal(err)
	}
	before := terminal.CursorPosition()
	if before.X != 12 || before.Y != 0 {
		t.Fatalf("initial cursor: %+v", before)
	}
	terminal.Resize(6, 24)
	after := terminal.CursorPosition()
	if after.X != 5 || after.Y != 0 {
		t.Fatalf("screen resize contract changed: %+v", after)
	}
}
