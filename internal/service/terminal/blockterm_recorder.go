package terminal

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var blockTermOSCMarker = []byte("\x1b]633;__VIBEGO_BLOCKTERM__;")

const (
	blockTermOSCMaxFrameBytes     = 1 << 20
	blockTermRecorderQueueSize    = 128
	blockTermRecorderMaxBatchSize = 256 << 10
	blockTermRecorderMaxAttempts  = 4
	blockTermRetiredBlockLimit    = 4096
	blockTermCompletedCwdMaxBytes = 4096
	// Output can arrive before the corresponding block-create request commits.
	// Keep recent orphan spans long enough for that normal race to settle, while
	// bounding both dormant and abandoned output over the lifetime of a server.
	blockTermOrphanMaxAge   = 10 * time.Minute
	blockTermOrphanMaxBytes = int64(64 << 20)
	blockTermOrphanMaxRows  = 4096
)

// errBlockTermOutputQueueFull means the bounded recorder queue could not
// accept a span without blocking the PTY reader. Once set, the recorder is no
// longer a complete raw-output source and callers must use the error instead
// of serving a supposedly settled snapshot.
var errBlockTermOutputQueueFull = errors.New("blockterm output recorder queue is full")

var (
	errBlockTermRecorderUnavailable = errors.New("blockterm output recorder is unavailable")
	errBlockTermRecorderBusy        = errors.New("blockterm output recorder is busy")
	errBlockTermRecorderFailed      = errors.New("blockterm output recorder failed")
)

type blockTermOutputSpan struct {
	BlockID     string
	StartCursor uint64
	EndCursor   uint64
	Data        []byte
}

// blockTermOutputEvent keeps recorder barriers in the same FIFO as output
// spans. A barrier completes only after every span queued before it has been
// persisted (or has reported the recorder's first persistence error).
type blockTermOutputEvent struct {
	span    blockTermOutputSpan
	barrier chan error
}

type blockTermCompletedLifecycle struct {
	BlockID    string
	BlockToken string
	ExitCode   int
	Cwd        string
	EndCursor  uint64
}

type blockTermRecorderState struct {
	BlockID        string
	BlockToken     string
	BlockPhase     string
	BlockTailID    string
	BlockTailToken string
	BlockTailPhase string
	Completions    []blockTermCompletedLifecycle
}

type blockTermOSCFrame struct {
	Kind     string
	BlockID  string
	Token    string
	Version  string
	ExitCode int
	Cwd      string
}

type blockTermOutputParser struct {
	activeBlockID       string
	activeBlockToken    string
	expectedBlockID     string
	expectedToken       string
	expectedGeneration  uint64
	preparedBlockID     string
	preparedBlockToken  string
	nextGeneration      uint64
	retiredBlockIDs     map[string]struct{}
	retiredBlockFIFO    []string
	retiredBlockTokens  map[string]string
	staleBlockTokens    map[blockTermLifecycleKey]struct{}
	staleBlockTokenFIFO []blockTermLifecycleKey
	rearmBlockTokens    map[string]string
	rearmBlockFIFO      []blockTermLifecycleKey
	discardBlockID      string
	discardBlockToken   string
	completedLifecycles []blockTermCompletedLifecycle
	pending             []byte
	pendingCursor       uint64
}

// blockTermLifecycleKey is kept separate from the durable block row because a
// block ID can be deliberately re-used for a new command lifecycle. Tokens are
// ephemeral correlation values and are never persisted.
type blockTermLifecycleKey struct {
	BlockID string
	Token   string
}

func (p *blockTermOutputParser) ExpectBlock(blockID, token string) bool {
	_, ok := p.expectBlock(blockID, token)
	return ok
}

func (p *blockTermOutputParser) expectBlock(blockID, token string) (uint64, bool) {
	if blockID == "" || !validBlockTermToken(token) {
		return 0, false
	}
	if p.preparedBlockID != "" {
		if p.preparedBlockID != blockID || p.preparedBlockToken != token ||
			p.expectedBlockID != "" || p.activeBlockID == blockID {
			return 0, false
		}
		if p.activeBlockID == "" {
			// Output observed while the restart was only prepared has no block
			// owner. Do not let a split marker prefix cross the tagged-input
			// boundary and consume the new lifecycle's start frame.
			p.pending = nil
			p.pendingCursor = 0
		}
		p.preparedBlockID = ""
		p.preparedBlockToken = ""
		return p.armExpectedBlock(blockID, token)
	}
	if _, retired := p.retiredBlockIDs[blockID]; retired {
		return 0, false
	}
	if p.isStaleLifecycle(blockID, token) {
		return 0, false
	}
	if p.expectedBlockID != "" || p.activeBlockID == blockID {
		return 0, false
	}
	if p.activeBlockID == "" {
		// A marker prefix observed before the managed input was armed must never be
		// completed by output from that input. It is unowned raw terminal output.
		p.pending = nil
		p.pendingCursor = 0
	}
	return p.armExpectedBlock(blockID, token)
}

func (p *blockTermOutputParser) armExpectedBlock(blockID, token string) (uint64, bool) {
	p.nextGeneration++
	if p.nextGeneration == 0 {
		p.nextGeneration++
	}
	p.expectedBlockID = blockID
	p.expectedToken = token
	p.expectedGeneration = p.nextGeneration
	return p.expectedGeneration, true
}

// rearmBlock explicitly starts a new lifecycle for a previously used block ID.
// Ordinary ExpectBlock calls remain one-shot, which prevents an arbitrary
// client from replaying output into a completed/deleted block. The caller must
// opt into rearming and provide a fresh token.
func (p *blockTermOutputParser) rearmBlock(blockID, token string) bool {
	if !p.canRearmBlock(blockID, token) {
		return false
	}
	p.commitRearmBlock(blockID, token)
	return true
}

func (p *blockTermOutputParser) commitRearmBlock(blockID, token string) {
	discardTarget := p.discardBlockID == blockID
	// Preserve the completed target token before releasing its binding. Delayed
	// frames are then recognizable even while the new run is active.
	p.rememberStaleLifecycle(blockID, p.retiredBlockTokens[blockID])

	// A reset discards parser-side bytes from the previous run. The recorder API
	// requires its caller to establish a FIFO barrier before clearing durable
	// output, so no old queued span can be persisted after this transition. A
	// retained tail for another block keeps its own parser prefix intact.
	if discardTarget {
		p.pending = nil
		p.pendingCursor = 0
		p.discardBlockID = ""
		p.discardBlockToken = ""
	}
	p.removeRetiredBlock(blockID)
	if len(p.completedLifecycles) > 0 {
		kept := p.completedLifecycles[:0]
		for _, completion := range p.completedLifecycles {
			if completion.BlockID != blockID {
				kept = append(kept, completion)
			}
		}
		p.completedLifecycles = kept
	}
	// Reserve the new lifecycle token without arming output ownership. The
	// existing tagged websocket input path consumes this reservation immediately
	// before writing the wrapper to the PTY. Until then, no other token can claim
	// the reset durable block.
	p.preparedBlockID = blockID
	p.preparedBlockToken = token
	p.rememberRearmBinding(blockID, token)
}

func (p *blockTermOutputParser) canCancelPreparedBlock(blockID, token string) bool {
	return p != nil && blockID != "" && validBlockTermToken(token) &&
		p.preparedBlockID == blockID && p.preparedBlockToken == token &&
		p.rearmBlockTokens[blockID] == token
}

