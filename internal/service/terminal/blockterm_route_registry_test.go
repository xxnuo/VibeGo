package terminal

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
)

const blockTermRouteTestToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type blockTermRouteTestRuntime struct {
	name       string
	methodCall atomic.Int64
}

func (r *blockTermRouteTestRuntime) Type() string { return r.name }

func (r *blockTermRouteTestRuntime) Capabilities() TerminalCapabilities {
	return TerminalCapabilities{}
}

func (r *blockTermRouteTestRuntime) Read([]byte) (int, error) {
	r.methodCall.Add(1)
	return 0, io.EOF
}

func (r *blockTermRouteTestRuntime) Write(p []byte) (int, error) {
	r.methodCall.Add(1)
	return len(p), nil
}

func (r *blockTermRouteTestRuntime) Resize(int, int) error {
	r.methodCall.Add(1)
	return nil
}

func (r *blockTermRouteTestRuntime) Close() error {
	r.methodCall.Add(1)
	return nil
}

func (r *blockTermRouteTestRuntime) ExitCode() int {
	r.methodCall.Add(1)
	return 0
}

func (r *blockTermRouteTestRuntime) Wait(context.Context) error {
	r.methodCall.Add(1)
	return nil
}

func TestBlockTermRuntimeRegistryResolveTable(t *testing.T) {
	registry := NewBlockTermRuntimeRegistry()
	sessionRuntime := &blockTermRouteTestRuntime{name: "session"}
	blockRuntime := &blockTermRouteTestRuntime{name: "block"}
	if _, err := registry.RegisterSession("term-1", sessionRuntime); err != nil {
		t.Fatalf("register session: %v", err)
	}
	if _, err := registry.RegisterBlock("term-1", "block-1", blockTermRouteTestToken, blockRuntime); err != nil {
		t.Fatalf("register block: %v", err)
	}

	tests := []struct {
		name        string
		request     BlockTermRuntimeRouteRequest
		wantStatus  BlockTermRuntimeRouteStatus
		wantRuntime TerminalRuntime
	}{
		{
			name:        "session exact",
			request:     BlockTermRuntimeRouteRequest{TerminalID: "term-1"},
			wantStatus:  BlockTermRuntimeRouteStatusSession,
			wantRuntime: sessionRuntime,
		},
		{
			name:        "block exact",
			request:     BlockTermRuntimeRouteRequest{TerminalID: "term-1", BlockID: "block-1", Token: blockTermRouteTestToken},
			wantStatus:  BlockTermRuntimeRouteStatusBlock,
			wantRuntime: blockRuntime,
		},
		{
			name:       "token mismatch",
			request:    BlockTermRuntimeRouteRequest{TerminalID: "term-1", BlockID: "block-1", Token: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"},
			wantStatus: BlockTermRuntimeRouteStatusTokenMismatch,
		},
		{
			name:       "unknown tagged",
			request:    BlockTermRuntimeRouteRequest{TerminalID: "term-1", BlockID: "missing", Token: blockTermRouteTestToken},
			wantStatus: BlockTermRuntimeRouteStatusUnknownTagged,
		},
		{
			name:       "unknown session fallback",
			request:    BlockTermRuntimeRouteRequest{TerminalID: "missing-terminal"},
			wantStatus: BlockTermRuntimeRouteStatusSessionFallback,
		},
		{
			name:       "partial block tag",
			request:    BlockTermRuntimeRouteRequest{TerminalID: "term-1", BlockID: "block-1"},
			wantStatus: BlockTermRuntimeRouteStatusInvalid,
		},
		{
			name:       "partial token tag",
			request:    BlockTermRuntimeRouteRequest{TerminalID: "term-1", Token: blockTermRouteTestToken},
			wantStatus: BlockTermRuntimeRouteStatusInvalid,
		},
		{
			name:       "invalid terminal",
			request:    BlockTermRuntimeRouteRequest{TerminalID: " term-1"},
			wantStatus: BlockTermRuntimeRouteStatusInvalid,
		},
		{
			name:       "invalid token",
			request:    BlockTermRuntimeRouteRequest{TerminalID: "term-1", BlockID: "block-1", Token: "bad"},
			wantStatus: BlockTermRuntimeRouteStatusInvalid,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := registry.Resolve(test.request)
			if got.Status != test.wantStatus {
				t.Fatalf("Resolve(%+v) status = %q, want %q", test.request, got.Status, test.wantStatus)
			}
			if test.wantRuntime != nil && got.Route.Runtime != test.wantRuntime {
				t.Fatalf("Resolve(%+v) runtime = %v, want %v", test.request, got.Route.Runtime, test.wantRuntime)
			}
			if test.wantRuntime == nil && got.Route.Runtime != nil {
				t.Fatalf("Resolve(%+v) returned runtime on non-success status: %v", test.request, got.Route.Runtime)
			}
		})
	}

	// A tagged request must not silently receive the session runtime.
	unknown := registry.Resolve(BlockTermRuntimeRouteRequest{
		TerminalID: "term-1",
		BlockID:    "unknown",
		Token:      blockTermRouteTestToken,
	})
	if unknown.Status != BlockTermRuntimeRouteStatusUnknownTagged || unknown.Route.Runtime != nil {
		t.Fatalf("unknown tagged request was downgraded: %+v", unknown)
	}
}

