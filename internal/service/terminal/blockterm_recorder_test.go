package terminal

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const blockTermTestToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func blockTermTestOSCStart(blockID string) []byte {
	return blockTermTestOSCStartWithToken(blockID, blockTermTestToken)
}

func blockTermTestOSCStartWithToken(blockID, token string) []byte {
	return []byte("\x1b]633;__VIBEGO_BLOCKTERM__;start;" + blockID + ";v3;" + token + ";123;/tmp;cHJpbnRm\x07")
}

func blockTermTestOSCEnd(blockID string) []byte {
	return blockTermTestOSCEndWithToken(blockID, blockTermTestToken)
}

func blockTermTestOSCEndWithToken(blockID, token string) []byte {
	return []byte("\x1b]633;__VIBEGO_BLOCKTERM__;end;" + blockID + ";v3;" + token + ";0;/tmp\x07")
}

func blockTermTestOSCEndWithMetadata(blockID, token string, exitCode int, cwd string) []byte {
	return []byte(fmt.Sprintf("\x1b]633;__VIBEGO_BLOCKTERM__;end;%s;v3;%s;%d;%s\x07", blockID, token, exitCode, cwd))
}

func blockTermTestOSCStartST(blockID string) []byte {
	return []byte("\x1b]633;__VIBEGO_BLOCKTERM__;start;" + blockID + ";v3;" + blockTermTestToken + ";123;/tmp;cHJpbnRm\x1b\\")
}

func blockTermTestOSCEndST(blockID string) []byte {
	return []byte("\x1b]633;__VIBEGO_BLOCKTERM__;end;" + blockID + ";v3;" + blockTermTestToken + ";0;/tmp\x1b\\")
}

func TestBlockTermOutputParserPreservesRawBytesAcrossReads(t *testing.T) {
	blockID := "block-raw"
	start := blockTermTestOSCStart(blockID)
	end := blockTermTestOSCEnd(blockID)
	raw := []byte{'\x1b', '[', '3', '1', 'm', 'A', 0x00, 0xff, 'B'}

	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))
	first := append(append([]byte{}, start...), raw[:4]...)
	spans := parser.Feed(first, 17)
	require.Len(t, spans, 1)
	require.Equal(t, uint64(17+len(start)), spans[0].StartCursor)
	require.Equal(t, raw[:4], spans[0].Data)

	second := append(append([]byte{}, raw[4:]...), end...)
	spans = parser.Feed(second, 17+uint64(len(first)))
	require.Len(t, spans, 1)
	require.Equal(t, raw[4:], spans[0].Data)
	require.Equal(t, uint64(17+len(start)+len(raw)), spans[0].EndCursor)
	require.Empty(t, parser.Flush())
}

func TestBlockTermOutputParserHandlesSplitMarkerAndSTAcrossReads(t *testing.T) {
	blockID := "block-split"
	start := blockTermTestOSCStartST(blockID)
	end := blockTermTestOSCEndST(blockID)
	raw := []byte{'A', 0x1b, '[', '3', '1', 'm', 0x00, 0xff, 'Z'}
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))

	// The prefix and terminator are intentionally divided at arbitrary read
	// boundaries. Bytes before start and after end must remain unowned.
	prefix := []byte("before")
	first := append(append([]byte{}, prefix...), start[:len(start)/2]...)
	require.Empty(t, parser.Feed(first, 100))
	second := append(append([]byte{}, start[len(start)/2:]...), raw...)
	second = append(second, end[:len(end)-1]...)
	spans := parser.Feed(second, 100+uint64(len(first)))
	require.Len(t, spans, 1)
	require.Equal(t, raw, spans[0].Data)
	require.Equal(t, uint64(100+len(prefix)+len(start)), spans[0].StartCursor)

	// Complete the split ST terminator with its final slash.
	require.Empty(t, parser.Feed(end[len(end)-1:], 100+uint64(len(first)+len(second))))
	require.Empty(t, parser.Flush())

	trailing := parser.Feed([]byte("after"), 100+uint64(len(first)+len(second)+1))
	require.Empty(t, trailing)
}

func TestBlockTermOutputParserRecordsCorrelatedCompletionWithAbsoluteCursor(t *testing.T) {
	const blockID = "block-completion"
	const baseCursor = uint64(73)
	start := blockTermTestOSCStartST(blockID)
	end := []byte("\x1b]633;__VIBEGO_BLOCKTERM__;end;" + blockID + ";v3;" + blockTermTestToken + ";23;/work;tree\x1b\\")
	prefix := []byte("unowned")
	payload := []byte("payload")
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))

	first := append(append([]byte{}, prefix...), start[:len(start)/2]...)
	require.Empty(t, parser.Feed(first, baseCursor))
	second := append(append([]byte{}, start[len(start)/2:]...), payload...)
	second = append(second, end[:len(end)-1]...)
	spans := parser.Feed(second, baseCursor+uint64(len(first)))
	require.Len(t, spans, 1)
	require.Equal(t, payload, spans[0].Data)
	require.Empty(t, parser.completedLifecycles)

	require.Empty(t, parser.Feed(end[len(end)-1:], baseCursor+uint64(len(first)+len(second))))
	require.Equal(t, []blockTermCompletedLifecycle{{
		BlockID:    blockID,
		BlockToken: blockTermTestToken,
		ExitCode:   23,
		Cwd:        "/work;tree",
		EndCursor:  baseCursor + uint64(len(prefix)+len(start)+len(payload)+len(end)),
	}}, parser.completedLifecycles)
	// The recorder segment intentionally excludes the end OSC frame, while the
	// completion watermark includes it. Keep this relationship explicit: callers
	// must use the FIFO barrier rather than compare the two cursors directly.
	require.Equal(t, uint64(len(end)), parser.completedLifecycles[0].EndCursor-spans[0].EndCursor)
}

func TestBlockTermOutputRecorderBarrierAcknowledgesCompletionWithoutPayload(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-recorder-empty-completion.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	const terminalID = "term-empty-completion"
	const blockID = "block-empty-completion"
	require.NoError(t, db.Create(&model.BlockTermBlock{ID: blockID, TerminalID: terminalID, LineNum: 0}).Error)

	recorder := newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, recorder)
	t.Cleanup(func() {
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})
	require.True(t, recorder.ExpectBlock(blockID, blockTermTestToken))

	start := blockTermTestOSCStart(blockID)
	end := blockTermTestOSCEndWithMetadata(blockID, blockTermTestToken, 0, "/empty")
	input := append(append([]byte{}, start...), end...)
	const baseCursor = uint64(211)
	recorder.Write(input, baseCursor)

	barrier, err := recorder.BeginFlush()
	require.NoError(t, err)
	require.NotNil(t, barrier)
	select {
	case barrierErr := <-barrier:
		require.NoError(t, barrierErr)
	case <-time.After(time.Second):
		t.Fatal("empty completion barrier did not complete")
	}

	var segments []model.BlockTermOutputSegment
	require.NoError(t, db.Where("block_id = ?", blockID).Find(&segments).Error)
	require.Empty(t, segments)
	state := recorder.CurrentState()
	require.Empty(t, state.BlockID)
	require.Len(t, state.Completions, 1)
	require.Equal(t, blockTermCompletedLifecycle{
		BlockID:    blockID,
		BlockToken: blockTermTestToken,
		ExitCode:   0,
		Cwd:        "/empty",
		EndCursor:  baseCursor + uint64(len(input)),
	}, state.Completions[0])
}

