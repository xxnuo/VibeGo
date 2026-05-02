//go:build linux

package remotedesktop

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	uinputSocketPath = "/run/vibego-input-helper.sock"
	uinputAbsMax     = 32767
	uiDevCreate      = 0x5501
	uiDevDestroy     = 0x5502
	uiDevSetup       = 0x405c5503
	uiSetEvBit       = 0x40045564
	uiSetKeyBit      = 0x40045565
	uiSetRelBit      = 0x40045566
	uiSetAbsBit      = 0x40045567
	evSyn            = 0x00
	evKey            = 0x01
	evRel            = 0x02
	evAbs            = 0x03
	synReport        = 0
	relWheel         = 0x08
	relHWheel        = 0x06
	absX             = 0x00
	absY             = 0x01
	keyEsc           = 1
	key1             = 2
	key2             = 3
	key3             = 4
	key4             = 5
	key5             = 6
	key6             = 7
	key7             = 8
	key8             = 9
	key9             = 10
	key0             = 11
	keyMinus         = 12
	keyEqual         = 13
	keyBackspace     = 14
	keyTab           = 15
	keyQ             = 16
	keyW             = 17
	keyE             = 18
	keyR             = 19
	keyT             = 20
	keyY             = 21
	keyU             = 22
	keyI             = 23
	keyO             = 24
	keyP             = 25
	keyLeftBrace     = 26
	keyRightBrace    = 27
	keyEnter         = 28
	keyLeftCtrl      = 29
	keyA             = 30
	keyS             = 31
	keyD             = 32
	keyF             = 33
	keyG             = 34
	keyH             = 35
	keyJ             = 36
	keyK             = 37
	keyL             = 38
	keySemicolon     = 39
	keyApostrophe    = 40
	keyGrave         = 41
	keyLeftShift     = 42
	keyBackslash     = 43
	keyZ             = 44
	keyX             = 45
	keyC             = 46
	keyV             = 47
	keyB             = 48
	keyN             = 49
	keyM             = 50
	keyComma         = 51
	keyDot           = 52
	keySlash         = 53
	keyRightShift    = 54
	keyLeftAlt       = 56
	keySpace         = 57
	keyF1            = 59
	keyF2            = 60
	keyF3            = 61
	keyF4            = 62
	keyF5            = 63
	keyF6            = 64
	keyF7            = 65
	keyF8            = 66
	keyF9            = 67
	keyF10           = 68
	keyHome          = 102
	keyUp            = 103
	keyPageUp        = 104
	keyLeft          = 105
	keyRight         = 106
	keyEnd           = 107
	keyDown          = 108
	keyPageDown      = 109
	keyDelete        = 111
	keyRightAlt      = 100
	keyRightCtrl     = 97
	keyLeftMeta      = 125
	keyRightMeta     = 126
	keyF11           = 87
	keyF12           = 88
	keyMicMute       = 248
	btnLeft          = 0x110
	btnRight         = 0x111
	btnMiddle        = 0x112
)

type UInputClientProvider struct {
	mu sync.Mutex
	x  int
	y  int
}

func NewUInputClientProvider() *UInputClientProvider {
	return &UInputClientProvider{}
}

func (p *UInputClientProvider) Available() error {
	return sendUInputCommand(uinputCommand{Type: "ping"})
}

func (p *UInputClientProvider) Move(x, y int) error {
	p.mu.Lock()
	p.x = x
	p.y = y
	p.mu.Unlock()
	return sendUInputCommand(uinputCommand{Type: "move", X: x, Y: y})
}

func (p *UInputClientProvider) Position() (int, int, error) {
	p.mu.Lock()
	x, y := p.x, p.y
	p.mu.Unlock()
	return x, y, nil
}

func (p *UInputClientProvider) Button(button string, down bool) error {
	return sendUInputCommand(uinputCommand{Type: "button", Button: normalizeButton(button), Down: down})
}

func (p *UInputClientProvider) Click(button string) error {
	button = normalizeButton(button)
	if err := p.Button(button, true); err != nil {
		return err
	}
	return p.Button(button, false)
}