func TestBlockTermRuntimeRegistryRegisterValidationAndDuplicate(t *testing.T) {
	registry := NewBlockTermRuntimeRegistry()
	runtime := &blockTermRouteTestRuntime{name: "runtime"}

	typedNil := (*blockTermRouteTestRuntime)(nil)
	if _, err := registry.RegisterSession("term-typed-nil", typedNil); !errors.Is(err, ErrBlockTermRuntimeRouteRuntimeNil) {
		t.Fatalf("typed nil registration error = %v, want runtime nil", err)
	}
	if _, err := registry.Register(BlockTermRuntimeRoute{TerminalID: "term-1", BlockID: "block-1", Runtime: runtime}); !errors.Is(err, ErrBlockTermRuntimeRouteInvalid) {
		t.Fatalf("block without token error = %v, want invalid", err)
	}
	if _, err := registry.Register(BlockTermRuntimeRoute{TerminalID: "term-1", Token: blockTermRouteTestToken, Runtime: runtime}); !errors.Is(err, ErrBlockTermRuntimeRouteInvalid) {
		t.Fatalf("session with token error = %v, want invalid", err)
	}
	if _, err := registry.RegisterSession("term-1", runtime); err != nil {
		t.Fatalf("first session registration: %v", err)
	}
	if _, err := registry.RegisterSession("term-1", runtime); !errors.Is(err, ErrBlockTermRuntimeRouteDuplicate) {
		t.Fatalf("duplicate registration error = %v, want duplicate", err)
	}
	if got := registry.Len(); got != 1 {
		t.Fatalf("registry length = %d, want 1", got)
	}
}

func TestBlockTermRuntimeRegistryReplaceAndABAFence(t *testing.T) {
	registry := NewBlockTermRuntimeRegistry()
	firstRuntime := &blockTermRouteTestRuntime{name: "first"}
	secondRuntime := &blockTermRouteTestRuntime{name: "second"}
	thirdRuntime := &blockTermRouteTestRuntime{name: "third"}

	oldHandle, err := registry.RegisterBlock("term-1", "block-1", blockTermRouteTestToken, firstRuntime)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	newHandle, err := registry.ReplaceBlock(oldHandle, blockTermRouteTestToken, secondRuntime)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if newHandle == oldHandle || newHandle.IsZero() {
		t.Fatalf("replacement did not create a new opaque generation: old=%#v new=%#v", oldHandle, newHandle)
	}
	if _, ok := registry.Remove(oldHandle); ok {
		t.Fatal("stale handle removed replacement route")
	}

	removed, ok := registry.Remove(newHandle)
	if !ok {
		t.Fatal("current handle failed to remove route")
	}
	if removed.Runtime != secondRuntime {
		t.Fatalf("removed runtime = %v, want second runtime", removed.Runtime)
	}

	// Re-registering the same key after removal must also advance generation,
	// so a delayed cleanup from the first lifecycle cannot remove it.
	thirdHandle, err := registry.RegisterBlock("term-1", "block-1", blockTermRouteTestToken, thirdRuntime)
	if err != nil {
		t.Fatalf("re-register: %v", err)
	}
	if _, ok := registry.Remove(newHandle); ok {
		t.Fatal("removed generation removed ABA replacement")
	}
	current := registry.ResolveByKey("term-1", "block-1", blockTermRouteTestToken)
	if current.Status != BlockTermRuntimeRouteStatusBlock || current.Route.Runtime != thirdRuntime {
		t.Fatalf("current ABA route = %+v", current)
	}
	if _, err := registry.Replace(oldHandle, BlockTermRuntimeRoute{TerminalID: "term-1", BlockID: "block-1", Token: blockTermRouteTestToken, Runtime: firstRuntime}); !errors.Is(err, ErrBlockTermRuntimeRouteStaleHandle) {
		t.Fatalf("old handle replace error = %v, want stale", err)
	}
	if _, ok := registry.Remove(thirdHandle); !ok {
		t.Fatal("current ABA handle failed to remove")
	}
}

