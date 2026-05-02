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
	if err := remotedesktop.ValidateClipboardText(req.Text); err != nil {
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
	qos := remotedesktop.NewQoS(session.Config())
	displayManager := remotedesktop.NewDisplayManager(h.capture)
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	paused := atomic.Bool{}
	latest := make(chan remotedesktop.Frame, 1)
	send := make(chan wsOutbound, 8)
	clipboardSync := atomic.Bool{}

	writeRemoteDesktopJSON(conn, "hello", gin.H{
		"version":  remotedesktop.ProtocolVersion,
		"displays": displays,
		"status":   remotedesktop.RuntimeStatus(h.capture, h.input, h.clip),
		"config":   session.Config(),
		"qos":      qos.Snapshot(),
	})

	go h.captureLoop(ctx, session, qos, &paused, latest, send)
	go h.displayLoop(ctx, session, displayManager, send)
	go h.clipboardLoop(ctx, &clipboardSync, send)
	go h.readLoop(ctx, cancel, conn, session, qos, &paused, &clipboardSync, send)

	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-latest:
			frame.Metadata.SentAt = time.Now().UnixMilli()
			data, err := remotedesktop.EncodeFrame(frame.Metadata, frame.JPEG)
			if err != nil {
				writeRemoteDesktopError(conn, "encode_failed", err.Error(), true)
				continue
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				cancel()
				return
			}
			qos.FrameSent(frame.Metadata.Seq)
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

func (h *RemoteDesktopHandler) captureLoop(ctx context.Context, session *remotedesktop.Session, qos *remotedesktop.QoS, paused *atomic.Bool, latest chan remotedesktop.Frame, send chan wsOutbound) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cfg := session.Config()
			if !paused.Load() {
				session.Configure(qos.Config(cfg))
				frame, err := session.CaptureFrame(ctx)
				if err != nil {
					queueRemoteDesktopError(send, "capture_failed", err.Error(), true)
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
			qos.Tick()
			timer.Reset(remotedesktop.FrameInterval(qos.Config(session.Config()).FPS))
		}
	}
}

func (h *RemoteDesktopHandler) displayLoop(ctx context.Context, session *remotedesktop.Session, displayManager *remotedesktop.DisplayManager, send chan wsOutbound) {
	ticker := time.NewTicker(800 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			snapshot, err := displayManager.Refresh()
			if err != nil {
				queueRemoteDesktopError(send, "display_unavailable", err.Error(), true)
				continue
			}
			if !snapshot.Changed {
				continue
			}
			cfg := session.Config()
			nextDisplayID := remotedesktop.SelectDisplay(snapshot.Displays, cfg.DisplayID)
			if nextDisplayID != cfg.DisplayID {
				cfg.DisplayID = nextDisplayID
				session.Configure(cfg)
			}
			queueRemoteDesktopJSON(send, "displays", gin.H{"displays": snapshot.Displays, "config": session.Config()})
		}
	}
}

func (h *RemoteDesktopHandler) clipboardLoop(ctx context.Context, enabled *atomic.Bool, send chan wsOutbound) {
	ticker := time.NewTicker(1200 * time.Millisecond)
	defer ticker.Stop()
	last := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !enabled.Load() {
				continue
			}
			text, err := h.clip.ReadText()
			if err != nil {
				queueRemoteDesktopError(send, "clipboard_read_failed", err.Error(), true)
				continue
			}
			if err := remotedesktop.ValidateClipboardText(text); err != nil {
				queueRemoteDesktopError(send, "clipboard_too_large", err.Error(), true)
				continue
			}
			if text != last {
				last = text
				queueRemoteDesktopJSON(send, "clipboard", gin.H{"text": text, "sync": true})
			}
		}
	}
}

func (h *RemoteDesktopHandler) readLoop(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, session *remotedesktop.Session, qos *remotedesktop.QoS, paused *atomic.Bool, clipboardSync *atomic.Bool, send chan wsOutbound) {
	defer cancel()
	defer h.releaseInput(session, send)
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
			queueRemoteDesktopError(send, "bad_message", err.Error(), true)
			continue
		}
		h.handleClientMessage(session, qos, paused, clipboardSync, msg, send)
	}
}

