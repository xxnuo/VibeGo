package terminal

import "errors"

// ProcessIdentity describes the processes currently associated with a local
// terminal runtime. ForegroundChildPID is the leader of the terminal's
// foreground process group; for a pipeline it is not necessarily the last
// process in the pipeline.
//
// The pointer fields are nil when the operating system cannot observe the
// corresponding value, or when the shell is idle (in the foreground-child
// case). A caller must not treat a nil foreground child as the shell PID.
type ProcessIdentity struct {
	ShellPID                 int64  `json:"shell_pid"`
	ShellProcessGroupID      *int64 `json:"shell_process_group_id"`
	ForegroundProcessGroupID *int64 `json:"foreground_process_group_id"`
	ForegroundChildPID       *int64 `json:"foreground_child_pid"`
}

// ProcessIdentityProvider is implemented by runtimes that can report the
// process identity of their live local session. It is deliberately optional so
// SSH runtimes and test doubles do not have to claim a PID they cannot verify.
type ProcessIdentityProvider interface {
	ProcessIdentity() (ProcessIdentity, error)
}

var ErrProcessIdentityUnsupported = errors.New("terminal runtime does not expose process identity")