func TestBlockTermOutputParserRejectsMismatchedCompletionMetadata(t *testing.T) {
	tests := []struct {
		name string
		end  []byte
	}{
		{name: "wrong token", end: blockTermTestOSCEndWithToken("block-invalid-end", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")},
		{name: "negative exit", end: blockTermTestOSCEndWithMetadata("block-invalid-end", blockTermTestToken, -1, "/tmp")},
		{name: "large exit", end: blockTermTestOSCEndWithMetadata("block-invalid-end", blockTermTestToken, 256, "/tmp")},
		{name: "nul cwd", end: blockTermTestOSCEndWithMetadata("block-invalid-end", blockTermTestToken, 0, "/tmp\x00bad")},
		{name: "oversized cwd", end: blockTermTestOSCEndWithMetadata("block-invalid-end", blockTermTestToken, 0, strings.Repeat("x", blockTermCompletedCwdMaxBytes+1))},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parser := blockTermOutputParser{}
			require.True(t, parser.ExpectBlock("block-invalid-end", blockTermTestToken))
			require.Empty(t, parser.Feed(blockTermTestOSCStart("block-invalid-end"), 0))
			spans := parser.Feed(test.end, uint64(len(blockTermTestOSCStart("block-invalid-end"))))
			require.Len(t, spans, 1)
			require.Equal(t, test.end, spans[0].Data)
			require.Equal(t, "block-invalid-end", parser.activeBlockID)
			require.Empty(t, parser.completedLifecycles)
		})
	}
}

func TestBlockTermOutputParserDoesNotLetNestedFramesStealOutput(t *testing.T) {
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock("block-real", blockTermTestToken))
	realStart := blockTermTestOSCStart("block-real")
	fakeStart := blockTermTestOSCStart("block-fake")
	fakeEnd := blockTermTestOSCEnd("block-fake")
	realEnd := blockTermTestOSCEnd("block-real")
	input := append(append(append(append(append([]byte{}, realStart...), fakeStart...), []byte("owned")...), fakeEnd...), realEnd...)

	spans := parser.Feed(input, 0)
	require.Len(t, spans, 1)
	require.Equal(t, "block-real", spans[0].BlockID)
	require.Equal(t, append(append(append([]byte{}, fakeStart...), []byte("owned")...), fakeEnd...), spans[0].Data)
	require.Empty(t, parser.activeBlockID)
}

func TestBlockTermOutputParserRejectsForgedStartBeforeExpectedBlock(t *testing.T) {
	parser := blockTermOutputParser{}
	parser.ExpectBlock("block-real", blockTermTestToken)
	fakeStart := blockTermTestOSCStart("block-fake")
	fakeEnd := blockTermTestOSCEnd("block-fake")
	realStart := blockTermTestOSCStart("block-real")
	realEnd := blockTermTestOSCEnd("block-real")
	input := append(append(append(append(append(append([]byte{}, fakeStart...), []byte("forged")...), fakeEnd...), realStart...), []byte("owned")...), realEnd...)

	spans := parser.Feed(input, 0)
	require.Len(t, spans, 1)
	require.Equal(t, "block-real", spans[0].BlockID)
	require.Equal(t, []byte("owned"), spans[0].Data)
	require.Empty(t, parser.activeBlockID)
	require.Empty(t, parser.expectedBlockID)
}

func TestBlockTermOutputParserRetiresCompletedBlockID(t *testing.T) {
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock("block-once", blockTermTestToken))
	input := append(append(blockTermTestOSCStart("block-once"), []byte("first")...), blockTermTestOSCEnd("block-once")...)
	spans := parser.Feed(input, 0)
	require.Len(t, spans, 1)
	require.Equal(t, []byte("first"), spans[0].Data)
	require.False(t, parser.ExpectBlock("block-once", blockTermTestToken))
	second := append(append(blockTermTestOSCStart("block-once"), []byte("second")...), blockTermTestOSCEnd("block-once")...)
	require.Empty(t, parser.Feed(second, uint64(len(input))))
}

func TestBlockTermOutputParserRearmsSameBlockWithFreshToken(t *testing.T) {
	const blockID = "block-rearm"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))

	oldStart := blockTermTestOSCStart(blockID)
	oldEnd := blockTermTestOSCEnd(blockID)
	oldInput := append(append(append([]byte{}, oldStart...), []byte("old-output")...), oldEnd...)
	oldSpans := parser.Feed(oldInput, 0)
	require.Len(t, oldSpans, 1)
	require.Equal(t, []byte("old-output"), oldSpans[0].Data)
	require.Len(t, parser.completedLifecycles, 1)

	// Rearm clears the old completion and leaves the parser unarmed. The normal
	// tagged-input path must perform the subsequent ExpectBlock transition.
	require.True(t, parser.rearmBlock(blockID, newToken))
	require.Empty(t, parser.activeBlockID)
	require.Empty(t, parser.expectedBlockID)
	require.Empty(t, parser.completedLifecycles)
	require.NotContains(t, parser.retiredBlockIDs, blockID)
	require.Contains(t, parser.staleBlockTokens, blockTermLifecycleKey{BlockID: blockID, Token: blockTermTestToken})
	require.True(t, parser.ExpectBlock(blockID, newToken))

	newStart := blockTermTestOSCStartWithToken(blockID, newToken)
	newEnd := blockTermTestOSCEndWithToken(blockID, newToken)
	// A delayed old lifecycle can arrive after the new input was armed. Its
	// marker and payload must be quarantined instead of being attached to the
	// reused durable block.
	input := append(append(append(append([]byte{}, oldStart...), []byte("late-old")...), oldEnd...), newStart...)
	input = append(append(input, []byte("new-output")...), newEnd...)
	spans := parser.Feed(input, uint64(len(oldInput)))
	require.Len(t, spans, 1)
	require.Equal(t, []byte("new-output"), spans[0].Data)
	require.Equal(t, blockID, spans[0].BlockID)
	require.Empty(t, parser.activeBlockID)
	require.Len(t, parser.completedLifecycles, 1)
	require.Equal(t, newToken, parser.retiredBlockTokens[blockID])
	require.Equal(t, 0, strings.Count(string(spans[0].Data), "late-old"))
}

