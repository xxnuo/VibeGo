//go:build windows

package terminal

import "errors"

func signalLocalProcess(_ int, name string) error {
	if normalized, err := NormalizeTerminalSignal(name); err != nil {
		return err
	} else if normalized == "INT" {
		return nil
	}
	return errors.New("non-interrupt signals are unsupported on Windows terminals")
}
