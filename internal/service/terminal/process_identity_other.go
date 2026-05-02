//go:build !linux

package terminal

import "fmt"

// Other platforms can still report the PID directly created by ptyx. Process
// group and foreground-child observations are intentionally left nil because
// their procfs/TTY layouts differ and this slice does not change signal
// behavior on those platforms.
func observeProcessIdentity(shellPID int) (ProcessIdentity, error) {
	if shellPID <= 0 {
		return ProcessIdentity{}, fmt.Errorf("invalid shell process id")
	}
	return ProcessIdentity{ShellPID: int64(shellPID)}, nil
}