func TestBlockTermOutputParserDropsDelayedOldEndWithoutOldStart(t *testing.T) {
	const blockID = "block-rearm-delayed-end"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))
	oldInput := append(
		append(append([]byte{}, blockTermTestOSCStart(blockID)...), []byte("old")...),
		blockTermTestOSCEnd(blockID)...,
	)
	require.Len(t, parser.Feed(oldInput, 0), 1)
	require.True(t, parser.rearmBlock(blockID, newToken))
	require.True(t, parser.ExpectBlock(blockID, newToken))

	newStart := blockTermTestOSCStartWithToken(blockID, newToken)
	newEnd := blockTermTestOSCEndWithToken(blockID, newToken)
	newPrefix := append(append([]byte{}, newStart...), []byte("new")...)
	spans := parser.Feed(newPrefix, uint64(len(oldInput)))
	require.Len(t, spans, 1)
	require.Equal(t, []byte("new"), spans[0].Data)
	require.Equal(t, blockID, parser.activeBlockID)

	// The old end may be delivered after the new lifecycle has started even if
	// the old start/payload were already consumed by a prior connection. Its
	// exact token must keep it out of the new block's raw output.
	require.Empty(t, parser.Feed(blockTermTestOSCEnd(blockID), uint64(len(oldInput)+len(newPrefix))))
	require.Equal(t, blockID, parser.activeBlockID)

	require.Empty(t, parser.Feed(newEnd, uint64(len(oldInput)+len(newPrefix)+len(blockTermTestOSCEnd(blockID)))))
	require.Empty(t, parser.activeBlockID)
	require.Len(t, parser.completedLifecycles, 1)
	require.Equal(t, newToken, parser.completedLifecycles[0].BlockToken)
}

func TestBlockTermOutputParserRearmClearsPreArmIncompleteMarker(t *testing.T) {
	const blockID = "block-rearm-split"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	const baseCursor = uint64(40)
	parser := blockTermOutputParser{}
	start := blockTermTestOSCStartWithToken(blockID, newToken)
	end := blockTermTestOSCEndWithToken(blockID, newToken)
	split := len(blockTermOSCMarker) - 3

	require.Empty(t, parser.Feed(start[:split], baseCursor))
	require.Equal(t, start[:split], parser.pending)
	require.Equal(t, baseCursor, parser.pendingCursor)
	require.True(t, parser.rearmBlock(blockID, newToken))
	require.True(t, parser.ExpectBlock(blockID, newToken))
	require.Empty(t, parser.pending)
	require.Zero(t, parser.pendingCursor)

	require.Empty(t, parser.Feed(start[split:], baseCursor+uint64(split)))
	require.Equal(t, blockID, parser.expectedBlockID)
	require.Empty(t, parser.activeBlockID)

	ownedStartCursor := baseCursor + uint64(len(start))
	input := append(append(append([]byte{}, start...), []byte("owned")...), end...)
	spans := parser.Feed(input, ownedStartCursor)
	require.Len(t, spans, 1)
	require.Equal(t, blockID, spans[0].BlockID)
	require.Equal(t, []byte("owned"), spans[0].Data)
	require.Equal(t, ownedStartCursor+uint64(len(start)), spans[0].StartCursor)
	require.Equal(t, ownedStartCursor+uint64(len(start)+len("owned")), spans[0].EndCursor)
	require.Empty(t, parser.expectedBlockID)
	require.Empty(t, parser.activeBlockID)
}

func TestBlockTermOutputParserRearmPreservesIncompleteMarkerForActiveTail(t *testing.T) {
	const oldBlockID = "block-rearm-tail-old"
	const newBlockID = "block-rearm-tail-new"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(oldBlockID, blockTermTestToken))
	oldStart := blockTermTestOSCStart(oldBlockID)
	oldEnd := blockTermTestOSCEnd(oldBlockID)
	require.Len(t, parser.Feed(append(append([]byte{}, oldStart...), []byte("tail")...), 0), 1)

	endCursor := uint64(len(oldStart) + len("tail"))
	split := len(blockTermOSCMarker) - 3
	require.Empty(t, parser.Feed(oldEnd[:split], endCursor))
	require.Equal(t, oldEnd[:split], parser.pending)
	require.True(t, parser.rearmBlock(newBlockID, newToken))
	require.True(t, parser.ExpectBlock(newBlockID, newToken))
	require.Equal(t, oldEnd[:split], parser.pending)

	require.Empty(t, parser.Feed(oldEnd[split:], endCursor+uint64(split)))
	require.Empty(t, parser.activeBlockID)
	require.Equal(t, newBlockID, parser.expectedBlockID)
	require.Len(t, parser.completedLifecycles, 1)
	require.Equal(t, oldBlockID, parser.completedLifecycles[0].BlockID)

	newStart := blockTermTestOSCStartWithToken(newBlockID, newToken)
	newEnd := blockTermTestOSCEndWithToken(newBlockID, newToken)
	spans := parser.Feed(
		append(append(append([]byte{}, newStart...), []byte("owned")...), newEnd...),
		endCursor+uint64(len(oldEnd)),
	)
	require.Len(t, spans, 1)
	require.Equal(t, newBlockID, spans[0].BlockID)
	require.Equal(t, []byte("owned"), spans[0].Data)
}

func TestBlockTermOutputParserRearmRequiresFreshTokenAndIdleParser(t *testing.T) {
	const blockID = "block-rearm-validation"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))
	parser.Feed(append(append(blockTermTestOSCStart(blockID), []byte("done")...), blockTermTestOSCEnd(blockID)...), 0)

	// Reusing the old token would let delayed frames satisfy the new lifecycle.
	require.False(t, parser.rearmBlock(blockID, blockTermTestToken))
	require.True(t, parser.rearmBlock(blockID, newToken))
	parser = blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))
	// An expected command is already reserved and cannot be replaced by restart.
	require.False(t, parser.rearmBlock(blockID, newToken))
	// An active command cannot be reset underneath the reader; it must first be
	// stopped/closed by the lifecycle owner.
	require.Empty(t, parser.Feed(blockTermTestOSCStart(blockID), 0))
	require.False(t, parser.rearmBlock(blockID, newToken))
}

func TestBlockTermOutputRecorderRearmMutationFailurePreservesParser(t *testing.T) {
	const blockID = "block-rearm-transaction"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	recorder := &blockTermOutputRecorder{}
	recorder.parser.retiredBlockIDs = map[string]struct{}{blockID: {}}
	recorder.parser.retiredBlockFIFO = []string{blockID}
	recorder.parser.retiredBlockTokens = map[string]string{blockID: blockTermTestToken}
	recorder.parser.completedLifecycles = []blockTermCompletedLifecycle{{BlockID: blockID, ExitCode: 1}}

	sentinel := errors.New("restart mutation failed")
	err := recorder.WithRearmBlock(blockID, newToken, func() error { return sentinel })
	require.ErrorIs(t, err, sentinel)
	require.Contains(t, recorder.parser.retiredBlockIDs, blockID)
	require.Equal(t, blockTermTestToken, recorder.parser.retiredBlockTokens[blockID])
	require.Len(t, recorder.parser.completedLifecycles, 1)
	require.Empty(t, recorder.parser.staleBlockTokens)

	require.NoError(t, recorder.RearmBlock(blockID, newToken))
	require.NotContains(t, recorder.parser.retiredBlockIDs, blockID)
	require.Empty(t, recorder.parser.completedLifecycles)
	require.True(t, recorder.ExpectBlock(blockID, newToken))
}

