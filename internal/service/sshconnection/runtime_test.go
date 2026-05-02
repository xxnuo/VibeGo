package sshconnection

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
)

type blockingWriteCloser struct {
	writeStarted chan struct{}
	writeRelease chan struct{}
	closeStarted chan struct{}
	closeRelease chan struct{}
	writeOnce    sync.Once
	closeOnce    sync.Once
	writeCalls   atomic.Int32
}

func newBlockingWriteCloser() *blockingWriteCloser {
	return &blockingWriteCloser{
		writeStarted: make(chan struct{}),
		writeRelease: make(chan struct{}),
		closeStarted: make(chan struct{}),
		closeRelease: make(chan struct{}),
	}
}

func (w *blockingWriteCloser) Write(p []byte) (int, error) {
	w.writeCalls.Add(1)
	w.writeOnce.Do(func() { close(w.writeStarted) })
	<-w.writeRelease
	return len(p), nil
}

func (w *blockingWriteCloser) Close() error {
	w.closeOnce.Do(func() { close(w.closeStarted) })
	<-w.closeRelease
	return nil
}

type blockingRuntimeSession struct {
	resizeStarted chan struct{}
	resizeRelease chan struct{}
	closeStarted  chan struct{}
	closeRelease  chan struct{}
	waitRelease   chan struct{}
	resizeOnce    sync.Once
	closeOnce     sync.Once
	resizeCalls   atomic.Int32
}

func newBlockingRuntimeSession() *blockingRuntimeSession {
	return &blockingRuntimeSession{
		resizeStarted: make(chan struct{}),
		resizeRelease: make(chan struct{}),
		closeStarted:  make(chan struct{}),
		closeRelease:  make(chan struct{}),
		waitRelease:   make(chan struct{}),
	}
}

func (s *blockingRuntimeSession) WindowChange(int, int) error {
	s.resizeCalls.Add(1)
	s.resizeOnce.Do(func() { close(s.resizeStarted) })
	<-s.resizeRelease
	return nil
}

func (s *blockingRuntimeSession) Close() error {
	s.closeOnce.Do(func() { close(s.closeStarted) })
	<-s.closeRelease
	return nil
}

func (s *blockingRuntimeSession) Wait() error {
	<-s.waitRelease
	return nil
}

type runtimeTestHarness struct {
	runtime         *Runtime
	stdin           *blockingWriteCloser
	session         *blockingRuntimeSession
	transportClosed chan struct{}
	release         sync.Once
}

type signalRuntimeSession struct {
	mu      sync.Mutex
	signals []ssh.Signal
}

func (s *signalRuntimeSession) WindowChange(int, int) error { return nil }
func (s *signalRuntimeSession) Close() error                { return nil }
func (s *signalRuntimeSession) Wait() error                 { return nil }
func (s *signalRuntimeSession) Signal(signal ssh.Signal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signals = append(s.signals, signal)
	return nil
}

type recordingWriteCloser struct {
	mu     sync.Mutex
	writes [][]byte
}

func (w *recordingWriteCloser) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writes = append(w.writes, append([]byte(nil), p...))
	return len(p), nil
}

func (w *recordingWriteCloser) Close() error { return nil }

func newRuntimeTestHarness(timeout time.Duration) *runtimeTestHarness {
	reader, writer := io.Pipe()
	stdin := newBlockingWriteCloser()
	session := newBlockingRuntimeSession()
	harness := &runtimeTestHarness{
		stdin:           stdin,
		session:         session,
		transportClosed: make(chan struct{}),
		runtime: &Runtime{
			session:          session,
			stdin:            stdin,
			reader:           reader,
			writer:           writer,
			done:             make(chan struct{}),
			closed:           make(chan struct{}),
			operationSlot:    make(chan struct{}, 1),
			operationTimeout: timeout,
			closeTimeout:     25 * time.Millisecond,
		},
	}
	harness.runtime.transportClose = func() {
		harness.releaseBlockedCalls()
		close(harness.transportClosed)
	}
	go harness.runtime.wait()
	return harness
}

func (h *runtimeTestHarness) releaseBlockedCalls() {
	h.release.Do(func() {
		close(h.stdin.writeRelease)
		close(h.stdin.closeRelease)
		close(h.session.resizeRelease)
		close(h.session.closeRelease)
		close(h.session.waitRelease)
		_ = h.runtime.reader.Close()
		_ = h.runtime.writer.Close()
	})
}

