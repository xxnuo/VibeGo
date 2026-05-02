package terminal

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
)

// BlockTermRuntimeRouteStatus describes how a route lookup was classified.
//
// A session route is the legacy, untagged terminal runtime. A block route is
// an exact terminal/block/token match. The remaining statuses are deliberate
// outcomes for callers that need to decide whether a legacy fallback is safe;
// Resolve never silently turns an unknown tagged request into a session route.
type BlockTermRuntimeRouteStatus string

const (
	BlockTermRuntimeRouteStatusSession         BlockTermRuntimeRouteStatus = "session"
	BlockTermRuntimeRouteStatusBlock           BlockTermRuntimeRouteStatus = "block"
	BlockTermRuntimeRouteStatusSessionFallback BlockTermRuntimeRouteStatus = "session_fallback"
	BlockTermRuntimeRouteStatusUnknownTagged   BlockTermRuntimeRouteStatus = "unknown_tagged"
	BlockTermRuntimeRouteStatusTokenMismatch   BlockTermRuntimeRouteStatus = "token_mismatch"
	BlockTermRuntimeRouteStatusInvalid         BlockTermRuntimeRouteStatus = "invalid"
)

// Short aliases keep the status names convenient at call sites while the
// longer constants remain self-documenting in protocol-facing code.
const (
	BlockTermRouteSession         = BlockTermRuntimeRouteStatusSession
	BlockTermRouteBlock           = BlockTermRuntimeRouteStatusBlock
	BlockTermRouteSessionFallback = BlockTermRuntimeRouteStatusSessionFallback
	BlockTermRouteUnknownTagged   = BlockTermRuntimeRouteStatusUnknownTagged
	BlockTermRouteTokenMismatch   = BlockTermRuntimeRouteStatusTokenMismatch
	BlockTermRouteInvalid         = BlockTermRuntimeRouteStatusInvalid
)

var (
	// ErrBlockTermRuntimeRouteInvalid indicates an invalid key/tag combination
	// or an invalid runtime value.
	ErrBlockTermRuntimeRouteInvalid = errors.New("invalid BlockTerm runtime route")
	// ErrBlockTermRuntimeRouteDuplicate is returned when a key is already
	// registered. Replacing a route must be an explicit operation.
	ErrBlockTermRuntimeRouteDuplicate = errors.New("BlockTerm runtime route already registered")
	// ErrBlockTermRuntimeRouteStaleHandle indicates that a handle no longer
	// names the current generation for its key (including an ABA replacement).
	ErrBlockTermRuntimeRouteStaleHandle = errors.New("stale BlockTerm runtime route handle")
	// ErrBlockTermRuntimeRouteRuntimeNil indicates a nil or typed-nil runtime.
	ErrBlockTermRuntimeRouteRuntimeNil = errors.New("BlockTerm runtime route has nil runtime")
)

// Compatibility aliases for callers that use the shorter Route spelling.
var (
	ErrBlockTermRouteInvalid     = ErrBlockTermRuntimeRouteInvalid
	ErrBlockTermRouteDuplicate   = ErrBlockTermRuntimeRouteDuplicate
	ErrBlockTermRouteStaleHandle = ErrBlockTermRuntimeRouteStaleHandle
	ErrBlockTermRouteRuntimeNil  = ErrBlockTermRuntimeRouteRuntimeNil
)

// BlockTermRuntimeRouteKey identifies one session or block route. BlockID is
// empty only for the untagged session route.
type BlockTermRuntimeRouteKey struct {
	TerminalID string
	BlockID    string
}

// BlockTermRuntimeRoute is the value stored by BlockTermRuntimeRegistry.
// Register and all lookup/removal methods copy this value; mutating a caller's
// input or a returned snapshot cannot alter the registry metadata.
//
// Runtime is intentionally an interface because existing local and SSH
// runtimes have different concrete implementations. The registry never calls
// methods on Runtime, including Close, while holding its mutex (and currently
// never calls them at all).
type BlockTermRuntimeRoute struct {
	TerminalID string
	BlockID    string
	Token      string
	Runtime    TerminalRuntime
}