func (p *blockTermOutputParser) commitCancelPreparedBlock(blockID, token string) {
	p.preparedBlockID = ""
	p.preparedBlockToken = ""
	p.rememberStaleLifecycle(blockID, token)
	p.retireBlockLifecycle(blockID, token)
}

func (p *blockTermOutputParser) canRearmBlock(blockID, token string) bool {
	if blockID == "" || !validBlockTermToken(token) || p.isStaleLifecycle(blockID, token) {
		return false
	}
	if p.preparedBlockID != "" {
		return false
	}
	if _, rebound := p.rearmBlockTokens[blockID]; rebound {
		return false
	}
	if p.expectedBlockID != "" || p.activeBlockID == blockID {
		return false
	}
	oldTokens := []string{p.retiredBlockTokens[blockID]}
	// The durable row is the source of truth for whether a restart is allowed.
	// The parser's bounded retired cache can evict an otherwise valid block, so
	// an absent old token is acceptable here. A retained target token must be
	// different so delayed frames cannot satisfy the new lifecycle. Active or
	// expected ownership of this same ID is rejected above even with a fresh token.
	for _, oldToken := range oldTokens {
		if oldToken != "" && (!validBlockTermToken(oldToken) || oldToken == token) {
			return false
		}
	}
	return true
}

func (p *blockTermOutputParser) isStaleLifecycle(blockID, token string) bool {
	if p == nil || blockID == "" || token == "" || p.staleBlockTokens == nil {
		return false
	}
	_, ok := p.staleBlockTokens[blockTermLifecycleKey{BlockID: blockID, Token: token}]
	return ok
}

func (p *blockTermOutputParser) rememberStaleLifecycle(blockID, token string) {
	if p == nil || blockID == "" || !validBlockTermToken(token) {
		return
	}
	if p.staleBlockTokens == nil {
		p.staleBlockTokens = make(map[blockTermLifecycleKey]struct{})
	}
	key := blockTermLifecycleKey{BlockID: blockID, Token: token}
	if _, exists := p.staleBlockTokens[key]; exists {
		return
	}
	p.staleBlockTokens[key] = struct{}{}
	p.staleBlockTokenFIFO = append(p.staleBlockTokenFIFO, key)
	if len(p.staleBlockTokenFIFO) > blockTermRetiredBlockLimit {
		oldest := p.staleBlockTokenFIFO[0]
		p.staleBlockTokenFIFO = p.staleBlockTokenFIFO[1:]
		delete(p.staleBlockTokens, oldest)
	}
}

func (p *blockTermOutputParser) rememberRearmBinding(blockID, token string) {
	if p == nil || blockID == "" || !validBlockTermToken(token) {
		return
	}
	if p.rearmBlockTokens == nil {
		p.rearmBlockTokens = make(map[string]string)
	}
	if p.rearmBlockTokens[blockID] == token {
		return
	}
	p.rearmBlockTokens[blockID] = token
	key := blockTermLifecycleKey{BlockID: blockID, Token: token}
	p.rearmBlockFIFO = append(p.rearmBlockFIFO, key)
	if len(p.rearmBlockFIFO) > blockTermRetiredBlockLimit {
		oldest := p.rearmBlockFIFO[0]
		p.rearmBlockFIFO = p.rearmBlockFIFO[1:]
		if p.rearmBlockTokens[oldest.BlockID] == oldest.Token {
			delete(p.rearmBlockTokens, oldest.BlockID)
		}
	}
}

func (p *blockTermOutputParser) removeRearmBinding(blockID, token string) {
	if p == nil || blockID == "" || token == "" || p.rearmBlockTokens[blockID] != token {
		return
	}
	delete(p.rearmBlockTokens, blockID)
}

func (p *blockTermOutputParser) removeRetiredBlock(blockID string) {
	if p == nil || blockID == "" {
		return
	}
	delete(p.retiredBlockIDs, blockID)
	delete(p.retiredBlockTokens, blockID)
	if len(p.retiredBlockFIFO) == 0 {
		return
	}
	kept := p.retiredBlockFIFO[:0]
	for _, id := range p.retiredBlockFIFO {
		if id != blockID {
			kept = append(kept, id)
		}
	}
	p.retiredBlockFIFO = kept
}

func (p *blockTermOutputParser) CancelExpectedBlock(blockID, token string) bool {
	return p.cancelExpectedBlock(blockID, token, 0)
}

func (p *blockTermOutputParser) CancelExpectedBlockGeneration(blockID, token string, generation uint64) bool {
	if generation == 0 {
		return false
	}
	return p.cancelExpectedBlock(blockID, token, generation)
}

func (p *blockTermOutputParser) cancelExpectedBlock(blockID, token string, generation uint64) bool {
	if blockID != "" && token != "" && p.expectedBlockID == blockID && p.expectedToken == token &&
		(generation == 0 || p.expectedGeneration == generation) {
		if p.rearmBlockTokens[blockID] == token {
			p.retireBlockLifecycle(blockID, token)
		}
		p.expectedBlockID = ""
		p.expectedToken = ""
		p.expectedGeneration = 0
		return true
	}
	return false
}

