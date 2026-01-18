package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type SessionHandler struct {
	db *gorm.DB
}

func NewSessionHandler(db *gorm.DB) *SessionHandler {
	return &SessionHandler{db: db}
}

func (h *SessionHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/session")
	g.GET("", h.List)
	g.POST("", h.Create)
	g.GET("/current", h.GetCurrent)
	g.PUT("/current/state", h.SaveCurrentState)
	g.GET("/:id", h.Get)
	g.PUT("/:id/state", h.SaveState)
	g.DELETE("/:id", h.Delete)
}

type SessionInfo struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
}

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
	h.db.Model(&model.UserSession{}).Count(&total)

	var sessions []model.UserSession
	offset := (page - 1) * pageSize
	if err := h.db.Order("updated_at DESC").Offset(offset).Limit(pageSize).Find(&sessions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	list := make([]SessionInfo, len(sessions))
	for i, s := range sessions {
		list[i] = SessionInfo{
			ID:         s.ID,
			UserID:     s.UserID,
			DeviceID:   s.DeviceID,
			DeviceName: s.DeviceName,
			CreatedAt:  s.CreatedAt,
			UpdatedAt:  s.UpdatedAt,
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"sessions":  list,
		"page":      page,
		"page_size": pageSize,
		"total":     total,
	})
}

type CreateSessionRequest struct {
	UserID     string `json:"user_id"`
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
}

func (h *SessionHandler) Create(c *gin.Context) {
	var req CreateSessionRequest
	c.ShouldBindJSON(&req)

	now := time.Now().Unix()
	session := model.UserSession{
		ID:         uuid.New().String(),
		UserID:     req.UserID,
		DeviceID:   req.DeviceID,
		DeviceName: req.DeviceName,
		State:      "{}",
		CreatedAt:  now,
		UpdatedAt:  now,
		ExpiresAt:  now + 30*24*60*60,
	}

	if err := h.db.Create(&session).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"ok": true, "id": session.ID})
}

func (h *SessionHandler) Get(c *gin.Context) {
	id := c.Param("id")
	var session model.UserSession
	if err := h.db.First(&session, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, session)
}

type SaveStateRequest struct {
	State string `json:"state"`
}

func (h *SessionHandler) SaveState(c *gin.Context) {
	id := c.Param("id")
	var session model.UserSession
	if err := h.db.First(&session, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	var req SaveStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.Model(&session).Updates(map[string]any{
		"state":      req.State,
		"updated_at": time.Now().Unix(),
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SessionHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	result := h.db.Delete(&model.UserSession{}, "id = ?", id)
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

func (h *SessionHandler) GetCurrent(c *gin.Context) {
	deviceID := c.GetHeader("X-Device-ID")
	if deviceID == "" {
		deviceID = "default"
	}

	var session model.UserSession
	result := h.db.First(&session, "device_id = ?", deviceID)

	if result.Error == gorm.ErrRecordNotFound {
		now := time.Now().Unix()
		session = model.UserSession{
			ID:         uuid.New().String(),
			UserID:     "",
			DeviceID:   deviceID,
			DeviceName: c.GetHeader("X-Device-Name"),
			State:      "{}",
			CreatedAt:  now,
			UpdatedAt:  now,
			ExpiresAt:  now + 30*24*60*60,
		}
		if err := h.db.Create(&session).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	}

	c.JSON(http.StatusOK, session)
}

func (h *SessionHandler) SaveCurrentState(c *gin.Context) {
	deviceID := c.GetHeader("X-Device-ID")
	if deviceID == "" {
		deviceID = "default"
	}

	var session model.UserSession
	result := h.db.First(&session, "device_id = ?", deviceID)

	if result.Error == gorm.ErrRecordNotFound {
		now := time.Now().Unix()
		session = model.UserSession{
			ID:         uuid.New().String(),
			UserID:     "",
			DeviceID:   deviceID,
			DeviceName: c.GetHeader("X-Device-Name"),
			State:      "{}",
			CreatedAt:  now,
			UpdatedAt:  now,
			ExpiresAt:  now + 30*24*60*60,
		}
		if err := h.db.Create(&session).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	}

	var req SaveStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.Model(&session).Updates(map[string]any{
		"state":      req.State,
		"updated_at": time.Now().Unix(),
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
