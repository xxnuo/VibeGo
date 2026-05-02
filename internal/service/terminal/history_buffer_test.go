package terminal

import (
	"bytes"
	"testing"
)

func TestNewHistoryBuffer(t *testing.T) {
	capacity := 1024
	hb := newHistoryBuffer(capacity)

	if hb == nil {
		t.Fatal("newHistoryBuffer returned nil")
	}
	if hb.Cap() != capacity {
		t.Errorf("expected capacity %d, got %d", capacity, hb.Cap())
	}
	if hb.Len() != 0 {
		t.Errorf("expected length 0, got %d", hb.Len())
	}
}

func TestHistoryBufferWrite(t *testing.T) {
	hb := newHistoryBuffer(10)

	data := []byte("hello")
	n, err := hb.Write(data)
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if n != len(data) {
		t.Errorf("expected to write %d bytes, wrote %d", len(data), n)
	}
	if hb.Len() != len(data) {
		t.Errorf("expected length %d, got %d", len(data), hb.Len())
	}

	read := hb.Read()
	if !bytes.Equal(read, data) {
		t.Errorf("expected %q, got %q", data, read)
	}
}

func TestHistoryBufferWrap(t *testing.T) {
	hb := newHistoryBuffer(5)

	hb.Write([]byte("12345"))
	if hb.Len() != 5 {
		t.Errorf("expected length 5, got %d", hb.Len())
	}

	hb.Write([]byte("67"))
	if hb.Len() != 5 {
		t.Errorf("expected length 5 after wrap, got %d", hb.Len())
	}

	read := hb.Read()
	expected := []byte("34567")
	if !bytes.Equal(read, expected) {
		t.Errorf("expected %q, got %q", expected, read)
	}
}

func TestHistoryBufferLargeWrite(t *testing.T) {
	hb := newHistoryBuffer(10)

	data := []byte("this is a very long string")
	hb.Write(data)

	read := hb.Read()
	expected := data[len(data)-10:]
	if !bytes.Equal(read, expected) {
		t.Errorf("expected %q, got %q", expected, read)
	}
}

func TestHistoryBufferReset(t *testing.T) {
	hb := newHistoryBuffer(10)

	hb.Write([]byte("hello"))
	if hb.Len() != 5 {
		t.Errorf("expected length 5, got %d", hb.Len())
	}

	hb.Reset()
	if hb.Len() != 0 {
		t.Errorf("expected length 0 after reset, got %d", hb.Len())
	}

	read := hb.Read()
	if read != nil {
		t.Errorf("expected nil after reset, got %q", read)
	}
}

func TestHistoryBufferRestorePreservesAbsoluteCursor(t *testing.T) {
	hb := newHistoryBuffer(5)
	hb.Restore([]byte("abcdef"), 12)

	if got := string(hb.Read()); got != "bcdef" {
		t.Fatalf("restored data = %q, want %q", got, "bcdef")
	}
	start, end := hb.CursorRange()
	if start != 7 || end != 12 {
		t.Fatalf("restored cursor range = (%d, %d), want (7, 12)", start, end)
	}

	if _, err := hb.Write([]byte("gh")); err != nil {
		t.Fatalf("append restored history: %v", err)
	}
	if got := string(hb.Read()); got != "defgh" {
		t.Fatalf("appended data = %q, want %q", got, "defgh")
	}
	start, end = hb.CursorRange()
	if start != 9 || end != 14 {
		t.Fatalf("appended cursor range = (%d, %d), want (9, 14)", start, end)
	}
}

func TestHistoryBufferRestoreRepairsLegacyCursor(t *testing.T) {
	hb := newHistoryBuffer(8)
	hb.Restore([]byte("legacy"), 0)

	start, end := hb.CursorRange()
	if start != 0 || end != 6 {
		t.Fatalf("legacy cursor range = (%d, %d), want (0, 6)", start, end)
	}
}

func TestHistoryBufferConcurrent(t *testing.T) {
	hb := newHistoryBuffer(100)

	done := make(chan bool)
	for i := 0; i < 10; i++ {
		go func(id int) {
			for j := 0; j < 100; j++ {
				hb.Write([]byte{byte(id)})
			}
			done <- true
		}(i)
	}

	for i := 0; i < 10; i++ {
		<-done
	}

	if hb.Len() != 100 {
		t.Errorf("expected length 100, got %d", hb.Len())
	}
}

func TestHistoryBufferEmptyWrite(t *testing.T) {
	hb := newHistoryBuffer(10)

	n, err := hb.Write([]byte{})
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if n != 0 {
		t.Errorf("expected to write 0 bytes, wrote %d", n)
	}
	if hb.Len() != 0 {
		t.Errorf("expected length 0, got %d", hb.Len())
	}
}

func TestHistoryBufferReadEmpty(t *testing.T) {
	hb := newHistoryBuffer(10)

	read := hb.Read()
	if read != nil {
		t.Errorf("expected nil from empty buffer, got %q", read)
	}
}

func TestHistoryBufferWrapMultipleTimes(t *testing.T) {
	hb := newHistoryBuffer(3)

	hb.Write([]byte("abc"))
	hb.Write([]byte("def"))
	hb.Write([]byte("ghi"))

	read := hb.Read()
	expected := []byte("ghi")
	if !bytes.Equal(read, expected) {
		t.Errorf("expected %q, got %q", expected, read)
	}
}

func TestHistoryBufferReadFromCursor(t *testing.T) {
	hb := newHistoryBuffer(5)

	start, end := hb.CursorRange()
	if start != 0 || end != 0 {
		t.Fatalf("expected empty cursor range 0,0 got %d,%d", start, end)
	}

	hb.Write([]byte("abc"))
	data, ok, next := hb.ReadFrom(1)
	if !ok {
		t.Fatal("expected cursor hit")
	}
	if next != 3 {
		t.Fatalf("expected next cursor 3, got %d", next)
	}
	if !bytes.Equal(data, []byte("bc")) {
		t.Fatalf("expected %q, got %q", []byte("bc"), data)
	}

	hb.Write([]byte("def"))

	data, ok, next = hb.ReadFrom(0)
	if ok {
		t.Fatal("expected cursor miss after wrap")
	}
	if next != 6 {
		t.Fatalf("expected next cursor 6, got %d", next)
	}
	if data != nil {
		t.Fatalf("expected nil data on miss, got %q", data)
	}

	data, ok, next = hb.ReadFrom(4)
	if !ok {
		t.Fatal("expected cursor hit")
	}
	if next != 6 {
		t.Fatalf("expected next cursor 6, got %d", next)
	}
	if !bytes.Equal(data, []byte("ef")) {
		t.Fatalf("expected %q, got %q", []byte("ef"), data)
	}
}

func TestHistoryBufferResetKeepsCursorContinuity(t *testing.T) {
	hb := newHistoryBuffer(5)
	hb.Write([]byte("abc"))
	hb.Reset()
	hb.Write([]byte("xy"))

	start, end := hb.CursorRange()
	if start != 3 || end != 5 {
		t.Fatalf("expected cursor range 3,5 got %d,%d", start, end)
	}
}
