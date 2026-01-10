package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

type mockMaster struct {
	readData  []byte
	readErr   error
	writeData [][]byte
	mu        sync.Mutex
}

func (m *mockMaster) Read(p []byte) (int, error) {
	if m.readErr != nil {
		return 0, m.readErr
	}
	if len(m.readData) == 0 {
		time.Sleep(10 * time.Millisecond)
		return 0, ErrMasterClosed
	}
	n := copy(p, m.readData)
	m.readData = m.readData[n:]
	return n, nil
}

func (m *mockMaster) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data := make([]byte, len(p))
	copy(data, p)
	m.writeData = append(m.writeData, data)
	return len(p), nil
}

type mockSlave struct {
	readData  []byte
	writeData [][]byte
	mu        sync.Mutex
}

func (s *mockSlave) Read(p []byte) (int, error) {
	if len(s.readData) == 0 {
		time.Sleep(10 * time.Millisecond)
		return 0, ErrSlaveClosed
	}
	n := copy(p, s.readData)
	s.readData = s.readData[n:]
	return n, nil
}

func (s *mockSlave) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := make([]byte, len(p))
	copy(data, p)
	s.writeData = append(s.writeData, data)
	return len(p), nil
}

func (s *mockSlave) ResizeTerminal(cols, rows int) error {
	return nil
}

func (s *mockSlave) WindowTitleVariables() map[string]interface{} {
	return map[string]interface{}{
		"command": "/bin/bash",
		"pid":     12345,
	}
}

func (s *mockSlave) Close() error {
	return nil
}

func TestWebTTY_SlaveToMaster(t *testing.T) {
	master := &mockMaster{}
	slave := &mockSlave{
		readData: []byte("hello world"),
	}

	wt := newWebTTY(master, slave)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	go wt.Run(ctx)
	time.Sleep(100 * time.Millisecond)

	master.mu.Lock()
	defer master.mu.Unlock()

	found := false
	for _, msg := range master.writeData {
		var wsMsg WSMessage
		if err := json.Unmarshal(msg, &wsMsg); err != nil {
			continue
		}
		if wsMsg.Type == MsgTypeCmd {
			decoded, err := base64.StdEncoding.DecodeString(wsMsg.Data)
			if err != nil {
				continue
			}
			if string(decoded) == "hello world" {
				found = true
				break
			}
		}
	}

	if !found {
		t.Error("expected to find 'hello world' in master write data")
	}
}

func TestWebTTY_MasterToSlave_Input(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("test input"))
	inputMsg := WSMessage{Type: MsgTypeCmd, Data: encoded}
	inputData, _ := json.Marshal(inputMsg)

	master := &mockMaster{
		readData: inputData,
	}
	slave := &mockSlave{}

	wt := newWebTTY(master, slave)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	go wt.Run(ctx)
	time.Sleep(100 * time.Millisecond)

	slave.mu.Lock()
	defer slave.mu.Unlock()

	if len(slave.writeData) == 0 {
		t.Fatal("expected slave to receive data")
	}

	if string(slave.writeData[0]) != "test input" {
		t.Errorf("expected 'test input', got %s", string(slave.writeData[0]))
	}
}

func TestWebTTY_Heartbeat(t *testing.T) {
	heartbeatMsg := WSMessage{Type: MsgTypeHeartbeat, Timestamp: time.Now().Unix()}
	heartbeatData, _ := json.Marshal(heartbeatMsg)

	master := &mockMaster{
		readData: heartbeatData,
	}
	slave := &mockSlave{}

	wt := newWebTTY(master, slave)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	go wt.Run(ctx)
	time.Sleep(100 * time.Millisecond)

	master.mu.Lock()
	defer master.mu.Unlock()

	found := false
	for _, msg := range master.writeData {
		var wsMsg WSMessage
		if err := json.Unmarshal(msg, &wsMsg); err != nil {
			continue
		}
		if wsMsg.Type == MsgTypeHeartbeat {
			found = true
			break
		}
	}

	if !found {
		t.Error("expected to find heartbeat response")
	}
}

func TestWebTTY_Resize(t *testing.T) {
	resizeMsg := WSMessage{Type: MsgTypeResize, Cols: 100, Rows: 30}
	resizeData, _ := json.Marshal(resizeMsg)

	master := &mockMaster{
		readData: resizeData,
	}
	slave := &mockSlave{}

	wt := newWebTTY(master, slave)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	go wt.Run(ctx)
	time.Sleep(100 * time.Millisecond)
}

func TestWebTTY_OnClosed(t *testing.T) {
	master := &mockMaster{
		readErr: ErrMasterClosed,
	}
	slave := &mockSlave{}

	called := false
	wt := newWebTTY(master, slave, withOnClosed(func() {
		called = true
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	wt.Run(ctx)

	if !called {
		t.Error("expected onClosed callback to be called")
	}
}
