package handler

import (
	"image"
	"image/color"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/service/remotedesktop"
)

func TestRemoteDesktopWebSocketHelloPauseResume(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api")
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.White)
	h := NewRemoteDesktopHandlerWithProviders(
		&handlerFakeCapture{
			displays: []remotedesktop.Display{{ID: 0, Width: 2, Height: 2}},
			img:      img,
		},
		&handlerFakeInput{},
		&handlerFakeClipboard{text: "clip"},
	)
	h.Register(api)

	srv := httptest.NewServer(r)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/remote-desktop/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer conn.Close()

	msgType, data, err := conn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.TextMessage, msgType)
	require.Contains(t, string(data), `"type":"hello"`)
	require.Contains(t, string(data), `"version":2`)
	require.Contains(t, string(data), `"qos"`)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "configure", "fps": 20, "quality": 90, "controlMode": "view", "clipboardSync": true}))
	data = readTextMessageContaining(t, conn, `"type":"status"`)
	require.Contains(t, string(data), `"controlMode":"view"`)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "frameAck", "seq": 1, "receivedAt": timeNowMilli()}))
	data = readTextMessageContaining(t, conn, `"type":"qos"`)
	require.Contains(t, string(data), `"effectiveFps"`)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "pause"}))
	data = readTextMessageContaining(t, conn, `"paused":true`)
	require.Contains(t, string(data), `"paused":true`)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "resume"}))
	data = readTextMessageContaining(t, conn, `"paused":false`)
	require.Contains(t, string(data), `"paused":false`)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "clipboardRead"}))
	data = readTextMessageContaining(t, conn, `"type":"clipboard"`)
	require.Contains(t, string(data), `"text":"clip"`)
}

func TestRemoteDesktopWebSocketExtendedConfigAndInputRelease(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api")
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	input := &handlerFakeInput{}
	h := NewRemoteDesktopHandlerWithProviders(
		&handlerFakeCapture{
			displays: []remotedesktop.Display{{ID: 0, Width: 2, Height: 2}},
			img:      img,
		},
		input,
		&handlerFakeClipboard{},
	)
	h.Register(api)

	srv := httptest.NewServer(r)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/remote-desktop/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer conn.Close()

	_, _, err = conn.ReadMessage()
	require.NoError(t, err)

	require.NoError(t, conn.WriteJSON(map[string]any{
		"type":            "configure",
		"fitMode":         "custom",
		"scalePercent":    125,
		"scrollMode":      "edge",
		"qualityPreset":   "sharp",
		"keyboardMode":    "text",
		"showLocalCursor": false,
	}))
	data := readTextMessageContaining(t, conn, `"type":"status"`)
	require.Contains(t, string(data), `"fitMode":"custom"`)
	require.Contains(t, string(data), `"scalePercent":125`)
	require.Contains(t, string(data), `"scrollMode":"edge"`)
	require.Contains(t, string(data), `"keyboardMode":"text"`)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "specialKey", "specialKey": "ctrlAltDel"}))
	require.Eventually(t, func() bool {
		return input.keyEvents >= 2
	}, time.Second, 10*time.Millisecond)

	require.NoError(t, conn.WriteJSON(map[string]any{"type": "releaseInput"}))
	require.Eventually(t, func() bool {
		return input.buttonEvents >= 3
	}, time.Second, 10*time.Millisecond)
}

func TestRemoteDesktopPointerButtonDoesNotMove(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 80))
	input := &handlerFakeInput{x: 40, y: 30}
	h := NewRemoteDesktopHandlerWithProviders(
		&handlerFakeCapture{
			displays: []remotedesktop.Display{{ID: 0, Width: 100, Height: 80}},
			img:      img,
		},
		input,
		&handlerFakeClipboard{},
	)
	session := remotedesktop.NewSession(h.capture, h.input, h.clip, remotedesktop.Config{DisplayID: 0})
	paused := atomic.Bool{}
	clipboardSync := atomic.Bool{}
	send := make(chan wsOutbound, 4)
	down := true

	h.handleClientMessage(session, remotedesktop.NewQoS(session.Config()), &paused, &clipboardSync, remotedesktop.ClientMessage{
		Type:   "pointer",
		Button: "left",
		Down:   &down,
		X:      0,
		Y:      0,
	}, send)

	require.Equal(t, 0, input.moveEvents)
	require.Equal(t, 1, input.buttonEvents)
	require.Equal(t, 40, input.x)
	require.Equal(t, 30, input.y)
}

