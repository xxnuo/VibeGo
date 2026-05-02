//go:build desktop

package main

import "testing"

func TestDesktopWindowProcessStartsEmpty(t *testing.T) {
	process := &desktopWindowProcess{}
	process.Close()
}
