package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/service/blockterm"
	"gorm.io/gorm"
)

func RegisterBlockTermV2(api *gin.RouterGroup, service *blockterm.Service) {
	g := api.Group("/blockterm/v2")
	fail := func(c *gin.Context, err error) bool {
		if err == nil {
			return false
		}
		code := http.StatusBadRequest
		if errors.Is(err, blockterm.ErrConflict) {
			code = http.StatusConflict
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			code = http.StatusNotFound
		}
		c.AbortWithStatusJSON(code, gin.H{"error": err.Error()})
		return true
	}
	bind := func(c *gin.Context, v any, limits ...int64) bool {
		limit := int64(2 << 20)
		if len(limits) > 0 {
			limit = limits[0]
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		return !fail(c, c.ShouldBindJSON(v))
	}
	g.GET("/history", func(c *gin.Context) {
		if offset := c.Query("offset"); offset != "" && offset != "0" {
			c.JSON(http.StatusConflict, gin.H{"error": "history pagination changed; refresh the client"})
			return
		}
		page, err := service.History(c.Query("group_id"), c.Query("q"), c.Query("cursor"))
		if !fail(c, err) {
			c.JSON(200, page)
		}
	})
	g.GET("/sessions/:id/blocks/:block/output", func(c *gin.Context) {
		info, err := service.GetContext(c.Request.Context(), c.Param("id"))
		if fail(c, err) {
			return
		}
		after, err := strconv.ParseUint(c.DefaultQuery("after", "0"), 10, 64)
		if fail(c, err) {
			return
		}
		through := info.Seq
		if value, present := c.GetQuery("through"); present {
			through, err = strconv.ParseUint(value, 10, 64)
			if fail(c, err) {
				return
			}
		}
		if after > through || through > info.Seq {
			c.JSON(409, gin.H{"error": "output cursor is outside the snapshot"})
			return
		}
		events, more, err := service.OutputPageThroughContext(c.Request.Context(), c.Param("id"), c.Param("block"), after, through)
		if !fail(c, err) {
			c.JSON(200, gin.H{"events": events, "has_more": more, "through": through})
		}
	})
	g.GET("/sessions", func(c *gin.Context) {
		sessions, err := service.List(c.Query("group_id"))
		if !fail(c, err) {
			c.JSON(200, gin.H{"sessions": sessions})
		}
	})
	g.POST("/sessions", func(c *gin.Context) {
		var req struct {
			GroupID string `json:"group_id"`
			Cwd     string `json:"cwd"`
			Shell   string `json:"shell"`
			Cols    int    `json:"cols"`
			Rows    int    `json:"rows"`
		}
		if !bind(c, &req) {
			return
		}
		session, err := service.Create(req.GroupID, req.Cwd, req.Shell, req.Cols, req.Rows)
		if !fail(c, err) {
			c.JSON(201, session)
		}
	})
	g.GET("/sessions/:id", func(c *gin.Context) {
		info, err := service.Get(c.Param("id"))
		if !fail(c, err) {
			c.JSON(200, info)
		}
	})
	g.GET("/sessions/:id/blocks", func(c *gin.Context) {
		blocks, err := service.Blocks(c.Param("id"))
		if !fail(c, err) {
			c.JSON(200, gin.H{"blocks": blocks})
		}
	})
	g.POST("/sessions/:id/control", func(c *gin.Context) {
		var req struct {
			Owner string `json:"owner"`
		}
		if !bind(c, &req) {
			return
		}
		if !fail(c, service.Claim(c.Param("id"), req.Owner)) {
			c.JSON(200, gin.H{"ok": true})
		}
	})
	g.DELETE("/sessions/:id/control", func(c *gin.Context) {
		service.Release(c.Param("id"), c.Query("owner"))
		c.JSON(200, gin.H{"ok": true})
	})
	g.POST("/sessions/:id/submit", func(c *gin.Context) {
		var req struct {
			Owner     string `json:"owner"`
			RequestID string `json:"request_id"`
			Command   string `json:"command"`
		}
		// JSON can encode each input byte as six ASCII bytes (e.g. \u0001).
		if !bind(c, &req, 6*blockterm.MaxCommandBytes+4096) {
			return
		}
		b, err := service.Submit(c.Param("id"), req.Owner, req.RequestID, req.Command)
		if !fail(c, err) {
			c.JSON(200, b)
		}
	})
	g.POST("/sessions/:id/input", func(c *gin.Context) {
		var req struct {
			Owner string `json:"owner"`
			Data  []byte `json:"data"`
		}
		if !bind(c, &req) {
			return
		}
		if !fail(c, service.Input(c.Param("id"), req.Owner, req.Data)) {
			c.JSON(200, gin.H{"ok": true})
		}
	})
	g.POST("/sessions/:id/native", func(c *gin.Context) {
		var req struct {
			Owner string `json:"owner"`
			Draft string `json:"draft"`
		}
		if !bind(c, &req, 6*blockterm.MaxCommandBytes+4096) {
			return
		}
		if !fail(c, service.BeginNative(c.Param("id"), req.Owner, req.Draft)) {
			c.JSON(200, gin.H{"ok": true})
		}
	})
	g.POST("/sessions/:id/resize", func(c *gin.Context) {
		var req struct {
			Owner string `json:"owner"`
			Cols  int    `json:"cols"`
			Rows  int    `json:"rows"`
		}
		if !bind(c, &req) {
			return
		}
		if !fail(c, service.Resize(c.Param("id"), req.Owner, req.Cols, req.Rows)) {
			c.JSON(200, gin.H{"ok": true})
		}
	})
	g.DELETE("/sessions/:id", func(c *gin.Context) {
		if !fail(c, service.CloseSession(c.Param("id"), c.Query("owner"))) {
			c.JSON(200, gin.H{"ok": true})
		}
	})
	g.GET("/sessions/:id/events", func(c *gin.Context) {
		info, err := service.GetContext(c.Request.Context(), c.Param("id"))
		if fail(c, err) {
			return
		}
		cursor, err := strconv.ParseUint(c.DefaultQuery("after", "0"), 10, 64)
		if fail(c, err) {
			return
		}
		if cursor > info.Seq {
			c.JSON(409, gin.H{"error": "event cursor is ahead of session"})
			return
		}
		upgrader := websocket.Upgrader{}
		ws, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ctx, cancel := context.WithCancel(c.Request.Context())
		defer cancel()
		metadata, _ := json.Marshal(info)
		if writeBlockTermEvents(ws, []blockterm.Event{{SessionID: info.ID, Seq: info.Seq, Type: "hello", Data: metadata}}) != nil {
			return
		}
		ws.SetReadLimit(4096)
		if ws.SetReadDeadline(time.Now().Add(60*time.Second)) != nil {
			return
		}
		ws.SetPongHandler(func(string) error {
			return ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		})
		go func() {
			ping := time.NewTicker(20 * time.Second)
			defer ping.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ping.C:
					// WriteControl permits concurrent use with the event writer.
					if ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
						cancel()
						_ = ws.Close()
						return
					}
				}
			}
		}()
		done := make(chan struct{})
		stop := make(chan struct{})
		defer close(stop)
		acks := make(chan uint64, 2)
		go func() {
			defer close(done)
			defer cancel()
			for {
				var ack struct {
					Ack uint64 `json:"ack"`
				}
				if err := ws.ReadJSON(&ack); err != nil {
					return
				}
				if ws.SetReadDeadline(time.Now().Add(60*time.Second)) != nil {
					return
				}
				select {
				case acks <- ack.Ack:
				case <-stop:
					return
				case <-c.Request.Context().Done():
					return
				default:
					// A client can acknowledge only one outstanding batch. Never
					// block the disconnect reader behind unsolicited ACKs.
					return
				}
			}
		}()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			events, err := service.EventsContext(ctx, info.ID, cursor)
			if err == nil {
				err = validateBlockTermReplay(events, info.ID, cursor, info.Seq)
			}
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				_ = writeBlockTermEvents(ws, []blockterm.Event{{Type: "fault", Data: []byte("读取输出失败: " + err.Error())}})
				return
			}
			if len(events) > 0 {
				if writeBlockTermEvents(ws, events) != nil {
					return
				}
				cursor = events[len(events)-1].Seq
				timeout := time.NewTimer(30 * time.Second)
			acknowledge:
				for {
					select {
					case ack := <-acks:
						if ack == cursor {
							break acknowledge
						}
					case <-done:
						timeout.Stop()
						return
					case <-c.Request.Context().Done():
						timeout.Stop()
						return
					case <-timeout.C:
						return
					}
				}
				timeout.Stop()
				continue
			}
			select {
			case <-done:
				return
			case <-c.Request.Context().Done():
				return
			case <-ticker.C:
			}
		}
	})
}

func validateBlockTermReplay(events []blockterm.Event, session string, cursor, watermark uint64) error {
	if len(events) == 0 && cursor < watermark {
		return errors.New("终端记录缺失，无法完成回放")
	}
	for _, event := range events {
		if event.SessionID != session || event.Seq <= cursor || event.Seq-cursor != 1 {
			return errors.New("终端事件不连续，无法安全回放")
		}
		cursor = event.Seq
	}
	return nil
}

func writeBlockTermEvents(writer interface {
	SetWriteDeadline(time.Time) error
	WriteJSON(interface{}) error
}, events []blockterm.Event) error {
	if err := writer.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return writer.WriteJSON(events)
}
