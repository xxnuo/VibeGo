package workspace

import (
	"encoding/json"
	"testing"
)

func TestTerminalEventsAreScopedEphemeralAndBounded(t *testing.T) {
	service := New(nil)
	own, done, off := service.Subscribe("ws")
	defer off()
	other, _, offOther := service.Subscribe("other")
	defer offOther()
	catalog, _, offCatalog := service.Subscribe("*")
	defer offCatalog()
	payload := json.RawMessage(`{"type":"terminal:notification","terminal_id":"terminal","title":"Test","body":"Done"}`)
	service.PublishTerminalEvent("ws", payload)
	event := <-own
	if event.Revision != 0 || event.Mutation != nil || event.Type != "terminal:event" {
		t.Fatal("event entered mutation protocol", event)
	}
	select {
	case <-other:
		t.Fatal("cross-workspace notification")
	default:
	}
	select {
	case <-catalog:
		t.Fatal("catalog notification")
	default:
	}
	for i := 0; i < 129; i++ {
		service.PublishTerminalEvent("ws", payload)
	}
	select {
	case <-done:
	default:
		t.Fatal("slow subscriber was not disconnected")
	}
	if len(own) != 128 {
		t.Fatal("unbounded event queue", len(own))
	}
}
