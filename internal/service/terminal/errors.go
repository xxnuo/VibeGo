package terminal

import "errors"

var (
	ErrSlaveClosed                 = errors.New("slave closed")
	ErrMasterClosed                = errors.New("master closed")
	ErrTerminalNotFound            = errors.New("terminal not found")
	ErrInvalidTerminalSettings     = errors.New("invalid terminal settings")
	ErrInvalidWorkspaceState       = errors.New("invalid workspace state")
	ErrTerminalScopeMismatch       = errors.New("terminal scope mismatch")
	ErrInvalidTerminalParent       = errors.New("invalid terminal parent")
	ErrWorkspaceNotFound           = errors.New("workspace session not found")
	ErrMaxConnectionsReached       = errors.New("max connections reached")
	ErrOutboundQueueFull           = errors.New("terminal outbound queue is full")
	ErrUnsupportedRuntime          = errors.New("unsupported terminal runtime")
	ErrRuntimeFactoryMissing       = errors.New("terminal runtime factory is not configured")
	ErrCompletionUnsupported       = errors.New("terminal runtime does not support completion")
	ErrTerminalResetBusy           = errors.New("terminal reset is busy")
	ErrTerminalResetUnsupported    = errors.New("terminal runtime cannot be reset")
	ErrBlockTermRestartInvalid     = errors.New("invalid BlockTerm restart request")
	ErrBlockTermRestartBusy        = errors.New("BlockTerm restart is busy")
	ErrBlockTermRestartUnsupported = errors.New("BlockTerm block cannot be restarted")
	ErrBlockTermRestartUnavailable = errors.New("BlockTerm restart recorder is unavailable")
	// Independent BlockTerm line runtimes have their own lifecycle. These
	// errors deliberately do not reuse terminal/session errors so callers can
	// distinguish a missing block route from a closed parent session.
	ErrBlockRuntimeInvalid       = errors.New("invalid BlockTerm runtime")
	ErrBlockRuntimeNotFound      = errors.New("BlockTerm runtime not found")
	ErrBlockRuntimeAlreadyExists = errors.New("BlockTerm runtime already exists")
	ErrBlockRuntimeNotRunning    = errors.New("BlockTerm runtime is not running")
	ErrBlockRuntimeRouteMismatch = errors.New("BlockTerm runtime route mismatch")
	// ErrBlockTermRecorderUnavailable keeps the service-level name used by
	// callers that distinguish recorder availability from other restart errors.
	ErrBlockTermRecorderUnavailable = ErrBlockTermRestartUnavailable
)

// Compatibility aliases for callers that use the shorter BlockRuntime name.
var (
	ErrBlockTermRuntimeInvalid       = ErrBlockRuntimeInvalid
	ErrBlockTermRuntimeNotFound      = ErrBlockRuntimeNotFound
	ErrBlockTermRuntimeAlreadyExists = ErrBlockRuntimeAlreadyExists
	ErrBlockTermRuntimeNotRunning    = ErrBlockRuntimeNotRunning
)
