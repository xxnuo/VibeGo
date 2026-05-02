package blockterm

import (
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
)

// backgroundTextStart finds text outside control strings, retaining parser state
// across reads. Leading UTF-8 bytes belong to the new block, not the prompt grid.
func (a *activeSession) backgroundTextStart(data []byte) int {
	if a.backgroundParser == nil {
		a.backgroundParser = ansi.NewParser()
		// Classification needs only parser state, never OSC/DCS payload contents.
		a.backgroundParser.SetDataSize(1)
	}
	for index, ch := range data {
		if a.backgroundParser.State() == parser.GroundState && ((ch > 0x20 && ch < 0x7f) || ch >= 0xa0) {
			return index
		}
		a.backgroundParser.Advance(ch)
	}
	return -1
}
