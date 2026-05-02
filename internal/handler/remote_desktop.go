package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
	"github.com/xxnuo/vibego/internal/service/remotedesktop"
)

type RemoteDesktopHandler struct {
	capture  remotedesktop.CaptureProvider
	input    remotedesktop.InputProvider
	clip     remotedesktop.ClipboardProvider
	upgrader websocket.Upgrader
}

func NewRemoteDesktopHandler() *RemoteDesktopHandler {
	return NewRemoteDesktopHandlerWithProviders(
		remotedesktop.NewScreenCaptureProvider(),
		remotedesktop.NewRobotInputProvider(),
		remotedesktop.NewSystemClipboardProvider(),
	)
}

func NewRemoteDesktopHandlerWithProviders(capture remotedesktop.CaptureProvider, input remotedesktop.InputProvider, clip remotedesktop.ClipboardProvider) *RemoteDesktopHandler {
	return &RemoteDesktopHandler{
		capture: capture,
		input:   input,
		clip:    clip,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

func (h *RemoteDesktopHandler) Register(g *gin.RouterGroup) {
	r := g.Group("/remote-desktop")
	r.GET("/displays", h.Displays)
	r.GET("/status", h.Status)
	r.GET("/clipboard", h.GetClipboard)
	r.POST("/clipboard", h.SetClipboard)
	r.GET("/ws", h.WebSocket)
}

func (h *RemoteDesktopHandler) Displays(c *gin.Context) {
	displays, err := h.capture.Displays()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "displays": []remotedesktop.Display{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"displays": displays})
}

func (h *RemoteDesktopHandler) Status(c *gin.Context) {
	c.JSON(http.StatusOK, remotedesktop.RuntimeStatus(h.capture, h.input, h.clip))
}

func (h *RemoteDesktopHandler) GetClipboard(c *gin.Context) {
	text, err := h.clip.ReadText()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"text": text})
}

type remoteDesktopClipboardRequest struct {
	Text string `json:"text"`
}

func (h *RemoteDesktopHandler) SetClipboard(c *gin.Context) {
	var req remoteDesktopClipboardRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.clip.WriteText(req.Text); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *RemoteDesktopHandler) WebSocket(c *gin.Context) {
	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	displays, err := h.capture.Displays()
	if err != nil {
		writeRemoteDesktopJSON(conn, "error", gin.H{"message": err.Error()})
		return
	}
	displayID := 0
	if len(displays) > 0 {
		displayID = displays[0].ID
	}

	session := remotedesktop.NewSession(h.capture, h.input, h.clip, remotedesktop.Config{
		DisplayID: displayID,
		FPS:       remotedesktop.DefaultFPS,
		Quality:   remotedesktop.DefaultQuality,
	})
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	paused := atomic.Bool{}
	latest := make(chan remotedesktop.Frame, 1)
	send := make(chan wsOutbound, 8)

	writeRemoteDesktopJSON(conn, "hello", gin.H{
		"displays": displays,
		"status":   remotedesktop.RuntimeStatus(h.capture, h.input, h.clip),
		"config":   session.Config(),
	})

	go h.captureLoop(ctx, session, &paused, latest, send)
	go h.readLoop(ctx, cancel, conn, session, &paused, send)

	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-latest:
			data, err := remotedesktop.EncodeFrame(frame.Metadata, frame.JPEG)
			if err != nil {
				writeRemoteDesktopJSON(conn, "error", gin.H{"message": err.Error()})
				continue
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				cancel()
				return
			}
		case msg := <-send:
			if err := conn.WriteMessage(msg.messageType, msg.data); err != nil {
				cancel()
				return
			}
		}
	}
}

type wsOutbound struct {
	messageType int
	data        []byte
}

func (h *RemoteDesktopHandler) captureLoop(ctx context.Context, session *remotedesktop.Session, paused *atomic.Bool, latest chan remotedesktop.Frame, send chan wsOutbound) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cfg := session.Config()
			if !paused.Load() {
				frame, err := session.CaptureFrame(ctx)
				if err != nil {
					queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
				} else {
					select {
					case latest <- frame:
					default:
						select {
						case <-latest:
						default:
						}
						latest <- frame
					}
				}
			}
			timer.Reset(remotedesktop.FrameInterval(cfg.FPS))
		}
	}
}

func (h *RemoteDesktopHandler) readLoop(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, session *remotedesktop.Session, paused *atomic.Bool, send chan wsOutbound) {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType != websocket.TextMessage {
			continue
		}
		msg, err := remotedesktop.ParseClientMessage(data)
		if err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
			continue
		}
		h.handleClientMessage(session, paused, msg, send)
	}
}

func (h *RemoteDesktopHandler) handleClientMessage(session *remotedesktop.Session, paused *atomic.Bool, msg remotedesktop.ClientMessage, send chan wsOutbound) {
	switch msg.Type {
	case "configure":
		cfg := session.Config()
		if msg.DisplayID != nil {
			cfg.DisplayID = *msg.DisplayID
		}
		if msg.FPS > 0 {
			cfg.FPS = msg.FPS
		}
		if msg.Quality > 0 {
			cfg.Quality = msg.Quality
		}
		cfg = session.Configure(cfg)
		queueRemoteDesktopJSON(send, "status", gin.H{"config": cfg})
	case "pointer":
		displayID := session.Config().DisplayID
		if msg.DisplayID != nil {
			displayID = *msg.DisplayID
		}
		if err := session.Pointer(displayID, msg.X, msg.Y, true); err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
		}
		if msg.Button != "" {
			if err := session.Button(msg.Button, msg.Down); err != nil {
				queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
			}
		}
	case "wheel":
		if err := session.Wheel(msg.DeltaX, msg.DeltaY); err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
		}
	case "key":
		down := msg.Down != nil && *msg.Down
		if err := session.Key(msg.Key, down, msg.Modifiers); err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
		}
	case "text":
		if err := session.Text(msg.Text); err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
		}
	case "clipboardRead":
		text, err := session.ReadClipboard()
		if err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
			return
		}
		queueRemoteDesktopJSON(send, "clipboard", gin.H{"text": text})
	case "clipboardWrite":
		if err := session.WriteClipboard(msg.Text); err != nil {
			queueRemoteDesktopJSON(send, "error", gin.H{"message": err.Error()})
			return
		}
		queueRemoteDesktopJSON(send, "clipboard", gin.H{"ok": true})
	case "pause":
		paused.Store(true)
		queueRemoteDesktopJSON(send, "status", gin.H{"paused": true})
	case "resume":
		paused.Store(false)
		queueRemoteDesktopJSON(send, "status", gin.H{"paused": false})
	}
}

func writeRemoteDesktopJSON(conn *websocket.Conn, typ string, payload gin.H) {
	data, err := remoteDesktopJSON(typ, payload)
	if err != nil {
		log.Warn().Err(err).Msg("Failed to encode remote desktop message")
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

func queueRemoteDesktopJSON(send chan wsOutbound, typ string, payload gin.H) {
	data, err := remoteDesktopJSON(typ, payload)
	if err != nil {
		return
	}
	msg := wsOutbound{messageType: websocket.TextMessage, data: data}
	select {
	case send <- msg:
	default:
	}
}

func remoteDesktopJSON(typ string, payload gin.H) ([]byte, error) {
	out := gin.H{"type": typ}
	for k, v := range payload {
		out[k] = v
	}
	return json.Marshal(out)
}
