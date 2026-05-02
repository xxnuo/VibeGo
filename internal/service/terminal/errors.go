package terminal

import "errors"

var (
	ErrSlaveClosed              = errors.New("slave closed")
	ErrMasterClosed             = errors.New("master closed")
	ErrTerminalNotFound         = errors.New("terminal not found")
	ErrInvalidTerminalSettings  = errors.New("invalid terminal settings")
	ErrInvalidWorkspaceState    = errors.New("invalid workspace state")
	ErrTerminalScopeMismatch    = errors.New("terminal scope mismatch")
	ErrInvalidTerminalParent    = errors.New("invalid terminal parent")
	ErrWorkspaceNotFound        = errors.New("workspace session not found")
	ErrMaxConnectionsReached    = errors.New("max connections reached")
	ErrOutboundQueueFull        = errors.New("terminal outbound queue is full")
	ErrUnsupportedRuntime       = errors.New("unsupported terminal runtime")
	ErrRuntimeFactoryMissing    = errors.New("terminal runtime factory is not configured")
	ErrCompletionUnsupported    = errors.New("terminal runtime does not support completion")
	ErrTerminalResetBusy        = errors.New("terminal reset is busy")
	ErrTerminalResetUnsupported = errors.New("terminal runtime cannot be reset")
)
