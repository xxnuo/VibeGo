//go:build !linux && !windows

package terminal

func terminalForegroundProcessGroup(_ int) (int, error) {
	return 0, errTerminalForegroundProcessUnavailable
}