// BlockTermRuntimeRouteRequest is the input to Resolve. A request is either
// untagged (both BlockID and Token empty) or fully tagged (both non-empty).
// A partial tag is invalid.
type BlockTermRuntimeRouteRequest struct {
	TerminalID string
	BlockID    string
	Token      string
}

// BlockTermRuntimeRouteResolution is a value result from Resolve. Route is
// zero when Status does not identify a usable registered runtime.
type BlockTermRuntimeRouteResolution struct {
	Status BlockTermRuntimeRouteStatus
	Route  BlockTermRuntimeRoute
}

// BlockTermRuntimeHandle is an opaque, generation-fenced registration handle.
// The unexported owner and generation fields prevent a handle from one
// registry, or an old handle after replacement, from removing a newer route.
// Handles are safe to copy and compare, but callers must not construct one.
type BlockTermRuntimeHandle struct {
	owner      *BlockTermRuntimeRegistry
	key        BlockTermRuntimeRouteKey
	generation uint64
}

// IsZero reports whether the handle has no registration identity.
func (h BlockTermRuntimeHandle) IsZero() bool {
	return h.owner == nil || h.generation == 0 || h.key.TerminalID == ""
}

// Valid reports whether the handle has a non-zero opaque identity. It does
// not guarantee that the route is still registered; Remove/Replace perform
// the generation check under the registry lock.
func (h BlockTermRuntimeHandle) Valid() bool {
	return !h.IsZero()
}

// Key returns a value copy of the key associated with the handle.
func (h BlockTermRuntimeHandle) Key() BlockTermRuntimeRouteKey {
	return h.key
}

type blockTermRuntimeRouteEntry struct {
	route      BlockTermRuntimeRoute
	generation uint64
}

// BlockTermRuntimeRegistry is a concurrency-safe in-memory route table.
//
// It deliberately has no database or Manager dependency. In particular,
// Resolve does not inspect durable blocks and does not fall back to a session
// runtime for an unknown tagged request. A Manager that has independently
// validated ownership may call ResolveWithSessionFallback explicitly.
type BlockTermRuntimeRegistry struct {
	mu       sync.RWMutex
	routes   map[BlockTermRuntimeRouteKey]blockTermRuntimeRouteEntry
	next     uint64
	identity *struct{}
}

// NewBlockTermRuntimeRegistry returns an empty route registry.
func NewBlockTermRuntimeRegistry() *BlockTermRuntimeRegistry {
	registry := &BlockTermRuntimeRegistry{}
	registry.identity = &struct{}{}
	registry.routes = make(map[BlockTermRuntimeRouteKey]blockTermRuntimeRouteEntry)
	return registry
}

// ensureReadyLocked initializes a zero-value registry. A registry should not
// be copied after first use; the owner pointer in handles also makes copied
// registries unable to consume one another's handles.
func (r *BlockTermRuntimeRegistry) ensureReadyLocked() {
	if r.identity == nil {
		r.identity = &struct{}{}
	}
	if r.routes == nil {
		r.routes = make(map[BlockTermRuntimeRouteKey]blockTermRuntimeRouteEntry)
	}
}

