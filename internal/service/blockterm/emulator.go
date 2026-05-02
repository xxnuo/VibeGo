package blockterm

import (
	"io"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

func newEmulator(cols, rows int) *vt.Emulator {
	emulator := vt.NewEmulator(cols, rows)
	// Replay events own history; neither backend screen needs a second copy.
	emulator.DisableScrollback()
	// DSR operating status is CSI 0 n, not a DEC-private CSI ? 0 n.
	// Leave other standard and private queries to the emulator's own handlers.
	emulator.RegisterCsiHandler('n', func(params ansi.Params) bool {
		value, _, present := params.Param(0, 1)
		if !present || value != 5 {
			return false
		}
		_, _ = io.WriteString(emulator.InputPipe(), "\x1b[0n")
		return true
	})
	return emulator
}
