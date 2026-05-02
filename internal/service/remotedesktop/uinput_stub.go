//go:build !linux || android

package remotedesktop

import "errors"

type UInputClientProvider struct{}

func NewUInputClientProvider() *UInputClientProvider {
	return &UInputClientProvider{}
}

func (p *UInputClientProvider) Available() error {
	return errors.New("uinput helper is only supported on linux")
}

func (p *UInputClientProvider) Move(x, y int) error { return p.Available() }
func (p *UInputClientProvider) Position() (int, int, error) {
	return 0, 0, p.Available()
}
func (p *UInputClientProvider) Button(button string, down bool) error { return p.Available() }
func (p *UInputClientProvider) Click(button string) error             { return p.Available() }
func (p *UInputClientProvider) Wheel(x, y int) error                  { return p.Available() }
func (p *UInputClientProvider) Key(key string, down bool, modifiers []string) error {
	return p.Available()
}
func (p *UInputClientProvider) Text(text string) error { return p.Available() }
func (p *UInputClientProvider) Release() error         { return p.Available() }

func RunInputHelper() error {
	return errors.New("uinput helper is only supported on linux")
}

func InstallInputHelper() error {
	return errors.New("uinput helper is only supported on linux")
}
