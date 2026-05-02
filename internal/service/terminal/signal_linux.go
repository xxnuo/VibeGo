//go:build linux

package terminal

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func terminalForegroundProcessGroup(pid int) (int, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, fmt.Errorf("%w: %v", errTerminalForegroundProcessUnavailable, err)
	}
	processGroup, foregroundProcessGroup, err := parseTerminalProcessGroups(data)
	if err != nil {
		return 0, err
	}
	if foregroundProcessGroup <= 0 || foregroundProcessGroup == processGroup {
		return 0, errTerminalForegroundProcessUnavailable
	}
	return foregroundProcessGroup, nil
}

func parseTerminalProcessGroups(data []byte) (int, int, error) {
	closingParen := strings.LastIndexByte(string(data), ')')
	if closingParen < 0 {
		return 0, 0, fmt.Errorf("%w: malformed process stat", errTerminalForegroundProcessUnavailable)
	}
	fields := strings.Fields(string(data[closingParen+1:]))
	if len(fields) <= 5 {
		return 0, 0, fmt.Errorf("%w: incomplete process stat", errTerminalForegroundProcessUnavailable)
	}
	processGroup, err := strconv.Atoi(fields[2])
	if err != nil || processGroup <= 0 {
		return 0, 0, fmt.Errorf("%w: invalid process group", errTerminalForegroundProcessUnavailable)
	}
	foregroundProcessGroup, err := strconv.Atoi(fields[5])
	if err != nil {
		return 0, 0, fmt.Errorf("%w: invalid foreground process group", errTerminalForegroundProcessUnavailable)
	}
	return processGroup, foregroundProcessGroup, nil
}
