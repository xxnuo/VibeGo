package blockterm

// csiFilter retains CSI across PTY reads while omitting submitted command echo.
// It does not interpret OSC/DCS or replace the terminal's full VT parser.
type csiFilter struct {
	pending []byte
	state   byte
}

func (f *csiFilter) feed(data []byte) []byte {
	var output []byte
	for _, ch := range data {
		if ch == 0x1b {
			f.pending = append(f.pending[:0], ch)
			f.state = 1
			continue
		}
		switch f.state {
		case 1:
			if ch == '[' {
				f.pending = append(f.pending, ch)
				f.state = 2
			} else if (ch < 0x20 && ch != 0x18 && ch != 0x1a) || ch == 0x7f {
				f.pending = append(f.pending, ch)
				if len(f.pending) > 4096 {
					f.reset()
				}
			} else {
				f.reset()
			}
		case 2, 3:
			switch {
			case ch == 0x18 || ch == 0x1a:
				f.reset()
			case ch < 0x20 || ch == 0x7f:
				// Embedded C0 executes without cancelling CSI; DEL is ignored.
				// Keep the bytes so the receiving terminal has the same behavior.
				f.pending = append(f.pending, ch)
			case ch >= 0x40 && ch <= 0x7e:
				output = append(output, f.pending...)
				output = append(output, ch)
				f.reset()
			case ch >= 0x20 && ch <= 0x2f:
				f.state = 3
				f.pending = append(f.pending, ch)
			case ch >= 0x30 && ch <= 0x3f && f.state == 2:
				f.pending = append(f.pending, ch)
			default:
				f.reset()
			}
			if len(f.pending) > 4096 {
				f.reset()
			}
		}
	}
	return output
}

func (f *csiFilter) reset() {
	f.pending = f.pending[:0]
	f.state = 0
}
