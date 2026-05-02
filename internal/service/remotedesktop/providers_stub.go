//go:build android || (!linux && !darwin && !windows)

package remotedesktop

import (
	"errors"
	"image"
)

var errRemoteDesktopUnsupported = errors.New("remote desktop is not supported on this platform")

type ScreenCaptureProvider struct{}

func NewScreenCaptureProvider() *ScreenCaptureProvider {
	return &ScreenCaptureProvider{}
}

func (p *ScreenCaptureProvider) Displays() ([]Display, error) {
	return nil, errRemoteDesktopUnsupported
}

func (p *ScreenCaptureProvider) Capture(displayID int) (image.Image, Display, error) {
	return nil, Display{}, errRemoteDesktopUnsupported
}

type RobotInputProvider struct{}

func NewRobotInputProvider() *RobotInputProvider {
	return &RobotInputProvider{}
}

func (p *RobotInputProvider) Available() error {
	return errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Move(x, y int) error {
	return errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Position() (int, int, error) {
	return 0, 0, errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Button(button string, down bool) error {
	return errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Click(button string) error {
	return errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Wheel(x, y int) error {
	return errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Key(key string, down bool, modifiers []string) error {
	return errRemoteDesktopUnsupported
}

func (p *RobotInputProvider) Text(text string) error {
	return errRemoteDesktopUnsupported
}

type SystemClipboardProvider struct{}

func NewSystemClipboardProvider() *SystemClipboardProvider {
	return &SystemClipboardProvider{}
}

func (p *SystemClipboardProvider) Available() error {
	return errRemoteDesktopUnsupported
}

func (p *SystemClipboardProvider) ReadText() (string, error) {
	return "", errRemoteDesktopUnsupported
}

func (p *SystemClipboardProvider) WriteText(text string) error {
	return errRemoteDesktopUnsupported
}
