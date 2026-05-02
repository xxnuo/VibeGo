package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const (
	blockTermHistoryPurgeMaxTargets      = 200
	blockTermHistoryMutationMaxBodyBytes = 256 * 1024
)

var errBlockTermHistoryMutationConflict = errors.New("history changed during update")

type blockTermHistoryOwnerScope struct {
	TerminalID         string  `json:"terminal_id"`
	WorkspaceSessionID *string `json:"workspace_session_id"`
	GroupID            *string `json:"group_id"`
	UserID             *string `json:"user_id"`
}

type blockTermHistoryPatchRequest struct {
	blockTermHistoryOwnerScope
	ID      *string `json:"id"`
	Starred *bool   `json:"starred"`
}

type blockTermHistoryPurgeTarget struct {
	blockTermHistoryOwnerScope
	ID string `json:"id"`
}

type blockTermHistoryPurgeRequest struct {
	Targets []blockTermHistoryPurgeTarget `json:"targets"`
}

func parseBlockTermHistoryStarred(raw string) (bool, bool, error) {
	switch raw {
	case "":
		return false, false, nil
	case "1":
		return true, true, nil
	case "0":
		return false, true, nil
	default:
		return false, false, errors.New("starred must be 0 or 1")
	}
}

func visibleBlockTermHistoryQuery(db *gorm.DB) *gorm.DB {
	return db.Model(&model.BlockTermCommandHistory{}).
		Where("history_purged_at IS NULL").
		Where("command <> ? OR block_deleted_at IS NULL", "")
}

func visibleBlockTermHistoryMetadataQuery(db *gorm.DB) *gorm.DB {
	return visibleBlockTermHistoryQuery(db).Select(`
		id,
		terminal_id,
		workspace_session_id,
		group_id,
		user_id,
		runtime_type,
		ssh_profile_id,
		line_num,
		command,
		cwd,
		starred,
		created_at,
		kind,
		text,
		status,
		mode,
		output_cursor,
		cmd_pid,
		remote_pid,
		term_cols,
		term_rows,
		term_flex_rows,
		term_max_pty_size,
		before_state_json,
		after_state_json,
		exit_code,
		started_at,
		finished_at,
		renderer,
		state_json,
		presentation_json,
		snapshot_updated_at,
		block_deleted_at
	`)
}

func normalizeBlockTermHistoryOwnerScope(scope *blockTermHistoryOwnerScope) error {
	scope.TerminalID = strings.TrimSpace(scope.TerminalID)
	if scope.TerminalID == "" {
		return errors.New("terminal_id is required")
	}
	for _, value := range []*string{scope.WorkspaceSessionID, scope.GroupID, scope.UserID} {
		if value != nil {
			*value = strings.TrimSpace(*value)
		}
	}
	return nil
}

func applyBlockTermHistoryOwnerScope(query *gorm.DB, scope blockTermHistoryOwnerScope) *gorm.DB {
	query = query.Where("terminal_id = ?", scope.TerminalID)
	if scope.WorkspaceSessionID != nil {
		query = query.Where("workspace_session_id = ?", *scope.WorkspaceSessionID)
	}
	if scope.GroupID != nil {
		query = query.Where("group_id = ?", *scope.GroupID)
	}
	if scope.UserID != nil {
		query = query.Where("user_id = ?", *scope.UserID)
	}
	return query
}

func loadVisibleBlockTermHistory(tx *gorm.DB, id string, scope blockTermHistoryOwnerScope) (model.BlockTermCommandHistory, error) {
	var history model.BlockTermCommandHistory
	query := visibleBlockTermHistoryMetadataQuery(tx).Where("id = ?", id)
	if err := applyBlockTermHistoryOwnerScope(query, scope).Take(&history).Error; err != nil {
		return model.BlockTermCommandHistory{}, err
	}
	return history, nil
}