func (h *RemoteDesktopHandler) handleClientMessage(session *remotedesktop.Session, qos *remotedesktop.QoS, paused *atomic.Bool, clipboardSync *atomic.Bool, msg remotedesktop.ClientMessage, send chan wsOutbound) {
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
		if msg.FitMode != "" {
			cfg.FitMode = msg.FitMode
		}
		if msg.ScalePercent > 0 {
			cfg.ScalePercent = msg.ScalePercent
		}
		if msg.ScrollMode != "" {
			cfg.ScrollMode = msg.ScrollMode
		}
		if msg.QualityPreset != "" {
			cfg.QualityPreset = msg.QualityPreset
		}
		if msg.ControlMode != "" {
			cfg.ControlMode = msg.ControlMode
		}
		if msg.KeyboardMode != "" {
			cfg.KeyboardMode = msg.KeyboardMode
		}
		if msg.ShowLocalCursor != nil {
			cfg.ShowLocalCursor = *msg.ShowLocalCursor
		}
		if msg.ClipboardSync != nil {
			cfg.ClipboardSync = *msg.ClipboardSync
			clipboardSync.Store(*msg.ClipboardSync)
		}
		cfg = session.Configure(cfg)
		qos.Configure(cfg)
		queueRemoteDesktopJSON(send, "status", gin.H{"config": session.Config(), "qos": qos.Snapshot()})
	case "pointer":
		if session.Config().ControlMode == "view" {
			return
		}
		displayID := session.Config().DisplayID
		if msg.DisplayID != nil {
			displayID = *msg.DisplayID
		}
		shouldMove := msg.Button == ""
		if msg.Move != nil {
			shouldMove = *msg.Move
		}
		if shouldMove {
			var err error
			if msg.Relative {
				err = session.MoveRelative(displayID, msg.DX, msg.DY)
			} else {
				err = session.Pointer(displayID, msg.X, msg.Y, true)
			}
			if err != nil {
				queueRemoteDesktopError(send, "pointer_failed", err.Error(), true)
			}
		}
		if msg.Button != "" {
			if err := session.Button(msg.Button, msg.Down); err != nil {
				queueRemoteDesktopError(send, "button_failed", err.Error(), true)
			}
		}
	case "wheel":
		if session.Config().ControlMode == "view" {
			return
		}
		if err := session.Wheel(msg.DeltaX, msg.DeltaY); err != nil {
			queueRemoteDesktopError(send, "wheel_failed", err.Error(), true)
		}
	case "key":
		if session.Config().ControlMode == "view" {
			return
		}
		down := msg.Down != nil && *msg.Down
		if err := session.Key(msg.Key, down, msg.Modifiers); err != nil {
			queueRemoteDesktopError(send, "key_failed", err.Error(), true)
		}
	case "text":
		if session.Config().ControlMode == "view" {
			return
		}
		if err := session.Text(msg.Text); err != nil {
			queueRemoteDesktopError(send, "text_failed", err.Error(), true)
		}
	case "specialKey":
		if session.Config().ControlMode == "view" {
			return
		}
		if err := h.specialKey(session, msg.SpecialKey); err != nil {
			queueRemoteDesktopError(send, "special_key_failed", err.Error(), true)
		}
	case "releaseInput":
		h.releaseInput(session, send)
	case "frameAck":
		delayMs := time.Now().UnixMilli() - msg.ReceivedAt
		if msg.ReceivedAt <= 0 {
			delayMs = msg.RenderMs
		}
		queueRemoteDesktopJSON(send, "qos", gin.H{"qos": qos.Ack(msg.Seq, delayMs)})
	case "clipboardRead":
		text, err := session.ReadClipboard()
		if err != nil {
			queueRemoteDesktopError(send, "clipboard_read_failed", err.Error(), true)
			return
		}
		queueRemoteDesktopJSON(send, "clipboard", gin.H{"text": text})
	case "clipboardWrite":
		if err := session.WriteClipboard(msg.Text); err != nil {
			queueRemoteDesktopError(send, "clipboard_write_failed", err.Error(), true)
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

func (h *RemoteDesktopHandler) specialKey(session *remotedesktop.Session, key string) error {
	press := func(k string, mods ...string) error {
		if err := session.Key(k, true, mods); err != nil {
			return err
		}
		return session.Key(k, false, mods)
	}
	switch key {
	case "ctrlAltDel":
		return press("delete", "ctrl", "alt")
	case "lock":
		return press("l", "cmd")
	case "esc":
		return press("esc")
	case "tab":
		return press("tab")
	case "enter":
		return press("enter")
	case "up":
		return press("arrowup")
	case "down":
		return press("arrowdown")
	case "left":
		return press("arrowleft")
	case "right":
		return press("arrowright")
	default:
		return nil
	}
}

func (h *RemoteDesktopHandler) releaseInput(session *remotedesktop.Session, send chan wsOutbound) {
	for _, key := range []string{"shift", "ctrl", "alt", "cmd"} {
		if err := session.Key(key, false, nil); err != nil {
			queueRemoteDesktopError(send, "key_release_failed", err.Error(), true)
		}
	}
	for _, button := range []string{"left", "middle", "right"} {
		down := false
		_ = session.Button(button, &down)
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

func writeRemoteDesktopError(conn *websocket.Conn, code, message string, recoverable bool) {
	writeRemoteDesktopJSON(conn, "error", gin.H{"code": code, "message": message, "recoverable": recoverable})
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

func queueRemoteDesktopError(send chan wsOutbound, code, message string, recoverable bool) {
	queueRemoteDesktopJSON(send, "error", gin.H{"code": code, "message": message, "recoverable": recoverable})
}

func remoteDesktopJSON(typ string, payload gin.H) ([]byte, error) {
	out := gin.H{"type": typ}
	for k, v := range payload {
		out[k] = v
	}
	return json.Marshal(out)
}
