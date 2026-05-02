package blockterm

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestConcurrentControlClaims(t *testing.T) {
	a := &activeSession{info: Session{ID: "control", Phase: "ready"}}
	s := &Service{sessions: map[string]*activeSession{"control": a}}
	start := make(chan struct{})
	winners := make(chan string, 64)
	failures := make(chan error, 64)
	var workers sync.WaitGroup
	for index := 0; index < 64; index++ {
		workers.Add(1)
		go func(owner string) {
			defer workers.Done()
			<-start
			if err := s.Claim("control", owner); err == nil {
				winners <- owner
			} else if !errors.Is(err, ErrConflict) {
				failures <- err
			}
		}(fmt.Sprintf("client-%d", index))
	}
	close(start)
	workers.Wait()
	close(winners)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	if len(winners) != 1 {
		t.Fatalf("expected one controller, got %d", len(winners))
	}
	winner := <-winners
	if err := s.Claim("control", winner); err != nil {
		t.Fatalf("renewal failed: %v", err)
	}
	s.Release("control", "non-owner")
	a.mu.Lock()
	retained := controls(a, winner)
	a.mu.Unlock()
	if !retained {
		t.Fatal("non-owner release revoked control")
	}
	if err := s.Input("control", "non-owner", []byte{3}); !errors.Is(err, ErrConflict) {
		t.Fatalf("non-owner input: %v", err)
	}
	s.Release("control", winner)
	if err := s.Claim("control", "next"); err != nil {
		t.Fatal(err)
	}
	s.Release("control", winner)
	a.mu.Lock()
	retained = controls(a, "next")
	a.mu.Unlock()
	if !retained {
		t.Fatal("late release revoked successor")
	}
}

func TestExpiredControlCannotWriteOrRevokeSuccessor(t *testing.T) {
	a := &activeSession{info: Session{ID: "control", Phase: "submitted"}, owner: "old", lease: time.Now().Add(-time.Second)}
	s := &Service{sessions: map[string]*activeSession{"control": a}}
	if err := s.Input("control", "old", []byte{3}); !errors.Is(err, ErrConflict) {
		t.Fatalf("expired input: %v", err)
	}
	if a.cancelRequested {
		t.Fatal("rejected Ctrl-C changed command lifecycle")
	}
	if err := s.Claim("control", "new"); err != nil {
		t.Fatal(err)
	}
	if err := s.Claim("control", "old"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale renewal: %v", err)
	}
	s.Release("control", "old")
	if !controls(a, "new") {
		t.Fatal("successor lost control")
	}
	a.info.Phase = "exited"
	if controls(a, "new") {
		t.Fatal("exited shell accepts input")
	}
}

func TestExitedSessionRejectsControlClaims(t *testing.T) {
	for _, previous := range []string{"", "same", "other"} {
		for _, expired := range []bool{false, true} {
			t.Run(fmt.Sprintf("owner=%s/expired=%v", previous, expired), func(t *testing.T) {
				lease := time.Now().Add(time.Minute)
				if expired {
					lease = time.Now().Add(-time.Minute)
				}
				// The reader has published exited but is still reaping the PTY.
				a := &activeSession{info: Session{ID: "control", Phase: "exited"}, owner: previous, lease: lease}
				s := &Service{sessions: map[string]*activeSession{"control": a}}
				if err := s.Claim("control", "same"); !errors.Is(err, ErrConflict) {
					t.Fatalf("exited claim accepted: %v", err)
				}
				if a.owner != previous || !a.lease.Equal(lease) {
					t.Fatal("rejected claim changed the owner or lease")
				}
			})
		}
	}
}
