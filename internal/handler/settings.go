package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/kv"
	"gorm.io/gorm"
)

type SettingsHandler struct {
	store *kv.Store
}

func NewSettingsHandler(db *gorm.DB) *SettingsHandler {
	store, err := kv.New(db)
	if err != nil {
		panic(err)
	}
	return &SettingsHandler{store: store}
}

func (h *SettingsHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/settings")
	g.GET("/list", h.List)
	g.POST("/set", h.Set)
	g.GET("/get", h.Get)
	g.POST("/reset", h.Reset)
}

// @Summary List all settings
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

// @Summary Set a setting
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

// @Summary Get a setting by key
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

// @Summary Reset all settings
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
