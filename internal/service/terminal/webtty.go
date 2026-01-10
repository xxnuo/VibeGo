package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"sync"
)

type webTTY struct {
	master            master
	slave             slave
	permitWrite       bool
	bufferSize        int
	encoder           *base64.Encoding
	writeMutex        sync.Mutex
	onClosed          func()
	onReady           func()
	historyWriter     io.Writer
	skipSlaveReadLoop bool
}

func newWebTTY(master master, slave slave, options ...webTTYOption) *webTTY {
	wt := &webTTY{
		master:      master,
		slave:       slave,
		permitWrite: true,
		bufferSize:  32 * 1024,
		encoder:     base64.StdEncoding,
	}

	for _, opt := range options {
		opt(wt)
	}

	return wt
}

func (wt *webTTY) Run(ctx context.Context) error {
	if err := wt.sendInitMessage(); err != nil {
		return err
	}

	if wt.onReady != nil {
		wt.onReady()
	}

	errs := make(chan error, 2)

	if !wt.skipSlaveReadLoop {
		go func() {
			errs <- wt.slaveReadLoop()
		}()
	}

	go func() {
		errs <- wt.masterReadLoop()
	}()

	select {
	case <-ctx.Done():
		if wt.onClosed != nil {
			wt.onClosed()
		}
		return ctx.Err()
	case err := <-errs:
		if wt.onClosed != nil {
			wt.onClosed()
		}
		return err
	}
}

func (wt *webTTY) slaveReadLoop() error {
	maxRawSize := (wt.bufferSize - 1) / 4 * 3
	buf := make([]byte, maxRawSize)

	for {
		n, err := wt.slave.Read(buf)
		if err != nil {
			return ErrSlaveClosed
		}

		if n > 0 {
			if wt.historyWriter != nil {
				wt.historyWriter.Write(buf[:n])
			}

			encoded := wt.encoder.EncodeToString(buf[:n])
			msg := append([]byte{MsgOutput}, []byte(encoded)...)

			if _, err := wt.masterWrite(msg); err != nil {
				return ErrMasterClosed
			}
		}
	}
}

func (wt *webTTY) masterReadLoop() error {
	buf := make([]byte, wt.bufferSize)

	for {
		n, err := wt.master.Read(buf)
		if err != nil {
			return ErrMasterClosed
		}

		if err := wt.handleMessage(buf[:n]); err != nil {
			return err
		}
	}
}

func (wt *webTTY) handleMessage(data []byte) error {
	if len(data) == 0 {
		return nil
	}

	msgType := data[0]
	payload := data[1:]

	switch msgType {
	case MsgInput:
		if !wt.permitWrite {
			return nil
		}
		decoded, err := wt.encoder.DecodeString(string(payload))
		if err != nil {
			decoded = payload
		}
		if _, err := wt.slave.Write(decoded); err != nil {
			return ErrSlaveClosed
		}

	case MsgPing:
		if _, err := wt.masterWrite([]byte{MsgPong}); err != nil {
			return ErrMasterClosed
		}

	case MsgResize:
		var resize ResizeMessage
		if err := json.Unmarshal(payload, &resize); err == nil {
			wt.slave.ResizeTerminal(resize.Cols, resize.Rows)
		}
	}

	return nil
}

func (wt *webTTY) sendInitMessage() error {
	titleVars := wt.slave.WindowTitleVariables()
	titleData, _ := json.Marshal(titleVars)
	wt.masterWrite(append([]byte{MsgSetWindowTitle}, titleData...))

	bufData, _ := json.Marshal(wt.bufferSize)
	wt.masterWrite(append([]byte{MsgSetBufferSize}, bufData...))

	return nil
}

func (wt *webTTY) masterWrite(data []byte) (int, error) {
	wt.writeMutex.Lock()
	defer wt.writeMutex.Unlock()
	return wt.master.Write(data)
}