func (p *blockTermOutputParser) Feed(data []byte, startCursor uint64) []blockTermOutputSpan {
	if len(data) == 0 {
		return nil
	}

	baseCursor := startCursor
	input := data
	if len(p.pending) > 0 {
		baseCursor = p.pendingCursor
		combined := make([]byte, 0, len(p.pending)+len(data))
		combined = append(combined, p.pending...)
		combined = append(combined, data...)
		input = combined
		p.pending = nil
	}

	spans := make([]blockTermOutputSpan, 0, 2)
	emit := func(blockID string, start, end int) {
		if blockID == "" || end <= start {
			return
		}
		spanStart := baseCursor + uint64(start)
		spanEnd := baseCursor + uint64(end)
		if len(spans) > 0 {
			last := &spans[len(spans)-1]
			if last.BlockID == blockID && last.EndCursor == spanStart {
				last.Data = append(last.Data, input[start:end]...)
				last.EndCursor = spanEnd
				return
			}
		}
		spans = append(spans, blockTermOutputSpan{
			BlockID:     blockID,
			StartCursor: spanStart,
			EndCursor:   spanEnd,
			Data:        append([]byte(nil), input[start:end]...),
		})
	}

	for index := 0; index < len(input); {
		ownerBlockID := p.activeBlockID
		// Once a stale lifecycle start is observed, bytes are quarantined until
		// its matching end (or the newly expected start) arrives. This prevents
		// delayed output from the previous run from being attributed to the new
		// run merely because both lifecycles reuse one durable block ID.
		if p.discardBlockID != "" {
			ownerBlockID = ""
		}
		relativeMarker := bytes.Index(input[index:], blockTermOSCMarker)
		if relativeMarker < 0 {
			keep := blockTermMarkerSuffixLength(input[index:])
			emit(ownerBlockID, index, len(input)-keep)
			if keep > 0 {
				p.pending = append([]byte(nil), input[len(input)-keep:]...)
				p.pendingCursor = baseCursor + uint64(len(input)-keep)
			}
			break
		}

		markerStart := index + relativeMarker
		emit(ownerBlockID, index, markerStart)
		terminatorIndex, terminatorLength := findBlockTermOSCTerminator(input, markerStart+len(blockTermOSCMarker))
		if terminatorIndex < 0 {
			if len(input)-markerStart <= blockTermOSCMaxFrameBytes {
				p.pending = append([]byte(nil), input[markerStart:]...)
				p.pendingCursor = baseCursor + uint64(markerStart)
				break
			}
			// A malformed oversized OSC-like sequence is ordinary command output.
			emit(ownerBlockID, markerStart, len(input))
			break
		}

		frameEnd := terminatorIndex + terminatorLength
		if frameEnd-markerStart > blockTermOSCMaxFrameBytes {
			emit(ownerBlockID, markerStart, frameEnd)
			index = frameEnd
			continue
		}
		frame, ok := parseBlockTermOSCFrame(input[markerStart+len(blockTermOSCMarker) : terminatorIndex])
		if !ok {
			emit(ownerBlockID, markerStart, frameEnd)
			index = frameEnd
			continue
		}

		if p.discardBlockID != "" {
			// A fresh expected start is the explicit boundary into the new run;
			// process it normally after leaving quarantine. Otherwise consume old
			// lifecycle bytes until its matching end frame.
			if frame.Version == "v3" && frame.Kind == "start" &&
				p.expectedBlockID == frame.BlockID && p.expectedToken == frame.Token {
				p.discardBlockID = ""
				p.discardBlockToken = ""
			} else if frame.Version == "v3" && frame.Kind == "end" &&
				p.activeBlockID == frame.BlockID && p.activeBlockToken == frame.Token {
				// A delayed stale start may never deliver its own end frame. The
				// exact end of the currently active lifecycle is still authoritative;
				// leave quarantine and process that completion normally.
				p.discardBlockID = ""
				p.discardBlockToken = ""
			} else if frame.Version == "v3" && frame.Kind == "end" &&
				frame.BlockID == p.discardBlockID && frame.Token == p.discardBlockToken {
				p.discardBlockID = ""
				p.discardBlockToken = ""
				index = frameEnd
				continue
			} else {
				index = frameEnd
				continue
			}
		}

		if frame.Version == "v3" && p.isStaleLifecycle(frame.BlockID, frame.Token) {
			if frame.Kind == "start" {
				p.discardBlockID = frame.BlockID
				p.discardBlockToken = frame.Token
			}
			index = frameEnd
			continue
		}

		switch frame.Kind {
		case "start":
			if frame.Version == "v3" && p.expectedBlockID == frame.BlockID && p.expectedToken == frame.Token {
				if p.activeBlockID != "" && p.activeBlockID != frame.BlockID {
					// An interrupt can return an interactive shell directly to its
					// prompt without executing the old wrapper's end frame. Keep all
					// bytes before this matched start on the old block, then let
					// the newly armed command take ownership from this exact boundary.
					p.retireBlockLifecycle(p.activeBlockID, p.activeBlockToken)
				}
				p.activeBlockID = frame.BlockID
				p.activeBlockToken = frame.Token
				p.expectedBlockID = ""
				p.expectedToken = ""
				p.expectedGeneration = 0
			} else if p.activeBlockID != "" {
				// Command output can contain private-looking frames. A nested start must
				// not redirect the current command's raw bytes to another block.
				emit(p.activeBlockID, markerStart, frameEnd)
			}
		case "end":
			if frame.Version == "v3" && p.activeBlockID == frame.BlockID && p.activeBlockToken == frame.Token {
				p.completedLifecycles = append(p.completedLifecycles, blockTermCompletedLifecycle{
					BlockID:    frame.BlockID,
					BlockToken: frame.Token,
					ExitCode:   frame.ExitCode,
					Cwd:        frame.Cwd,
					EndCursor:  baseCursor + uint64(frameEnd),
				})
				p.activeBlockID = ""
				p.activeBlockToken = ""
				p.retireBlockLifecycle(frame.BlockID, frame.Token)
				if len(p.completedLifecycles) > blockTermRetiredBlockLimit {
					p.completedLifecycles = p.completedLifecycles[len(p.completedLifecycles)-blockTermRetiredBlockLimit:]
				}
			} else {
				// Preserve a mismatched private frame as ordinary command output.
				emit(p.activeBlockID, markerStart, frameEnd)
			}
		}
		index = frameEnd
	}

	return spans
}

func (p *blockTermOutputParser) retireBlockID(blockID string) {
	if blockID == "" {
		return
	}
	if p.retiredBlockIDs == nil {
		p.retiredBlockIDs = make(map[string]struct{})
	}
	if _, retired := p.retiredBlockIDs[blockID]; retired {
		return
	}
	p.retiredBlockIDs[blockID] = struct{}{}
	p.retiredBlockFIFO = append(p.retiredBlockFIFO, blockID)
	if len(p.retiredBlockFIFO) > blockTermRetiredBlockLimit {
		oldest := p.retiredBlockFIFO[0]
		p.retiredBlockFIFO = p.retiredBlockFIFO[1:]
		delete(p.retiredBlockIDs, oldest)
		delete(p.retiredBlockTokens, oldest)
	}
}

func (p *blockTermOutputParser) retireBlockLifecycle(blockID, token string) {
	if blockID == "" {
		return
	}
	p.retireBlockID(blockID)
	p.removeRearmBinding(blockID, token)
	if !validBlockTermToken(token) {
		return
	}
	if p.retiredBlockTokens == nil {
		p.retiredBlockTokens = make(map[string]string)
	}
	p.retiredBlockTokens[blockID] = token
}

func (p *blockTermOutputParser) Flush() []blockTermOutputSpan {
	if len(p.pending) == 0 {
		return nil
	}
	pending := p.pending
	start := p.pendingCursor
	p.pending = nil
	if p.activeBlockID == "" || p.discardBlockID != "" {
		return nil
	}
	return []blockTermOutputSpan{{
		BlockID:     p.activeBlockID,
		StartCursor: start,
		EndCursor:   start + uint64(len(pending)),
		Data:        pending,
	}}
}

func blockTermMarkerSuffixLength(data []byte) int {
	maxLength := len(blockTermOSCMarker) - 1
	if len(data) < maxLength {
		maxLength = len(data)
	}
	for length := maxLength; length > 0; length-- {
		if bytes.Equal(data[len(data)-length:], blockTermOSCMarker[:length]) {
			return length
		}
	}
	return 0
}

func findBlockTermOSCTerminator(data []byte, start int) (int, int) {
	for index := start; index < len(data); index++ {
		switch data[index] {
		case '\a':
			return index, 1
		case '\x1b':
			if index+1 < len(data) && data[index+1] == '\\' {
				return index, 2
			}
		}
	}
	return -1, 0
}

