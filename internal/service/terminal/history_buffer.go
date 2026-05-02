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
		buf:      make([]byte, min(capacity, 64*1024)),
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

	hb.growLocked(min(hb.capacity, hb.length+len(data)))
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
		pos := (hb.start + hb.length) % len(hb.buf)
		hb.buf[pos] = data[i]
		if hb.length < hb.capacity {
			hb.length++
		} else {
			hb.start = (hb.start + 1) % len(hb.buf)
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

	return hb.readRangeLocked(int(cursor-hb.startCursor), int(hb.endCursor-cursor)), true, hb.endCursor
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

	return hb.readRangeLocked(0, hb.length)
}

func (hb *historyBuffer) readRangeLocked(offset, size int) []byte {
	result := make([]byte, size)
	if size == 0 {
		return result
	}
	start := (hb.start + offset) % len(hb.buf)
	first := min(size, len(hb.buf)-start)
	copy(result, hb.buf[start:start+first])
	copy(result[first:], hb.buf[:size-first])
	return result
}

func (hb *historyBuffer) growLocked(size int) {
	if size <= len(hb.buf) {
		return
	}
	buf := make([]byte, min(hb.capacity, max(size, len(hb.buf)*2)))
	copy(buf, hb.readRangeLocked(0, hb.length))
	hb.buf, hb.start = buf, 0
}

// ReadChunk copies only the requested range, never the entire retained history.
func (hb *historyBuffer) ReadChunk(cursor uint64, limit int) ([]byte, bool, uint64) {
	hb.mu.RLock()
	defer hb.mu.RUnlock()
	if cursor < hb.startCursor || cursor > hb.endCursor {
		return nil, false, hb.endCursor
	}
	size := min(limit, int(hb.endCursor-cursor))
	return hb.readRangeLocked(int(cursor-hb.startCursor), size), true, cursor + uint64(size)
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

	hb.growLocked(len(data))
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
