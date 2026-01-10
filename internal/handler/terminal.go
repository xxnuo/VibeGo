package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type TerminalHandler struct {
	manager *terminal.Manager
}

func NewTerminalHandler(db *gorm.DB, shell string) *TerminalHandler {
	mgr := terminal.NewManager(db, &terminal.ManagerConfig{Shell: shell})
	mgr.CleanupOnStart()

	return &TerminalHandler{manager: mgr}
}

func (h *TerminalHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/terminal")
	g.GET("/list", h.List)
	g.POST("/new", h.New)
	g.POST("/close", h.Close)
	g.GET("/ws/:id", h.WebSocket)
}

type TerminalInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Shell       string `json:"shell"`
	Cwd         string `json:"cwd"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	Status      string `json:"status"`
	PTYStatus   string `json:"pty_status"`
	ExitCode    int    `json:"exit_code"`
	HistorySize int64  `json:"history_size"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

// List godoc
// @Summary List terminal sessions
// @Tags Terminal
// @Produce json
// @Success 200 {object} map[string][]TerminalInfo
// @Failure 500 {object} map[string]string
// @Router /api/terminal/list [get]
func (h *TerminalHandler) List(c *gin.Context) {
	sessions, err := h.manager.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	list := make([]TerminalInfo, len(sessions))
	for i, s := range sessions {
		list[i] = TerminalInfo{
			ID:        s.ID,
			Name:      s.Name,
			Shell:     s.Shell,
			Cwd:       s.Cwd,
			Cols:      s.Cols,
			Rows:      s.Rows,
			Status:    s.Status,
			PTYStatus: s.PTYStatus,
			CreatedAt: s.CreatedAt,
			UpdatedAt: s.UpdatedAt,
		}
	}
	c.JSON(http.StatusOK, gin.H{"terminals": list})
}

type NewTerminalRequest struct {
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// New godoc
// @Summary Create new terminal session
// @Tags Terminal
// @Accept json
// @Produce json
// @Param request body NewTerminalRequest true "Terminal options"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/terminal/new [post]
func (h *TerminalHandler) New(c *gin.Context) {
	var req NewTerminalRequest
	c.ShouldBindJSON(&req)

	info, err := h.manager.Create(terminal.CreateOptions{
		Name: req.Name,
		Cwd:  req.Cwd,
		Cols: req.Cols,
		Rows: req.Rows,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": info.ID, "name": info.Name})
}

type CloseTerminalRequest struct {
	ID string `json:"id" binding:"required"`
}

// Close godoc
// @Summary Close terminal session
// @Tags Terminal
// @Accept json
// @Produce json
// @Param request body CloseTerminalRequest true "Terminal ID"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/terminal/close [post]
func (h *TerminalHandler) Close(c *gin.Context) {
	var req CloseTerminalRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.manager.Close(req.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// WebSocket godoc
// @Summary Connect to terminal websocket
// @Tags Terminal
// @Param id path string true "Terminal ID"
// @Router /api/terminal/ws/{id} [get]
func (h *TerminalHandler) WebSocket(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	termConn, err := h.manager.Attach(id, conn, terminal.AttachOptions{Reactivate: true})
	if err != nil {
		conn.Close()
		return
	}

	<-termConn.Done
}