// Register inserts a new route. Duplicate keys are rejected; use Replace with
// the current handle when an intentional lifecycle replacement is required.
func (r *BlockTermRuntimeRegistry) Register(route BlockTermRuntimeRoute) (BlockTermRuntimeHandle, error) {
	if r == nil {
		return BlockTermRuntimeHandle{}, fmt.Errorf("%w: nil registry", ErrBlockTermRuntimeRouteInvalid)
	}
	if err := validateBlockTermRuntimeRoute(route); err != nil {
		return BlockTermRuntimeHandle{}, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureReadyLocked()
	key := blockTermRuntimeRouteKey(route)
	if _, exists := r.routes[key]; exists {
		return BlockTermRuntimeHandle{}, fmt.Errorf("%w: %s/%s", ErrBlockTermRuntimeRouteDuplicate, key.TerminalID, key.BlockID)
	}
	generation := r.nextGenerationLocked()
	// Assigning route to the map and returning it through a fresh handle keeps
	// all metadata value-owned by the registry. No runtime method is invoked.
	r.routes[key] = blockTermRuntimeRouteEntry{route: route, generation: generation}
	return BlockTermRuntimeHandle{owner: r, key: key, generation: generation}, nil
}

// RegisterSession inserts the untagged session route for terminalID.
func (r *BlockTermRuntimeRegistry) RegisterSession(terminalID string, runtime TerminalRuntime) (BlockTermRuntimeHandle, error) {
	return r.Register(BlockTermRuntimeRoute{TerminalID: terminalID, Runtime: runtime})
}

// RegisterBlock inserts an exact block route.
func (r *BlockTermRuntimeRegistry) RegisterBlock(terminalID, blockID, token string, runtime TerminalRuntime) (BlockTermRuntimeHandle, error) {
	return r.Register(BlockTermRuntimeRoute{
		TerminalID: terminalID,
		BlockID:    blockID,
		Token:      token,
		Runtime:    runtime,
	})
}

// Replace atomically replaces the route named by handle and returns a fresh
// generation handle. The key cannot change during replacement. A stale handle
// is rejected, which prevents an old reader from deleting a newer ABA route.
func (r *BlockTermRuntimeRegistry) Replace(handle BlockTermRuntimeHandle, route BlockTermRuntimeRoute) (BlockTermRuntimeHandle, error) {
	if r == nil {
		return BlockTermRuntimeHandle{}, fmt.Errorf("%w: nil registry", ErrBlockTermRuntimeRouteInvalid)
	}
	if err := validateBlockTermRuntimeRoute(route); err != nil {
		return BlockTermRuntimeHandle{}, err
	}
	key := blockTermRuntimeRouteKey(route)
	if handle.owner != r || handle.generation == 0 || handle.key != key {
		return BlockTermRuntimeHandle{}, ErrBlockTermRuntimeRouteStaleHandle
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureReadyLocked()
	entry, ok := r.routes[key]
	if !ok || entry.generation != handle.generation {
		return BlockTermRuntimeHandle{}, ErrBlockTermRuntimeRouteStaleHandle
	}
	generation := r.nextGenerationLocked()
	r.routes[key] = blockTermRuntimeRouteEntry{route: route, generation: generation}
	return BlockTermRuntimeHandle{owner: r, key: key, generation: generation}, nil
}

// ReplaceSession replaces an existing session route after checking its handle.
func (r *BlockTermRuntimeRegistry) ReplaceSession(handle BlockTermRuntimeHandle, runtime TerminalRuntime) (BlockTermRuntimeHandle, error) {
	return r.Replace(handle, BlockTermRuntimeRoute{TerminalID: handle.key.TerminalID, Runtime: runtime})
}

// ReplaceBlock replaces an existing block route after checking its handle.
func (r *BlockTermRuntimeRegistry) ReplaceBlock(handle BlockTermRuntimeHandle, token string, runtime TerminalRuntime) (BlockTermRuntimeHandle, error) {
	return r.Replace(handle, BlockTermRuntimeRoute{
		TerminalID: handle.key.TerminalID,
		BlockID:    handle.key.BlockID,
		Token:      token,
		Runtime:    runtime,
	})
}

// Resolve classifies a route request and returns a value snapshot. Unknown
// tagged requests never receive the session route, even when one exists.
func (r *BlockTermRuntimeRegistry) Resolve(request BlockTermRuntimeRouteRequest) BlockTermRuntimeRouteResolution {
	if r == nil || !validBlockTermRuntimeTerminalID(request.TerminalID) {
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
	}
	hasBlock := request.BlockID != ""
	hasToken := request.Token != ""
	if hasBlock != hasToken {
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
	}
	if hasBlock {
		if !validBlockTermBlockID(request.BlockID) || !validBlockTermToken(request.Token) {
			return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
		}
	} else if request.BlockID != "" || request.Token != "" {
		// Keep this explicit for clarity if validation rules change later.
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
	}

	key := BlockTermRuntimeRouteKey{TerminalID: request.TerminalID, BlockID: request.BlockID}
	r.mu.RLock()
	entry, ok := r.routes[key]
	if !ok && hasBlock {
		// A tagged key is intentionally isolated from the untagged session key.
		r.mu.RUnlock()
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusUnknownTagged}
	}
	if !ok {
		r.mu.RUnlock()
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusSessionFallback}
	}
	route := entry.route
	r.mu.RUnlock()

	if !hasBlock {
		return BlockTermRuntimeRouteResolution{
			Status: BlockTermRuntimeRouteStatusSession,
			Route:  route,
		}
	}
	if route.Token != request.Token {
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusTokenMismatch}
	}
	return BlockTermRuntimeRouteResolution{
		Status: BlockTermRuntimeRouteStatusBlock,
		Route:  route,
	}
}

