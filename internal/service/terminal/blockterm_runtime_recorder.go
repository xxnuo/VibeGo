package terminal

// WriteRawBlock appends an already-correlated PTY byte span to the recorder.
// Independent block runtimes do not emit the parent shell's OSC 633 framing,
// so they bypass the parser while retaining the recorder's bounded queue,
// coalescing, retry, conflict detection and scoped trimming behavior.
func (r *blockTermOutputRecorder) WriteRawBlock(blockID string, data []byte, startCursor uint64) {
	if r == nil || blockID == "" || !validBlockTermBlockID(blockID) || len(data) == 0 {
		return
	}
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	if r.closed || r.currentError() != nil {
		return
	}
	_ = r.acceptSpanLocked(blockTermOutputSpan{
		BlockID:     blockID,
		StartCursor: startCursor,
		EndCursor:   startCursor + uint64(len(data)),
		Data:        append([]byte(nil), data...),
	})
}