func TestBlockTermOutputRecorderExpectedRearmCancellationIsTransactional(t *testing.T) {
	const blockID = "block-rearm-expected-cancel"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	recorder := &blockTermOutputRecorder{}
	recorder.parser.retiredBlockIDs = map[string]struct{}{blockID: {}}
	recorder.parser.retiredBlockFIFO = []string{blockID}
	recorder.parser.retiredBlockTokens = map[string]string{blockID: blockTermTestToken}
	require.NoError(t, recorder.RearmBlock(blockID, newToken))
	generation, err := recorder.expectBlock(blockID, newToken)
	require.NoError(t, err)

	sentinel := errors.New("expected restart mutation failed")
	handled, err := recorder.WithCancelExpectedRearmBlockGeneration(
		blockID,
		newToken,
		generation,
		func() error { return sentinel },
	)
	require.True(t, handled)
	require.ErrorIs(t, err, sentinel)
	phase, ok := recorder.RearmBindingState(blockID, newToken)
	require.True(t, ok)
	require.Equal(t, "expected", phase)
	require.Equal(t, generation, recorder.parser.expectedGeneration)

	recorder.setError(errors.New("raw persistence failed"))
	handled, err = recorder.WithCancelExpectedRearmBlockGeneration(blockID, newToken, generation, nil)
	require.True(t, handled)
	require.NoError(t, err)
	_, ok = recorder.RearmBindingState(blockID, newToken)
	require.False(t, ok)
	require.Equal(t, newToken, recorder.parser.retiredBlockTokens[blockID])
}

func TestBlockTermOutputRecorderAllowsPreparedRearmCancellationAfterClose(t *testing.T) {
	const blockID = "block-rearm-prepared-closed"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	recorder := &blockTermOutputRecorder{}
	recorder.parser.retiredBlockIDs = map[string]struct{}{blockID: {}}
	recorder.parser.retiredBlockFIFO = []string{blockID}
	recorder.parser.retiredBlockTokens = map[string]string{blockID: blockTermTestToken}
	require.NoError(t, recorder.RearmBlock(blockID, newToken))
	recorder.closed = true

	mutated := false
	require.NoError(t, recorder.WithCancelPreparedBlock(blockID, newToken, func() error {
		mutated = true
		return nil
	}))
	require.True(t, mutated)
	_, ok := recorder.RearmBindingState(blockID, newToken)
	require.False(t, ok)
}

func TestBlockTermOutputRecorderAllowsExpectedRearmCancellationAfterClose(t *testing.T) {
	const blockID = "block-rearm-expected-closed"
	const newToken = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	recorder := &blockTermOutputRecorder{}
	recorder.parser.retiredBlockIDs = map[string]struct{}{blockID: {}}
	recorder.parser.retiredBlockFIFO = []string{blockID}
	recorder.parser.retiredBlockTokens = map[string]string{blockID: blockTermTestToken}
	require.NoError(t, recorder.RearmBlock(blockID, newToken))
	generation, err := recorder.expectBlock(blockID, newToken)
	require.NoError(t, err)
	recorder.closed = true

	mutated := false
	handled, err := recorder.WithCancelExpectedRearmBlockGeneration(
		blockID,
		newToken,
		generation,
		func() error {
			mutated = true
			return nil
		},
	)
	require.NoError(t, err)
	require.True(t, handled)
	require.True(t, mutated)
	_, ok := recorder.RearmBindingState(blockID, newToken)
	require.False(t, ok)
}

func TestBlockTermOutputParserBoundsRetiredBlockIDs(t *testing.T) {
	parser := blockTermOutputParser{}
	for index := 0; index <= blockTermRetiredBlockLimit; index++ {
		blockID := fmt.Sprintf("block-retired-%d", index)
		require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))
		parser.Feed(append(blockTermTestOSCStart(blockID), blockTermTestOSCEnd(blockID)...), uint64(index*1000))
	}
	require.Len(t, parser.retiredBlockIDs, blockTermRetiredBlockLimit)
	require.Len(t, parser.completedLifecycles, blockTermRetiredBlockLimit)
	require.Equal(t, "block-retired-1", parser.completedLifecycles[0].BlockID)
	require.Equal(t, fmt.Sprintf("block-retired-%d", blockTermRetiredBlockLimit), parser.completedLifecycles[len(parser.completedLifecycles)-1].BlockID)
	require.True(t, parser.ExpectBlock("block-retired-0", blockTermTestToken))
	require.True(t, parser.CancelExpectedBlock("block-retired-0", blockTermTestToken))
	require.False(t, parser.ExpectBlock(fmt.Sprintf("block-retired-%d", blockTermRetiredBlockLimit), blockTermTestToken))
}

func TestBlockTermOutputRecorderCurrentStateReturnsCompletionCopy(t *testing.T) {
	recorder := &blockTermOutputRecorder{}
	recorder.parser.completedLifecycles = []blockTermCompletedLifecycle{{
		BlockID:   "block-copy",
		ExitCode:  7,
		Cwd:       "/copy",
		EndCursor: 42,
	}}

	first := recorder.CurrentState()
	require.Len(t, first.Completions, 1)
	first.Completions[0].BlockID = "mutated"
	first.Completions = append(first.Completions, blockTermCompletedLifecycle{BlockID: "extra"})

	second := recorder.CurrentState()
	require.Equal(t, []blockTermCompletedLifecycle{{
		BlockID:   "block-copy",
		ExitCode:  7,
		Cwd:       "/copy",
		EndCursor: 42,
	}}, second.Completions)
}

func TestBlockTermOutputParserExpectedStartSupersedesInterruptedActiveBlock(t *testing.T) {
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock("block-first", blockTermTestToken))
	firstStart := blockTermTestOSCStart("block-first")
	spans := parser.Feed(append(append([]byte{}, firstStart...), []byte("first")...), 0)
	require.Len(t, spans, 1)
	require.True(t, parser.ExpectBlock("block-second", blockTermTestToken))
	require.False(t, parser.ExpectBlock("block-third", blockTermTestToken))
	require.False(t, parser.ExpectBlock("block-first", blockTermTestToken))

	secondStart := blockTermTestOSCStart("block-second")
	spans = parser.Feed(secondStart, uint64(len(firstStart)+len("first")))
	require.Empty(t, spans)
	require.Equal(t, "block-second", parser.activeBlockID)
	require.Empty(t, parser.expectedBlockID)
	require.Contains(t, parser.retiredBlockIDs, "block-first")
	require.Empty(t, parser.completedLifecycles)

	secondEnd := blockTermTestOSCEnd("block-second")
	secondInput := append([]byte("second"), secondEnd...)
	spans = parser.Feed(secondInput, 1000)
	require.Len(t, spans, 1)
	require.Equal(t, "block-second", spans[0].BlockID)
	require.Equal(t, []byte("second"), spans[0].Data)
	require.Empty(t, parser.activeBlockID)
	require.Empty(t, parser.expectedBlockID)
	require.Len(t, parser.completedLifecycles, 1)
	require.Equal(t, "block-second", parser.completedLifecycles[0].BlockID)
}

