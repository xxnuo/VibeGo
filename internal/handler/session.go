package handler

import (
	"net/http"
	"strconv"
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
	g.GET("", h.List)
	g.POST("", h.New)
	g.GET("/:id", h.Load)
	g.PUT("/:id", h.Save)
	g.DELETE("/:id", h.Remove)
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
// @Param page query int false "Page number (default 1)"
// @Param page_size query int false "Page size (default 20)"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/session [get]
func (h *SessionHandler) List(c *gin.Context) {
	page := 1
	pageSize := 20
	if p := c.Query("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			page = n
		}
	}
	if ps := c.Query("page_size"); ps != "" {
		if n, err := strconv.Atoi(ps); err == nil && n > 0 && n <= 100 {
			pageSize = n
		}
	}

	var total int64
	h.db.Model(&Session{}).Count(&total)

	var sessions []Session
	offset := (page - 1) * pageSize
	if err := h.db.Order("updated_at DESC").Offset(offset).Limit(pageSize).Find(&sessions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	list := make([]SessionInfo, len(sessions))
	for i, s := range sessions {
		list[i] = SessionInfo{ID: s.ID, Name: s.Name, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt}
	}
	c.JSON(http.StatusOK, gin.H{
		"sessions":   list,
		"page":       page,
		"page_size":  pageSize,
		"total":      total,
	})
}

type NewSessionRequest struct {
	Name string `json:"name"`
}

// @Summary Create new session
// @Tags Session
// @Accept json
// @Produce json
// @Param request body NewSessionRequest false "New session request"
// @Success 201 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/session [post]
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
	c.JSON(http.StatusCreated, gin.H{"ok": true, "id": session.ID})
}

type SaveSessionRequest struct {
	Name     string `json:"name"`
	Messages string `json:"messages"`
}

// @Summary Save session
// @Tags Session
// @Accept json
// @Produce json
// @Param id path string true "Session ID"
// @Param request body SaveSessionRequest true "Save session request"
// @Success 200 {object} map[string]bool
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/session/{id} [put]
func (h *SessionHandler) Save(c *gin.Context) {
	id := c.Param("id")
	var session Session
	if err := h.db.First(&session, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	var req SaveSessionRequest
	c.ShouldBindJSON(&req)
	updates := map[string]interface{}{"updated_at": time.Now().Unix()}
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
// @Param id path string true "Session ID"
// @Success 200 {object} Session
// @Failure 404 {object} map[string]string
// @Router /api/session/{id} [get]
func (h *SessionHandler) Load(c *gin.Context) {
	id := c.Param("id")
	var session Session
	if err := h.db.First(&session, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, session)
}

// @Summary Remove session
// @Tags Session
// @Produce json
// @Param id path string true "Session ID"
// @Success 200 {object} map[string]bool
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/session/{id} [delete]
func (h *SessionHandler) Remove(c *gin.Context) {
	id := c.Param("id")
	result := h.db.Delete(&Session{}, "id = ?", id)
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
