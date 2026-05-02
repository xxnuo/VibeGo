package remotedesktop

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

type CompositeInputProvider struct {
	robot InputProvider
}

func NewCompositeInputProvider() *CompositeInputProvider {
	return &CompositeInputProvider{robot: NewRobotInputProvider()}
}

func (p *CompositeInputProvider) selected() InputProvider {
	if runtime.GOOS == "linux" && isWayland() {
		return NewUInputClientProvider()
	}
	return p.robot
}

func (p *CompositeInputProvider) InputStatus() InputStatus {
	if runtime.GOOS == "linux" && isWayland() {
		provider := NewUInputClientProvider()
		err := provider.Available()
		status := InputStatus{
			Backend:       "uinput",
			Backends:      []string{"uinput"},
			SetupRequired: err != nil,
			SetupState:    "ready",
			Err:           err,
		}
		if err != nil {
			status.Backend = "none"
			status.SetupState = "required"
		}
		return status
	}
	err := p.robot.Available()
	status := InputStatus{
		Backend:    "robotgo",
		Backends:   []string{"robotgo"},
		SetupState: "ready",
		Err:        err,
	}
	if err != nil {
		status.Backend = "none"
		status.SetupState = "unavailable"
	}
	return status
}

func (p *CompositeInputProvider) Available() error {
	return p.selected().Available()
}

func (p *CompositeInputProvider) Move(x, y int) error {
	return p.selected().Move(x, y)
}

func (p *CompositeInputProvider) Position() (int, int, error) {
	return p.selected().Position()
}

func (p *CompositeInputProvider) Button(button string, down bool) error {
	return p.selected().Button(button, down)
}

func (p *CompositeInputProvider) Click(button string) error {
	return p.selected().Click(button)
}

func (p *CompositeInputProvider) Wheel(x, y int) error {
	return p.selected().Wheel(x, y)
}

func (p *CompositeInputProvider) Key(key string, down bool, modifiers []string) error {
	return p.selected().Key(key, down, modifiers)
}

func (p *CompositeInputProvider) Text(text string) error {
	return p.selected().Text(text)
}

func (p *CompositeInputProvider) Release() error {
	if release, ok := p.selected().(InputReleaseProvider); ok {
		return release.Release()
	}
	for _, key := range []string{"shift", "ctrl", "alt", "cmd"} {
		_ = p.Key(key, false, nil)
	}
	for _, button := range []string{"left", "middle", "right"} {
		_ = p.Button(button, false)
	}
	return nil
}

func RuntimeStatus(capture CaptureProvider, input InputProvider, clip ClipboardProvider) Status {
	sessionType := currentSessionType()
	status := Status{
		OS:             runtime.GOOS,
		Platform:       runtime.GOOS,
		SessionType:    sessionType,
		DefaultFPS:     DefaultFPS,
		DefaultQuality: DefaultQuality,
		MinFPS:         MinFPS,
		MaxFPS:         MaxFPS,
		MinQuality:     MinQuality,
		MaxQuality:     MaxQuality,
		Wayland:        runtime.GOOS == "linux" && isWayland(),
	}
	if _, err := capture.Displays(); err != nil {
		status.Warnings = append(status.Warnings, fmt.Sprintf("screen capture unavailable: %s", err.Error()))
	} else {
		status.CaptureAvailable = true
		status.Capabilities.Capture = true
	}
	if err := input.Available(); err != nil {
		status.Warnings = append(status.Warnings, fmt.Sprintf("input unavailable: %s", err.Error()))
	} else {
		status.InputAvailable = true
		status.Capabilities.Input = true
	}
	if inputStatus, ok := input.(InputStatusProvider); ok {
		next := inputStatus.InputStatus()
		status.InputBackend = next.Backend
		status.InputBackends = next.Backends
		status.InputSetupRequired = next.SetupRequired
		status.InputSetupState = next.SetupState
		if next.Err != nil {
			status.InputError = next.Err.Error()
		}
	} else if status.InputAvailable {
		status.InputBackend = "custom"
		status.InputBackends = []string{"custom"}
		status.InputSetupState = "ready"
	} else {
		status.InputBackend = "none"
		status.InputSetupState = "unavailable"
	}
	if err := clip.Available(); err != nil {
		status.Warnings = append(status.Warnings, fmt.Sprintf("clipboard unavailable: %s", err.Error()))
	} else {
		status.ClipboardAvailable = true
		status.Capabilities.Clipboard = true
		status.Capabilities.ClipboardSync = true
	}
	status.Capabilities.DisplayWatch = true
	status.Capabilities.QoS = true
	appendPlatformWarnings(&status)
	status.Available = status.CaptureAvailable
	return status
}

func isWayland() bool {
	return strings.EqualFold(os.Getenv("XDG_SESSION_TYPE"), "wayland") || os.Getenv("WAYLAND_DISPLAY") != ""
}

func currentSessionType() string {
	if runtime.GOOS == "linux" {
		if session := strings.TrimSpace(os.Getenv("XDG_SESSION_TYPE")); session != "" {
			return strings.ToLower(session)
		}
		if isWayland() {
			return "wayland"
		}
		if os.Getenv("DISPLAY") != "" {
			return "x11"
		}
	}
	return runtime.GOOS
}

func appendPlatformWarnings(status *Status) {
	switch runtime.GOOS {
	case "linux":
		if status.Wayland {
			status.Warnings = append(status.Warnings, "wayland may restrict screen capture, input injection, and clipboard access")
		}
	case "darwin":
		if !status.CaptureAvailable || !status.InputAvailable {
			status.Warnings = append(status.Warnings, "macOS may require Screen Recording and Accessibility permissions")
		}
	case "windows":
		if !status.CaptureAvailable || !status.InputAvailable {
			status.Warnings = append(status.Warnings, "Windows capture or input may be blocked by system permissions or elevated windows")
		}
	}
}

func normalizeButton(button string) string {
	switch strings.ToLower(button) {
	case "middle", "center":
		return "center"
	case "right":
		return "right"
	default:
		return "left"
	}
}

func normalizeModifiers(modifiers []string) []interface{} {
	out := make([]interface{}, 0, len(modifiers))
	for _, mod := range modifiers {
		switch strings.ToLower(mod) {
		case "alt", "ctrl", "control", "shift", "cmd", "command", "super", "meta":
			if mod == "control" {
				mod = "ctrl"
			}
			if mod == "command" || mod == "super" || mod == "meta" {
				mod = "cmd"
			}
			out = append(out, strings.ToLower(mod))
		}
	}
	return out
}

func normalizeKey(key string) string {
	k := strings.TrimSpace(strings.ToLower(key))
	if len(k) == 1 {
		return k
	}
	switch k {
	case " ":
		return "space"
	case "escape", "esc":
		return "esc"
	case "arrowup":
		return "up"
	case "arrowdown":
		return "down"
	case "arrowleft":
		return "left"
	case "arrowright":
		return "right"
	case "enter", "return", "tab", "backspace", "delete", "home", "end", "pageup", "pagedown", "space":
		return k
	case "control":
		return "ctrl"
	case "meta", "super", "command":
		return "cmd"
	default:
		if strings.HasPrefix(k, "f") && len(k) <= 3 {
			return k
		}
		return ""
	}
}
