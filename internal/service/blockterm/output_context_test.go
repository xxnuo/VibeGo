package blockterm

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestOutputReadCancellationWhileWaitingForDatabase(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	sqlDB, err := s.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"session", "output", "events"} {
		t.Run(operation, func(t *testing.T) {
			connection, err := sqlDB.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			before := sqlDB.Stats().WaitCount
			done := make(chan error, 1)
			go func() {
				if operation == "session" {
					_, err := s.GetContext(ctx, "session")
					done <- err
				} else if operation == "events" {
					_, err := s.EventsContext(ctx, "session", 0)
					done <- err
				} else {
					_, err := s.OutputContext(ctx, "session", "block", 0)
					done <- err
				}
			}()
			deadline := time.Now().Add(2 * time.Second)
			for sqlDB.Stats().WaitCount == before {
				if time.Now().After(deadline) {
					t.Fatal("read did not wait for the occupied connection")
				}
				time.Sleep(time.Millisecond)
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("read cancellation: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("canceled read still waiting for the database")
			}
		})
	}
	if _, err := s.OutputContext(context.Background(), "session", "block", 0); err != nil {
		t.Fatalf("fresh read after cancellation: %v", err)
	}
}