func blockTermHistoryOwnerScopeFromQuery(c *gin.Context) (blockTermHistoryOwnerScope, error) {
	terminalID, ok := c.GetQuery("terminal_id")
	if !ok {
		return blockTermHistoryOwnerScope{}, errors.New("terminal_id is required")
	}
	workspaceSessionID, ok := c.GetQuery("workspace_session_id")
	if !ok {
		return blockTermHistoryOwnerScope{}, errors.New("workspace_session_id is required")
	}
	groupID, ok := c.GetQuery("group_id")
	if !ok {
		return blockTermHistoryOwnerScope{}, errors.New("group_id is required")
	}
	userID, ok := c.GetQuery("user_id")
	if !ok {
		return blockTermHistoryOwnerScope{}, errors.New("user_id is required")
	}
	scope := blockTermHistoryOwnerScope{
		TerminalID:         terminalID,
		WorkspaceSessionID: &workspaceSessionID,
		GroupID:            &groupID,
		UserID:             &userID,
	}
	if err := normalizeBlockTermHistoryOwnerScope(&scope); err != nil {
		return blockTermHistoryOwnerScope{}, err
	}
	return scope, nil
}

func (h *BlockTermHandler) GetHistoryOutput(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	scope, err := blockTermHistoryOwnerScopeFromQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var output struct {
		Output       []byte `gorm:"column:output"`
		OutputCursor *int64 `gorm:"column:output_cursor"`
	}
	h.blockMu.RLock()
	query := visibleBlockTermHistoryQuery(h.db).
		Select("output", "output_cursor").
		Where("id = ?", id)
	err = applyBlockTermHistoryOwnerScope(query, scope).Take(&output).Error
	h.blockMu.RUnlock()
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "history not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if output.OutputCursor != nil {
		c.Header(blockTermOutputCursorHeader, strconv.FormatInt(*output.OutputCursor, 10))
	}
	c.Data(http.StatusOK, "application/octet-stream", output.Output)
}

func syncBlockTermHistoryStarredFromBlock(tx *gorm.DB, block model.BlockTermBlock, starred bool) error {
	if !tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) {
		return nil
	}
	if !blockTermBlockWritesHistory(block) {
		return nil
	}
	var history model.BlockTermCommandHistory
	if err := tx.Where("id = ? AND terminal_id = ? AND created_at = ?", block.ID, block.TerminalID, block.CreatedAt).Take(&history).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	var terminal model.TerminalSession
	if err := tx.First(&terminal, "id = ?", block.TerminalID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if terminal.WorkspaceSessionID != history.WorkspaceSessionID ||
		terminal.GroupID != history.GroupID ||
		terminal.UserID != history.UserID {
		return nil
	}
	return tx.Model(&model.BlockTermCommandHistory{}).
		Where("id = ? AND terminal_id = ? AND created_at = ?", block.ID, block.TerminalID, block.CreatedAt).
		UpdateColumn("starred", starred).Error
}

func syncBlockTermBlockStarredFromHistory(tx *gorm.DB, history model.BlockTermCommandHistory, starred bool) error {
	var block model.BlockTermBlock
	if err := tx.Where("id = ? AND terminal_id = ? AND created_at = ?", history.ID, history.TerminalID, history.CreatedAt).Take(&block).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if !blockTermBlockWritesHistory(block) {
		return nil
	}
	var terminal model.TerminalSession
	if err := tx.First(&terminal, "id = ?", block.TerminalID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if terminal.WorkspaceSessionID != history.WorkspaceSessionID ||
		terminal.GroupID != history.GroupID ||
		terminal.UserID != history.UserID {
		return nil
	}
	return tx.Model(&model.BlockTermBlock{}).
		Where("id = ? AND terminal_id = ? AND created_at = ?", history.ID, history.TerminalID, history.CreatedAt).
		UpdateColumn("starred", starred).Error
}

func bindBlockTermHistoryMutationJSON(c *gin.Context, target any) error {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermHistoryMutationMaxBodyBytes)
	return c.ShouldBindJSON(target)
}