func TestBlockTermOutputRecorderPrefersExpectedBindingOverRetainedActive(t *testing.T) {
	recorder := &blockTermOutputRecorder{}
	recorder.parser.activeBlockID = "block-old"
	recorder.parser.activeBlockToken = blockTermTestToken
	recorder.parser.expectedBlockID = "block-new"
	recorder.parser.expectedToken = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

	blockID, token, phase := recorder.CurrentBinding()
	require.Equal(t, "block-new", blockID)
	require.Equal(t, recorder.parser.expectedToken, token)
	require.Equal(t, "expected", phase)
	require.Equal(t, blockTermRecorderState{
		BlockID:        "block-new",
		BlockToken:     recorder.parser.expectedToken,
		BlockPhase:     "expected",
		BlockTailID:    "block-old",
		BlockTailToken: blockTermTestToken,
		BlockTailPhase: "active",
	}, recorder.CurrentState())

	blockID, token, phase = recorder.CurrentSignalBinding()
	require.Equal(t, "block-old", blockID)
	require.Equal(t, blockTermTestToken, token)
	require.Equal(t, "active", phase)
}

func TestBlockTermOutputParserClearsPreArmIncompleteMarker(t *testing.T) {
	parser := blockTermOutputParser{}
	prefix := blockTermOSCMarker[:len(blockTermOSCMarker)-3]
	require.Empty(t, parser.Feed(prefix, 40))
	require.NotEmpty(t, parser.pending)
	require.True(t, parser.ExpectBlock("block-pre-arm", blockTermTestToken))
	require.Empty(t, parser.pending)

	// Completing bytes from the pre-arm prefix cannot combine with the managed
	// wrapper or consume its expectation.
	require.Empty(t, parser.Feed(blockTermOSCMarker[len(blockTermOSCMarker)-3:], 40+uint64(len(prefix))))
	require.Equal(t, "block-pre-arm", parser.expectedBlockID)
	require.Equal(t, blockTermTestToken, parser.expectedToken)

	start := blockTermTestOSCStart("block-pre-arm")
	end := blockTermTestOSCEnd("block-pre-arm")
	spans := parser.Feed(append(append(start, []byte("owned")...), end...), 100)
	require.Len(t, spans, 1)
	require.Equal(t, []byte("owned"), spans[0].Data)
}

func TestBlockTermOutputParserRequiresMatchingV3Token(t *testing.T) {
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock("block-token", blockTermTestToken))
	wrongToken := "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	wrongStart := blockTermTestOSCStartWithToken("block-token", wrongToken)
	v2Start := []byte("\x1b]633;__VIBEGO_BLOCKTERM__;start;block-token;v2;123;/tmp;cHJpbnRm\x07")
	require.Empty(t, parser.Feed(append(wrongStart, v2Start...), 0))
	require.Equal(t, "block-token", parser.expectedBlockID)

	start := blockTermTestOSCStart("block-token")
	wrongEnd := blockTermTestOSCEndWithToken("block-token", wrongToken)
	spans := parser.Feed(append(append(start, wrongEnd...), []byte("owned")...), uint64(len(wrongStart)+len(v2Start)))
	require.Len(t, spans, 1)
	require.Equal(t, append(wrongEnd, []byte("owned")...), spans[0].Data)
	require.Equal(t, "block-token", parser.activeBlockID)
	require.Equal(t, blockTermTestToken, parser.activeBlockToken)
	require.Empty(t, parser.Feed(blockTermTestOSCEnd("block-token"), 1000))
	require.Empty(t, parser.activeBlockID)
}

func TestBlockTermOutputParserFlushesIncompleteMarkerAsRawOutput(t *testing.T) {
	blockID := "block-incomplete"
	start := blockTermTestOSCStart(blockID)
	partial := []byte("\x1b]633;__VIBEGO_BLOCKTERM__;end;" + blockID)
	parser := blockTermOutputParser{}
	require.True(t, parser.ExpectBlock(blockID, blockTermTestToken))

	spans := parser.Feed(start, 0)
	require.Empty(t, spans)
	spans = parser.Feed([]byte("payload"), uint64(len(start)))
	require.Len(t, spans, 1)
	require.Equal(t, []byte("payload"), spans[0].Data)
	spans = parser.Feed(partial, uint64(len(start)+len("payload")))
	require.Empty(t, spans)

	flushed := parser.Flush()
	require.Len(t, flushed, 1)
	require.Equal(t, partial, flushed[0].Data)
	require.Equal(t, uint64(len(start)+len("payload")), flushed[0].StartCursor)
}

func TestBlockTermOutputRecorderPersistsIdempotentSegments(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-recorder.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create(&model.BlockTermBlock{ID: "block-db", TerminalID: "term-db", LineNum: 0}).Error)

	recorder := newBlockTermOutputRecorder(db, "term-db")
	require.NotNil(t, recorder)
	require.True(t, recorder.ExpectBlock("block-db", blockTermTestToken))
	start := blockTermTestOSCStart("block-db")
	chunk := append(append(append([]byte{}, start...), []byte("one")...), []byte("two")...)
	chunk = append(chunk, blockTermTestOSCEnd("block-db")...)
	recorder.Write(chunk, 0)
	recorder.CloseInput()
	require.NoError(t, recorder.Wait())

	var segments []model.BlockTermOutputSegment
	require.NoError(t, db.Order("start_cursor ASC").Find(&segments).Error)
	require.Len(t, segments, 1)
	require.Equal(t, []byte("onetwo"), segments[0].Data)
	require.Equal(t, uint64(len(start)), segments[0].StartCursor)
	require.Equal(t, uint64(len(start)+6), segments[0].EndCursor)

	// Repeating the same range is safe and does not create duplicate rows.
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID:     "block-db",
		StartCursor: segments[0].StartCursor,
		EndCursor:   segments[0].EndCursor,
		Data:        bytes.Clone(segments[0].Data),
	}))
	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).Count(&count).Error)
	require.Equal(t, int64(1), count)

	require.Error(t, recorder.persist(blockTermOutputSpan{
		BlockID:     "block-db",
		StartCursor: segments[0].StartCursor,
		EndCursor:   segments[0].EndCursor,
		Data:        []byte("different"),
	}))
}