func TestBlockTermRuntimeRegistrySnapshotsAndRemoveTerminal(t *testing.T) {
	registry := NewBlockTermRuntimeRegistry()
	sessionRuntime := &blockTermRouteTestRuntime{name: "session"}
	blockB := &blockTermRouteTestRuntime{name: "b"}
	blockA := &blockTermRouteTestRuntime{name: "a"}
	if _, err := registry.RegisterSession("term-1", sessionRuntime); err != nil {
		t.Fatalf("register session: %v", err)
	}
	if _, err := registry.RegisterBlock("term-1", "block-b", blockTermRouteTestToken, blockB); err != nil {
		t.Fatalf("register block b: %v", err)
	}
	if _, err := registry.RegisterBlock("term-1", "block-a", blockTermRouteTestToken, blockA); err != nil {
		t.Fatalf("register block a: %v", err)
	}
	if _, err := registry.RegisterSession("term-2", &blockTermRouteTestRuntime{name: "other"}); err != nil {
		t.Fatalf("register other session: %v", err)
	}

	got := registry.ResolveSessionFallback("term-1")
	if got.Status != BlockTermRuntimeRouteStatusSessionFallback || got.Route.Runtime != sessionRuntime {
		t.Fatalf("explicit session fallback = %+v", got)
	}

	// Returned route metadata is a value snapshot. Reassigning the local copy
	// does not affect subsequent lookups.
	snapshot := registry.ResolveByKey("term-1", "block-a", blockTermRouteTestToken).Route
	snapshot.TerminalID = "mutated"
	snapshot.BlockID = "mutated"
	snapshot.Token = "mutated"
	current := registry.ResolveByKey("term-1", "block-a", blockTermRouteTestToken)
	if current.Status != BlockTermRuntimeRouteStatusBlock || current.Route.TerminalID != "term-1" || current.Route.BlockID != "block-a" || current.Route.Token != blockTermRouteTestToken {
		t.Fatalf("registry metadata changed through snapshot: %+v", current)
	}

	removedBlocks := registry.RemoveBlocks("term-1")
	if len(removedBlocks) != 2 || removedBlocks[0].BlockID != "block-a" || removedBlocks[1].BlockID != "block-b" {
		t.Fatalf("removed block routes = %#v, want block-a/block-b", removedBlocks)
	}
	if session := registry.Resolve(BlockTermRuntimeRouteRequest{TerminalID: "term-1"}); session.Status != BlockTermRuntimeRouteStatusSession || session.Route.Runtime != sessionRuntime {
		t.Fatalf("session route after block removal = %+v", session)
	}
	if status := registry.ResolveByKey("term-1", "block-a", blockTermRouteTestToken).Status; status != BlockTermRuntimeRouteStatusUnknownTagged {
		t.Fatalf("removed block route status = %q", status)
	}
	if _, err := registry.RegisterBlock("term-1", "block-b", blockTermRouteTestToken, blockB); err != nil {
		t.Fatalf("restore block b: %v", err)
	}
	if _, err := registry.RegisterBlock("term-1", "block-a", blockTermRouteTestToken, blockA); err != nil {
		t.Fatalf("restore block a: %v", err)
	}

	removed := registry.RemoveTerminal("term-1")
	if len(removed) != 3 {
		t.Fatalf("removed route count = %d, want 3", len(removed))
	}
	if removed[0].BlockID != "" || removed[1].BlockID != "block-a" || removed[2].BlockID != "block-b" {
		t.Fatalf("removed route order = %#v, want session/block-a/block-b", removed)
	}
	if got := registry.Len(); got != 1 {
		t.Fatalf("registry length after terminal removal = %d, want 1", got)
	}
	if status := registry.ResolveSessionFallback("term-1").Status; status != BlockTermRuntimeRouteStatusSessionFallback {
		t.Fatalf("removed terminal fallback status = %q", status)
	}
	if status := registry.ResolveSessionFallback("term-2").Status; status != BlockTermRuntimeRouteStatusSessionFallback {
		t.Fatalf("other terminal fallback status = %q", status)
	}
	if sessionRuntime.methodCall.Load() != 0 || blockA.methodCall.Load() != 0 || blockB.methodCall.Load() != 0 {
		t.Fatalf("registry invoked runtime methods during removal: session=%d a=%d b=%d", sessionRuntime.methodCall.Load(), blockA.methodCall.Load(), blockB.methodCall.Load())
	}
}

