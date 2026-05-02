package terminal

import (
	"sync"
	"testing"
)

func TestManagerReserveConnectionSlotsConcurrent(t *testing.T) {
	const limit = 4
	const attempts = 128

	manager := &Manager{maxConnections: limit}
	start := make(chan struct{})
	results := make(chan bool, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- manager.reserveConnectionSlot()
		}()
	}

	close(start)
	wg.Wait()
	close(results)

	accepted := 0
	for result := range results {
		if result {
			accepted++
		}
	}
	if accepted != limit {
		t.Fatalf("accepted %d concurrent reservations, want exactly %d", accepted, limit)
	}
	if got := manager.activeConns.Load(); got != limit {
		t.Fatalf("active connection count = %d, want %d", got, limit)
	}

	for i := 0; i < limit; i++ {
		manager.activeConns.Add(-1)
	}
	if manager.activeConns.Load() != 0 {
		t.Fatalf("active connection count after release = %d, want 0", manager.activeConns.Load())
	}
	if !manager.reserveConnectionSlot() {
		t.Fatal("expected a slot to become available after release")
	}
}