func TestRemoteDesktopPointerRelativeMove(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 80))
	input := &handlerFakeInput{x: 95, y: 75}
	h := NewRemoteDesktopHandlerWithProviders(
		&handlerFakeCapture{
			displays: []remotedesktop.Display{{ID: 0, Width: 100, Height: 80}},
			img:      img,
		},
		input,
		&handlerFakeClipboard{},
	)
	session := remotedesktop.NewSession(h.capture, h.input, h.clip, remotedesktop.Config{DisplayID: 0})
	paused := atomic.Bool{}
	clipboardSync := atomic.Bool{}
	send := make(chan wsOutbound, 4)
	move := true

	h.handleClientMessage(session, remotedesktop.NewQoS(session.Config()), &paused, &clipboardSync, remotedesktop.ClientMessage{
		Type:     "pointer",
		Move:     &move,
		Relative: true,
		DX:       20,
		DY:       20,
	}, send)

	require.Equal(t, 1, input.moveEvents)
	require.Equal(t, 99, input.x)
	require.Equal(t, 79, input.y)
}

func TestRemoteDesktopDropsStaleRealtimeInput(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 80))
	input := &handlerFakeInput{x: 40, y: 30}
	h := NewRemoteDesktopHandlerWithProviders(
		&handlerFakeCapture{
			displays: []remotedesktop.Display{{ID: 0, Width: 100, Height: 80}},
			img:      img,
		},
		input,
		&handlerFakeClipboard{},
	)
	session := remotedesktop.NewSession(h.capture, h.input, h.clip, remotedesktop.Config{DisplayID: 0})
	paused := atomic.Bool{}
	clipboardSync := atomic.Bool{}
	send := make(chan wsOutbound, 4)

	h.handleClientMessage(session, remotedesktop.NewQoS(session.Config()), &paused, &clipboardSync, remotedesktop.ClientMessage{
		Type:         "pointer",
		X:            1,
		Y:            1,
		ClientSentAt: time.Now().Add(-2 * time.Second).UnixMilli(),
	}, send)

	require.Equal(t, 0, input.moveEvents)
	require.Equal(t, 40, input.x)
	require.Equal(t, 30, input.y)
}

func timeNowMilli() int64 {
	return time.Now().UnixMilli()
}

func readTextMessageContaining(t *testing.T, conn *websocket.Conn, needle string) []byte {
	t.Helper()
	for i := 0; i < 20; i++ {
		msgType, data, err := conn.ReadMessage()
		require.NoError(t, err)
		if msgType == websocket.TextMessage && strings.Contains(string(data), needle) {
			return data
		}
	}
	t.Fatalf("text message containing %q not found", needle)
	return nil
}

type handlerFakeCapture struct {
	displays []remotedesktop.Display
	img      image.Image
}

func (f *handlerFakeCapture) Displays() ([]remotedesktop.Display, error) {
	return f.displays, nil
}

func (f *handlerFakeCapture) Capture(displayID int) (image.Image, remotedesktop.Display, error) {
	for _, display := range f.displays {
		if display.ID == displayID {
			return f.img, display, nil
		}
	}
	return nil, remotedesktop.Display{}, remotedesktop.ErrDisplayNotFound
}

type handlerFakeInput struct {
	keyEvents    int
	buttonEvents int
	moveEvents   int
	x            int
	y            int
}

func (f *handlerFakeInput) Available() error { return nil }
func (f *handlerFakeInput) Move(x, y int) error {
	f.moveEvents++
	f.x = x
	f.y = y
	return nil
}
func (f *handlerFakeInput) Position() (int, int, error) {
	return f.x, f.y, nil
}
func (f *handlerFakeInput) Button(button string, down bool) error {
	f.buttonEvents++
	return nil
}
func (f *handlerFakeInput) Click(button string) error { return nil }
func (f *handlerFakeInput) Wheel(x, y int) error      { return nil }
func (f *handlerFakeInput) Key(key string, down bool, modifiers []string) error {
	f.keyEvents++
	return nil
}
func (f *handlerFakeInput) Text(text string) error { return nil }

type handlerFakeClipboard struct {
	text string
}

func (f *handlerFakeClipboard) Available() error          { return nil }
func (f *handlerFakeClipboard) ReadText() (string, error) { return f.text, nil }
func (f *handlerFakeClipboard) WriteText(text string) error {
	f.text = text
	return nil
}
