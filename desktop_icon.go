//go:build (desktop || desktop_window) && !windows

package main

import _ "embed"

//go:embed assets/logo.png
var desktopIcon []byte