func TestBlockTermOutputRecorderFlushWaitsForDelayedPersistence(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-recorder-flush.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create(&model.BlockTermBlock{ID: "block-flush", TerminalID: "term-flush", LineNum: 0}).Error)

	recorder := newBlockTermOutputRecorder(db, "term-flush")
	require.NotNil(t, recorder)
	t.Cleanup(func() {
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})

	persistStarted := make(chan struct{})
	releasePersist := make(chan struct{})
	const callbackName = "test:blockterm_output_segment_delayed_create"
	var blockOnce sync.Once
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermOutputSegment{}).TableName() {
			blockOnce.Do(func() {
				close(persistStarted)
				<-releasePersist
			})
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	start := blockTermTestOSCStart("block-flush")
	require.True(t, recorder.ExpectBlock("block-flush", blockTermTestToken))
	recorder.Write(append(append([]byte{}, start...), []byte("delayed")...), 0)

	flushed := make(chan error, 1)
	go func() { flushed <- recorder.Flush() }()
	select {
	case <-persistStarted:
	case <-time.After(time.Second):
		t.Fatal("recorder persistence did not start")
	}
	select {
	case err := <-flushed:
		t.Fatalf("Flush returned before delayed persistence completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(releasePersist)
	require.NoError(t, <-flushed)
	var segment model.BlockTermOutputSegment
	require.NoError(t, db.First(&segment, "block_id = ?", "block-flush").Error)
	require.Equal(t, []byte("delayed"), segment.Data)
}

func TestBlockTermOutputRecorderBeginFlushReleasesInputBeforePersistence(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-recorder-begin-flush.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create([]model.BlockTermBlock{
		{ID: "block-begin-flush-1", TerminalID: "term-begin-flush", LineNum: 0},
		{ID: "block-begin-flush-2", TerminalID: "term-begin-flush", LineNum: 1},
	}).Error)

	recorder := newBlockTermOutputRecorder(db, "term-begin-flush")
	require.NotNil(t, recorder)
	persistStarted := make(chan struct{})
	releasePersist := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releasePersist) }) }
	const callbackName = "test:blockterm_output_segment_begin_flush"
	var blockOnce sync.Once
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermOutputSegment{}).TableName() {
			blockOnce.Do(func() {
				close(persistStarted)
				<-releasePersist
			})
		}
	}))
	t.Cleanup(func() {
		_ = db.Callback().Create().Remove(callbackName)
		release()
		recorder.CloseInput()
		_ = recorder.Wait()
	})

	first := append(append([]byte{}, blockTermTestOSCStart("block-begin-flush-1")...), []byte("one")...)
	first = append(first, blockTermTestOSCEnd("block-begin-flush-1")...)
	require.True(t, recorder.ExpectBlock("block-begin-flush-1", blockTermTestToken))
	recorder.Write(first, 0)
	select {
	case <-persistStarted:
	case <-time.After(time.Second):
		t.Fatal("recorder persistence did not start")
	}

	barrier, err := recorder.BeginFlush()
	require.NoError(t, err)
	require.NotNil(t, barrier)
	second := append(append([]byte{}, blockTermTestOSCStart("block-begin-flush-2")...), []byte("two")...)
	second = append(second, blockTermTestOSCEnd("block-begin-flush-2")...)
	require.True(t, recorder.ExpectBlock("block-begin-flush-2", blockTermTestToken))
	writeDone := make(chan struct{})
	go func() {
		recorder.Write(second, 100)
		close(writeDone)
	}()
	select {
	case <-writeDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Write remained blocked while BeginFlush barrier was persisting")
	}

	release()
	select {
	case barrierErr := <-barrier:
		require.NoError(t, barrierErr)
	case <-time.After(2 * time.Second):
		t.Fatal("BeginFlush barrier did not complete")
	}
	recorder.CloseInput()
	require.NoError(t, recorder.Wait())
}

func TestBlockTermOutputRecorderQueueFullFailsClosedWithoutBlocking(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-recorder-queue-full.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))

	const terminalID = "term-queue-full"
	for index := 0; index < blockTermRecorderQueueSize+2; index++ {
		require.NoError(t, db.Create(&model.BlockTermBlock{
			ID:         fmt.Sprintf("block-queue-full-%d", index),
			TerminalID: terminalID,
			LineNum:    index,
		}).Error)
	}

	recorder := newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, recorder)
	persistStarted := make(chan struct{})
	releasePersist := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releasePersist) }) }
	const callbackName = "test:blockterm_output_segment_queue_full"
	var blockOnce sync.Once
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermOutputSegment{}).TableName() {
			blockOnce.Do(func() {
				close(persistStarted)
				<-releasePersist
			})
		}
	}))
	t.Cleanup(func() {
		_ = db.Callback().Create().Remove(callbackName)
		release()
		recorder.CloseInput()
		_ = recorder.Wait()
	})

	firstID := "block-queue-full-0"
	first := append(append([]byte{}, blockTermTestOSCStart(firstID)...), []byte("x")...)
	first = append(first, blockTermTestOSCEnd(firstID)...)
	require.True(t, recorder.ExpectBlock(firstID, blockTermTestToken))
	recorder.Write(first, 0)
	select {
	case <-persistStarted:
	case <-time.After(time.Second):
		t.Fatal("recorder persistence did not start")
	}

	start := time.Now()
	for index := 1; index < blockTermRecorderQueueSize+2; index++ {
		blockID := fmt.Sprintf("block-queue-full-%d", index)
		data := append(append([]byte{}, blockTermTestOSCStart(blockID)...), []byte("x")...)
		data = append(data, blockTermTestOSCEnd(blockID)...)
		require.True(t, recorder.ExpectBlock(blockID, blockTermTestToken))
		recorder.Write(data, uint64(index*100))
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("queue-full writes blocked for %s", elapsed)
	}
	require.ErrorIs(t, recorder.Flush(), errBlockTermOutputQueueFull)

	release()
	closeStart := time.Now()
	recorder.CloseInput()
	if elapsed := time.Since(closeStart); elapsed > 500*time.Millisecond {
		t.Fatalf("CloseInput blocked for %s after queue overflow", elapsed)
	}
	require.ErrorIs(t, recorder.Wait(), errBlockTermOutputQueueFull)
}

func TestBlockTermOutputRecorderCoalescesLargeSingleBlockOutput(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-recorder-large-block.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))

	const terminalID = "term-large-block"
	const blockID = "block-large-block"
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: blockID, TerminalID: terminalID, LineNum: 0,
	}).Error)

	recorder := newBlockTermOutputRecorder(db, terminalID)
	require.NotNil(t, recorder)

	persistStarted := make(chan struct{})
	releasePersist := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releasePersist) }) }
	const callbackName = "test:blockterm_output_segment_large_block"
	var blockOnce sync.Once
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.BlockTermOutputSegment{}).TableName() {
			blockOnce.Do(func() {
				close(persistStarted)
				<-releasePersist
			})
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })
	t.Cleanup(func() {
		release()
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})

	// Keep the payload free of OSC-like bytes so every byte belongs to the
	// single block and can be compared directly after segment reconstruction.
	payload := bytes.Repeat([]byte("0123456789abcdef"), 75_000)
	const writeChunkSize = 1024
	cursor := uint64(0)
	write := func(data []byte) {
		recorder.Write(data, cursor)
		cursor += uint64(len(data))
	}
	require.True(t, recorder.ExpectBlock(blockID, blockTermTestToken))
	write(blockTermTestOSCStart(blockID))

	// Fill exactly one producer batch first. This ensures the first DB write is
	// blocked while the remaining payload continues through many small writes.
	initialBytes := blockTermRecorderMaxBatchSize
	for offset := 0; offset < initialBytes; {
		end := offset + writeChunkSize
		if end > initialBytes {
			end = initialBytes
		}
		write(payload[offset:end])
		offset = end
	}
	select {
	case <-persistStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("recorder persistence did not start for the first large batch")
	}

	for offset := initialBytes; offset < len(payload); {
		end := offset + writeChunkSize
		if end > len(payload) {
			end = len(payload)
		}
		write(payload[offset:end])
		offset = end
	}

	barrier, err := recorder.BeginFlush()
	require.NoError(t, err)
	require.NotNil(t, barrier)
	select {
	case barrierErr := <-barrier:
		t.Fatalf("BeginFlush returned before delayed persistence was released: %v", barrierErr)
	case <-time.After(50 * time.Millisecond):
	}

	release()
	require.NoError(t, <-barrier)
	recorder.CloseInput()
	require.NoError(t, recorder.Wait())

	var segments []model.BlockTermOutputSegment
	require.NoError(t, db.Where("block_id = ?", blockID).Order("start_cursor ASC").Find(&segments).Error)
	require.NotEmpty(t, segments)
	var reconstructed []byte
	expectedCursor := uint64(len(blockTermTestOSCStart(blockID)))
	for _, segment := range segments {
		require.Equal(t, expectedCursor, segment.StartCursor)
		require.LessOrEqual(t, len(segment.Data), blockTermRecorderMaxBatchSize)
		require.Equal(t, uint64(len(segment.Data)), segment.EndCursor-segment.StartCursor)
		reconstructed = append(reconstructed, segment.Data...)
		expectedCursor = segment.EndCursor
	}
	require.Equal(t, payload, reconstructed)
	require.Equal(t, uint64(len(blockTermTestOSCStart(blockID)))+uint64(len(payload)), expectedCursor)
}

