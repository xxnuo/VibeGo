package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const (
	blockTermBookmarkDefaultLimit      = 100
	blockTermBookmarkMaxLimit          = 200
	blockTermBookmarkMaxTitleLen       = 256
	blockTermBookmarkMaxDescriptionLen = 4 * 1024
	blockTermBookmarkMaxCommandLen     = 16 * 1024
	blockTermBookmarkMaxQueryLen       = 1024
	blockTermBookmarkMaxBodyBytes      = 128 * 1024
)

type createBlockTermBookmarkRequest struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Command     string `json:"command"`
}

type patchBlockTermBookmarkRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	Command     *string `json:"command"`
}

func (h *BlockTermHandler) registerBookmarkRoutes(r *gin.RouterGroup) {
	g := r.Group("/blockterm/bookmarks")
	g.GET("", h.ListBookmarks)
	g.POST("", h.CreateBookmark)
	g.PATCH("/:id", h.PatchBookmark)
	g.DELETE("/:id", h.DeleteBookmark)
}

func bindBlockTermBookmarkJSON(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermBookmarkMaxBodyBytes)
	if err := c.ShouldBindJSON(target); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return false
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return false
	}
	return true
}

func validateBlockTermBookmarkTitle(title string) error {
	if len(title) > blockTermBookmarkMaxTitleLen {
		return fmt.Errorf("title is too long, max length is %d", blockTermBookmarkMaxTitleLen)
	}
	return nil
}

func validateBlockTermBookmarkDescription(description string) error {
	if len(description) > blockTermBookmarkMaxDescriptionLen {
		return fmt.Errorf("description is too long, max length is %d", blockTermBookmarkMaxDescriptionLen)
	}
	return nil
}

func validateBlockTermBookmarkCommand(command string) error {
	if len(command) > blockTermBookmarkMaxCommandLen {
		return fmt.Errorf("command is too long, max length is %d", blockTermBookmarkMaxCommandLen)
	}
	if strings.TrimSpace(command) == "" {
		return errors.New("command is required")
	}
	return nil
}

func validateBlockTermBookmark(title, description, command string) error {
	if err := validateBlockTermBookmarkTitle(title); err != nil {
		return err
	}
	if err := validateBlockTermBookmarkDescription(description); err != nil {
		return err
	}
	return validateBlockTermBookmarkCommand(command)
}

func parseBlockTermBookmarkLimit(raw string) (int, error) {
	if raw == "" {
		return blockTermBookmarkDefaultLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return 0, errors.New("limit must be a positive integer")
	}
	if limit > blockTermBookmarkMaxLimit {
		limit = blockTermBookmarkMaxLimit
	}
	return limit, nil
}

func escapeBlockTermBookmarkLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func (h *BlockTermHandler) ListBookmarks(c *gin.Context) {
	limit, err := parseBlockTermBookmarkLimit(c.Query("limit"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	search := c.Query("q")
	if len(search) > blockTermBookmarkMaxQueryLen {
		c.JSON(http.StatusBadRequest, gin.H{"error": "query is too long"})
		return
	}

	bookmarks := make([]model.BlockTermBookmark, 0)
	query := h.db.Model(&model.BlockTermBookmark{})
	if search != "" {
		pattern := "%" + escapeBlockTermBookmarkLike(search) + "%"
		query = query.Where(`(
			title LIKE ? ESCAPE '\' OR
			description LIKE ? ESCAPE '\' OR
			command LIKE ? ESCAPE '\'
		)`, pattern, pattern, pattern)
	}
	if err := query.Order("updated_at DESC, id DESC").Limit(limit).Find(&bookmarks).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"bookmarks": bookmarks})
}

func (h *BlockTermHandler) CreateBookmark(c *gin.Context) {
	var req createBlockTermBookmarkRequest
	if !bindBlockTermBookmarkJSON(c, &req) {
		return
	}
	if err := validateBlockTermBookmark(req.Title, req.Description, req.Command); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	now := time.Now().UnixMilli()
	bookmark := model.BlockTermBookmark{
		ID:          uuid.NewString(),
		Title:       req.Title,
		Description: req.Description,
		Command:     req.Command,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.db.Create(&bookmark).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"bookmark": bookmark})
}

func (h *BlockTermHandler) PatchBookmark(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	var req patchBlockTermBookmarkRequest
	if !bindBlockTermBookmarkJSON(c, &req) {
		return
	}
	updates := make(map[string]any)
	if req.Title != nil {
		if err := validateBlockTermBookmarkTitle(*req.Title); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updates["title"] = *req.Title
	}
	if req.Description != nil {
		if err := validateBlockTermBookmarkDescription(*req.Description); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updates["description"] = *req.Description
	}
	if req.Command != nil {
		if err := validateBlockTermBookmarkCommand(*req.Command); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updates["command"] = *req.Command
	}
	if len(updates) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one field is required"})
		return
	}
	now := time.Now().UnixMilli()
	updates["updated_at"] = gorm.Expr("CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END", now, now)

	result := h.db.Model(&model.BlockTermBookmark{}).Where("id = ?", id).Updates(updates)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "bookmark not found"})
		return
	}

	var bookmark model.BlockTermBookmark
	if err := h.db.First(&bookmark, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "bookmark not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"bookmark": bookmark})
}

func (h *BlockTermHandler) DeleteBookmark(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	result := h.db.Delete(&model.BlockTermBookmark{}, "id = ?", id)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": result.Error.Error()})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "bookmark not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