func (p *UInputClientProvider) Wheel(x, y int) error {
	return sendUInputCommand(uinputCommand{Type: "wheel", DX: x, DY: y})
}

func (p *UInputClientProvider) Key(key string, down bool, modifiers []string) error {
	return sendUInputCommand(uinputCommand{Type: "key", Key: key, Down: down, Modifiers: normalizeModifierStrings(modifiers)})
}

func (p *UInputClientProvider) Text(text string) error {
	if text == "" {
		return nil
	}
	return sendUInputCommand(uinputCommand{Type: "text", Text: text})
}

func (p *UInputClientProvider) Release() error {
	return sendUInputCommand(uinputCommand{Type: "release"})
}

type uinputCommand struct {
	Type      string   `json:"type"`
	X         int      `json:"x,omitempty"`
	Y         int      `json:"y,omitempty"`
	DX        int      `json:"dx,omitempty"`
	DY        int      `json:"dy,omitempty"`
	Button    string   `json:"button,omitempty"`
	Down      bool     `json:"down,omitempty"`
	Key       string   `json:"key,omitempty"`
	Modifiers []string `json:"modifiers,omitempty"`
	Text      string   `json:"text,omitempty"`
}

type uinputResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type inputEventRaw struct {
	Time  syscall.Timeval
	Type  uint16
	Code  uint16
	Value int32
}

type uinputIDRaw struct {
	Bustype uint16
	Vendor  uint16
	Product uint16
	Version uint16
}

type uinputSetupRaw struct {
	ID      uinputIDRaw
	Name    [80]byte
	FFMax   uint32
	Absmax  [64]int32
	Absmin  [64]int32
	Absfuzz [64]int32
	Absflat [64]int32
}

func sendUInputCommand(cmd uinputCommand) error {
	conn, err := net.Dial("unix", uinputSocketPath)
	if err != nil {
		return fmt.Errorf("uinput helper unavailable: %w", err)
	}
	defer conn.Close()
	if err := json.NewEncoder(conn).Encode(cmd); err != nil {
		return err
	}
	var resp uinputResponse
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return err
	}
	if !resp.OK {
		if resp.Error == "" {
			resp.Error = "uinput helper command failed"
		}
		return errors.New(resp.Error)
	}
	return nil
}

func InstallInputHelper() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	args := []string{exe, "service", "install-input-helper"}
	if err := runPrivilegeCommand("pkexec", args...); err == nil {
		return nil
	}
	return runPrivilegeCommand("sudo", append([]string{"-A"}, args...)...)
}

func runPrivilegeCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("%s failed: %s", name, msg)
	}
	return nil
}

func RunInputHelper() error {
	server, err := newUInputServer()
	if err != nil {
		return err
	}
	defer server.Close()
	_ = os.Remove(uinputSocketPath)
	listener, err := net.Listen("unix", uinputSocketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(uinputSocketPath, 0666); err != nil {
		return err
	}
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go server.handle(conn)
	}
}

type uinputServer struct {
	keyboard int
	mouse    int
	mu       sync.Mutex
}

func newUInputServer() (*uinputServer, error) {
	keyboard, err := createKeyboardDevice()
	if err != nil {
		return nil, err
	}
	mouse, err := createMouseDevice()
	if err != nil {
		_ = unix.Close(keyboard)
		return nil, err
	}
	return &uinputServer{keyboard: keyboard, mouse: mouse}, nil
}

func (s *uinputServer) Close() {
	_ = ioctlSetInt(s.keyboard, uiDevDestroy, 0)
	_ = ioctlSetInt(s.mouse, uiDevDestroy, 0)
	_ = unix.Close(s.keyboard)
	_ = unix.Close(s.mouse)
}

func (s *uinputServer) handle(conn net.Conn) {
	defer conn.Close()
	if !validPeer(conn) {
		_ = json.NewEncoder(conn).Encode(uinputResponse{OK: false, Error: "invalid uinput helper peer"})
		return
	}
	var cmd uinputCommand
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&cmd); err != nil {
		_ = json.NewEncoder(conn).Encode(uinputResponse{OK: false, Error: err.Error()})
		return
	}
	s.mu.Lock()
	err := s.exec(cmd)
	s.mu.Unlock()
	if err != nil {
		_ = json.NewEncoder(conn).Encode(uinputResponse{OK: false, Error: err.Error()})
		return
	}
	_ = json.NewEncoder(conn).Encode(uinputResponse{OK: true})
}

