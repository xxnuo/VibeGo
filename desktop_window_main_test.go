//go:build desktop_window

package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestDesktopWindowOptions(t *testing.T) {
	options := desktopWindowOptions("http://127.0.0.1:43210")
	if options.Name != desktopWindowName || options.URL != "http://127.0.0.1:43210" {
		t.Fatalf("unexpected window identity: %#v", options)
	}
	if options.Width != 1440 || options.Height != 900 || options.MinWidth != 900 || options.MinHeight != 600 {
		t.Fatalf("unexpected window size: %#v", options)
	}
	if options.Linux.WebviewGpuPolicy != application.WebviewGpuPolicyNever || len(options.Linux.Icon) == 0 {
		t.Fatalf("unexpected Linux window options: %#v", options.Linux)
	}
}
