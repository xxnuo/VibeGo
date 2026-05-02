//go:build (linux && !android) || darwin || windows

package remotedesktop

import (
	"errors"
	"image"
	"runtime"
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