// ResolveRoute is a naming alias for Resolve.
func (r *BlockTermRuntimeRegistry) ResolveRoute(request BlockTermRuntimeRouteRequest) BlockTermRuntimeRouteResolution {
	return r.Resolve(request)
}

// ResolveByKey is a convenience wrapper for protocol handlers.
func (r *BlockTermRuntimeRegistry) ResolveByKey(terminalID, blockID, token string) BlockTermRuntimeRouteResolution {
	return r.Resolve(BlockTermRuntimeRouteRequest{TerminalID: terminalID, BlockID: blockID, Token: token})
}

// ResolveWithSessionFallback explicitly returns the session route for a
// terminal after the caller has performed any durable ownership checks it
// needs. It is the only API that can classify a tagged request as a fallback;
// Resolve itself never performs this downgrade.
func (r *BlockTermRuntimeRegistry) ResolveWithSessionFallback(request BlockTermRuntimeRouteRequest) BlockTermRuntimeRouteResolution {
	if r == nil || !validBlockTermRuntimeTerminalID(request.TerminalID) {
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
	}
	// Keep malformed/partial tags invalid even for an explicit fallback. A
	// manager may pass a valid unknown tag here only after its own validation.
	if (request.BlockID == "") != (request.Token == "") {
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
	}
	if request.BlockID != "" && (!validBlockTermBlockID(request.BlockID) || !validBlockTermToken(request.Token)) {
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusInvalid}
	}
	key := BlockTermRuntimeRouteKey{TerminalID: request.TerminalID}
	r.mu.RLock()
	entry, ok := r.routes[key]
	if ok {
		route := entry.route
		r.mu.RUnlock()
		return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusSessionFallback, Route: route}
	}
	r.mu.RUnlock()
	return BlockTermRuntimeRouteResolution{Status: BlockTermRuntimeRouteStatusSessionFallback}
}

// ResolveSessionFallback is an explicit untagged fallback lookup.
func (r *BlockTermRuntimeRegistry) ResolveSessionFallback(terminalID string) BlockTermRuntimeRouteResolution {
	return r.ResolveWithSessionFallback(BlockTermRuntimeRouteRequest{TerminalID: terminalID})
}

// Remove removes exactly the generation named by handle and returns its value
// snapshot. It never calls Runtime.Close; the caller owns close ordering and
// must perform it after this method returns.
func (r *BlockTermRuntimeRegistry) Remove(handle BlockTermRuntimeHandle) (BlockTermRuntimeRoute, bool) {
	if r == nil || handle.owner != r || handle.generation == 0 {
		return BlockTermRuntimeRoute{}, false
	}
	r.mu.Lock()
	entry, ok := r.routes[handle.key]
	if !ok || entry.generation != handle.generation {
		r.mu.Unlock()
		return BlockTermRuntimeRoute{}, false
	}
	delete(r.routes, handle.key)
	r.mu.Unlock()
	return entry.route, true
}

// RemoveHandle is a naming alias for Remove.
func (r *BlockTermRuntimeRegistry) RemoveHandle(handle BlockTermRuntimeHandle) (BlockTermRuntimeRoute, bool) {
	return r.Remove(handle)
}