func validPeer(conn net.Conn) bool {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return false
	}
	valid := false
	_ = raw.Control(func(fd uintptr) {
		cred, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		valid = err == nil && cred.Uid != ^uint32(0)
	})
	return valid
}

func (s *uinputServer) exec(cmd uinputCommand) error {
	switch cmd.Type {
	case "ping":
		return nil
	case "move":
		x := clampInt(cmd.X, 0, uinputAbsMax)
		y := clampInt(cmd.Y, 0, uinputAbsMax)
		return emitSyn(s.mouse,
			inputEvent(evAbs, absX, int32(x)),
			inputEvent(evAbs, absY, int32(y)),
		)
	case "button":
		code := mouseButtonCode(cmd.Button)
		return emitSyn(s.mouse, inputEvent(evKey, code, boolValue(cmd.Down)))
	case "wheel":
		events := make([]inputEventRaw, 0, 2)
		if cmd.DX != 0 {
			events = append(events, inputEvent(evRel, relHWheel, int32(cmd.DX)))
		}
		if cmd.DY != 0 {
			events = append(events, inputEvent(evRel, relWheel, int32(-cmd.DY)))
		}
		return emitSyn(s.mouse, events...)
	case "key":
		return s.emitKey(cmd.Key, cmd.Down, cmd.Modifiers)
	case "text":
		for _, r := range cmd.Text {
			if err := s.emitRune(r); err != nil {
				return err
			}
		}
		return nil
	case "release":
		return s.releaseAll()
	default:
		return fmt.Errorf("unsupported uinput command %q", cmd.Type)
	}
}

func (s *uinputServer) emitKey(key string, down bool, modifiers []string) error {
	for _, mod := range modifiers {
		code, ok := keyCode(mod)
		if ok {
			if err := emitSyn(s.keyboard, inputEvent(evKey, code, boolValue(down))); err != nil {
				return err
			}
		}
	}
	code, ok := keyCode(key)
	if !ok {
		return nil
	}
	return emitSyn(s.keyboard, inputEvent(evKey, code, boolValue(down)))
}

func (s *uinputServer) emitRune(r rune) error {
	code, shifted, ok := runeKeyCode(r)
	if !ok {
		return fmt.Errorf("unsupported text character %q", r)
	}
	events := make([]inputEventRaw, 0, 4)
	if shifted {
		events = append(events, inputEvent(evKey, keyLeftShift, 1))
	}
	events = append(events, inputEvent(evKey, code, 1), inputEvent(evKey, code, 0))
	if shifted {
		events = append(events, inputEvent(evKey, keyLeftShift, 0))
	}
	return emitSyn(s.keyboard, events...)
}

func (s *uinputServer) releaseAll() error {
	events := []inputEventRaw{
		inputEvent(evKey, keyLeftShift, 0),
		inputEvent(evKey, keyRightShift, 0),
		inputEvent(evKey, keyLeftCtrl, 0),
		inputEvent(evKey, keyRightCtrl, 0),
		inputEvent(evKey, keyLeftAlt, 0),
		inputEvent(evKey, keyRightAlt, 0),
		inputEvent(evKey, keyLeftMeta, 0),
		inputEvent(evKey, keyRightMeta, 0),
		inputEvent(evKey, btnLeft, 0),
		inputEvent(evKey, btnMiddle, 0),
		inputEvent(evKey, btnRight, 0),
	}
	if err := emitSyn(s.keyboard, events[:8]...); err != nil {
		return err
	}
	return emitSyn(s.mouse, events[8:]...)
}

func createKeyboardDevice() (int, error) {
	fd, err := unix.Open("/dev/uinput", unix.O_WRONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return -1, err
	}
	if err := enable(fd, evKey); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	for code := keyEsc; code <= keyMicMute; code++ {
		_ = ioctlSetInt(fd, uiSetKeyBit, code)
	}
	return createDevice(fd, "VibeGo UInput Keyboard", 0x03, 0x01)
}

