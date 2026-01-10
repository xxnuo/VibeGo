package terminal

import "errors"

var (
	ErrSlaveClosed           = errors.New("slave closed")
	ErrMasterClosed          = errors.New("master closed")
	ErrTerminalNotFound      = errors.New("terminal not found")
	ErrMaxConnectionsReached = errors.New("max connections reached")
)
