package terminal

import (
	"sync"
)

type historyBuffer struct {
	buf         []byte
	capacity    int
	start       int
	length      int
	startCursor uint64
	endCursor   uint64
	mu          sync.RWMutex
}

func newHistoryBuffer(capacity int) *historyBuffer {
	return &historyBuffer{
		buf:      make([]byte, capacity),
		capacity: capacity,
		start:    0,
		length:   0,
	}
}

func (hb *historyBuffer) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}

	hb.mu.Lock()
	defer hb.mu.Unlock()

	n := len(data)
	if n >= hb.capacity {
		copy(hb.buf, data[n-hb.capacity:])
		hb.start = 0
		hb.length = hb.capacity
		hb.endCursor += uint64(n)
		hb.startCursor = hb.endCursor - uint64(hb.length)
		return n, nil
	}

	for i := 0; i < n; i++ {
		pos := (hb.start + hb.length) % hb.capacity
		hb.buf[pos] = data[i]
		if hb.length < hb.capacity {
			hb.length++
		} else {
			hb.start = (hb.start + 1) % hb.capacity
			hb.startCursor++
		}
		hb.endCursor++
	}

	return n, nil
}

func (hb *historyBuffer) Read() []byte {
	hb.mu.RLock()
	defer hb.mu.RUnlock()

	return hb.readLocked()
}

func (hb *historyBuffer) ReadFrom(cursor uint64) ([]byte, bool, uint64) {
	hb.mu.RLock()
	defer hb.mu.RUnlock()

	if cursor < hb.startCursor || cursor > hb.endCursor {
		return nil, false, hb.endCursor
	}

	if cursor == hb.endCursor {
		return nil, true, hb.endCursor
	}

	all := hb.readLocked()
	if len(all) == 0 {
		return nil, true, hb.endCursor
	}

	offset := int(cursor - hb.startCursor)
	if offset < 0 || offset > len(all) {
		return nil, false, hb.endCursor
	}

	data := make([]byte, len(all)-offset)
	copy(data, all[offset:])
	return data, true, hb.endCursor
}

func (hb *historyBuffer) CursorRange() (uint64, uint64) {
	hb.mu.RLock()
	defer hb.mu.RUnlock()
	return hb.startCursor, hb.endCursor
}

func (hb *historyBuffer) readLocked() []byte {
	if hb.length == 0 {
		return nil
	}

	result := make([]byte, hb.length)
	if hb.start+hb.length <= hb.capacity {
		copy(result, hb.buf[hb.start:hb.start+hb.length])
	} else {
		firstPart := hb.capacity - hb.start
		copy(result, hb.buf[hb.start:])
		copy(result[firstPart:], hb.buf[:hb.length-firstPart])
	}

	return result
}

func (hb *historyBuffer) Reset() {
	hb.mu.Lock()
	defer hb.mu.Unlock()

	hb.start = 0
	hb.length = 0
	hb.startCursor = hb.endCursor
}

// Restore seeds a live ring from a persisted absolute-cursor snapshot.
func (hb *historyBuffer) Restore(data []byte, cursor uint64) {
	hb.mu.Lock()
	defer hb.mu.Unlock()

	if cursor < uint64(len(data)) {
		cursor = uint64(len(data))
	}
	if len(data) > hb.capacity {
		data = data[len(data)-hb.capacity:]
	}

	hb.start = 0
	hb.length = len(data)
	copy(hb.buf, data)
	hb.endCursor = cursor
	hb.startCursor = cursor - uint64(len(data))
}

func (hb *historyBuffer) Len() int {
	hb.mu.RLock()
	defer hb.mu.RUnlock()
	return hb.length
}

func (hb *historyBuffer) Cap() int {
	return hb.capacity
}