func createMouseDevice() (int, error) {
	fd, err := unix.Open("/dev/uinput", unix.O_WRONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return -1, err
	}
	for _, ev := range []int{evKey, evRel, evAbs} {
		if err := enable(fd, ev); err != nil {
			_ = unix.Close(fd)
			return -1, err
		}
	}
	for _, code := range []int{btnLeft, btnRight, btnMiddle} {
		_ = ioctlSetInt(fd, uiSetKeyBit, code)
	}
	for _, code := range []int{relWheel, relHWheel} {
		_ = ioctlSetInt(fd, uiSetRelBit, code)
	}
	for _, code := range []int{absX, absY} {
		_ = ioctlSetInt(fd, uiSetAbsBit, code)
	}
	return createDevice(fd, "VibeGo UInput Mouse", 0x03, 0x02)
}

func enable(fd int, ev int) error {
	return ioctlSetInt(fd, uiSetEvBit, ev)
}

func createDevice(fd int, name string, bustype uint16, product uint16) (int, error) {
	var setup uinputSetupRaw
	copy(setup.Name[:], name)
	setup.ID.Bustype = bustype
	setup.ID.Vendor = 0x7667
	setup.ID.Product = product
	setup.ID.Version = 1
	setup.Absmin[absX] = 0
	setup.Absmax[absX] = uinputAbsMax
	setup.Absmin[absY] = 0
	setup.Absmax[absY] = uinputAbsMax
	if err := ioctlUinputSetup(fd, &setup); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	if err := ioctlSetInt(fd, uiDevCreate, 0); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	return fd, nil
}

func ioctlUinputSetup(fd int, setup *uinputSetupRaw) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(uiDevSetup), uintptr(unsafe.Pointer(setup)))
	if errno != 0 {
		return errno
	}
	return nil
}

func ioctlSetInt(fd int, req int, value int) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(req), uintptr(value))
	if errno != 0 {
		return errno
	}
	return nil
}

func emitSyn(fd int, events ...inputEventRaw) error {
	events = append(events, inputEvent(evSyn, synReport, 0))
	for _, event := range events {
		if err := writeEvent(fd, event); err != nil {
			return err
		}
	}
	return nil
}

func writeEvent(fd int, event inputEventRaw) error {
	buf := unsafe.Slice((*byte)(unsafe.Pointer(&event)), unsafe.Sizeof(event))
	_, err := unix.Write(fd, buf)
	return err
}

func inputEvent(typ int, code int, value int32) inputEventRaw {
	return inputEventRaw{Type: uint16(typ), Code: uint16(code), Value: value}
}

func boolValue(v bool) int32 {
	if v {
		return 1
	}
	return 0
}

func mouseButtonCode(button string) int {
	switch normalizeButton(button) {
	case "right":
		return btnRight
	case "center":
		return btnMiddle
	default:
		return btnLeft
	}
}

func normalizeModifierStrings(modifiers []string) []string {
	out := make([]string, 0, len(modifiers))
	for _, mod := range modifiers {
		switch strings.ToLower(mod) {
		case "control":
			out = append(out, "ctrl")
		case "command", "super", "meta":
			out = append(out, "cmd")
		case "alt", "ctrl", "shift", "cmd":
			out = append(out, strings.ToLower(mod))
		}
	}
	return out
}