func parseBlockTermOSCFrame(body []byte) (blockTermOSCFrame, bool) {
	fields := bytes.Split(body, []byte(";"))
	if len(fields) < 2 {
		return blockTermOSCFrame{}, false
	}
	kind := string(fields[0])
	if kind != "start" && kind != "end" {
		return blockTermOSCFrame{}, false
	}
	blockID := string(fields[1])
	if !validBlockTermBlockID(blockID) {
		return blockTermOSCFrame{}, false
	}
	if len(fields) >= 4 && string(fields[2]) == "v3" {
		token := string(fields[3])
		if !validBlockTermToken(token) {
			return blockTermOSCFrame{}, false
		}
		frame := blockTermOSCFrame{Kind: kind, BlockID: blockID, Token: token, Version: "v3"}
		if kind == "start" {
			if len(fields) < 7 || !validBlockTermPositiveDecimal(fields[4]) {
				return blockTermOSCFrame{}, false
			}
			cwd := bytes.Join(fields[5:len(fields)-1], []byte(";"))
			if !validBlockTermCompletedCwd(cwd) {
				return blockTermOSCFrame{}, false
			}
			frame.Cwd = string(cwd)
			return frame, true
		}
		if len(fields) < 6 {
			return blockTermOSCFrame{}, false
		}
		exitCode, ok := parseBlockTermExitCode(fields[4])
		if !ok {
			return blockTermOSCFrame{}, false
		}
		cwd := bytes.Join(fields[5:], []byte(";"))
		if !validBlockTermCompletedCwd(cwd) {
			return blockTermOSCFrame{}, false
		}
		frame.ExitCode = exitCode
		frame.Cwd = string(cwd)
		return frame, true
	}
	// Older frames remain recognizable so an active v3 command preserves them
	// verbatim as ordinary output, but they can never satisfy a v3 correlation.
	if kind == "start" && len(fields) >= 3 && string(fields[2]) == "v2" {
		return blockTermOSCFrame{Kind: kind, BlockID: blockID, Version: "v2"}, true
	}
	return blockTermOSCFrame{Kind: kind, BlockID: blockID, Version: "legacy"}, true
}

func validBlockTermBlockID(blockID string) bool {
	return blockID != "" && blockID == strings.TrimSpace(blockID) && len([]byte(blockID)) <= 256 &&
		strings.IndexByte(blockID, 0) < 0
}

