package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type WorkspaceHandler struct {
	db *gorm.DB
}

func NewWorkspaceHandler(db *gorm.DB) *WorkspaceHandler {
	return &WorkspaceHandler{db: db}
}

func (h *WorkspaceHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/workspace")
	g.GET("", h.List)
	g.GET("/recent", h.Recent)
	g.POST("/open", h.Open)
	g.GET("/:id", h.Get)
	g.PUT("/:id/state", h.SaveState)
	g.PUT("/:id/pin", h.TogglePin)
	g.DELETE("/:id", h.Delete)
}

type WorkspaceInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	IsPinned   bool   `json:"is_pinned"`
	LastOpenAt int64  `json:"last_open_at"`
	CreatedAt  int64  `json:"created_at"`
}

func (h *WorkspaceHandler) List(c *gin.Context) {
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
	h.db.Model(&model.Workspace{}).Count(&total)

	var workspaces []model.Workspace
	offset := (page - 1) * pageSize
	if err := h.db.Order("last_open_at DESC").Offset(offset).Limit(pageSize).Find(&workspaces).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	list := make([]WorkspaceInfo, len(workspaces))
	for i, w := range workspaces {
		list[i] = WorkspaceInfo{
			ID:         w.ID,
			Name:       w.Name,
			Path:       w.Path,
			IsPinned:   w.IsPinned,
			LastOpenAt: w.LastOpenAt,
			CreatedAt:  w.CreatedAt,
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"workspaces": list,
		"page":       page,
		"page_size":  pageSize,
		"total":      total,
	})
}

func (h *WorkspaceHandler) Recent(c *gin.Context) {
	limit := 10
	if l := c.Query("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 50 {
			limit = n
		}
	}

	var workspaces []model.Workspace
	if err := h.db.Order("last_open_at DESC").Limit(limit).Find(&workspaces).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	list := make([]WorkspaceInfo, len(workspaces))
	for i, w := range workspaces {
		list[i] = WorkspaceInfo{
			ID:         w.ID,
			Name:       w.Name,
			Path:       w.Path,
			IsPinned:   w.IsPinned,
			LastOpenAt: w.LastOpenAt,
			CreatedAt:  w.CreatedAt,
		}
	}

	c.JSON(http.StatusOK, gin.H{"workspaces": list})
}

type OpenWorkspaceRequest struct {
	Path string `json:"path" binding:"required"`
}

func (h *WorkspaceHandler) Open(c *gin.Context) {
	var req OpenWorkspaceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}

	absPath, err := filepath.Abs(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid path"})
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "path does not exist"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is not a directory"})
		return
	}

	now := time.Now().Unix()

	var workspace model.Workspace
	result := h.db.First(&workspace, "path = ?", absPath)

	if result.Error == gorm.ErrRecordNotFound {
		workspace = model.Workspace{
			ID:         uuid.New().String(),
			UserID:     "",
			Name:       filepath.Base(absPath),
			Path:       absPath,
			State:      "{}",
			IsPinned:   false,
			LastOpenAt: now,
			CreatedAt:  now,
			UpdatedAt:  now,
		}
		if err := h.db.Create(&workspace).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	} else {
		if err := h.db.Model(&workspace).Updates(map[string]any{
			"last_open_at": now,
			"updated_at":   now,
		}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"ok": true,
		"workspace": WorkspaceInfo{
			ID:         workspace.ID,
			Name:       workspace.Name,
			Path:       workspace.Path,
			IsPinned:   workspace.IsPinned,
			LastOpenAt: workspace.LastOpenAt,
			CreatedAt:  workspace.CreatedAt,
		},
	})
}

func (h *WorkspaceHandler) Get(c *gin.Context) {
	id := c.Param("id")
	var workspace model.Workspace
	if err := h.db.First(&workspace, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "workspace not found"})
		return
	}
	c.JSON(http.StatusOK, workspace)
}

type SaveWorkspaceStateRequest struct {
	State string `json:"state"`
}

func (h *WorkspaceHandler) SaveState(c *gin.Context) {
	id := c.Param("id")
	var workspace model.Workspace
	if err := h.db.First(&workspace, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "workspace not found"})
		return
	}

	var req SaveWorkspaceStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.Model(&workspace).Updates(map[string]any{
		"state":      req.State,
		"updated_at": time.Now().Unix(),
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type TogglePinRequest struct {
	IsPinned bool `json:"is_pinned"`
}

func (h *WorkspaceHandler) TogglePin(c *gin.Context) {
	id := c.Param("id")
	var workspace model.Workspace
	if err := h.db.First(&workspace, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "workspace not found"})
		return
	}

	var req TogglePinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.Model(&workspace).Updates(map[string]any{
		"is_pinned":  req.IsPinned,
		"updated_at": time.Now().Unix(),
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *WorkspaceHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	result := h.db.Delete(&model.Workspace{}, "id = ?", id)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "workspace not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
