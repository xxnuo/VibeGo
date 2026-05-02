package handler

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/service/blockterm"
)

type blockTermWriterProbe struct {
	deadline    time.Time
	deadlineErr error
	writeErr    error
	payload     interface{}
}

func (w *blockTermWriterProbe) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return w.deadlineErr
}
func (w *blockTermWriterProbe) WriteJSON(payload interface{}) error {
	if w.deadline.IsZero() {
		return errors.New("write without deadline")
	}
	w.payload = payload
	return w.writeErr
}

func TestBlockTermV2EventWritesHaveFreshDeadlines(t *testing.T) {
	for _, kind := range []string{"hello", "output", "fault"} {
		writer := &blockTermWriterProbe{deadline: time.Now().Add(-time.Hour)}
		events := []blockterm.Event{{Type: kind}}
		before := time.Now()
		if err := writeBlockTermEvents(writer, events); err != nil {
			t.Fatal(err)
		}
		if writer.deadline.Before(before.Add(10*time.Second)) || writer.deadline.After(time.Now().Add(10*time.Second)) {
			t.Fatalf("invalid deadline for %s: %v", kind, writer.deadline)
		}
		if !reflect.DeepEqual(writer.payload, events) {
			t.Fatalf("event payload changed: %#v", writer.payload)
		}
	}
	failure := errors.New("writer failure")
	writer := &blockTermWriterProbe{deadlineErr: failure}
	if err := writeBlockTermEvents(writer, nil); !errors.Is(err, failure) || writer.payload != nil {
		t.Fatal("deadline failure must prevent writing")
	}
	writer = &blockTermWriterProbe{writeErr: failure}
	if err := writeBlockTermEvents(writer, nil); !errors.Is(err, failure) {
		t.Fatal("write failure was not propagated")
	}
}
