package terminal

import (
	"sync"
)

type historyBuffer struct {
	buf      []byte
	capacity int
	start    int
	length   int
	mu       sync.RWMutex
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
		return n, nil
	}

	for i := 0; i < n; i++ {
		pos := (hb.start + hb.length) % hb.capacity
		hb.buf[pos] = data[i]
		if hb.length < hb.capacity {
			hb.length++
		} else {
			hb.start = (hb.start + 1) % hb.capacity
		}
	}

	return n, nil
}

func (hb *historyBuffer) Read() []byte {
	hb.mu.RLock()
	defer hb.mu.RUnlock()

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
}

func (hb *historyBuffer) Len() int {
	hb.mu.RLock()
	defer hb.mu.RUnlock()
	return hb.length
}

func (hb *historyBuffer) Cap() int {
	return hb.capacity
}
