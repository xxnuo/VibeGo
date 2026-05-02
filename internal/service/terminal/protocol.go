package terminal

const (
	MsgTypeInput         = "input"
	MsgTypeInputRejected = "input_rejected"
	MsgTypeResize        = "resize"
	MsgTypeSignal        = "signal"
	MsgTypeAck           = "ack"
	MsgTypeOutput        = "output"
	MsgTypeReplay        = "replay"
	MsgTypeReplayDone    = "replay_done"
	MsgTypeState         = "state"
	MsgTypePtyExited     = "pty_exited"
)

// RouteMode selects the runtime route requested by a client. An omitted mode
// preserves the pre-route protocol semantics for older clients.
const (
	RouteModeLegacy = "legacy"
	RouteModeBlock  = "block"
)

type InputRejectedReason string

const (
	InputRejectedEmptyInput          InputRejectedReason = "empty_input"
	InputRejectedInvalidEncoding     InputRejectedReason = "invalid_encoding"
	InputRejectedTerminalNotRunning  InputRejectedReason = "terminal_not_running"
	InputRejectedInvalidBlock        InputRejectedReason = "invalid_block"
	InputRejectedRecorderUnavailable InputRejectedReason = "recorder_unavailable"
	InputRejectedRecorderBusy        InputRejectedReason = "recorder_busy"
	InputRejectedRecorderError       InputRejectedReason = "recorder_error"
	InputRejectedRecorderTimeout     InputRejectedReason = "recorder_timeout"
	InputRejectedRuntimeWriteFailed  InputRejectedReason = "runtime_write_failed"
	InputRejectedRuntimeSignalFailed InputRejectedReason = "runtime_signal_failed"
	InputRejectedInvalidSignal       InputRejectedReason = "invalid_signal"
	InputRejectedRouteRequired       InputRejectedReason = "route_required"
	InputRejectedTokenMismatch       InputRejectedReason = "token_mismatch"
	InputRejectedRouteNotFound       InputRejectedReason = "route_not_found"
	InputRejectedInvalidRoute        InputRejectedReason = "invalid_route"
)

// BlockTermCompletion is a command lifecycle correlated from an exact v3
// block ID/token end frame in the live PTY stream. The token separates nearby
// lifecycles; it is not an authentication boundary against code sharing the
// same PTY or user account.
type BlockTermCompletion struct {
	BlockID    string `json:"block_id"`
	BlockToken string `json:"block_token,omitempty"`
	ExitCode   int    `json:"exit_code"`
	Cwd        string `json:"cwd"`
	EndCursor  uint64 `json:"end_cursor"`
}

type WSMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	// RouteMode is optional for wire compatibility. Explicit "block" requires
	// a complete block_id/block_token pair; explicit "legacy" forbids both.
	RouteMode string `json:"route_mode,omitempty"`
	BlockID   string `json:"block_id,omitempty"`
	// BlockToken correlates managed input, signal, state, and timeout rejection
	// messages with one BlockTerm lifecycle on the same PTY.
	BlockToken string `json:"block_token,omitempty"`
	BlockPhase string `json:"block_phase,omitempty"`
	// BlockTail* carries a retained lifecycle that still owns trailing PTY
	// bytes while BlockID/BlockToken describe a newer expected owner.
	BlockTailID      string                `json:"block_tail_id,omitempty"`
	BlockTailToken   string                `json:"block_tail_token,omitempty"`
	BlockTailPhase   string                `json:"block_tail_phase,omitempty"`
	BlockCompletions []BlockTermCompletion `json:"block_completions,omitempty"`
	Reason           InputRejectedReason   `json:"reason,omitempty"`
	Cols             int                   `json:"cols,omitempty"`
	Rows             int                   `json:"rows,omitempty"`
	Signal           string                `json:"signal,omitempty"`
	Cursor           uint64                `json:"cursor,omitempty"`
	Reset            bool                  `json:"reset,omitempty"`
	Status           string                `json:"status,omitempty"`
	// BlockStatus is the durable command-block lifecycle. Independent runtimes
	// can report transport status exited/closed while the durable row maps to
	// success/error/interrupted. A finalization failure leaves this as running.
	BlockStatus         string               `json:"block_status,omitempty"`
	DurableError        string               `json:"durable_error,omitempty"`
	ExitCode            *int                 `json:"exit_code,omitempty"`
	RuntimeType         string               `json:"runtime_type,omitempty"`
	Readonly            bool                 `json:"readonly,omitempty"`
	Capabilities        TerminalCapabilities `json:"capabilities,omitempty"`
	CurrentCwd          string               `json:"current_cwd,omitempty"`
	ShellType           string               `json:"shell_type,omitempty"`
	ShellState          string               `json:"shell_state,omitempty"`
	ShellIntegration    bool                 `json:"shell_integration,omitempty"`
	LastCommand         string               `json:"last_command,omitempty"`
	LastCommandExitCode *int                 `json:"last_command_exit_code,omitempty"`
}

type ResizeMessage struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}
