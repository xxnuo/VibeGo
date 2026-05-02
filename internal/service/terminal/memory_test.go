package terminal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

func TestHistoryBufferLazyGrowthAndChunks(t *testing.T) {
	b := newHistoryBuffer(10 * 1024 * 1024)
	if len(b.buf) > 64*1024 {
		t.Fatal("eager allocation", len(b.buf))
	}
	var all []byte
	for i := 0; i < 180; i++ {
		data := bytes.Repeat([]byte{byte(i)}, 70001)
		all = append(all, data...)
		_, _ = b.Write(data)
	}
	retained := all[len(all)-b.Cap():]
	if !bytes.Equal(b.Read(), retained) {
		t.Fatal("growth/wrap lost data")
	}
	start, _ := b.CursorRange()
	data, ok, end := b.ReadChunk(start+17, 32768)
	if !ok || end != start+17+32768 || !bytes.Equal(data, retained[17:17+32768]) {
		t.Fatal("wrong chunk")
	}
}

func TestNaturalExitRetiresRepeatedTerminals(t *testing.T) {
	m := NewManager(setupTestDB(t), &ManagerConfig{Shell: "/bin/sh"})
	for round := 0; round < 3; round++ {
		for i := 0; i < 100; i++ {
			id := fmt.Sprintf("exit-%d-%d", round, i)
			if err := m.db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
				t.Fatal(err)
			}
			at := newTestActiveTerminalForDrain(id, newTailRuntime([]byte("tail"), false), m)
			go m.ptyReadLoop(at)
			m.monitorRuntimeAsync(at)
			if _, ok := m.getActive(id); ok {
				t.Fatal("exited terminal retained")
			}
			snapshot, err := m.loadSnapshot(id)
			if err != nil || string(snapshot.Data) != "tail" || snapshot.Status != model.StatusExited {
				t.Fatal("lost final snapshot", err)
			}
		}
		count := 0
		m.terminals.Range(func(_, _ any) bool { count++; return true })
		if count != 0 {
			t.Fatal("activity grew", count)
		}
	}
}

type flowTestMaster struct {
	messages chan WSMessage
	ctx      context.Context
	once     sync.Once
}

func (m *flowTestMaster) Write(data []byte) (int, error) {
	var msg WSMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return 0, err
	}
	select {
	case m.messages <- msg:
		return len(data), nil
	case <-m.ctx.Done():
		return 0, m.ctx.Err()
	}
}
func (m *flowTestMaster) ReadMessage() ([]byte, error) { <-m.ctx.Done(); return nil, m.ctx.Err() }
func (m *flowTestMaster) Ping() error                  { return nil }
func (m *flowTestMaster) Close() error                 { return nil }

func TestFlowWindowAndExpiredHistory(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	at := deliveryTestTerminal()
	at.historyBuffer = newHistoryBuffer(1024 * 1024)
	at.Session = &model.TerminalSession{ID: at.ID, Status: model.StatusRunning}
	_, _ = at.historyBuffer.Write(bytes.Repeat([]byte("a"), 1024*1024))
	master := &flowTestMaster{messages: make(chan WSMessage, 32), ctx: ctx}
	f := &terminalFlow{wake: make(chan struct{}, 1)}
	conn := &terminalConnection{Master: master, Ctx: ctx, Cancel: cancel, flow: f, sendCh: make(chan terminalOutboundMessage, 128)}
	m := &Manager{}
	done := make(chan error, 1)
	go func() { done <- m.writeFlow(at, conn, 0) }()
	read := func() WSMessage {
		t.Helper()
		select {
		case msg := <-master.messages:
			return msg
		case <-time.After(time.Second):
			t.Fatal("flow stalled")
			return WSMessage{}
		}
	}
	first := read()
	stream := first.StreamID
	total := 0
	var cursor uint64
	for total < flowWindow {
		msg := read()
		data, _ := base64.StdEncoding.DecodeString(msg.Data)
		total += len(data)
		cursor = msg.Cursor
		if len(data) > flowChunk {
			t.Fatal("oversized frame")
		}
	}
	f.acknowledge("stale", cursor)
	f.acknowledge(stream, cursor+1)
	select {
	case msg := <-master.messages:
		t.Fatal("invalid ACK released window", msg.Type)
	case <-time.After(20 * time.Millisecond):
	}
	at.historyMu.Lock()
	_, _ = at.historyBuffer.Write(bytes.Repeat([]byte("b"), 2*1024*1024))
	at.historyMu.Unlock()
	f.acknowledge(stream, cursor)
	sawReset := false
	for i := 0; i < 100; i++ {
		msg := read()
		if msg.Reset {
			if msg.StreamID == stream || msg.Reason != "history_expired" {
				t.Fatal("missing stream reset")
			}
			sawReset = true
			break
		}
		if msg.Data != "" {
			f.acknowledge(msg.StreamID, msg.Cursor)
		}
	}
	if !sawReset {
		t.Fatal("no catch-up reset")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("writer leaked")
	}
}