func TestRuntimeWriteAndResizeTimeoutWithoutUnboundedOperations(t *testing.T) {
	t.Run("write", func(t *testing.T) {
		harness := newRuntimeTestHarness(25 * time.Millisecond)
		defer harness.releaseBlockedCalls()

		startedAt := time.Now()
		_, err := harness.runtime.Write([]byte("blocked"))
		require.ErrorIs(t, err, errRuntimeOperationTimeout)
		require.Less(t, time.Since(startedAt), time.Second)
		select {
		case <-harness.transportClosed:
		case <-time.After(time.Second):
			t.Fatal("write timeout did not close the SSH transport")
		}
		_, err = harness.runtime.Write([]byte("still-blocked"))
		require.ErrorIs(t, err, errRuntimeClosed)
		require.Equal(t, int32(1), harness.stdin.writeCalls.Load())
	})

	t.Run("resize", func(t *testing.T) {
		harness := newRuntimeTestHarness(25 * time.Millisecond)
		defer harness.releaseBlockedCalls()

		startedAt := time.Now()
		err := harness.runtime.Resize(120, 40)
		require.ErrorIs(t, err, errRuntimeOperationTimeout)
		require.Less(t, time.Since(startedAt), time.Second)
		select {
		case <-harness.transportClosed:
		case <-time.After(time.Second):
			t.Fatal("resize timeout did not close the SSH transport")
		}
		err = harness.runtime.Resize(100, 30)
		require.ErrorIs(t, err, errRuntimeClosed)
		require.Equal(t, int32(1), harness.session.resizeCalls.Load())
	})
}

func TestRuntimeSignalUsesPTYInterruptAndNormalizesInput(t *testing.T) {
	session := &signalRuntimeSession{}
	stdin := &recordingWriteCloser{}
	reader, writer := io.Pipe()
	runtime := &Runtime{
		session:          session,
		stdin:            stdin,
		reader:           reader,
		writer:           writer,
		done:             make(chan struct{}),
		closed:           make(chan struct{}),
		operationSlot:    make(chan struct{}, 1),
		operationTimeout: time.Second,
	}
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	require.NoError(t, runtime.Signal(" sigint "))
	stdin.mu.Lock()
	require.Equal(t, [][]byte{{3}}, stdin.writes)
	stdin.mu.Unlock()
	session.mu.Lock()
	require.Empty(t, session.signals)
	session.mu.Unlock()
	require.ErrorIs(t, runtime.Signal("TERM"), terminal.ErrTerminalSignalUnsupported)
	require.Error(t, runtime.Signal("QUIT"))
}

func TestRuntimeSignalTimesOutAndClosesTransport(t *testing.T) {
	harness := newRuntimeTestHarness(25 * time.Millisecond)
	defer harness.releaseBlockedCalls()

	startedAt := time.Now()
	require.ErrorIs(t, harness.runtime.Signal("INT"), errRuntimeOperationTimeout)
	require.Less(t, time.Since(startedAt), time.Second)
	select {
	case <-harness.transportClosed:
	case <-time.After(time.Second):
		t.Fatal("signal timeout did not close the SSH transport")
	}
	require.Equal(t, int32(1), harness.stdin.writeCalls.Load())
}

func TestRuntimeCloseUnblocksLocalLifecycleWhileSSHCallsAreBlocked(t *testing.T) {
	harness := newRuntimeTestHarness(time.Hour)
	defer harness.releaseBlockedCalls()

	writeDone := make(chan error, 1)
	go func() {
		_, err := harness.runtime.Write([]byte("blocked"))
		writeDone <- err
	}()
	select {
	case <-harness.stdin.writeStarted:
	case <-time.After(time.Second):
		t.Fatal("SSH runtime write did not start")
	}

	readDone := make(chan error, 1)
	go func() {
		buffer := make([]byte, 1)
		_, err := harness.runtime.Read(buffer)
		readDone <- err
	}()
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- harness.runtime.Wait(context.Background())
	}()

	startedAt := time.Now()
	require.NoError(t, harness.runtime.Close())
	require.Less(t, time.Since(startedAt), time.Second)
	require.ErrorIs(t, <-writeDone, errRuntimeClosed)
	require.Error(t, <-readDone)
	require.NoError(t, <-waitDone)

	select {
	case <-harness.stdin.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("stdin close did not start asynchronously")
	}
	select {
	case <-harness.session.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("session close did not start asynchronously")
	}
	select {
	case <-harness.transportClosed:
	case <-time.After(time.Second):
		t.Fatal("blocked session close did not trigger the transport fallback")
	}
}
