package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	workspacesvc "github.com/xxnuo/vibego/internal/service/workspace"
	"gorm.io/gorm"
)

type WorkspaceHandler struct {
	service *workspacesvc.Service
	manager *terminal.Manager
}

func NewWorkspaceHandler(service *workspacesvc.Service, managers ...*terminal.Manager) *WorkspaceHandler {
	h := &WorkspaceHandler{service: service}
	if len(managers) > 0 {
		h.manager = managers[0]
	}
	return h
}
func (h *WorkspaceHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/workspace")
	g.POST("/mutations", h.SubmitMutation)
	g.GET("/events", h.HandleWebSocket)
	g.GET("/:id", h.GetWorkspaceSnapshot)
}

func workspaceError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		status = http.StatusNotFound
	case errors.Is(err, workspacesvc.ErrInvalid):
		status = http.StatusBadRequest
	case errors.Is(err, workspacesvc.ErrConflict):
		status = http.StatusConflict
	}
	c.JSON(status, gin.H{"error": err.Error()})
}

func (h *WorkspaceHandler) SubmitMutation(c *gin.Context) {
	var m workspacesvc.ClientMutation
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024*1024)
	if err := c.ShouldBindJSON(&m); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if m.ClientID == "server" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reserved client id"})
		return
	}
	if err := workspacesvc.ValidateEnvelope(m); err != nil {
		workspaceError(c, err)
		return
	}
	exists, err := h.service.HasMutation(m.WorkspaceID, m.ID)
	if err != nil {
		workspaceError(c, err)
		return
	}
	if !exists && (m.Type == "terminal/close" || m.Type == "workspace/delete") {
		if h.manager == nil {
			c.JSON(http.StatusConflict, gin.H{"error": "terminal lifecycle unavailable"})
			return
		}
		var p struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(m.Payload, &p) != nil || p.ID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id required"})
			return
		}
		snapshot, err := h.service.Snapshot(m.WorkspaceID)
		if err != nil {
			workspaceError(c, err)
			return
		}
		if m.BaseRevision > snapshot.Workspace.Revision || m.BaseRevision < snapshot.Workspace.CompactedRevision {
			workspaceError(c, workspacesvc.ErrConflict)
			return
		}
		if m.Type == "terminal/close" {
			var term model.TerminalSession
			err := h.manager.DB().First(&term, "id = ?", p.ID).Error
			if err == nil {
				if term.WorkspaceSessionID != m.WorkspaceID {
					c.JSON(http.StatusConflict, gin.H{"error": "terminal scope mismatch"})
					return
				}
				if err := h.manager.Delete(p.ID); err != nil {
					workspaceError(c, err)
					return
				}
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				workspaceError(c, err)
				return
			}
		} else {
			if p.ID != m.WorkspaceID {
				c.JSON(http.StatusBadRequest, gin.H{"error": "workspace id mismatch"})
				return
			}
			if err := h.manager.DeleteWorkspace(p.ID); err != nil {
				workspaceError(c, err)
				return
			}
		}
	}
	event, err := h.service.Commit(m)
	if err != nil {
		workspaceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "revision": event.Revision, "mutation_id": m.ID, "event": event})
}

func (h *WorkspaceHandler) GetWorkspaceSnapshot(c *gin.Context) {
	snapshot, err := h.service.Snapshot(c.Param("id"))
	if err != nil {
		workspaceError(c, err)
		return
	}
	c.JSON(http.StatusOK, snapshot)
}

func (h *WorkspaceHandler) HandleWebSocket(c *gin.Context) {
	id := c.Query("workspace_id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workspace_id required"})
		return
	}
	after, err := strconv.ParseInt(c.DefaultQuery("after", "0"), 10, 64)
	if err != nil || after < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid revision"})
		return
	}
	// Subscribe before taking the snapshot to close the HTTP-to-WebSocket gap.
	events, done, unsubscribe := h.service.Subscribe(id)
	defer unsubscribe()
	var snapshot workspacesvc.Snapshot
	if id != "*" {
		snapshot, err = h.service.Snapshot(id)
		if err != nil {
			workspaceError(c, err)
			return
		}
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		if r.Header.Get("Origin") == "" {
			return true
		}
		origin, err := url.Parse(r.Header.Get("Origin"))
		return err == nil && origin.Host == r.Host
	}}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		conn.SetReadLimit(1024)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	write := func(value any) error {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(value)
	}
	// Replay committed events (including transient plugin messages) before the
	// authoritative snapshot. The client deduplicates revisions and mutation IDs.
	if id != "*" && after > 0 {
		earliest, err := h.service.EarliestRevision(id)
		if err != nil {
			return
		}
		if earliest > 0 && after < earliest-1 {
			after = snapshot.Workspace.Revision
		}
		for after < snapshot.Workspace.Revision {
			backlog, err := h.service.Events(id, after)
			if err != nil {
				return
			}
			// Compaction may race the earliest-revision check. Never send a partial delta chain.
			if len(backlog) == 0 || backlog[0].Revision != after+1 {
				break
			}
			for _, event := range backlog {
				if event.Revision > snapshot.Workspace.Revision {
					break
				}
				if write(event) != nil {
					return
				}
				after = event.Revision
			}
		}
	}
	if id == "*" {
		if write(gin.H{"type": "workspace:catalog"}) != nil {
			return
		}
	} else {
		if write(gin.H{"type": "workspace:snapshot", "revision": snapshot.Workspace.Revision, "snapshot": snapshot, "terminal_events": true}) != nil {
			return
		}
	}
	last := snapshot.Workspace.Revision
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-closed:
			return
		case <-done:
			return
		case <-ticker.C:
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
				return
			}
		case event := <-events:
			if event.Type == "terminal:event" {
				if write(event) != nil {
					return
				}
				continue
			}
			if id != "*" && event.Revision <= last {
				continue
			}
			if write(event) != nil {
				return
			}
			last = event.Revision
		}
	}
}