func TestBlockTermOutputRecorderDoesNotWaitForBlockCreation(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-before-block.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	recorder := newBlockTermOutputRecorder(db, "term-before-block")
	require.NotNil(t, recorder)
	t.Cleanup(func() {
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})

	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID:     "block-before-create",
		StartCursor: 20,
		EndCursor:   23,
		Data:        []byte("raw"),
	}))
	var segment model.BlockTermOutputSegment
	require.NoError(t, db.First(&segment, "block_id = ?", "block-before-create").Error)
	require.Equal(t, []byte("raw"), segment.Data)
}

func TestBlockTermOutputRecorderRetainsConfiguredTail(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-retention.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "block-retention", TerminalID: "term-retention", LineNum: 0, TermMaxPTYSize: 6,
	}).Error)

	recorder := newBlockTermOutputRecorder(db, "term-retention")
	require.NotNil(t, recorder)
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-retention", StartCursor: 100, EndCursor: 103, Data: []byte("abc"),
	}))
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-retention", StartCursor: 103, EndCursor: 107, Data: []byte("defg"),
	}))
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-retention", StartCursor: 107, EndCursor: 111, Data: []byte("hijk"),
	}))

	var segments []model.BlockTermOutputSegment
	require.NoError(t, db.Order("start_cursor ASC").Find(&segments).Error)
	require.Len(t, segments, 2)
	require.Equal(t, uint64(105), segments[0].StartCursor)
	require.Equal(t, []byte("fg"), segments[0].Data)
	require.Equal(t, uint64(111), segments[1].EndCursor)
	require.Equal(t, []byte("hijk"), segments[1].Data)

	// Retrying an old range after it has fallen out of the window is stable.
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-retention", StartCursor: 100, EndCursor: 103, Data: []byte("abc"),
	}))
	segments = nil
	require.NoError(t, db.Order("start_cursor ASC").Find(&segments).Error)
	require.Len(t, segments, 2)
	require.Equal(t, uint64(105), segments[0].StartCursor)
	require.Equal(t, []byte("fg"), segments[0].Data)

	recorder.CloseInput()
	require.NoError(t, recorder.Wait())
}

func TestBlockTermOutputRecorderRejectsCrossTerminalAndSkipsDeletedBlocks(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-lifecycle.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
		&model.BlockTermOutputSegment{},
	))
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "block-moved", TerminalID: "term-target", LineNum: 0,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "block-local", TerminalID: "term-source", LineNum: 1,
	}).Error)
	deletedAt := int64(10)
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: "block-deleted", TerminalID: "term-source", Command: "true", BlockDeletedAt: &deletedAt,
	}).Error)

	recorder := newBlockTermOutputRecorder(db, "term-source")
	require.NotNil(t, recorder)
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-moved", StartCursor: 30, EndCursor: 33, Data: []byte("raw"),
	}))
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-local", StartCursor: 31, EndCursor: 36, Data: []byte("local"),
	}))
	require.NoError(t, recorder.persist(blockTermOutputSpan{
		BlockID: "block-deleted", StartCursor: 40, EndCursor: 44, Data: []byte("late"),
	}))

	var movedCount int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("block_id = ?", "block-moved").Count(&movedCount).Error)
	require.Zero(t, movedCount)
	var local model.BlockTermOutputSegment
	require.NoError(t, db.First(&local, "block_id = ?", "block-local").Error)
	require.Equal(t, "term-source", local.TerminalID)
	require.Equal(t, []byte("local"), local.Data)
	var deletedCount int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("block_id = ?", "block-deleted").Count(&deletedCount).Error)
	require.Zero(t, deletedCount)

	recorder.CloseInput()
	require.NoError(t, recorder.Wait())
}

func TestCleanupOrphanOutputSegmentsRetainsCreateRaceAndEnforcesCaps(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-orphan-gc.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "orphan-gc-live-block", TerminalID: "orphan-gc-terminal", LineNum: 0,
	}).Error)
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{
			ID: "orphan-gc-live", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-live-block",
			StartCursor: 0, EndCursor: 4, Data: []byte("live"), CreatedAt: now - 7200,
		},
		{
			ID: "orphan-gc-stale", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-stale-block",
			StartCursor: 0, EndCursor: 5, Data: []byte("stale"), CreatedAt: now - 7200,
		},
		{
			ID: "orphan-gc-fresh", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-fresh-block",
			StartCursor: 0, EndCursor: 5, Data: []byte("fresh"), CreatedAt: now,
		},
	}).Error)

	// A recent orphan remains available for the normal output-before-create race,
	// while an abandoned old row is reclaimed.
	require.NoError(t, cleanupOrphanBlockTermOutputSegmentsTx(
		db, now, time.Hour, 1<<20, 100,
	))
	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "orphan-gc-stale").Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "orphan-gc-fresh").Count(&count).Error)
	require.EqualValues(t, 1, count)
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "orphan-gc-live").Count(&count).Error)
	require.EqualValues(t, 1, count)

	// Even fresh rows cannot make the orphan table unbounded when a producer
	// continually invents block IDs. The newest rows win deterministic ties.
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{ID: "orphan-gc-cap-1", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-cap-1", StartCursor: 0, EndCursor: 3, Data: []byte("111"), CreatedAt: now + 1},
		{ID: "orphan-gc-cap-2", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-cap-2", StartCursor: 0, EndCursor: 3, Data: []byte("222"), CreatedAt: now + 2},
		{ID: "orphan-gc-cap-3", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-cap-3", StartCursor: 0, EndCursor: 3, Data: []byte("333"), CreatedAt: now + 3},
	}).Error)
	require.NoError(t, cleanupOrphanBlockTermOutputSegmentsTx(
		db, now, time.Hour, 5, 2,
	))
	var orphanRows []orphanOutputSegmentMetadata
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Select("id", "LENGTH(data) AS data_size").
		Where("NOT EXISTS (SELECT 1 FROM blockterm_blocks AS blocks WHERE blocks.id = blockterm_output_segments.block_id)").
		Find(&orphanRows).Error)
	var orphanBytes int64
	for _, row := range orphanRows {
		orphanBytes += row.DataSize
	}
	if len(orphanRows) > 2 || orphanBytes > 5 {
		t.Fatalf("orphan caps exceeded: rows=%d bytes=%d", len(orphanRows), orphanBytes)
	}
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "orphan-gc-cap-3").Count(&count).Error)
	require.EqualValues(t, 1, count)
}