func keyCode(key string) (int, bool) {
	k := normalizeKey(key)
	if len(k) == 1 {
		code, _, ok := runeKeyCode([]rune(k)[0])
		return code, ok
	}
	switch k {
	case "esc":
		return keyEsc, true
	case "backspace":
		return keyBackspace, true
	case "tab":
		return keyTab, true
	case "enter", "return":
		return keyEnter, true
	case "space":
		return keySpace, true
	case "delete":
		return keyDelete, true
	case "home":
		return keyHome, true
	case "end":
		return keyEnd, true
	case "pageup":
		return keyPageUp, true
	case "pagedown":
		return keyPageDown, true
	case "up":
		return keyUp, true
	case "down":
		return keyDown, true
	case "left":
		return keyLeft, true
	case "right":
		return keyRight, true
	case "shift":
		return keyLeftShift, true
	case "ctrl":
		return keyLeftCtrl, true
	case "alt":
		return keyLeftAlt, true
	case "cmd":
		return keyLeftMeta, true
	}
	if strings.HasPrefix(k, "f") {
		switch k {
		case "f1":
			return keyF1, true
		case "f2":
			return keyF2, true
		case "f3":
			return keyF3, true
		case "f4":
			return keyF4, true
		case "f5":
			return keyF5, true
		case "f6":
			return keyF6, true
		case "f7":
			return keyF7, true
		case "f8":
			return keyF8, true
		case "f9":
			return keyF9, true
		case "f10":
			return keyF10, true
		case "f11":
			return keyF11, true
		case "f12":
			return keyF12, true
		}
	}
	return 0, false
}

func runeKeyCode(r rune) (int, bool, bool) {
	if r >= 'a' && r <= 'z' {
		code, ok := letterKeyCode(r)
		return code, false, ok
	}
	if r >= 'A' && r <= 'Z' {
		code, ok := letterKeyCode(r + ('a' - 'A'))
		return code, true, ok
	}
	if r >= '1' && r <= '9' {
		return int(key1 + r - '1'), false, true
	}
	if r == '0' {
		return key0, false, true
	}
	switch r {
	case ' ':
		return keySpace, false, true
	case '\n', '\r':
		return keyEnter, false, true
	case '`':
		return keyGrave, false, true
	case '~':
		return keyGrave, true, true
	case '-':
		return keyMinus, false, true
	case '_':
		return keyMinus, true, true
	case '=':
		return keyEqual, false, true
	case '+':
		return keyEqual, true, true
	case '[':
		return keyLeftBrace, false, true
	case '{':
		return keyLeftBrace, true, true
	case ']':
		return keyRightBrace, false, true
	case '}':
		return keyRightBrace, true, true
	case '\\':
		return keyBackslash, false, true
	case '|':
		return keyBackslash, true, true
	case ';':
		return keySemicolon, false, true
	case ':':
		return keySemicolon, true, true
	case '\'':
		return keyApostrophe, false, true
	case '"':
		return keyApostrophe, true, true
	case ',':
		return keyComma, false, true
	case '<':
		return keyComma, true, true
	case '.':
		return keyDot, false, true
	case '>':
		return keyDot, true, true
	case '/':
		return keySlash, false, true
	case '?':
		return keySlash, true, true
	case '!':
		return key1, true, true
	case '@':
		return key2, true, true
	case '#':
		return key3, true, true
	case '$':
		return key4, true, true
	case '%':
		return key5, true, true
	case '^':
		return key6, true, true
	case '&':
		return key7, true, true
	case '*':
		return key8, true, true
	case '(':
		return key9, true, true
	case ')':
		return key0, true, true
	}
	return 0, false, false
}

func letterKeyCode(r rune) (int, bool) {
	switch r {
	case 'a':
		return keyA, true
	case 'b':
		return keyB, true
	case 'c':
		return keyC, true
	case 'd':
		return keyD, true
	case 'e':
		return keyE, true
	case 'f':
		return keyF, true
	case 'g':
		return keyG, true
	case 'h':
		return keyH, true
	case 'i':
		return keyI, true
	case 'j':
		return keyJ, true
	case 'k':
		return keyK, true
	case 'l':
		return keyL, true
	case 'm':
		return keyM, true
	case 'n':
		return keyN, true
	case 'o':
		return keyO, true
	case 'p':
		return keyP, true
	case 'q':
		return keyQ, true
	case 'r':
		return keyR, true
	case 's':
		return keyS, true
	case 't':
		return keyT, true
	case 'u':
		return keyU, true
	case 'v':
		return keyV, true
	case 'w':
		return keyW, true
	case 'x':
		return keyX, true
	case 'y':
		return keyY, true
	case 'z':
		return keyZ, true
	default:
		return 0, false
	}
}

var _ = syscall.Getuid
