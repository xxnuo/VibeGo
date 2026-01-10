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

func (wt *webTTY) sendOutput(data []byte) error {
	msg := WSMessage{
		Type: MsgTypeCmd,
		Data: wt.encoder.EncodeToString(data),
	}
	return wt.sendJSON(msg)
}

func (wt *webTTY) sendJSON(msg WSMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = wt.masterWrite(data)
	return err
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

			if err := wt.sendOutput(buf[:n]); err != nil {
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

	var msg WSMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil
	}

	switch msg.Type {
	case MsgTypeCmd:
		if !wt.permitWrite {
			return nil
		}
		decoded, err := wt.encoder.DecodeString(msg.Data)
		if err != nil {
			return nil
		}
		if _, err := wt.slave.Write(decoded); err != nil {
			return ErrSlaveClosed
		}

	case MsgTypeHeartbeat:
		resp := WSMessage{
			Type:      MsgTypeHeartbeat,
			Timestamp: msg.Timestamp,
		}
		wt.sendJSON(resp)

	case MsgTypeResize:
		if msg.Cols > 0 && msg.Rows > 0 {
			wt.slave.ResizeTerminal(msg.Cols, msg.Rows)
		}
	}

	return nil
}

func (wt *webTTY) sendInitMessage() error {
	return nil
}

func (wt *webTTY) masterWrite(data []byte) (int, error) {
	wt.writeMutex.Lock()
	defer wt.writeMutex.Unlock()
	return wt.master.Write(data)
}
