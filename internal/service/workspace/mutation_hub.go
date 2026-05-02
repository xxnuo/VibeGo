package workspace

import (
	"encoding/json"
	"strings"
)

type ClientMutation struct {
	ID           string          `json:"id"`
	WorkspaceID  string          `json:"workspace_id"`
	ClientID     string          `json:"client_id"`
	Type         string          `json:"type"`
	Payload      json.RawMessage `json:"payload"`
	CreatedAt    int64           `json:"created_at"`
	BaseRevision int64           `json:"base_revision"`
}

type MutationEvent struct {
	Type     string          `json:"type"`
	Revision int64           `json:"revision"`
	ClientID string          `json:"client_id"`
	Mutation *ClientMutation `json:"mutation,omitempty"`
}

type subscriber struct {
	workspaceID string
	events      chan MutationEvent
	done        chan struct{}
}

func (s *Service) Subscribe(id string) (<-chan MutationEvent, <-chan struct{}, func()) {
	c := &subscriber{workspaceID: id, events: make(chan MutationEvent, 128), done: make(chan struct{})}
	s.mu.Lock()
	s.clients[c] = struct{}{}
	s.mu.Unlock()
	return c.events, c.done, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, ok := s.clients[c]; ok {
			delete(s.clients, c)
			close(c.done)
		}
	}
}

func (s *Service) broadcast(event MutationEvent) {
	for c := range s.clients {
		if c.workspaceID != "*" && c.workspaceID != event.Mutation.WorkspaceID {
			continue
		}
		if c.workspaceID == "*" && !strings.HasPrefix(event.Mutation.Type, "workspace/") {
			continue
		}
		select {
		case c.events <- event:
		default:
			delete(s.clients, c)
			close(c.done)
		}
	}
}