func TestOSCParserBoundsAndSplitSequences(t *testing.T) {
	var p oscParser
	var got []string
	input := "\x1bPimage\x1b]9;fake\a\x1b\\\x1b]9;中文\a\x1b]777;notify;title;body\x1b\\"
	for _, b := range []byte(input) {
		p.feed([]byte{b}, func(s string) { got = append(got, s) })
	}
	if len(got) != 2 || got[0] != "9;中文" || got[1] != "777;notify;title;body" {
		t.Fatal(got)
	}
	p.feed(append([]byte("\x1b]9;"), bytes.Repeat([]byte("x"), 128*1024)...), func(string) { t.Fatal("unterminated notification") })
	if len(p.data) > 64*1024 {
		t.Fatal("parser grew")
	}
	p.feed([]byte("\a\x1b]9;ok\a"), func(s string) {
		if s != "9;ok" {
			t.Fatal(s)
		}
	})
}

func TestHistoryPaginationWithEqualTimestamps(t *testing.T) {
	m := NewManager(setupTestDB(t), &ManagerConfig{})
	for i := 0; i < 120; i++ {
		m.db.Create(&model.TerminalSession{ID: fmt.Sprintf("history-%03d", i), CreatedAt: 1, Status: model.StatusExited})
	}
	m.db.Create(&model.TerminalSession{ID: "running", CreatedAt: 2, Status: model.StatusRunning})
	cursor := ""
	seen := map[string]bool{}
	for {
		page, err := m.ListHistory("", "", cursor, 50)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Terminals) > 50 {
			t.Fatal("page too large")
		}
		for _, item := range page.Terminals {
			if seen[item.ID] || item.ID == "running" {
				t.Fatal("duplicate/wrong status")
			}
			seen[item.ID] = true
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
	}
	if len(seen) != 120 {
		t.Fatal(len(seen))
	}
	if _, err := m.ListHistory("", "", "invalid", 50); err == nil {
		t.Fatal("accepted invalid cursor")
	}
}

type retrySnapshotStore struct {
	TerminalSnapshotStore
	fail     atomic.Bool
	attempts atomic.Int32
}

func (s *retrySnapshotStore) Save(snapshot *TerminalSnapshot) error {
	s.attempts.Add(1)
	if s.fail.Load() {
		return errors.New("temporary storage failure")
	}
	return s.TerminalSnapshotStore.Save(snapshot)
}

