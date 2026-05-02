package handler

import (
	"image"
	"image/color"
	"net/http/httptest"
	"strings"
	"testing"

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

type handlerFakeInput struct{}

func (f *handlerFakeInput) Available() error                                    { return nil }
func (f *handlerFakeInput) Move(x, y int) error                                 { return nil }
func (f *handlerFakeInput) Button(button string, down bool) error               { return nil }
func (f *handlerFakeInput) Click(button string) error                           { return nil }
func (f *handlerFakeInput) Wheel(x, y int) error                                { return nil }
func (f *handlerFakeInput) Key(key string, down bool, modifiers []string) error { return nil }
func (f *handlerFakeInput) Text(text string) error                              { return nil }

type handlerFakeClipboard struct {
	text string
}

func (f *handlerFakeClipboard) Available() error          { return nil }
func (f *handlerFakeClipboard) ReadText() (string, error) { return f.text, nil }
func (f *handlerFakeClipboard) WriteText(text string) error {
	f.text = text
	return nil
}