func TestCleanupOrphanOutputSegmentsRemovesTombstonedRows(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-orphan-tombstone.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermCommandHistory{}, &model.BlockTermOutputSegment{}))
	deletedAt := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: "orphan-gc-deleted-block", TerminalID: "orphan-gc-terminal", LineNum: 0,
		Command: "echo deleted", CreatedAt: deletedAt - 1, BlockDeletedAt: &deletedAt,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermOutputSegment{
		ID: "orphan-gc-tombstoned", TerminalID: "orphan-gc-terminal", BlockID: "orphan-gc-deleted-block",
		StartCursor: 1, EndCursor: 7, Data: []byte("late!!"), CreatedAt: deletedAt,
	}).Error)

	require.NoError(t, CleanupOrphanBlockTermOutputSegments(db))
	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "orphan-gc-tombstoned").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermOutputRecorderIgnoresCrossTerminalMarkerInjection(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-marker-isolation.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "forged-target-block", TerminalID: "target-terminal", LineNum: 0,
	}).Error)

	recorder := newBlockTermOutputRecorder(db, "source-terminal")
	require.NotNil(t, recorder)
	t.Cleanup(func() {
		recorder.CloseInput()
		require.NoError(t, recorder.Wait())
	})

	// The source PTY can emit a syntactically valid marker for a block owned by
	// another terminal. The recorder must discard the resulting span instead of
	// changing its terminal scope or writing into the target block.
	data := append(append(blockTermTestOSCStart("forged-target-block"), []byte("forged output")...), blockTermTestOSCEnd("forged-target-block")...)
	recorder.Write(data, 0)
	recorder.CloseInput()
	require.NoError(t, recorder.Wait())

	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("block_id = ?", "forged-target-block").Count(&count).Error)
	require.Zero(t, count)
}

func TestBlockTermOutputRecorderHonorsGlobalTombstones(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-tombstone-isolation.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermCommandHistory{}, &model.BlockTermOutputSegment{}))
	deletedAt := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: "shared-deleted-block", TerminalID: "target-terminal", LineNum: 0,
		Command: "echo target", CreatedAt: deletedAt - 1, BlockDeletedAt: &deletedAt,
	}).Error)

	sourceRecorder := newBlockTermOutputRecorder(db, "source-terminal")
	require.NotNil(t, sourceRecorder)
	t.Cleanup(func() {
		sourceRecorder.CloseInput()
		require.NoError(t, sourceRecorder.Wait())
	})
	require.NoError(t, sourceRecorder.persist(blockTermOutputSpan{
		BlockID: "shared-deleted-block", StartCursor: 10, EndCursor: 16, Data: []byte("source"),
	}))

	// Stable block IDs are globally unique. A tombstone belonging to another
	// terminal still reserves this ID, so a late source-recorder retry must be
	// discarded rather than creating a cross-terminal orphan row.
	var sourceCount int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("terminal_id = ? AND block_id = ?", "source-terminal", "shared-deleted-block").Count(&sourceCount).Error)
	require.Zero(t, sourceCount)

	// Cleanup uses the global tombstone reservation as well, including rows
	// written under a moved/current terminal ID.
	require.NoError(t, db.Create(&model.BlockTermOutputSegment{
		ID: "target-late-row", TerminalID: "target-terminal", BlockID: "shared-deleted-block",
		StartCursor: 20, EndCursor: 26, Data: []byte("target"), CreatedAt: deletedAt,
	}).Error)
	require.NoError(t, CleanupOrphanBlockTermOutputSegments(db))
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("terminal_id = ? AND block_id = ?", "target-terminal", "shared-deleted-block").Count(&sourceCount).Error)
	require.Zero(t, sourceCount)
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("terminal_id = ? AND block_id = ?", "source-terminal", "shared-deleted-block").Count(&sourceCount).Error)
	require.Zero(t, sourceCount)
}

func TestCleanupOrphanOutputSegmentsScopesBlockOwnershipByTerminal(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-orphan-isolation.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "shared-live-block", TerminalID: "target-terminal", LineNum: 0,
	}).Error)
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{
			ID: "target-live-row", TerminalID: "target-terminal", BlockID: "shared-live-block",
			StartCursor: 0, EndCursor: 6, Data: []byte("target"), CreatedAt: now - 7200,
		},
		{
			ID: "source-stale-row", TerminalID: "source-terminal", BlockID: "shared-live-block",
			StartCursor: 0, EndCursor: 6, Data: []byte("source"), CreatedAt: now - 7200,
		},
	}).Error)

	require.NoError(t, cleanupOrphanBlockTermOutputSegmentsTx(db, now, time.Hour, 1<<20, 100))
	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "target-live-row").Count(&count).Error)
	require.EqualValues(t, 1, count)
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "source-stale-row").Count(&count).Error)
	require.Zero(t, count)
}

func TestTrimBlockTermOutputSegmentsForTerminalIsolatesSameBlockID(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "raw-trim-isolation.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{
			ID: "target-trim-first", TerminalID: "target-terminal", BlockID: "shared-trim-block",
			StartCursor: 0, EndCursor: 3, Data: []byte("abc"), CreatedAt: 1,
		},
		{
			ID: "target-trim-second", TerminalID: "target-terminal", BlockID: "shared-trim-block",
			StartCursor: 3, EndCursor: 7, Data: []byte("defg"), CreatedAt: 2,
		},
		// This row is intentionally malformed. A correctly scoped trim must not
		// inspect or mutate another terminal's same-ID row.
		{
			ID: "source-trim-foreign", TerminalID: "source-terminal", BlockID: "shared-trim-block",
			StartCursor: 0, EndCursor: 99, Data: []byte("foreign"), CreatedAt: 3,
		},
	}).Error)

	require.NoError(t, TrimBlockTermOutputSegmentsForTerminal(
		db, "shared-trim-block", "target-terminal", 3,
	))

	var target []model.BlockTermOutputSegment
	require.NoError(t, db.Where("terminal_id = ? AND block_id = ?", "target-terminal", "shared-trim-block").
		Order("start_cursor ASC").Find(&target).Error)
	require.Len(t, target, 1)
	require.Equal(t, "target-trim-second", target[0].ID)
	require.Equal(t, uint64(4), target[0].StartCursor)
	require.Equal(t, uint64(7), target[0].EndCursor)
	require.Equal(t, []byte("efg"), target[0].Data)

	var foreign model.BlockTermOutputSegment
	require.NoError(t, db.Where("id = ?", "source-trim-foreign").Take(&foreign).Error)
	require.Equal(t, uint64(0), foreign.StartCursor)
	require.Equal(t, uint64(99), foreign.EndCursor)
	require.Equal(t, []byte("foreign"), foreign.Data)
}