// RemoveBlocks detaches every block route belonging to terminalID while
// preserving its untagged session route. Returned snapshots are sorted by
// block ID. It performs no runtime calls while the registry lock is held.
func (r *BlockTermRuntimeRegistry) RemoveBlocks(terminalID string) []BlockTermRuntimeRoute {
	if r == nil || !validBlockTermRuntimeTerminalID(terminalID) {
		return nil
	}
	r.mu.Lock()
	removed := make([]BlockTermRuntimeRoute, 0)
	for key, entry := range r.routes {
		if key.TerminalID != terminalID || key.BlockID == "" {
			continue
		}
		removed = append(removed, entry.route)
		delete(r.routes, key)
	}
	r.mu.Unlock()
	sort.Slice(removed, func(i, j int) bool {
		return removed[i].BlockID < removed[j].BlockID
	})
	return removed
}

// RemoveTerminal detaches every route belonging to terminalID and returns
// value snapshots in deterministic order (session first, then block ID). It
// performs no runtime calls or closes while the registry lock is held.
func (r *BlockTermRuntimeRegistry) RemoveTerminal(terminalID string) []BlockTermRuntimeRoute {
	if r == nil || !validBlockTermRuntimeTerminalID(terminalID) {
		return nil
	}
	r.mu.Lock()
	removed := make([]BlockTermRuntimeRoute, 0)
	for key, entry := range r.routes {
		if key.TerminalID != terminalID {
			continue
		}
		removed = append(removed, entry.route)
		delete(r.routes, key)
	}
	r.mu.Unlock()
	sort.Slice(removed, func(i, j int) bool {
		if removed[i].BlockID == "" {
			return true
		}
		if removed[j].BlockID == "" {
			return false
		}
		return removed[i].BlockID < removed[j].BlockID
	})
	return removed
}

// Len returns the number of currently registered routes.
func (r *BlockTermRuntimeRegistry) Len() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	length := len(r.routes)
	r.mu.RUnlock()
	return length
}

func (r *BlockTermRuntimeRegistry) nextGenerationLocked() uint64 {
	// Generation zero is reserved for an invalid/zero handle. Wraparound is
	// practically unreachable, but skipping zero preserves that invariant.
	r.next++
	if r.next == 0 {
		r.next++
	}
	return r.next
}

func blockTermRuntimeRouteKey(route BlockTermRuntimeRoute) BlockTermRuntimeRouteKey {
	return BlockTermRuntimeRouteKey{TerminalID: route.TerminalID, BlockID: route.BlockID}
}

func validateBlockTermRuntimeRoute(route BlockTermRuntimeRoute) error {
	if !validBlockTermRuntimeTerminalID(route.TerminalID) {
		return fmt.Errorf("%w: terminal ID", ErrBlockTermRuntimeRouteInvalid)
	}
	if isTypedNil(route.Runtime) {
		return ErrBlockTermRuntimeRouteRuntimeNil
	}
	if route.BlockID == "" {
		if route.Token != "" {
			return fmt.Errorf("%w: session route must not have a token", ErrBlockTermRuntimeRouteInvalid)
		}
		return nil
	}
	if !validBlockTermBlockID(route.BlockID) {
		return fmt.Errorf("%w: block ID", ErrBlockTermRuntimeRouteInvalid)
	}
	if !validBlockTermToken(route.Token) {
		return fmt.Errorf("%w: block route token", ErrBlockTermRuntimeRouteInvalid)
	}
	return nil
}

func validBlockTermRuntimeTerminalID(terminalID string) bool {
	return terminalID != "" && terminalID == strings.TrimSpace(terminalID) &&
		len([]byte(terminalID)) <= 256 && strings.IndexByte(terminalID, 0) < 0
}

func isTypedNil(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

// Compatibility type aliases. They intentionally preserve one implementation
// and therefore one set of locking and generation guarantees.
type BlockTermRouteStatus = BlockTermRuntimeRouteStatus
type BlockTermRouteKey = BlockTermRuntimeRouteKey
type BlockTermRoute = BlockTermRuntimeRoute
type BlockTermRouteRequest = BlockTermRuntimeRouteRequest
type BlockTermRouteResolution = BlockTermRuntimeRouteResolution
type BlockTermRouteHandle = BlockTermRuntimeHandle
type BlockTermRouteRegistry = BlockTermRuntimeRegistry
