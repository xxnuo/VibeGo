package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/version"
)

type SystemHandler struct{}

func NewSystemHandler() *SystemHandler {
	return &SystemHandler{}
}

func (h *SystemHandler) Register(r *gin.Engine) {
	r.GET("/version", h.Version)
	r.GET("/health", h.Health)
	r.GET("/__heartbeat__", h.Heartbeat)
	r.GET("/__lbheartbeat__", h.LBHeartbeat)
}

// @Summary Get server version
// @Tags         System
// @Produce      json
// @Success      200  {object}  map[string]string
// @Router       /version [get]
func (h *SystemHandler) Version(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"version": version.Version,
	})
}

// @Summary Health check
// @Tags         System
// @Produce      json
// @Success      200  {object}  map[string]string
// @Router       /health [get]
func (h *SystemHandler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
	})
}

// @Summary Heartbeat check
// @Tags         System
// @Produce      plain
// @Success      200  {string}  string  "Ready"
// @Router       /__heartbeat__ [get]
func (h *SystemHandler) Heartbeat(c *gin.Context) {
	c.String(http.StatusOK, "Ready")
}

// @Summary LBHeartbeat check
// @Tags         System
// @Produce      plain
// @Success      200  {string}  string  "Ready"
// @Router       /__lbheartbeat__ [get]
func (h *SystemHandler) LBHeartbeat(c *gin.Context) {
	c.String(http.StatusOK, "Ready")
}