func TestFinalSnapshotRetryPreservesTail(t *testing.T) {
	m := NewManager(setupTestDB(t), &ManagerConfig{})
	store := &retrySnapshotStore{TerminalSnapshotStore: m.snapshotStore}
	store.fail.Store(true)
	m.snapshotStore = store
	const id = "retry-final"
	if err := m.db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatal(err)
	}
	at := newTestActiveTerminalForDrain(id, newTailRuntime([]byte("durable-tail"), false), m)
	go m.ptyReadLoop(at)
	done := make(chan struct{})
	go func() { m.monitorRuntimeAsync(at); close(done) }()
	deadline := time.Now().Add(time.Second)
	for store.attempts.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if store.attempts.Load() < 2 {
		t.Fatal("retry did not start")
	}
	if _, ok := m.getActive(id); !ok {
		t.Fatal("discarded unsaved history")
	}
	store.fail.Store(false)
	select {
	case <-done:
	case <-time.After(6 * time.Second):
		t.Fatal("retry did not release terminal")
	}
	snapshot, err := m.loadSnapshot(id)
	if err != nil || snapshot == nil || string(snapshot.Data) != "durable-tail" {
		t.Fatal("tail lost", err)
	}
	if _, ok := m.getActive(id); ok {
		t.Fatal("saved terminal retained")
	}
}

func TestFlowClientsHaveIndependentWindows(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	at := deliveryTestTerminal()
	at.historyBuffer = newHistoryBuffer(2 * flowWindow)
	at.Session = &model.TerminalSession{ID: at.ID, Status: model.StatusRunning}
	_, _ = at.historyBuffer.Write(bytes.Repeat([]byte("z"), 2*flowWindow))
	m := &Manager{}
	slow := &terminalFlow{wake: make(chan struct{}, 1)}
	fast := &terminalFlow{wake: make(chan struct{}, 1)}
	slowMaster := &flowTestMaster{messages: make(chan WSMessage, 64), ctx: ctx}
	fastMaster := &flowTestMaster{messages: make(chan WSMessage, 64), ctx: ctx}
	finished := make(chan error, 2)
	for _, item := range []struct {
		f      *terminalFlow
		master *flowTestMaster
	}{{slow, slowMaster}, {fast, fastMaster}} {
		conn := &terminalConnection{Master: item.master, Ctx: ctx, Cancel: cancel, flow: item.f, sendCh: make(chan terminalOutboundMessage, 128)}
		go func() { finished <- m.writeFlow(at, conn, 0) }()
	}
	total := 0
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for total < 2*flowWindow {
		select {
		case msg := <-fastMaster.messages:
			data, _ := base64.StdEncoding.DecodeString(msg.Data)
			total += len(data)
			fast.acknowledge(msg.StreamID, msg.Cursor)
		case <-deadline.C:
			t.Fatal("fast client blocked behind slow client")
		}
	}
	slow.mu.Lock()
	outstanding := slow.sent - slow.ack
	slow.mu.Unlock()
	if outstanding > flowWindow {
		t.Fatal("slow window unbounded", outstanding)
	}
	cancel()
	for i := 0; i < 2; i++ {
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("writer leaked")
		}
	}
}

func TestDeleteCancelsFinalSnapshotRetry(t *testing.T) {
	m := NewManager(setupTestDB(t), &ManagerConfig{})
	store := &retrySnapshotStore{TerminalSnapshotStore: m.snapshotStore}
	store.fail.Store(true)
	m.snapshotStore = store
	const id = "delete-retrying-final"
	if err := m.db.Create(&model.TerminalSession{ID: id, Status: model.StatusRunning}).Error; err != nil {
		t.Fatal(err)
	}
	at := newTestActiveTerminalForDrain(id, newTailRuntime([]byte("tail"), false), m)
	go m.ptyReadLoop(at)
	done := make(chan struct{})
	go func() { m.monitorRuntimeAsync(at); close(done) }()
	deadline := time.Now().Add(time.Second)
	for store.attempts.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if store.attempts.Load() < 2 {
		t.Fatal("retry did not start")
	}
	store.fail.Store(false)
	if err := m.Delete(id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retry survived deletion")
	}
	var count int64
	if err := m.db.Model(&model.TerminalHistory{}).Where("session_id = ?", id).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("history resurrected", count, err)
	}
}
