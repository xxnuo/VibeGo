package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/settings"
	"gorm.io/gorm"
)

type SettingsHandler struct {
	store *settings.Store
}

func NewSettingsHandler(db *gorm.DB) *SettingsHandler {
	return &SettingsHandler{store: settings.New(db)}
}

func (h *SettingsHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/settings")
	g.GET("/list", h.List)
	g.POST("/set", h.Set)
	g.GET("/get", h.Get)
	g.POST("/reset", h.Reset)
}

// List godoc
// @Summary List all settings
// @Description Get all user settings as key-value pairs
// @Tags Settings
// @Produce json
// @Success 200 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/settings/list [get]
func (h *SettingsHandler) List(c *gin.Context) {
	all, err := h.store.All()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, all)
}

type SetRequest struct {
	Key   string `json:"key" binding:"required"`
	Value string `json:"value" binding:"required"`
}

// Set godoc
// @Summary Set a setting
// @Description Set a user setting by key
// @Tags Settings
// @Accept json
// @Produce json
// @Param request body SetRequest true "Set request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/settings/set [post]
func (h *SettingsHandler) Set(c *gin.Context) {
	var req SetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.Set(req.Key, req.Value); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Get godoc
// @Summary Get a setting by key
// @Description Get a user setting value by key
// @Tags Settings
// @Produce json
// @Param key query string true "Setting key"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/settings/get [get]
func (h *SettingsHandler) Get(c *gin.Context) {
	key := c.Query("key")
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "key is required"})
		return
	}
	val, err := h.store.Get(key)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "key not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"key": key, "value": val})
}

// Reset godoc
// @Summary Reset all settings
// @Description Clear all user settings
// @Tags Settings
// @Produce json
// @Success 200 {object} map[string]bool
// @Failure 500 {object} map[string]string
// @Router /api/settings/reset [post]
func (h *SettingsHandler) Reset(c *gin.Context) {
	if err := h.store.Clear(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