func writeBlockTermHistoryBindError(c *gin.Context, err error) {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
		return
	}
	c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
}

func (h *BlockTermHandler) PatchHistory(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	var req blockTermHistoryPatchRequest
	if err := bindBlockTermHistoryMutationJSON(c, &req); err != nil {
		writeBlockTermHistoryBindError(c, err)
		return
	}
	if req.ID != nil {
		*req.ID = strings.TrimSpace(*req.ID)
		if *req.ID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
			return
		}
		if *req.ID != id {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id must match path"})
			return
		}
	}
	if err := normalizeBlockTermHistoryOwnerScope(&req.blockTermHistoryOwnerScope); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Starred == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "starred is required"})
		return
	}

	var history model.BlockTermCommandHistory
	h.blockMu.Lock()
	err := h.db.Transaction(func(tx *gorm.DB) error {
		loaded, err := loadVisibleBlockTermHistory(tx, id, req.blockTermHistoryOwnerScope)
		if err != nil {
			return err
		}
		result := tx.Model(&model.BlockTermCommandHistory{}).
			Where("id = ? AND terminal_id = ? AND history_purged_at IS NULL", loaded.ID, loaded.TerminalID).
			UpdateColumn("starred", *req.Starred)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errBlockTermHistoryMutationConflict
		}
		loaded.Starred = *req.Starred
		if err := syncBlockTermBlockStarredFromHistory(tx, loaded, *req.Starred); err != nil {
			return err
		}
		return visibleBlockTermHistoryMetadataQuery(tx).
			Where("id = ? AND terminal_id = ?", loaded.ID, loaded.TerminalID).
			Take(&history).Error
	})
	h.blockMu.Unlock()
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "history not found"})
		return
	}
	if errors.Is(err, errBlockTermHistoryMutationConflict) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"history": history})
}

func (h *BlockTermHandler) PurgeHistory(c *gin.Context) {
	var req blockTermHistoryPurgeRequest
	if err := bindBlockTermHistoryMutationJSON(c, &req); err != nil {
		writeBlockTermHistoryBindError(c, err)
		return
	}
	if len(req.Targets) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "targets must contain at least one item"})
		return
	}
	if len(req.Targets) > blockTermHistoryPurgeMaxTargets {
		c.JSON(http.StatusBadRequest, gin.H{"error": "targets cannot contain more than 200 items"})
		return
	}
	seen := make(map[string]struct{}, len(req.Targets))
	for i := range req.Targets {
		req.Targets[i].ID = strings.TrimSpace(req.Targets[i].ID)
		if req.Targets[i].ID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "target id is required"})
			return
		}
		if err := normalizeBlockTermHistoryOwnerScope(&req.Targets[i].blockTermHistoryOwnerScope); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if _, exists := seen[req.Targets[i].ID]; exists {
			c.JSON(http.StatusBadRequest, gin.H{"error": "duplicate history id"})
			return
		}
		seen[req.Targets[i].ID] = struct{}{}
	}

	purgedIDs := make([]string, len(req.Targets))
	h.blockMu.Lock()
	err := h.db.Transaction(func(tx *gorm.DB) error {
		for i, target := range req.Targets {
			if _, err := loadVisibleBlockTermHistory(tx, target.ID, target.blockTermHistoryOwnerScope); err != nil {
				return err
			}
			purgedIDs[i] = target.ID
		}
		purgedAt := time.Now().Unix()
		result := tx.Model(&model.BlockTermCommandHistory{}).
			Where("id IN ? AND history_purged_at IS NULL", purgedIDs).
			UpdateColumn("history_purged_at", purgedAt)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != int64(len(purgedIDs)) {
			return errBlockTermHistoryMutationConflict
		}
		return nil
	})
	h.blockMu.Unlock()
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "history not found"})
		return
	}
	if errors.Is(err, errBlockTermHistoryMutationConflict) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"purged_ids": purgedIDs})
}
