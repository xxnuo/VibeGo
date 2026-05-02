package remotedesktop

import (
	"errors"
	"fmt"
	"image"
	"os"
	"runtime"
	"strings"
	"sync"

	"github.com/go-vgo/robotgo"
	"github.com/kbinani/screenshot"
	"golang.design/x/clipboard"
)

type ScreenCaptureProvider struct{}

func NewScreenCaptureProvider() *ScreenCaptureProvider {
	return &ScreenCaptureProvider{}
}

func (p *ScreenCaptureProvider) Displays() ([]Display, error) {
	count := screenshot.NumActiveDisplays()
	if count <= 0 {
		return nil, errors.New("no active displays")
	}
	displays := make([]Display, 0, count)
	for i := 0; i < count; i++ {
		b := screenshot.GetDisplayBounds(i)
		displays = append(displays, Display{
			ID:      i,
			X:       b.Min.X,
			Y:       b.Min.Y,
			Width:   b.Dx(),
			Height:  b.Dy(),
			Scale:   1,
			Primary: i == 0,
		})
	}
	return displays, nil
}

func (p *ScreenCaptureProvider) Capture(displayID int) (image.Image, Display, error) {
	displays, err := p.Displays()
	if err != nil {
		return nil, Display{}, err
	}
	for _, display := range displays {
		if display.ID == displayID {
			img, err := screenshot.CaptureDisplay(displayID)
			return img, display, err
		}
	}
	return nil, Display{}, ErrDisplayNotFound
}

type RobotInputProvider struct{}

func NewRobotInputProvider() *RobotInputProvider {
	return &RobotInputProvider{}
}

func (p *RobotInputProvider) Available() error {
	if runtime.GOOS == "linux" && isWayland() {
		return errors.New("wayland input injection may require compositor support")
	}
	return nil
}

func (p *RobotInputProvider) Move(x, y int) error {
	robotgo.MoveMouse(x, y)
	return nil
}

func (p *RobotInputProvider) Position() (int, int, error) {
	x, y := robotgo.Location()
	return x, y, nil
}

func (p *RobotInputProvider) Button(button string, down bool) error {
	button = normalizeButton(button)
	if down {
		return robotgo.MouseDown(button)
	}
	return robotgo.MouseUp(button)
}

func (p *RobotInputProvider) Click(button string) error {
	return robotgo.Click(normalizeButton(button))
}

func (p *RobotInputProvider) Wheel(x, y int) error {
	if x != 0 {
		robotgo.Scroll(x, 0)
	}
	if y != 0 {
		robotgo.Scroll(0, y)
	}
	return nil
}

func (p *RobotInputProvider) Key(key string, down bool, modifiers []string) error {
	key = normalizeKey(key)
	if key == "" {
		return nil
	}
	mods := normalizeModifiers(modifiers)
	if down {
		return robotgo.KeyDown(key, mods)
	}
	return robotgo.KeyUp(key, mods)
}

func (p *RobotInputProvider) Text(text string) error {
	if text == "" {
		return nil
	}
	robotgo.TypeStr(text)
	return nil
}

type SystemClipboardProvider struct {
	once    sync.Once
	initErr error
}

func NewSystemClipboardProvider() *SystemClipboardProvider {
	return &SystemClipboardProvider{}
}

func (p *SystemClipboardProvider) Available() error {
	p.once.Do(func() {
		p.initErr = clipboard.Init()
	})
	return p.initErr
}

func (p *SystemClipboardProvider) ReadText() (string, error) {
	if err := p.Available(); err != nil {
		return "", err
	}
	return string(clipboard.Read(clipboard.FmtText)), nil
}

func (p *SystemClipboardProvider) WriteText(text string) error {
	if err := p.Available(); err != nil {
		return err
	}
	clipboard.Write(clipboard.FmtText, []byte(text))
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
