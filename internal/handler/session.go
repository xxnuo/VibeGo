package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

const maxSessionNameLength = 50

var (
	errInvalidSessionUpdate  = errors.New("invalid session update")
	errInvalidSessionReorder = errors.New("invalid session reorder")
)

type SessionHandler struct {
	db      *gorm.DB
	manager *terminal.Manager
}

func NewSessionHandler(db *gorm.DB, managers ...*terminal.Manager) *SessionHandler {
	var manager *terminal.Manager
	if len(managers) > 0 {
		manager = managers[0]
	}
	return &SessionHandler{db: db, manager: manager}
}

func (h *SessionHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/session")
	g.GET("", h.List)
	g.POST("", h.Create)
	g.POST("/reorder", h.Reorder)
	g.GET("/:id", h.Get)
	g.PUT("/:id", h.Update)
	g.PATCH("/:id/workspace", h.PatchWorkspace)
	g.DELETE("/:id", h.Delete)
}

type SessionInfo struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Name      string `json:"name"`
	Position  int64  `json:"position"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type SessionDetail struct {
	ID             string         `json:"id"`
	UserID         string         `json:"user_id"`
	Name           string         `json:"name"`
	Position       int64          `json:"position"`
	State          string         `json:"state"`
	WorkspaceState WorkspaceState `json:"workspace_state"`
	LastActiveAt   int64          `json:"last_active_at"`
	ExpiredAt      int64          `json:"expired_at"`
	CreatedAt      int64          `json:"created_at"`
	UpdatedAt      int64          `json:"updated_at"`
}

func (h *SessionHandler) List(c *gin.Context) {
	page := 1
	pageSize := 50
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
	if err := orderedSessions(h.db).Offset(offset).Limit(pageSize).Find(&sessions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	list := make([]SessionInfo, len(sessions))
	for i, s := range sessions {
		list[i] = SessionInfo{
			ID:        s.ID,
			UserID:    s.UserID,
			Name:      s.Name,
			Position:  s.Position,
			CreatedAt: s.CreatedAt,
			UpdatedAt: s.UpdatedAt,
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
	Name   string `json:"name"`
	UserID string `json:"user_id"`
}

func (h *SessionHandler) Create(c *gin.Context) {
	var req CreateSessionRequest
	c.ShouldBindJSON(&req)

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Untitled Session"
	} else {
		var err error
		name, err = normalizeSessionName(name)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	now := time.Now().Unix()
	expiredAt := now + 7*24*60*60
	state, err := marshalWorkspaceState(emptyWorkspaceState())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	session := model.UserSession{
		ID:           uuid.New().String(),
		UserID:       req.UserID,
		Name:         name,
		State:        state,
		LastActiveAt: now,
		ExpiredAt:    expiredAt,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := h.db.Transaction(func(tx *gorm.DB) error {
		position, err := nextSessionPosition(tx)
		if err != nil {
			return err
		}
		session.Position = position
		return tx.Create(&session).Error
	}); err != nil {
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

	now := time.Now().Unix()
	if session.ExpiredAt > 0 && now > session.ExpiredAt {
		c.JSON(http.StatusGone, gin.H{"error": "session expired"})
		return
	}

	if c.Query("touch") != "false" {
		h.db.Model(&session).Update("last_active_at", now)
		session.LastActiveAt = now
	}

	workspaceState, err := parseWorkspaceState(session.State)
	if err != nil {
		workspaceState = emptyWorkspaceState()
	}

	c.JSON(http.StatusOK, SessionDetail{
		ID:             session.ID,
		UserID:         session.UserID,
		Name:           session.Name,
		Position:       session.Position,
		State:          session.State,
		WorkspaceState: workspaceState,
		LastActiveAt:   session.LastActiveAt,
		ExpiredAt:      session.ExpiredAt,
		CreatedAt:      session.CreatedAt,
		UpdatedAt:      session.UpdatedAt,
	})
}

type UpdateSessionRequest struct {
	Name                  *string             `json:"name,omitempty"`
	WorkspaceNameOverride optionalStringPatch `json:"workspaceNameOverride,omitempty"`
}

func (h *SessionHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var req UpdateSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Name != nil {
		name, err := normalizeSessionName(*req.Name)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		req.Name = &name
	}
	if req.WorkspaceNameOverride.Set && req.WorkspaceNameOverride.Value != nil {
		override, err := normalizeSessionName(*req.WorkspaceNameOverride.Value)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		req.WorkspaceNameOverride.Value = &override
		if req.Name == nil {
			req.Name = &override
		} else if *req.Name != override {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name and workspaceNameOverride must match"})
			return
		}
	}

	var err error
	if h.manager != nil {
		err = h.manager.MutateWorkspace(id, func(tx *gorm.DB) error {
			return updateSession(tx, id, req)
		})
	} else {
		err = h.db.Transaction(func(tx *gorm.DB) error {
			return updateSession(tx, id, req)
		})
	}
	if err != nil {
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound), errors.Is(err, terminal.ErrWorkspaceNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		case errors.Is(err, errInvalidSessionUpdate), errors.Is(err, errWorkspaceStatePatchInvalid):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type ReorderSessionsRequest struct {
	IDs []string `json:"ids"`
}

func (h *SessionHandler) Reorder(c *gin.Context) {
	var req ReorderSessionsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids is required"})
		return
	}

	seen := make(map[string]struct{}, len(req.IDs))
	for i := range req.IDs {
		req.IDs[i] = strings.TrimSpace(req.IDs[i])
		if req.IDs[i] == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "session id is required"})
			return
		}
		if _, exists := seen[req.IDs[i]]; exists {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("duplicate session id %q", req.IDs[i])})
			return
		}
		seen[req.IDs[i]] = struct{}{}
	}

	err := h.db.Transaction(func(tx *gorm.DB) error {
		var sessions []model.UserSession
		if err := orderedSessions(tx).Find(&sessions).Error; err != nil {
			return err
		}
		byID := make(map[string]model.UserSession, len(sessions))
		for _, session := range sessions {
			byID[session.ID] = session
		}
		ordered := make([]model.UserSession, 0, len(sessions))
		for _, id := range req.IDs {
			session, exists := byID[id]
			if !exists {
				return fmt.Errorf("%w: session %q not found", errInvalidSessionReorder, id)
			}
			ordered = append(ordered, session)
		}
		for _, session := range sessions {
			if _, specified := seen[session.ID]; !specified {
				ordered = append(ordered, session)
			}
		}
		for i, session := range ordered {
			position := int64(i + 1)
			if session.Position == position {
				continue
			}
			if err := tx.Model(&model.UserSession{}).Where("id = ?", session.ID).UpdateColumn("position", position).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, errInvalidSessionReorder) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func normalizeSessionName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: name is required", errInvalidSessionUpdate)
	}
	if utf8.RuneCountInString(value) > maxSessionNameLength {
		return "", fmt.Errorf("%w: name must be at most %d characters", errInvalidSessionUpdate, maxSessionNameLength)
	}
	return value, nil
}

func nextSessionPosition(db *gorm.DB) (int64, error) {
	var maxPosition int64
	if err := db.Model(&model.UserSession{}).Select("COALESCE(MAX(position), 0)").Scan(&maxPosition).Error; err != nil {
		return 0, err
	}
	return maxPosition + 1, nil
}

func orderedSessions(db *gorm.DB) *gorm.DB {
	return db.
		Order("CASE WHEN position > 0 THEN 0 ELSE 1 END ASC").
		Order("CASE WHEN position > 0 THEN position ELSE 0 END ASC").
		Order("updated_at DESC").
		Order("id ASC")
}

func updateSession(db *gorm.DB, id string, req UpdateSessionRequest) error {
	var session model.UserSession
	if err := db.First(&session, "id = ?", id).Error; err != nil {
		return err
	}

	now := time.Now().Unix()
	updates := map[string]any{
		"updated_at":     now,
		"last_active_at": now,
	}
	if req.Name != nil {
		updates["name"] = *req.Name
	}
	if req.WorkspaceNameOverride.Set {
		state, err := parseWorkspaceState(session.State)
		if err != nil {
			return fmt.Errorf("%w: %v", errWorkspaceStateStoredInvalid, err)
		}
		state.WorkspaceNameOverride = req.WorkspaceNameOverride.Value
		rawState, err := marshalWorkspaceState(state)
		if err != nil {
			return fmt.Errorf("%w: %v", errWorkspaceStatePatchInvalid, err)
		}
		updates["state"] = rawState
	}

	result := db.Model(&model.UserSession{}).Where("id = ?", id).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (h *SessionHandler) PatchWorkspace(c *gin.Context) {
	id := c.Param("id")

	var req WorkspaceStatePatch
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	mutation := func(tx *gorm.DB) error {
		// Check the workspace before inspecting terminal rows. This keeps the
		// missing-workspace response deterministic even when the request also
		// contains stale or cross-scope terminal IDs.
		var workspace model.UserSession
		if err := tx.Select("id").First(&workspace, "id = ?", id).Error; err != nil {
			return err
		}
		if req.TerminalsByGroup != nil {
			if err := canonicalizeWorkspaceTerminalSettings(tx, id, *req.TerminalsByGroup); err != nil {
				return err
			}
		}
		_, err := updateSessionWorkspaceState(tx, id, req)
		return err
	}

	var err error
	if h.manager != nil {
		err = h.manager.MutateWorkspace(id, mutation)
	} else {
		err = h.db.Transaction(mutation)
	}
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, terminal.ErrWorkspaceNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
		if errors.Is(err, errWorkspaceStateStoredInvalid) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, errWorkspaceStatePatchInvalid) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, terminal.ErrTerminalNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, terminal.ErrTerminalScopeMismatch) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SessionHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	// Keep lightweight handler tests and callers that do not configure terminal
	// lifecycle management compatible with the original session-only delete.
	if h.manager == nil {
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
		return
	}
	if err := h.manager.DeleteWorkspace(id); err != nil {
		if errors.Is(err, terminal.ErrWorkspaceNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
