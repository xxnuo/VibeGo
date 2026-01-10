package terminal

import (
	"io"
	"time"
)

type webTTYOption func(*webTTY)

func withBufferSize(size int) webTTYOption {
	return func(wt *webTTY) {
		wt.bufferSize = size
	}
}

func withPermitWrite(permit bool) webTTYOption {
	return func(wt *webTTY) {
		wt.permitWrite = permit
	}
}

func withOnClosed(callback func()) webTTYOption {
	return func(wt *webTTY) {
		wt.onClosed = callback
	}
}

func withOnReady(callback func()) webTTYOption {
	return func(wt *webTTY) {
		wt.onReady = callback
	}
}

func withHistoryWriter(writer io.Writer) webTTYOption {
	return func(wt *webTTY) {
		wt.historyWriter = writer
	}
}

func withSkipSlaveReadLoop(skip bool) webTTYOption {
	return func(wt *webTTY) {
		wt.skipSlaveReadLoop = skip
	}
}

type localCommandOption func(*localCommand)

func withCloseTimeout(timeout time.Duration) localCommandOption {
	return func(lc *localCommand) {
		lc.closeTimeout = timeout
	}
}
