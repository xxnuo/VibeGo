package blockterm

import (
	"bytes"
	"strings"
)

// Decoder removes only this session's hooks. All other bytes remain terminal data.
type Decoder struct {
	pending []byte
	prefix  []byte
}

func NewDecoder(nonce string) *Decoder {
	return &Decoder{prefix: []byte("\x1b]777;vibego;" + nonce + ";")}
}

func (d *Decoder) Feed(data []byte, output func([]byte), hook func(string)) {
	d.pending = append(d.pending, data...)
	for len(d.pending) > 0 {
		i := bytes.Index(d.pending, d.prefix)
		if i < 0 {
			keep := 0
			for n := 1; n < len(d.prefix) && n <= len(d.pending); n++ {
				if bytes.Equal(d.pending[len(d.pending)-n:], d.prefix[:n]) {
					keep = n
				}
			}
			output(d.pending[:len(d.pending)-keep])
			d.pending = append([]byte(nil), d.pending[len(d.pending)-keep:]...)
			return
		}
		output(d.pending[:i])
		d.pending = d.pending[i:]
		payload := d.pending[len(d.prefix):]
		end, terminator := bytes.IndexByte(payload, 7), 1
		if st := bytes.Index(payload, []byte("\x1b\\")); st >= 0 && (end < 0 || st < end) {
			end, terminator = st, 2
		}
		// Payloads are base64/ASCII fields: a nested prefix means the previous frame was broken.
		if next := bytes.Index(payload, d.prefix); next >= 0 && (end < 0 || next < end) {
			boundary := len(d.prefix) + next
			output(d.pending[:boundary])
			d.pending = d.pending[boundary:]
			continue
		}
		if end < 0 {
			// A submitted command may contain 1 MiB before base64 encoding.
			if len(d.pending) > 2<<20 {
				output(d.pending)
				d.pending = nil
			}
			return
		}
		end += len(d.prefix)
		if end > 2<<20 {
			output(d.pending[:end+terminator])
		} else {
			hook(strings.TrimSpace(string(d.pending[len(d.prefix):end])))
		}
		d.pending = d.pending[end+terminator:]
	}
}

func (d *Decoder) Flush(output func([]byte)) { output(d.pending); d.pending = nil }
