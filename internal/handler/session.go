package handler

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Session struct {
	ID        string `gorm:"column:id;primaryKey" json:"id"`
	Name      string `gorm:"column:name" json:"name"`
	Messages  string `gorm:"column:messages;type:text" json:"messages"`
	CreatedAt int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt int64  `gorm:"column:updated_at" json:"updated_at"`
}

type SessionHandler struct {
	db *gorm.DB
}

func NewSessionHandler(db *gorm.DB) *SessionHandler {
	return &SessionHandler{db: db}
}

func (h *SessionHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/session")
	g.GET("/list", h.List)
	g.POST("/new", h.New)
	g.POST("/save", h.Save)
	g.GET("/load", h.Load)
	g.DELETE("/rm", h.Remove)
}

type SessionInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// @Summary List all sessions
// @Tags Session
// @Produce json
// @Success 200 {object} map[string][]SessionInfo
// @Failure 500 {object} map[string]string
// @Router /api/session/list [get]
func (h *SessionHandler) List(c *gin.Context) {
	var sessions []Session
	if err := h.db.Order("updated_at DESC").Find(&sessions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	list := make([]SessionInfo, len(sessions))
	for i, s := range sessions {
		list[i] = SessionInfo{
			ID:        s.ID,
			Name:      s.Name,
			CreatedAt: s.CreatedAt,
			UpdatedAt: s.UpdatedAt,
		}
	}
	c.JSON(http.StatusOK, gin.H{"sessions": list})
}

type NewSessionRequest struct {
	Name string `json:"name"`
}

// @Summary Create new session
// @Tags Session
// @Accept json
// @Produce json
// @Param request body NewSessionRequest false "New session request"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/session/new [post]
func (h *SessionHandler) New(c *gin.Context) {
	var req NewSessionRequest
	c.ShouldBindJSON(&req)
	now := time.Now().Unix()
	session := Session{
		ID:        uuid.New().String(),
		Name:      req.Name,
		Messages:  "[]",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := h.db.Create(&session).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": session.ID})
}

type SaveSessionRequest struct {
	ID       string `json:"id" binding:"required"`
	Name     string `json:"name"`
	Messages string `json:"messages"`
}

// @Summary Save session
// @Tags Session
// @Accept json
// @Produce json
// @Param request body SaveSessionRequest true "Save session request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/session/save [post]
func (h *SessionHandler) Save(c *gin.Context) {
	var req SaveSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var session Session
	if err := h.db.First(&session, "id = ?", req.ID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	updates := map[string]interface{}{
		"updated_at": time.Now().Unix(),
	}
	if req.Name != "" {
		updates["name"] = req.Name
	}
	if req.Messages != "" {
		updates["messages"] = req.Messages
	}
	if err := h.db.Model(&session).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Load session by ID
// @Tags Session
// @Produce json
// @Param id query string true "Session ID"
// @Success 200 {object} Session
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/session/load [get]
func (h *SessionHandler) Load(c *gin.Context) {
	id := c.Query("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	var session Session
	if err := h.db.First(&session, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, session)
}

type RemoveSessionRequest struct {
	ID string `json:"id" binding:"required"`
}

// @Summary Remove session
// @Tags Session
// @Accept json
// @Produce json
// @Param request body RemoveSessionRequest true "Remove session request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/session/rm [delete]
func (h *SessionHandler) Remove(c *gin.Context) {
	var req RemoveSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	result := h.db.Delete(&Session{}, "id = ?", req.ID)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
