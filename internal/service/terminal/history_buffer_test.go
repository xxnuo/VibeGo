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