func TestBlockTermRuntimeRegistryZeroValueAndForeignHandle(t *testing.T) {
	var zero BlockTermRuntimeRegistry
	runtime := &blockTermRouteTestRuntime{name: "zero"}
	handle, err := zero.RegisterSession("term-1", runtime)
	if err != nil {
		t.Fatalf("zero-value register: %v", err)
	}
	if !handle.Valid() || handle.Key() != (BlockTermRuntimeRouteKey{TerminalID: "term-1"}) {
		t.Fatalf("zero-value handle = %#v", handle)
	}

	other := NewBlockTermRuntimeRegistry()
	if _, ok := other.Remove(handle); ok {
		t.Fatal("foreign registry accepted handle")
	}
	if _, err := other.Replace(handle, BlockTermRuntimeRoute{TerminalID: "term-1", Runtime: runtime}); !errors.Is(err, ErrBlockTermRuntimeRouteStaleHandle) {
		t.Fatalf("foreign replace error = %v, want stale", err)
	}
	if _, ok := zero.Remove(handle); !ok {
		t.Fatal("zero-value registry failed to remove current handle")
	}
}

func TestBlockTermRuntimeRegistryConcurrentAccess(t *testing.T) {
	registry := NewBlockTermRuntimeRegistry()
	const terminalCount = 8
	const blockCount = 8

	var handlesMu sync.Mutex
	handles := make(map[BlockTermRuntimeRouteKey]BlockTermRuntimeHandle)
	var wg sync.WaitGroup
	for terminalIndex := 0; terminalIndex < terminalCount; terminalIndex++ {
		terminalID := "term-race-" + string(rune('a'+terminalIndex))
		runtime := &blockTermRouteTestRuntime{name: terminalID}
		wg.Add(1)
		go func() {
			defer wg.Done()
			handle, err := registry.RegisterSession(terminalID, runtime)
			if err != nil {
				t.Errorf("register session %s: %v", terminalID, err)
				return
			}
			handlesMu.Lock()
			handles[BlockTermRuntimeRouteKey{TerminalID: terminalID}] = handle
			handlesMu.Unlock()
		}()
		for blockIndex := 0; blockIndex < blockCount; blockIndex++ {
			blockID := "block-" + string(rune('a'+blockIndex))
			token := blockTermRouteTestToken
			wg.Add(1)
			go func(blockID string) {
				defer wg.Done()
				runtime := &blockTermRouteTestRuntime{name: terminalID + "/" + blockID}
				handle, err := registry.RegisterBlock(terminalID, blockID, token, runtime)
				if err != nil {
					t.Errorf("register block %s/%s: %v", terminalID, blockID, err)
					return
				}
				handlesMu.Lock()
				handles[BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}] = handle
				handlesMu.Unlock()
			}(blockID)
		}
	}
	wg.Wait()

	if got, want := registry.Len(), terminalCount*(blockCount+1); got != want {
		t.Fatalf("registered route count = %d, want %d", got, want)
	}

	// Resolve concurrently with replacement and removal. All operations are
	// intentionally independent of runtime methods, making this suitable for
	// the race detector without introducing PTY timing.
	for terminalIndex := 0; terminalIndex < terminalCount; terminalIndex++ {
		terminalID := "term-race-" + string(rune('a'+terminalIndex))
		for blockIndex := 0; blockIndex < blockCount; blockIndex++ {
			blockID := "block-" + string(rune('a'+blockIndex))
			key := BlockTermRuntimeRouteKey{TerminalID: terminalID, BlockID: blockID}
			handlesMu.Lock()
			handle := handles[key]
			handlesMu.Unlock()
			wg.Add(1)
			go func(terminalID, blockID string, handle BlockTermRuntimeHandle) {
				defer wg.Done()
				for iteration := 0; iteration < 32; iteration++ {
					resolution := registry.ResolveByKey(terminalID, blockID, blockTermRouteTestToken)
					if resolution.Status != BlockTermRuntimeRouteStatusBlock && resolution.Status != BlockTermRuntimeRouteStatusTokenMismatch && resolution.Status != BlockTermRuntimeRouteStatusUnknownTagged {
						t.Errorf("unexpected resolution status for %s/%s: %q", terminalID, blockID, resolution.Status)
					}
					if iteration%8 == 0 {
						replacementRuntime := &blockTermRouteTestRuntime{name: "replacement"}
						if replacement, err := registry.ReplaceBlock(handle, blockTermRouteTestToken, replacementRuntime); err == nil {
							handle = replacement
						}
					}
				}
				_, _ = registry.Remove(handle)
			}(terminalID, blockID, handle)
		}
	}
	wg.Wait()
	if registry.Len() < terminalCount {
		t.Fatalf("concurrent operations removed session routes unexpectedly: len=%d", registry.Len())
	}
}