func validBlockTermPositiveDecimal(value []byte) bool {
	if len(value) == 0 || len(value) > 19 {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	parsed, err := strconv.ParseUint(string(value), 10, 64)
	return err == nil && parsed > 0
}

func parseBlockTermExitCode(value []byte) (int, bool) {
	if len(value) == 0 || len(value) > 3 {
		return 0, false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	parsed, err := strconv.Atoi(string(value))
	return parsed, err == nil && parsed >= 0 && parsed <= 255
}

func validBlockTermCompletedCwd(cwd []byte) bool {
	return len(cwd) <= blockTermCompletedCwdMaxBytes && bytes.IndexByte(cwd, 0) < 0
}

func validBlockTermToken(token string) bool {
	if len(token) < 32 || len(token) > 128 {
		return false
	}
	for _, char := range token {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

type blockTermOutputRecorder struct {
	db                  *gorm.DB
	terminalID          string
	hasBlockTable       bool
	hasHistoryTombstone bool
	parser              blockTermOutputParser
	queue               chan blockTermOutputEvent
	done                chan struct{}
	closeOnce           sync.Once
	queueMu             sync.Mutex
	pendingSpan         *blockTermOutputSpan
	closed              bool
	errMu               sync.Mutex
	err                 error
}

func newBlockTermOutputRecorder(db *gorm.DB, terminalID string) *blockTermOutputRecorder {
	if db == nil || terminalID == "" || !db.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
		return nil
	}
	recorder := &blockTermOutputRecorder{
		db:                  db,
		terminalID:          terminalID,
		hasBlockTable:       db.Migrator().HasTable(&model.BlockTermBlock{}),
		hasHistoryTombstone: db.Migrator().HasTable(&model.BlockTermCommandHistory{}) && db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "block_deleted_at"),
		queue:               make(chan blockTermOutputEvent, blockTermRecorderQueueSize),
		done:                make(chan struct{}),
	}
	go recorder.run()
	return recorder
}

func (r *blockTermOutputRecorder) ExpectBlock(blockID, token string) bool {
	_, err := r.expectBlock(blockID, token)
	return err == nil
}

func (r *blockTermOutputRecorder) expectBlock(blockID, token string) (uint64, error) {
	if r == nil || blockID == "" {
		return 0, errBlockTermRecorderUnavailable
	}
	if !validBlockTermToken(token) {
		return 0, errBlockTermRecorderBusy
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.closed {
		return 0, errBlockTermRecorderUnavailable
	}
	if err := r.currentError(); err != nil {
		return 0, fmt.Errorf("%w: %v", errBlockTermRecorderFailed, err)
	}
	generation, ok := r.parser.expectBlock(blockID, token)
	if !ok {
		return 0, errBlockTermRecorderBusy
	}
	return generation, nil
}

// RearmBlock releases a durable block ID for one new tagged-input lifecycle.
// Callers that also reset durable output should use WithRearmBlock so the DB
// mutation and parser transition either both happen or neither happens.
func (r *blockTermOutputRecorder) RearmBlock(blockID, newToken string) error {
	return r.WithRearmBlock(blockID, newToken, nil)
}

// WithRearmBlock validates a restart, runs mutation, then commits the parser
// transition while holding queueMu. The caller must first wait for a recorder
// FIFO barrier and prevent new recorder input until this method returns; that
// ordering ensures old spans cannot be persisted after mutation clears output.
// mutation must not call back into this recorder.
func (r *blockTermOutputRecorder) WithRearmBlock(
	blockID string,
	newToken string,
	mutation func() error,
) error {
	if r == nil || blockID == "" {
		return errBlockTermRecorderUnavailable
	}
	if !validBlockTermToken(newToken) {
		return errBlockTermRecorderBusy
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.closed {
		return errBlockTermRecorderUnavailable
	}
	if err := r.currentError(); err != nil {
		return fmt.Errorf("%w: %v", errBlockTermRecorderFailed, err)
	}
	if !r.parser.canRearmBlock(blockID, newToken) {
		return errBlockTermRecorderBusy
	}
	if mutation != nil {
		if err := mutation(); err != nil {
			return err
		}
	}
	// queueMu prevents parser state from changing after validation. Commit the
	// reservation directly so a successful durable mutation cannot be followed
	// by a second fallible validation step.
	r.parser.commitRearmBlock(blockID, newToken)
	// Any producer-side aggregate belongs to the old lifecycle. The manager's
	// normal path establishes a FIFO barrier before calling this method; dropping
	// the aggregate here also keeps direct recorder users from carrying a partial
	// marker into the new run.
	r.pendingSpan = nil
	return nil
}

// WithCancelPreparedBlock rolls back a restart that committed durable state
// but could not send its tagged wrapper to the PTY. Only the exact prepared
// lifecycle may be cancelled; expected and active commands are never touched.
func (r *blockTermOutputRecorder) WithCancelPreparedBlock(
	blockID string,
	token string,
	mutation func() error,
) error {
	if r == nil || blockID == "" {
		return errBlockTermRecorderUnavailable
	}
	if !validBlockTermToken(token) {
		return errBlockTermRecorderBusy
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if !r.parser.canCancelPreparedBlock(blockID, token) {
		return errBlockTermRecorderBusy
	}
	if mutation != nil {
		if err := mutation(); err != nil {
			return err
		}
	}
	r.parser.commitCancelPreparedBlock(blockID, token)
	return nil
}

func (r *blockTermOutputRecorder) CancelExpectedBlock(blockID, token string) bool {
	if r == nil || blockID == "" {
		return false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.closed {
		return false
	}
	return r.parser.CancelExpectedBlock(blockID, token)
}

func (r *blockTermOutputRecorder) CancelExpectedBlockGeneration(blockID, token string, generation uint64) bool {
	if r == nil || blockID == "" || generation == 0 {
		return false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.closed {
		return false
	}
	return r.parser.CancelExpectedBlockGeneration(blockID, token, generation)
}

// WithCancelExpectedRearmBlockGeneration atomically settles an exact restart
// expectation. A matching rearm lifecycle is reported as handled even when
// mutation fails; in that case the parser binding is deliberately preserved so
// the caller can retry without leaving durable and in-memory state divergent.
func (r *blockTermOutputRecorder) WithCancelExpectedRearmBlockGeneration(
	blockID string,
	token string,
	generation uint64,
	mutation func() error,
) (handled bool, err error) {
	if r == nil || blockID == "" || generation == 0 {
		return false, errBlockTermRecorderUnavailable
	}
	if !validBlockTermToken(token) {
		return false, errBlockTermRecorderBusy
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.parser.expectedBlockID != blockID || r.parser.expectedToken != token ||
		r.parser.expectedGeneration != generation || r.parser.rearmBlockTokens[blockID] != token {
		return false, nil
	}
	if mutation != nil {
		if err := mutation(); err != nil {
			return true, err
		}
	}
	if !r.parser.cancelExpectedBlock(blockID, token, generation) {
		return true, errBlockTermRecorderBusy
	}
	return true, nil
}

// CurrentBinding reports the recorder's lifecycle correlation for reconnect handshakes.
// A newly expected command wins over an interrupted command that is retained
// only to match its late end frame and trailing output.
func (r *blockTermOutputRecorder) CurrentBinding() (blockID, token, phase string) {
	if r == nil {
		return "", "", ""
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.parser.expectedBlockID != "" {
		return r.parser.expectedBlockID, r.parser.expectedToken, "expected"
	}
	if r.parser.preparedBlockID != "" {
		return r.parser.preparedBlockID, r.parser.preparedBlockToken, "prepared"
	}
	if r.parser.activeBlockID != "" {
		return r.parser.activeBlockID, r.parser.activeBlockToken, "active"
	}
	return "", "", ""
}

// RearmBindingState reports the exact phase of a manager-prepared restart
// lifecycle. Ordinary tagged input is intentionally excluded.
func (r *blockTermOutputRecorder) RearmBindingState(blockID, token string) (string, bool) {
	if r == nil || blockID == "" || !validBlockTermToken(token) {
		return "", false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.parser.rearmBlockTokens[blockID] != token {
		return "", false
	}
	switch {
	case r.parser.preparedBlockID == blockID && r.parser.preparedBlockToken == token:
		return "prepared", true
	case r.parser.expectedBlockID == blockID && r.parser.expectedToken == token:
		return "expected", true
	case r.parser.activeBlockID == blockID && r.parser.activeBlockToken == token:
		return "active", true
	default:
		return "", false
	}
}

func (r *blockTermOutputRecorder) WasCancelledRearmBinding(blockID, token string) bool {
	if r == nil || blockID == "" || !validBlockTermToken(token) {
		return false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	key := blockTermLifecycleKey{BlockID: blockID, Token: token}
	_, stale := r.parser.staleBlockTokens[key]
	return !r.closed && stale && r.parser.retiredBlockTokens[blockID] == token &&
		r.parser.rearmBlockTokens[blockID] != token &&
		!(r.parser.preparedBlockID == blockID && r.parser.preparedBlockToken == token) &&
		!(r.parser.expectedBlockID == blockID && r.parser.expectedToken == token) &&
		!(r.parser.activeBlockID == blockID && r.parser.activeBlockToken == token)
}

func (r *blockTermOutputRecorder) HasPreparedBinding() bool {
	if r == nil {
		return false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	return !r.closed && r.parser.preparedBlockID != ""
}

// HasLifecycleBindingForBlock reports whether parser ownership for blockID is
// still recorded. Closed recorders intentionally retain this state; callers
// use IsDrained to distinguish an unfinished lifecycle from inert history.
func (r *blockTermOutputRecorder) HasLifecycleBindingForBlock(blockID string) bool {
	if r == nil || blockID == "" {
		return false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	return r.parser.preparedBlockID == blockID ||
		r.parser.expectedBlockID == blockID ||
		r.parser.activeBlockID == blockID
}

// HasRearmBindingForBlock reports whether a manager-owned restart lifecycle
// still owns blockID. The binding remains present from durable restart
// preparation through the tagged start/end lifecycle, and is removed only
// when the restart completes or is durably cancelled.
func (r *blockTermOutputRecorder) HasRearmBindingForBlock(blockID string) bool {
	if r == nil || blockID == "" {
		return false
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	token, ok := r.parser.rearmBlockTokens[blockID]
	if !ok || !validBlockTermToken(token) {
		return false
	}
	return (r.parser.preparedBlockID == blockID && r.parser.preparedBlockToken == token) ||
		(r.parser.expectedBlockID == blockID && r.parser.expectedToken == token) ||
		(r.parser.activeBlockID == blockID && r.parser.activeBlockToken == token)
}

// CurrentSignalBinding reports the binding that currently owns the foreground
// process. A retained active command wins over a queued expectation because a
// terminal signal cannot target input that the shell has not started yet.
func (r *blockTermOutputRecorder) CurrentSignalBinding() (blockID, token, phase string) {
	blockID, token, phase, _ = r.CurrentSignalBindingGeneration()
	return blockID, token, phase
}

func (r *blockTermOutputRecorder) CurrentSignalBindingGeneration() (
	blockID string,
	token string,
	phase string,
	generation uint64,
) {
	if r == nil {
		return "", "", "", 0
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.parser.activeBlockID != "" {
		return r.parser.activeBlockID, r.parser.activeBlockToken, "active", 0
	}
	if r.parser.expectedBlockID != "" {
		return r.parser.expectedBlockID, r.parser.expectedToken, "expected", r.parser.expectedGeneration
	}
	return "", "", "", 0
}

// PendingRearmBinding reports a manager-owned restart that has not reached its
// start marker. It remains available after input closes so shutdown can settle
// the durable row after the recorder worker drains.
func (r *blockTermOutputRecorder) PendingRearmBinding() (
	blockID string,
	token string,
	phase string,
	generation uint64,
) {
	if r == nil {
		return "", "", "", 0
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.parser.preparedBlockID != "" &&
		r.parser.rearmBlockTokens[r.parser.preparedBlockID] == r.parser.preparedBlockToken {
		return r.parser.preparedBlockID, r.parser.preparedBlockToken, "prepared", 0
	}
	if r.parser.expectedBlockID != "" &&
		r.parser.rearmBlockTokens[r.parser.expectedBlockID] == r.parser.expectedToken {
		return r.parser.expectedBlockID, r.parser.expectedToken, "expected", r.parser.expectedGeneration
	}
	return "", "", "", 0
}

// CurrentState snapshots both the current lifecycle correlation and the bounded
// matched completion ring used by reconnect handshakes.
func (r *blockTermOutputRecorder) CurrentState() blockTermRecorderState {
	if r == nil {
		return blockTermRecorderState{}
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	state := blockTermRecorderState{}
	if r.parser.expectedBlockID != "" {
		state.BlockID = r.parser.expectedBlockID
		state.BlockToken = r.parser.expectedToken
		state.BlockPhase = "expected"
		// An interrupted command may still own the PTY tail while the next
		// command is waiting for its exact start marker. Expose both lifecycles
		// so reconnecting clients cannot make the old tail replace the new owner.
		if r.parser.activeBlockID != "" && r.parser.activeBlockID != r.parser.expectedBlockID {
			state.BlockTailID = r.parser.activeBlockID
			state.BlockTailToken = r.parser.activeBlockToken
			state.BlockTailPhase = "active"
		}
	} else if r.parser.preparedBlockID != "" {
		state.BlockID = r.parser.preparedBlockID
		state.BlockToken = r.parser.preparedBlockToken
		state.BlockPhase = "prepared"
		if r.parser.activeBlockID != "" && r.parser.activeBlockID != r.parser.preparedBlockID {
			state.BlockTailID = r.parser.activeBlockID
			state.BlockTailToken = r.parser.activeBlockToken
			state.BlockTailPhase = "active"
		}
	} else if r.parser.activeBlockID != "" {
		state.BlockID = r.parser.activeBlockID
		state.BlockToken = r.parser.activeBlockToken
		state.BlockPhase = "active"
	}
	state.Completions = append([]blockTermCompletedLifecycle(nil), r.parser.completedLifecycles...)
	return state
}

func (r *blockTermOutputRecorder) Write(data []byte, startCursor uint64) {
	if r == nil || len(data) == 0 {
		return
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.closed || r.currentError() != nil {
		return
	}
	for _, span := range r.parser.Feed(data, startCursor) {
		if !r.acceptSpanLocked(span) {
			return
		}
	}
	// A valid end frame does not produce a span, but it still terminates the
	// block. Do not leave the final producer-side batch waiting for another
	// output read that may never arrive.
	if r.pendingSpan != nil && r.parser.activeBlockID != r.pendingSpan.BlockID {
		r.flushPendingLocked()
	}
}

func (r *blockTermOutputRecorder) CloseInput() {
	if r == nil {
		return
	}
	r.closeOnce.Do(func() {
		r.queueMu.Lock()
		defer r.queueMu.Unlock()
		if r.closed {
			return
		}
		r.closed = true
		for _, span := range r.parser.Flush() {
			if !r.acceptSpanLocked(span) {
				break
			}
		}
		r.flushPendingLocked()
		close(r.queue)
	})
}

// enqueueLocked is deliberately non-blocking. A recorder is fed from the PTY
// reader; waiting for a stalled database here would prevent the reader from
// observing shutdown and can deadlock terminal close. The first dropped event
// is surfaced through Wait/Flush so raw snapshots fail closed.
func (r *blockTermOutputRecorder) enqueueLocked(event blockTermOutputEvent) bool {
	select {
	case r.queue <- event:
		return true
	default:
		r.setError(errBlockTermOutputQueueFull)
		return false
	}
}

// acceptSpanLocked coalesces adjacent output from one block before it enters
// the bounded queue. Keeping the aggregate on the producer side limits queue
// pressure when a PTY emits many small reads, while every queued event remains
// at or below blockTermRecorderMaxBatchSize.
func (r *blockTermOutputRecorder) acceptSpanLocked(span blockTermOutputSpan) bool {
	if span.BlockID == "" || len(span.Data) == 0 {
		return true
	}

	data := span.Data
	cursor := span.StartCursor
	for len(data) > 0 {
		if r.pendingSpan != nil &&
			(r.pendingSpan.BlockID != span.BlockID || r.pendingSpan.EndCursor != cursor) {
			if !r.flushPendingLocked() {
				return false
			}
		}

		if r.pendingSpan == nil {
			take := len(data)
			if take > blockTermRecorderMaxBatchSize {
				take = blockTermRecorderMaxBatchSize
			}
			chunk := append([]byte(nil), data[:take]...)
			r.pendingSpan = &blockTermOutputSpan{
				BlockID:     span.BlockID,
				StartCursor: cursor,
				EndCursor:   cursor + uint64(take),
				Data:        chunk,
			}
			data = data[take:]
			cursor += uint64(take)
		} else {
			remaining := blockTermRecorderMaxBatchSize - len(r.pendingSpan.Data)
			if remaining <= 0 {
				if !r.flushPendingLocked() {
					return false
				}
				continue
			}
			take := len(data)
			if take > remaining {
				take = remaining
			}
			r.pendingSpan.Data = append(r.pendingSpan.Data, data[:take]...)
			r.pendingSpan.EndCursor = cursor + uint64(take)
			data = data[take:]
			cursor += uint64(take)
		}

		if len(r.pendingSpan.Data) == blockTermRecorderMaxBatchSize {
			if !r.flushPendingLocked() {
				return false
			}
		}
	}
	return true
}

// flushPendingLocked moves the producer-side aggregate into the FIFO. The
// aggregate is cleared before enqueue so a full queue releases its memory and
// preserves the recorder's existing fail-closed behavior.
func (r *blockTermOutputRecorder) flushPendingLocked() bool {
	if r.pendingSpan == nil {
		return true
	}
	span := *r.pendingSpan
	r.pendingSpan = nil
	return r.enqueueLocked(blockTermOutputEvent{span: span})
}

// BeginFlush places a FIFO barrier after all spans accepted before this call
// and returns a channel that receives the recorder error once those spans have
// been persisted. The enqueue operation itself never waits for persistence;
// callers can therefore release their terminal/input mutex before awaiting
// the returned channel.
func (r *blockTermOutputRecorder) BeginFlush() (<-chan error, error) {
	if r == nil {
		done := make(chan error, 1)
		done <- nil
		return done, nil
	}
	r.queueMu.Lock()
	if r.closed {
		r.queueMu.Unlock()
		done := make(chan error, 1)
		go func() { done <- r.Wait() }()
		return done, nil
	}
	if err := r.currentError(); err != nil {
		r.queueMu.Unlock()
		return nil, err
	}
	if !r.flushPendingLocked() {
		err := r.currentError()
		r.queueMu.Unlock()
		return nil, err
	}
	done := make(chan error, 1)
	if !r.enqueueLocked(blockTermOutputEvent{barrier: done}) {
		err := r.currentError()
		r.queueMu.Unlock()
		return nil, err
	}
	r.queueMu.Unlock()
	return done, nil
}

// Flush waits until all spans submitted before this call have reached the
// database. It is the synchronous convenience wrapper around BeginFlush.
func (r *blockTermOutputRecorder) Flush() error {
	done, err := r.BeginFlush()
	if err != nil {
		return err
	}
	return <-done
}

func (r *blockTermOutputRecorder) Wait() error {
	if r == nil {
		return nil
	}
	<-r.done
	r.errMu.Lock()
	defer r.errMu.Unlock()
	return r.err
}

func (r *blockTermOutputRecorder) IsDrained() bool {
	if r == nil {
		return true
	}
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

func (r *blockTermOutputRecorder) currentError() error {
	r.errMu.Lock()
	defer r.errMu.Unlock()
	return r.err
}

func (r *blockTermOutputRecorder) run() {
	defer close(r.done)
	var carry *blockTermOutputEvent
	for {
		var event blockTermOutputEvent
		var ok bool
		if carry != nil {
			event = *carry
			carry = nil
			ok = true
		} else {
			event, ok = <-r.queue
		}
		if !ok {
			return
		}
		if event.barrier != nil {
			event.barrier <- r.currentError()
			continue
		}
		span := event.span

		for len(span.Data) < blockTermRecorderMaxBatchSize {
			select {
			case next, open := <-r.queue:
				if !open {
					if err := r.persistWithRetry(span); err != nil {
						r.setError(err)
					}
					return
				}
				if next.barrier != nil {
					carry = &next
					goto persist
				}
				if next.span.BlockID == span.BlockID && next.span.StartCursor == span.EndCursor &&
					len(span.Data)+len(next.span.Data) <= blockTermRecorderMaxBatchSize {
					span.Data = append(span.Data, next.span.Data...)
					span.EndCursor = next.span.EndCursor
					continue
				}
				carry = &next
			default:
			}
			break
		}

	persist:
		if err := r.persistWithRetry(span); err != nil {
			r.setError(err)
		}
	}
}

func (r *blockTermOutputRecorder) persistWithRetry(span blockTermOutputSpan) error {
	var err error
	for attempt := 0; attempt < blockTermRecorderMaxAttempts; attempt++ {
		err = r.persist(span)
		if err == nil {
			return nil
		}
		if attempt+1 < blockTermRecorderMaxAttempts {
			time.Sleep(time.Duration(1<<attempt) * 10 * time.Millisecond)
		}
	}
	return err
}

func (r *blockTermOutputRecorder) persist(span blockTermOutputSpan) error {
	if span.BlockID == "" || len(span.Data) == 0 || span.EndCursor <= span.StartCursor {
		return nil
	}
	if span.EndCursor-span.StartCursor != uint64(len(span.Data)) {
		return fmt.Errorf("blockterm raw output span length does not match cursor range")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		terminalID := r.terminalID
		maxPTYSize := 0
		blockExists := false
		if r.hasHistoryTombstone {
			var history struct {
				BlockDeletedAt *int64 `gorm:"column:block_deleted_at"`
			}
			// Block IDs are globally unique and tombstones reserve an ID even
			// after the block has moved to another terminal. Keep this lookup
			// global so a late recorder retry cannot recreate deleted output.
			err := tx.Model(&model.BlockTermCommandHistory{}).
				Select("block_deleted_at").
				Where("id = ?", span.BlockID).
				Take(&history).Error
			if err == nil && history.BlockDeletedAt != nil {
				return nil
			}
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		if r.hasBlockTable {
			var block struct {
				TerminalID     string `gorm:"column:terminal_id"`
				TermMaxPTYSize int    `gorm:"column:term_max_pty_size"`
			}
			err := tx.Model(&model.BlockTermBlock{}).
				Select("terminal_id", "term_max_pty_size").
				Where("id = ?", span.BlockID).
				Take(&block).Error
			if err == nil {
				blockExists = true
				if block.TerminalID != terminalID {
					// A recorder must never be able to inject output into a block
					// owned by another terminal. Unknown blocks remain eligible for
					// the normal output-before-create race below.
					return nil
				}
				maxPTYSize = block.TermMaxPTYSize
			}
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		segment := model.BlockTermOutputSegment{
			ID:          uuid.NewString(),
			TerminalID:  terminalID,
			BlockID:     span.BlockID,
			StartCursor: span.StartCursor,
			EndCursor:   span.EndCursor,
			Data:        span.Data,
			CreatedAt:   time.Now().Unix(),
		}
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&segment)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			var existing model.BlockTermOutputSegment
			if err := tx.Where(
				"terminal_id = ? AND block_id = ? AND start_cursor = ?",
				terminalID,
				span.BlockID,
				span.StartCursor,
			).Take(&existing).Error; err != nil {
				return err
			}
			if existing.EndCursor != span.EndCursor || !bytes.Equal(existing.Data, span.Data) {
				return fmt.Errorf("blockterm raw output segment conflict at cursor %d", span.StartCursor)
			}
		}
		if blockExists {
			return TrimBlockTermOutputSegmentsForTerminal(tx, span.BlockID, terminalID, maxPTYSize)
		}
		// A block-create request may be racing this write. Preserve the span for
		// the grace period, but prune abandoned rows so a client that never
		// completes the request cannot grow the table without bound.
		return cleanupOrphanBlockTermOutputSegmentsTx(tx, time.Now().Unix(), blockTermOrphanMaxAge, blockTermOrphanMaxBytes, blockTermOrphanMaxRows)
	})
}

// CleanupOrphanBlockTermOutputSegments removes raw-output rows whose block
// never materialized. Recent rows are retained to cover the PTY/output versus
// block-create race; byte and row caps provide a hard bound when a producer
// emits many abandoned block IDs. Existing blocks are never touched here.
//
// The function is intentionally safe to call during startup and from a
// maintenance task. It is a no-op when the segment table is not present.
func CleanupOrphanBlockTermOutputSegments(db *gorm.DB) error {
	if db == nil {
		return nil
	}
	return db.Transaction(func(tx *gorm.DB) error {
		return cleanupOrphanBlockTermOutputSegmentsTx(
			tx,
			time.Now().Unix(),
			blockTermOrphanMaxAge,
			blockTermOrphanMaxBytes,
			blockTermOrphanMaxRows,
		)
	})
}

type orphanOutputSegmentMetadata struct {
	ID       string `gorm:"column:id"`
	DataSize int64  `gorm:"column:data_size"`
}

func cleanupOrphanBlockTermOutputSegmentsTx(
	tx *gorm.DB,
	nowUnix int64,
	maxAge time.Duration,
	maxBytes int64,
	maxRows int,
) error {
	if tx == nil || !tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
		return nil
	}

	// Tombstoned blocks are no longer eligible for the early-output race. Drop
	// their rows immediately, including rows inserted by a late recorder retry.
	if tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) &&
		tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "block_deleted_at") {
		if err := tx.Exec(`
			DELETE FROM blockterm_output_segments
			WHERE EXISTS (
				SELECT 1 FROM blockterm_command_history AS history
				WHERE history.id = blockterm_output_segments.block_id
				  AND history.block_deleted_at IS NOT NULL
			)
		`).Error; err != nil {
			return err
		}
	}

	hasBlockTable := tx.Migrator().HasTable(&model.BlockTermBlock{})
	if !hasBlockTable {
		// During a partial/legacy migration there is no authoritative block table
		// to distinguish an early span from an orphan. Apply only the hard cap.
		return enforceOrphanOutputSegmentCaps(tx, "1=1", maxBytes, maxRows)
	}
	orphanPredicate := `NOT EXISTS (
		SELECT 1 FROM blockterm_blocks AS blocks
		WHERE blocks.id = blockterm_output_segments.block_id
		  AND blocks.terminal_id = blockterm_output_segments.terminal_id
	)`
	cutoff := nowUnix
	if maxAge > 0 {
		cutoff = nowUnix - int64(maxAge/time.Second)
	}
	if maxAge > 0 {
		if err := tx.Exec(`
			DELETE FROM blockterm_output_segments
			WHERE `+orphanPredicate+` AND created_at < ?
		`, cutoff).Error; err != nil {
			return err
		}
	}
	return enforceOrphanOutputSegmentCaps(tx, orphanPredicate, maxBytes, maxRows)
}

func enforceOrphanOutputSegmentCaps(
	tx *gorm.DB,
	orphanPredicate string,
	maxBytes int64,
	maxRows int,
) error {
	if maxBytes <= 0 && maxRows <= 0 {
		return nil
	}
	// Read only aggregate state first. This avoids loading an already-bloated
	// orphan table into memory before we start reclaiming it.
	var stats struct {
		RowCount   int64 `gorm:"column:row_count"`
		TotalBytes int64 `gorm:"column:total_bytes"`
	}
	if err := tx.Model(&model.BlockTermOutputSegment{}).
		Select("COUNT(*) AS row_count, COALESCE(SUM(LENGTH(data)), 0) AS total_bytes").
		Where(orphanPredicate).
		Scan(&stats).Error; err != nil {
		return err
	}
	if (maxBytes <= 0 || stats.TotalBytes <= maxBytes) &&
		(maxRows <= 0 || stats.RowCount <= int64(maxRows)) {
		return nil
	}

	const batchSize = 256
	for (maxBytes > 0 && stats.TotalBytes > maxBytes) ||
		(maxRows > 0 && stats.RowCount > int64(maxRows)) {
		var segments []orphanOutputSegmentMetadata
		if err := tx.Model(&model.BlockTermOutputSegment{}).
			Select("id", "LENGTH(data) AS data_size").
			Where(orphanPredicate).
			Order("created_at ASC, id ASC").
			Limit(batchSize).
			Find(&segments).Error; err != nil {
			return err
		}
		if len(segments) == 0 {
			break
		}

		deleteIDs := make([]string, 0, len(segments))
		deletedBytes := int64(0)
		for _, segment := range segments {
			if (maxBytes <= 0 || stats.TotalBytes-deletedBytes <= maxBytes) &&
				(maxRows <= 0 || stats.RowCount-int64(len(deleteIDs)) <= int64(maxRows)) {
				break
			}
			deleteIDs = append(deleteIDs, segment.ID)
			if segment.DataSize > 0 {
				deletedBytes += segment.DataSize
			}
		}
		if len(deleteIDs) == 0 {
			// A zero-length or malformed row cannot reduce the byte total, but it
			// still needs to be removed when the row cap is the violated bound.
			deleteIDs = append(deleteIDs, segments[0].ID)
			if segments[0].DataSize > 0 {
				deletedBytes = segments[0].DataSize
			}
		}
		result := tx.Where(orphanPredicate).
			Where("id IN ?", deleteIDs).
			Delete(&model.BlockTermOutputSegment{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			break
		}
		stats.RowCount -= result.RowsAffected
		stats.TotalBytes -= deletedBytes
		if stats.TotalBytes < 0 {
			stats.TotalBytes = 0
		}
	}
	return nil
}

type blockTermOutputSegmentMetadata struct {
	ID          string `gorm:"column:id"`
	StartCursor uint64 `gorm:"column:start_cursor"`
	EndCursor   uint64 `gorm:"column:end_cursor"`
	DataSize    int64  `gorm:"column:data_size"`
}

// TrimBlockTermOutputSegments keeps the newest raw PTY bytes for one block.
//
// This compatibility wrapper intentionally preserves the historical
// block-id-only behavior. New code that has a terminal scope should call
// TrimBlockTermOutputSegmentsForTerminal instead.
func TrimBlockTermOutputSegments(tx *gorm.DB, blockID string, maxPTYSize int) error {
	return trimBlockTermOutputSegments(tx, blockID, "", maxPTYSize)
}

// TrimBlockTermOutputSegmentsForTerminal keeps the newest raw PTY bytes for a
// block while restricting every read, update, and delete to the owning
// terminal. An empty terminal ID is rejected so callers cannot accidentally
// widen a scoped cleanup into the compatibility behavior above.
func TrimBlockTermOutputSegmentsForTerminal(tx *gorm.DB, blockID, terminalID string, maxPTYSize int) error {
	if terminalID == "" {
		return nil
	}
	return trimBlockTermOutputSegments(tx, blockID, terminalID, maxPTYSize)
}

func trimBlockTermOutputSegments(tx *gorm.DB, blockID, terminalID string, maxPTYSize int) error {
	if tx == nil || blockID == "" {
		return nil
	}
	retainedBytes := int64(maxPTYSize)
	if retainedBytes <= 0 || retainedBytes > model.BlockTermMaxPTYSize {
		retainedBytes = model.BlockTermMaxPTYSize
	}

	segmentsQuery := tx.Model(&model.BlockTermOutputSegment{}).
		Select("id", "start_cursor", "end_cursor", "LENGTH(data) AS data_size").
		Where("block_id = ?", blockID)
	if terminalID != "" {
		segmentsQuery = segmentsQuery.Where("terminal_id = ?", terminalID)
	}
	var segments []blockTermOutputSegmentMetadata
	if err := segmentsQuery.
		Order("start_cursor ASC, end_cursor ASC, id ASC").
		Find(&segments).Error; err != nil {
		return err
	}

	var totalBytes int64
	for _, segment := range segments {
		if segment.DataSize < 0 || segment.EndCursor < segment.StartCursor ||
			uint64(segment.DataSize) != segment.EndCursor-segment.StartCursor {
			return fmt.Errorf("invalid blockterm raw output segment %s", segment.ID)
		}
		totalBytes += segment.DataSize
	}
	trimBytes := totalBytes - retainedBytes
	if trimBytes <= 0 {
		return nil
	}

	deleteIDs := make([]string, 0)
	for _, segment := range segments {
		if trimBytes >= segment.DataSize {
			deleteIDs = append(deleteIDs, segment.ID)
			trimBytes -= segment.DataSize
			continue
		}
		if trimBytes == 0 {
			break
		}

		boundaryQuery := tx.Select("id", "start_cursor", "end_cursor", "data").
			Where("id = ? AND block_id = ?", segment.ID, blockID)
		if terminalID != "" {
			boundaryQuery = boundaryQuery.Where("terminal_id = ?", terminalID)
		}
		var boundary model.BlockTermOutputSegment
		if err := boundaryQuery.Take(&boundary).Error; err != nil {
			return err
		}
		trimCount := int(trimBytes)
		newStartCursor := boundary.StartCursor + uint64(trimCount)
		boundaryUpdate := tx.Model(&model.BlockTermOutputSegment{}).
			Where("id = ? AND block_id = ? AND start_cursor = ?", boundary.ID, blockID, boundary.StartCursor)
		if terminalID != "" {
			boundaryUpdate = boundaryUpdate.Where("terminal_id = ?", terminalID)
		}
		result := boundaryUpdate.
			Updates(map[string]any{
				"start_cursor": newStartCursor,
				"data":         append([]byte(nil), boundary.Data[trimCount:]...),
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return fmt.Errorf("blockterm raw output segment changed while trimming")
		}
		trimBytes = 0
		break
	}
	if len(deleteIDs) > 0 {
		deleteQuery := tx.Where("block_id = ? AND id IN ?", blockID, deleteIDs)
		if terminalID != "" {
			deleteQuery = deleteQuery.Where("terminal_id = ?", terminalID)
		}
		if err := deleteQuery.Delete(&model.BlockTermOutputSegment{}).Error; err != nil {
			return err
		}
	}
	return nil
}

func (r *blockTermOutputRecorder) setError(err error) {
	if err == nil {
		return
	}
	r.errMu.Lock()
	if r.err == nil {
		r.err = err
	}
	r.errMu.Unlock()
}
