//go:build linux

package terminal

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func observeProcessIdentity(shellPID int) (ProcessIdentity, error) {
	identity := ProcessIdentity{ShellPID: int64(shellPID)}
	if shellPID <= 0 {
		return identity, fmt.Errorf("invalid shell process id")
	}

	data, err := os.ReadFile("/proc/" + strconv.Itoa(shellPID) + "/stat")
	if err != nil {
		return identity, nil
	}
	processGroup, foregroundProcessGroup, err := parseTerminalProcessGroups(data)
	if err != nil {
		return identity, nil
	}
	processGroupID := int64(processGroup)
	identity.ShellProcessGroupID = &processGroupID
	if foregroundProcessGroup > 0 {
		foregroundGroupID := int64(foregroundProcessGroup)
		identity.ForegroundProcessGroupID = &foregroundGroupID
	}

	// An idle terminal reports its own process group as the foreground group.
	// Only expose a child when the foreground group is distinct, and verify that
	// its leader still exists so a procfs race produces null rather than a stale
	// PID.
	if foregroundProcessGroup <= 0 || foregroundProcessGroup == processGroup {
		return identity, nil
	}
	childStat, err := os.ReadFile("/proc/" + strconv.Itoa(foregroundProcessGroup) + "/stat")
	if err != nil {
		return identity, nil
	}
	childProcessGroup, _, err := parseTerminalProcessGroups(childStat)
	if err != nil || childProcessGroup != foregroundProcessGroup {
		return identity, nil
	}
	children, err := os.ReadFile(
		"/proc/" + strconv.Itoa(shellPID) + "/task/" + strconv.Itoa(shellPID) + "/children",
	)
	if err != nil || !containsProcessID(children, foregroundProcessGroup) {
		return identity, nil
	}
	childPID := int64(foregroundProcessGroup)
	identity.ForegroundChildPID = &childPID
	return identity, nil
}

func containsProcessID(data []byte, target int) bool {
	for _, field := range strings.Fields(string(data)) {
		pid, err := strconv.Atoi(field)
		if err == nil && pid == target {
			return true
		}
	}
	return false
}
