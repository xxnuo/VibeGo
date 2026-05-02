package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermhistory"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	blockTermMaxRendererLen     = 50
	blockTermMaxStateJSONLen    = 4 * 1024
	blockTermHistoryLimit       = 100
	blockTermHistoryMaxLimit    = 200
	blockTermMaxOutputBytes     = model.BlockTermMaxPTYSize
	blockTermOutputCursorHeader = "X-BlockTerm-Output-Cursor"
	blockTermOutputStartHeader  = "X-BlockTerm-Output-Start-Cursor"
	blockTermOutputEndHeader    = "X-BlockTerm-Output-End-Cursor"
)

var (
	blockTermRendererRe        = regexp.MustCompile("^[a-zA-Z][a-zA-Z0-9_.:-]*$")
	errBlockTermOutputConflict = errors.New("block output cursor conflict")
	errBlockTermDeleted        = errors.New("block has been deleted")
	errBlockTermOutputMoved    = errors.New("block terminal changed while loading raw output")
	errBlockTermModelOwned     = errors.New("model blocks must be managed through the blockterm model API")
)

// BlockTermHandler exposes the durable command-block store used by BlockTerm.
type BlockTermHandler struct {
	manager *terminal.Manager
	db      *gorm.DB
	// blockMu serializes block mutations with reads that need a coherent
	// snapshot. The terminal lifecycle lock only protects terminal deletion;
	// it intentionally allows concurrent block requests, which otherwise lets a
	// raw-output read race a PATCH/DELETE of the same block.
	blockMu *sync.RWMutex
}

func NewBlockTermHandler(manager *terminal.Manager) *BlockTermHandler {
	return &BlockTermHandler{manager: manager, db: manager.DB(), blockMu: manager.BlockTermMutationGate()}
}

func (h *BlockTermHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/blockterm/blocks")
	g.GET("", h.List)
	g.POST("", h.Create)
	g.POST("/:id/restart", h.Restart)
	g.POST("/:id/restart/cancel", h.CancelRestart)
	g.PATCH("/:id", h.Patch)
	g.DELETE("/:id", h.Delete)
	g.GET("/:id/output", h.GetOutput)
	g.GET("/:id/raw-output", h.GetRawOutput)
	g.PUT("/:id/output", h.PutOutput)
	h.registerBookmarkRoutes(r)
	r.GET("/blockterm/history", h.History)
	r.GET("/blockterm/history/:id/output", h.GetHistoryOutput)
	r.PATCH("/blockterm/history/:id", h.PatchHistory)
	r.DELETE("/blockterm/history", h.PurgeHistory)
	// Keep clients released during the singular/plural naming transition
	// compatible with the same completion contract.
	r.POST("/blockterm/complete", h.Complete)
	r.POST("/blockterm/completion", h.Complete)
	r.POST("/blockterm/completions", h.Complete)
	h.registerBlockRuntimeRoutes(r)
}

func terminalExists(db *gorm.DB, terminalID string) (bool, error) {
	var count int64
	if err := db.Model(&model.TerminalSession{}).Where("id = ?", terminalID).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func blockTermTombstoneExists(tx *gorm.DB, blockID string) (bool, error) {
	// Stable block IDs are globally unique. A tombstone therefore reserves the
	// ID even if the block was moved before deletion; scoping this check by the
	// current terminal would let a note/renderer recreate a deleted ID after a
	// move because those kinds do not write a history row.
	if tx == nil || blockID == "" || !tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) ||
		!tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "block_deleted_at") {
		return false, nil
	}
	var count int64
	if err := tx.Model(&model.BlockTermCommandHistory{}).
		Where("id = ? AND block_deleted_at IS NOT NULL", blockID).
		Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func (h *BlockTermHandler) requireTerminal(c *gin.Context, terminalID string) bool {
	if strings.TrimSpace(terminalID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "terminal_id is required"})
		return false
	}
	exists, err := terminalExists(h.db, terminalID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return false
	}
	if !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "terminal not found"})
		return false
	}
	return true
}

func parseBlockTermHistoryLimit(raw string) (int, error) {
	if raw == "" {
		return blockTermHistoryLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return 0, errors.New("limit must be a positive integer")
	}
	if limit > blockTermHistoryMaxLimit {
		limit = blockTermHistoryMaxLimit
	}
	return limit, nil
}

func parseBlockTermHistoryOffset(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	offset, err := strconv.Atoi(raw)
	if err != nil || offset < 0 {
		return 0, errors.New("offset must be a non-negative integer")
	}
	return offset, nil
}

func escapeBlockTermHistoryLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func (h *BlockTermHandler) History(c *gin.Context) {
	h.blockMu.RLock()
	defer h.blockMu.RUnlock()

	limit, err := parseBlockTermHistoryLimit(c.Query("limit"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	offset, err := parseBlockTermHistoryOffset(c.Query("offset"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	starred, hasStarred, err := parseBlockTermHistoryStarred(c.Query("starred"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	history := make([]model.BlockTermCommandHistory, 0)
	query := visibleBlockTermHistoryMetadataQuery(h.db)
	if terminalID := strings.TrimSpace(c.Query("terminal_id")); terminalID != "" {
		query = query.Where("terminal_id = ?", terminalID)
	}
	if workspaceSessionID := strings.TrimSpace(c.Query("workspace_session_id")); workspaceSessionID != "" {
		query = query.Where("workspace_session_id = ?", workspaceSessionID)
	}
	if groupID := strings.TrimSpace(c.Query("group_id")); groupID != "" {
		query = query.Where("group_id = ?", groupID)
	}
	if runtimeType := strings.TrimSpace(c.Query("runtime_type")); runtimeType != "" {
		query = query.Where("runtime_type = ?", runtimeType)
	}
	if hasStarred {
		query = query.Where("starred = ?", starred)
	}
	if search := c.Query("q"); search != "" {
		query = query.Where(`command LIKE ? ESCAPE '\'`, "%"+escapeBlockTermHistoryLike(search)+"%")
	}
	if err := query.Order("created_at DESC, id DESC").Offset(offset).Limit(limit + 1).Find(&history).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	hasMore := len(history) > limit
	if hasMore {
		history = history[:limit]
	}
	c.JSON(http.StatusOK, gin.H{
		"history":     history,
		"offset":      offset,
		"limit":       limit,
		"has_more":    hasMore,
		"next_offset": offset + len(history),
	})
}

type blockTermMetadata struct {
	ID               string `gorm:"column:id" json:"id"`
	TerminalID       string `gorm:"column:terminal_id" json:"terminal_id"`
	LineNum          int    `gorm:"column:line_num" json:"line_num"`
	Kind             string `gorm:"column:kind" json:"kind"`
	Command          string `gorm:"column:command" json:"command"`
	Text             string `gorm:"column:text" json:"text"`
	Cwd              string `gorm:"column:cwd" json:"cwd"`
	RuntimeType      string `gorm:"column:runtime_type" json:"runtime_type"`
	SSHProfileID     string `gorm:"column:ssh_profile_id" json:"ssh_profile_id,omitempty"`
	Status           string `gorm:"column:status" json:"status"`
	Mode             string `gorm:"column:mode" json:"mode"`
	OutputSize       int64  `gorm:"column:output_size" json:"output_size"`
	OutputCursor     *int64 `gorm:"column:output_cursor" json:"output_cursor"`
	CmdPID           *int64 `gorm:"column:cmd_pid" json:"cmd_pid,omitempty"`
	RemotePID        *int64 `gorm:"column:remote_pid" json:"remote_pid,omitempty"`
	TermCols         int    `gorm:"column:term_cols" json:"term_cols,omitempty"`
	TermRows         int    `gorm:"column:term_rows" json:"term_rows,omitempty"`
	TermFlexRows     bool   `gorm:"column:term_flex_rows" json:"term_flex_rows,omitempty"`
	TermMaxPTYSize   int    `gorm:"column:term_max_pty_size" json:"term_max_pty_size,omitempty"`
	BeforeStateJSON  string `gorm:"column:before_state_json" json:"before_state_json,omitempty"`
	AfterStateJSON   string `gorm:"column:after_state_json" json:"after_state_json,omitempty"`
	ExitCode         *int   `gorm:"column:exit_code" json:"exit_code"`
	StartedAt        *int64 `gorm:"column:started_at" json:"started_at"`
	FinishedAt       *int64 `gorm:"column:finished_at" json:"finished_at"`
	Collapsed        bool   `gorm:"column:collapsed" json:"collapsed"`
	Pinned           bool   `gorm:"column:pinned" json:"pinned"`
	Archived         bool   `gorm:"column:archived" json:"archived"`
	Starred          bool   `gorm:"column:starred" json:"starred"`
	Renderer         string `gorm:"column:renderer" json:"renderer"`
	StateJSON        string `gorm:"column:state_json" json:"state_json"`
	PresentationJSON string `gorm:"column:presentation_json" json:"presentation_json"`
	CreatedAt        int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt        int64  `gorm:"column:updated_at" json:"updated_at"`
}

func blockTermMetadataQuery(db *gorm.DB) *gorm.DB {
	return db.Model(&model.BlockTermBlock{}).Select(`
		id,
		terminal_id,
		line_num,
		kind,
		command,
		text,
		cwd,
		runtime_type,
		ssh_profile_id,
		status,
		mode,
		COALESCE(LENGTH(output), 0) AS output_size,
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
		collapsed,
		pinned,
		archived,
		starred,
		renderer,
		state_json,
		presentation_json,
		created_at,
		updated_at
	`)
}

func includeBlockTermOutput(c *gin.Context, defaultValue bool) bool {
	raw, ok := c.GetQuery("include_output")
	if !ok {
		return defaultValue
	}
	return raw == "1"
}

func (h *BlockTermHandler) List(c *gin.Context) {
	h.blockMu.RLock()
	defer h.blockMu.RUnlock()

	terminalID := c.Query("terminal_id")
	if !h.requireTerminal(c, terminalID) {
		return
	}

	var blocks any
	if includeBlockTermOutput(c, false) {
		fullBlocks := make([]model.BlockTermBlock, 0)
		if err := h.db.Where("terminal_id = ?", terminalID).
			Order("line_num ASC, created_at ASC, id ASC").Find(&fullBlocks).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		blocks = fullBlocks
	} else {
		metadata := make([]blockTermMetadata, 0)
		if err := blockTermMetadataQuery(h.db).Where("terminal_id = ?", terminalID).
			Order("line_num ASC, created_at ASC, id ASC").Scan(&metadata).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		blocks = metadata
	}
	deletedBlockIDs := make([]string, 0)
	if err := h.db.Model(&model.BlockTermCommandHistory{}).
		Where("terminal_id = ? AND block_deleted_at IS NOT NULL", terminalID).
		Order("id ASC").Pluck("id", &deletedBlockIDs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"blocks": blocks, "deleted_block_ids": deletedBlockIDs})
}

type blockTermOutput struct {
	TerminalID   string `gorm:"column:terminal_id"`
	Output       []byte `gorm:"column:output"`
	OutputCursor *int64 `gorm:"column:output_cursor"`
}

func (h *BlockTermHandler) GetOutput(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	var output blockTermOutput
	h.blockMu.RLock()
	err := h.db.Model(&model.BlockTermBlock{}).
		Select("output", "output_cursor").
		Where("id = ?", id).
		Take(&output).Error
	h.blockMu.RUnlock()
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "block not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if output.OutputCursor != nil {
		c.Header(blockTermOutputCursorHeader, strconv.FormatInt(*output.OutputCursor, 10))
	}
	c.Data(http.StatusOK, "application/octet-stream", output.Output)
}

func (h *BlockTermHandler) GetRawOutput(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	var requestedCursor *uint64
	if rawCursor, hasCursor := c.GetQuery("cursor"); hasCursor {
		cursor, err := parseBlockTermRawOutputCursor(rawCursor)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		requestedCursor = &cursor
	}

	var output blockTermOutput
	var segments []model.BlockTermOutputSegment
	var loadErr error
	for attempt := 0; attempt < 2; attempt++ {
		// Read the owner before waiting on the recorder. The block lock must not
		// span that wait: persistence is asynchronous and a slow database should
		// not serialize unrelated block mutations.
		h.blockMu.RLock()
		loadErr = h.db.Model(&model.BlockTermBlock{}).
			Select("terminal_id", "output").
			Where("id = ?", id).
			Take(&output).Error
		h.blockMu.RUnlock()
		if loadErr != nil {
			break
		}

		loadSnapshot := func() error {
			// PTY websocket delivery is intentionally ahead of the asynchronous raw
			// recorder. Establish a FIFO barrier before reading segments so bytes that
			// were already broadcast cannot be missed by this snapshot request.
			if h.manager != nil && output.TerminalID != "" {
				if err := h.manager.FlushTerminalOutput(output.TerminalID); err != nil {
					return err
				}
			}
			h.blockMu.RLock()
			defer h.blockMu.RUnlock()
			var latest blockTermOutput
			if err := h.db.Model(&model.BlockTermBlock{}).
				Select("terminal_id", "output").
				Where("id = ?", id).
				Take(&latest).Error; err != nil {
				return err
			}
			if latest.TerminalID != output.TerminalID {
				return errBlockTermOutputMoved
			}
			output = latest
			segments = segments[:0]
			if h.db.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := h.db.Where("block_id = ? AND terminal_id = ?", id, output.TerminalID).
					Order("start_cursor ASC, end_cursor ASC, id ASC").
					Find(&segments).Error; err != nil {
					return err
				}
			}
			return nil
		}
		loadErr = loadSnapshot()
		if errors.Is(loadErr, errBlockTermOutputMoved) {
			continue
		}
		break
	}
	if loadErr != nil {
		if errors.Is(loadErr, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "block not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": loadErr.Error()})
		return
	}
	if len(segments) == 0 {
		c.Data(http.StatusOK, "application/octet-stream", output.Output)
		return
	}

	for index, segment := range segments {
		if segment.EndCursor < segment.StartCursor ||
			segment.EndCursor-segment.StartCursor != uint64(len(segment.Data)) ||
			(index > 0 && segment.StartCursor < segments[index-1].EndCursor) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid raw output segment range"})
			return
		}
	}

	startIndex := 0
	startOffset := 0
	startCursor := segments[0].StartCursor
	endCursor := segments[len(segments)-1].EndCursor
	if requestedCursor != nil {
		cursor := *requestedCursor
		if cursor > startCursor {
			startIndex = len(segments)
			startCursor = endCursor
			for index, segment := range segments {
				if cursor < segment.StartCursor {
					startIndex = index
					startCursor = segment.StartCursor
					break
				}
				if cursor < segment.EndCursor {
					startIndex = index
					startOffset = int(cursor - segment.StartCursor)
					startCursor = cursor
					break
				}
			}
		}
	}

	var outputSize int64
	for index := startIndex; index < len(segments); index++ {
		segmentSize := len(segments[index].Data)
		if index == startIndex {
			segmentSize -= startOffset
		}
		outputSize += int64(segmentSize)
	}
	c.Header(blockTermOutputStartHeader, strconv.FormatUint(startCursor, 10))
	c.Header(blockTermOutputEndHeader, strconv.FormatUint(endCursor, 10))
	c.Header(blockTermOutputCursorHeader, strconv.FormatUint(endCursor, 10))
	c.Header("Content-Length", strconv.FormatInt(outputSize, 10))
	c.Header("Content-Type", "application/octet-stream")
	c.Status(http.StatusOK)
	for index := startIndex; index < len(segments); index++ {
		data := segments[index].Data
		if index == startIndex && startOffset > 0 {
			data = data[startOffset:]
		}
		if _, err := c.Writer.Write(data); err != nil {
			return
		}
	}
}

func parseBlockTermRawOutputCursor(raw string) (uint64, error) {
	if raw == "" {
		return 0, errors.New("cursor must be a non-negative integer")
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, errors.New("cursor must be a non-negative integer")
		}
	}
	cursor, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, errors.New("cursor must be a non-negative integer")
	}
	return cursor, nil
}

func parseBlockTermOutputCursor(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, errors.New("output cursor is required")
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, errors.New("output cursor must be a non-negative integer")
		}
	}
	cursor, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, errors.New("output cursor must be a non-negative integer")
	}
	return cursor, nil
}

func (h *BlockTermHandler) PutOutput(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	cursor, err := parseBlockTermOutputCursor(c.GetHeader(blockTermOutputCursorHeader))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	reader := http.MaxBytesReader(c.Writer, c.Request.Body, blockTermMaxOutputBytes)
	output, err := io.ReadAll(reader)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "output is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read output"})
		return
	}

	// Body parsing intentionally happens before taking the mutation lock. This
	// keeps a slow client from blocking unrelated block operations while still
	// making the compare-and-write section atomic with PATCH/DELETE.
	h.blockMu.Lock()
	err = func() error {
		return h.db.Transaction(func(tx *gorm.DB) error {
			var block model.BlockTermBlock
			if err := tx.First(&block, "id = ?", id).Error; err != nil {
				return err
			}
			if block.Renderer == blockTermRendererOpenAI {
				return errBlockTermModelOwned
			}
			updatedAt := time.Now().Unix()
			result := tx.Model(&model.BlockTermBlock{}).
				Where("id = ? AND (output_cursor IS NULL OR output_cursor < ?)", id, cursor).
				Updates(map[string]any{
					"output":        output,
					"output_cursor": cursor,
					"updated_at":    updatedAt,
				})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected > 0 {
				block.Output = output
				block.OutputCursor = &cursor
				block.UpdatedAt = updatedAt
				return blocktermhistory.Sync(tx, block)
			}

			var current blockTermOutput
			if err := tx.Model(&model.BlockTermBlock{}).
				Select("output", "output_cursor").
				Where("id = ?", id).
				Take(&current).Error; err != nil {
				return err
			}
			if current.OutputCursor != nil &&
				*current.OutputCursor == cursor &&
				bytes.Equal(current.Output, output) {
				return blocktermhistory.SyncByID(tx, id)
			}
			return errBlockTermOutputConflict
		})
	}()
	h.blockMu.Unlock()
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "block not found"})
		return
	}
	if errors.Is(err, errBlockTermOutputConflict) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if errors.Is(err, errBlockTermModelOwned) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

type createBlockTermRequest struct {
	ID               string `json:"id"`
	TerminalID       string `json:"terminal_id" binding:"required"`
	LineNum          *int   `json:"line_num" binding:"required"`
	Kind             string `json:"kind"`
	Command          string `json:"command"`
	Text             string `json:"text"`
	Cwd              string `json:"cwd"`
	RuntimeType      string `json:"runtime_type"`
	SSHProfileID     string `json:"ssh_profile_id"`
	Status           string `json:"status"`
	Mode             string `json:"mode"`
	Output           []byte `json:"output"`
	ExitCode         *int   `json:"exit_code"`
	StartedAt        *int64 `json:"started_at"`
	FinishedAt       *int64 `json:"finished_at"`
	CmdPID           *int64 `json:"cmd_pid"`
	RemotePID        *int64 `json:"remote_pid"`
	TermCols         int    `json:"term_cols"`
	TermRows         int    `json:"term_rows"`
	TermFlexRows     bool   `json:"term_flex_rows"`
	TermMaxPTYSize   int    `json:"term_max_pty_size"`
	BeforeStateJSON  string `json:"before_state_json"`
	AfterStateJSON   string `json:"after_state_json"`
	Collapsed        bool   `json:"collapsed"`
	Pinned           bool   `json:"pinned"`
	Archived         bool   `json:"archived"`
	Starred          bool   `json:"starred"`
	Renderer         string `json:"renderer"`
	StateJSON        string `json:"state_json"`
	PresentationJSON string `json:"presentation_json"`
}

func validateBlockTermRenderer(renderer string) error {
	if renderer == "" {
		return nil
	}
	if len(renderer) > blockTermMaxRendererLen {
		return fmt.Errorf("renderer name too long, max length is %d", blockTermMaxRendererLen)
	}
	if !blockTermRendererRe.MatchString(renderer) {
		return errors.New("invalid renderer format")
	}
	return nil
}

func validateBlockTermRuntimeSelection(runtimeType, sshProfileID string) error {
	runtimeType = strings.TrimSpace(runtimeType)
	sshProfileID = strings.TrimSpace(sshProfileID)
	switch runtimeType {
	case terminal.RuntimeTypeLocal:
		if sshProfileID != "" {
			return errors.New("ssh_profile_id is only valid for ssh runtime")
		}
	case terminal.RuntimeTypeSSH:
		if sshProfileID == "" {
			return errors.New("ssh_profile_id is required for ssh runtime")
		}
	default:
		return errors.New("runtime_type must be local or ssh")
	}
	return nil
}

// resolveBlockTermRuntimeSelection applies the API's inheritance rules for a
// newly-created block. An omitted runtime inherits the terminal runtime (or
// local when the legacy terminal row is blank); an omitted profile inherits a
// terminal profile only for SSH. Explicit local selections never retain a
// profile from the parent terminal.
func resolveBlockTermRuntimeSelection(
	runtimeType string,
	sshProfileID string,
	terminalSession model.TerminalSession,
) (string, string, error) {
	runtimeType = strings.TrimSpace(runtimeType)
	sshProfileID = strings.TrimSpace(sshProfileID)
	profileExplicit := sshProfileID != ""
	if runtimeType == "" {
		runtimeType = strings.TrimSpace(terminalSession.RuntimeType)
		if runtimeType == "" {
			runtimeType = terminal.RuntimeTypeLocal
		}
	}
	if !profileExplicit && runtimeType == terminal.RuntimeTypeSSH {
		sshProfileID = strings.TrimSpace(terminalSession.SSHProfileID)
	}
	if err := validateBlockTermRuntimeSelection(runtimeType, sshProfileID); err != nil {
		return "", "", err
	}
	return runtimeType, sshProfileID, nil
}

func resolveExistingBlockTermRuntimeSelection(
	block model.BlockTermBlock,
	terminalSession model.TerminalSession,
) (string, string, error) {
	runtimeType := strings.TrimSpace(block.RuntimeType)
	sshProfileID := strings.TrimSpace(block.SSHProfileID)
	if runtimeType == "" {
		runtimeType = strings.TrimSpace(terminalSession.RuntimeType)
		if runtimeType == "" {
			runtimeType = terminal.RuntimeTypeLocal
		}
	}
	if runtimeType == terminal.RuntimeTypeLocal {
		sshProfileID = ""
	} else if runtimeType == terminal.RuntimeTypeSSH && sshProfileID == "" {
		sshProfileID = strings.TrimSpace(terminalSession.SSHProfileID)
	}
	if err := validateBlockTermRuntimeSelection(runtimeType, sshProfileID); err != nil {
		return "", "", err
	}
	return runtimeType, sshProfileID, nil
}

func validateBlockTermStateJSON(stateJSON string) error {
	if stateJSON == "" {
		return nil
	}
	if len(stateJSON) > blockTermMaxStateJSONLen {
		return fmt.Errorf("state_json too long, max length is %d", blockTermMaxStateJSONLen)
	}

	var state map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stateJSON), &state); err != nil || state == nil {
		return errors.New("state_json must be a valid JSON object")
	}
	return nil
}

func validateBlockTermRendererState(renderer, stateJSON *string) error {
	if renderer != nil {
		if err := validateBlockTermRenderer(*renderer); err != nil {
			return err
		}
	}
	if stateJSON != nil {
		if err := validateBlockTermStateJSON(*stateJSON); err != nil {
			return err
		}
	}
	return nil
}

func (h *BlockTermHandler) Create(c *gin.Context) {
	var req createBlockTermRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermMaxBodyBytes)
	if err := c.ShouldBindJSON(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(req.TerminalID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "terminal_id is required"})
		return
	}
	if req.LineNum == nil || *req.LineNum < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "line_num must be a non-negative integer"})
		return
	}
	kind, err := normalizeBlockTermKind(req.Kind, req.Renderer)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Renderer == blockTermRendererOpenAI {
		c.JSON(http.StatusConflict, gin.H{"error": errBlockTermModelOwned.Error()})
		return
	}
	if err := validateBlockTermMetadata(kind, req.Text, req.Renderer, req.StateJSON, req.PresentationJSON); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateBlockTermPID(req.CmdPID, "cmd_pid"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateBlockTermPID(req.RemotePID, "remote_pid"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateBlockTermGeometry(req.TermCols, req.TermRows); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateBlockTermMaxPTYSize(req.TermMaxPTYSize); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateBlockTermCommandState(req.BeforeStateJSON, "before_state_json"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateBlockTermCommandState(req.AfterStateJSON, "after_state_json"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.Output) > blockTermMaxOutputBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "output is too large"})
		return
	}

	// Keep request decoding outside the critical section; the lock covers the
	// complete create/idempotency transaction so DELETE/PATCH cannot interleave
	// between the existence check and the insert.
	now := time.Now().Unix()
	requestedID := strings.TrimSpace(req.ID)
	id := requestedID
	if id == "" {
		id = uuid.NewString()
	}
	status := req.Status
	if status == "" {
		status = "running"
	}
	mode := req.Mode
	if mode == "" {
		mode = "text"
	}
	block := model.BlockTermBlock{
		ID:               id,
		TerminalID:       req.TerminalID,
		LineNum:          *req.LineNum,
		Kind:             kind,
		Command:          req.Command,
		Text:             req.Text,
		Cwd:              req.Cwd,
		Status:           status,
		Mode:             mode,
		Output:           req.Output,
		CmdPID:           req.CmdPID,
		RemotePID:        req.RemotePID,
		TermCols:         req.TermCols,
		TermRows:         req.TermRows,
		TermFlexRows:     req.TermFlexRows,
		TermMaxPTYSize:   req.TermMaxPTYSize,
		BeforeStateJSON:  req.BeforeStateJSON,
		AfterStateJSON:   req.AfterStateJSON,
		ExitCode:         req.ExitCode,
		StartedAt:        req.StartedAt,
		FinishedAt:       req.FinishedAt,
		Collapsed:        req.Collapsed,
		Pinned:           req.Pinned,
		Archived:         req.Archived,
		Starred:          req.Starred,
		Renderer:         req.Renderer,
		StateJSON:        req.StateJSON,
		PresentationJSON: req.PresentationJSON,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	h.blockMu.Lock()
	err = func() error {
		return h.db.Transaction(func(tx *gorm.DB) error {
			var terminalSession model.TerminalSession
			if err := tx.First(&terminalSession, "id = ?", req.TerminalID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return terminal.ErrTerminalNotFound
				}
				return err
			}
			var selectionErr error
			block.RuntimeType, block.SSHProfileID, selectionErr = resolveBlockTermRuntimeSelection(
				req.RuntimeType,
				req.SSHProfileID,
				terminalSession,
			)
			if selectionErr != nil {
				return &blockTermPatchMetadataValidationError{err: selectionErr}
			}
			if requestedID != "" {
				deleted, err := blockTermTombstoneExists(tx, requestedID)
				if err != nil {
					return err
				}
				if deleted {
					return errBlockTermDeleted
				}
			}

			if err := tx.Create(&block).Error; err != nil {
				if requestedID == "" || !isBlockTermConflict(err) {
					return err
				}
				var existing model.BlockTermBlock
				if loadErr := tx.First(&existing, "id = ?", requestedID).Error; loadErr != nil {
					if errors.Is(loadErr, gorm.ErrRecordNotFound) {
						return err
					}
					return loadErr
				}
				existingRuntimeType, existingSSHProfileID, normalizeErr :=
					resolveExistingBlockTermRuntimeSelection(existing, terminalSession)
				if normalizeErr != nil {
					return &blockTermPatchMetadataValidationError{err: normalizeErr}
				}
				if existing.TerminalID != req.TerminalID ||
					existing.LineNum != *req.LineNum ||
					existing.Kind != kind ||
					existing.Command != req.Command ||
					existing.Text != req.Text ||
					existingRuntimeType != block.RuntimeType ||
					existingSSHProfileID != block.SSHProfileID ||
					existing.Renderer != req.Renderer ||
					existing.StateJSON != req.StateJSON ||
					existing.PresentationJSON != req.PresentationJSON {
					return err
				}
				if existing.RuntimeType != existingRuntimeType || existing.SSHProfileID != existingSSHProfileID {
					if updateErr := tx.Model(&model.BlockTermBlock{}).Where("id = ?", existing.ID).Updates(map[string]any{
						"runtime_type":   existingRuntimeType,
						"ssh_profile_id": existingSSHProfileID,
					}).Error; updateErr != nil {
						return updateErr
					}
					existing.RuntimeType = existingRuntimeType
					existing.SSHProfileID = existingSSHProfileID
				}
				block = existing
				if blockTermBlockWritesHistory(block) {
					history := blockTermCommandHistory(terminalSession, block)
					if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&history).Error; err != nil {
						return err
					}
				}
			} else if blockTermBlockWritesHistory(block) {
				history := blockTermCommandHistory(terminalSession, block)
				if err := tx.Create(&history).Error; err != nil {
					return err
				}
			}
			if blockTermBlockWritesHistory(block) {
				if err := blocktermhistory.Sync(tx, block); err != nil {
					return err
				}
			}
			if tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := tx.Model(&model.BlockTermOutputSegment{}).
					Where("block_id = ? AND terminal_id = ?", block.ID, block.TerminalID).
					Update("terminal_id", block.TerminalID).Error; err != nil {
					return err
				}
				return terminal.TrimBlockTermOutputSegmentsForTerminal(tx, block.ID, block.TerminalID, block.TermMaxPTYSize)
			}
			return nil
		})
	}()
	h.blockMu.Unlock()
	if err != nil {
		var metadataValidationErr *blockTermPatchMetadataValidationError
		if errors.As(err, &metadataValidationErr) {
			c.JSON(http.StatusBadRequest, gin.H{"error": metadataValidationErr.Error()})
			return
		}
		if errors.Is(err, terminal.ErrTerminalNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "terminal not found"})
			return
		}
		if errors.Is(err, errBlockTermDeleted) {
			c.JSON(http.StatusConflict, gin.H{"error": "block has been deleted"})
			return
		}
		if isBlockTermConflict(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "block id or terminal_id and line_num already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"block": block})
}

func blockTermCommandHistory(
	terminalSession model.TerminalSession,
	block model.BlockTermBlock,
) model.BlockTermCommandHistory {
	return blocktermhistory.NewSnapshot(terminalSession, block)
}

// blockTermPatchRequest uses RawMessage for nullable values so an explicit
// JSON null can clear exit_code/started_at/finished_at while omission leaves
// the existing value untouched.
type blockTermPatchRequest struct {
	TerminalID       *string         `json:"terminal_id"`
	LineNum          *int            `json:"line_num"`
	Kind             *string         `json:"kind"`
	Command          *string         `json:"command"`
	Text             *string         `json:"text"`
	Cwd              *string         `json:"cwd"`
	RuntimeType      *string         `json:"runtime_type"`
	SSHProfileID     *string         `json:"ssh_profile_id"`
	Status           *string         `json:"status"`
	Mode             *string         `json:"mode"`
	Output           *[]byte         `json:"output"`
	CmdPID           json.RawMessage `json:"cmd_pid"`
	RemotePID        json.RawMessage `json:"remote_pid"`
	TermCols         *int            `json:"term_cols"`
	TermRows         *int            `json:"term_rows"`
	TermFlexRows     *bool           `json:"term_flex_rows"`
	TermMaxPTYSize   *int            `json:"term_max_pty_size"`
	BeforeStateJSON  *string         `json:"before_state_json"`
	AfterStateJSON   *string         `json:"after_state_json"`
	ExitCode         json.RawMessage `json:"exit_code"`
	StartedAt        json.RawMessage `json:"started_at"`
	FinishedAt       json.RawMessage `json:"finished_at"`
	Collapsed        *bool           `json:"collapsed"`
	Pinned           *bool           `json:"pinned"`
	Archived         *bool           `json:"archived"`
	Starred          *bool           `json:"starred"`
	Renderer         *string         `json:"renderer"`
	StateJSON        *string         `json:"state_json"`
	PresentationJSON *string         `json:"presentation_json"`
}

func (r blockTermPatchRequest) mutatesModelOwnedFields() bool {
	return r.TerminalID != nil ||
		r.LineNum != nil ||
		r.Kind != nil ||
		r.Command != nil ||
		r.Text != nil ||
		r.Cwd != nil ||
		r.RuntimeType != nil ||
		r.SSHProfileID != nil ||
		r.Status != nil ||
		r.Mode != nil ||
		r.Output != nil ||
		len(r.CmdPID) > 0 ||
		len(r.RemotePID) > 0 ||
		r.TermCols != nil ||
		r.TermRows != nil ||
		r.TermFlexRows != nil ||
		r.TermMaxPTYSize != nil ||
		r.BeforeStateJSON != nil ||
		r.AfterStateJSON != nil ||
		len(r.ExitCode) > 0 ||
		len(r.StartedAt) > 0 ||
		len(r.FinishedAt) > 0 ||
		r.Renderer != nil ||
		r.StateJSON != nil
}

func (r blockTermPatchRequest) mutatesIndependentRuntimeFields() bool {
	return r.TerminalID != nil ||
		r.LineNum != nil ||
		r.Kind != nil ||
		r.Command != nil ||
		r.Cwd != nil ||
		r.RuntimeType != nil ||
		r.SSHProfileID != nil ||
		r.Status != nil ||
		r.Mode != nil ||
		r.Output != nil ||
		len(r.CmdPID) > 0 ||
		len(r.RemotePID) > 0 ||
		r.TermCols != nil ||
		r.TermRows != nil ||
		r.TermFlexRows != nil ||
		r.TermMaxPTYSize != nil ||
		r.BeforeStateJSON != nil ||
		r.AfterStateJSON != nil ||
		len(r.ExitCode) > 0 ||
		len(r.StartedAt) > 0 ||
		len(r.FinishedAt) > 0
}

type blockTermPatchMetadataValidationError struct {
	err error
}

func (e *blockTermPatchMetadataValidationError) Error() string {
	return e.err.Error()
}

func (e *blockTermPatchMetadataValidationError) Unwrap() error {
	return e.err
}

func decodeNullableInt64(raw json.RawMessage) (*int64, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func decodeNullableInt(raw json.RawMessage) (*int, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func valueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func (h *BlockTermHandler) Patch(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	var req blockTermPatchRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermMaxBodyBytes)
	if err := c.ShouldBindJSON(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.TerminalID != nil && strings.TrimSpace(*req.TerminalID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "terminal_id is required"})
		return
	}
	if req.LineNum != nil && *req.LineNum < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "line_num must be a non-negative integer"})
		return
	}
	if req.Renderer != nil && *req.Renderer == blockTermRendererOpenAI {
		c.JSON(http.StatusConflict, gin.H{"error": errBlockTermModelOwned.Error()})
		return
	}
	if req.Kind != nil {
		if err := validateBlockTermKind(*req.Kind); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if req.Text != nil {
		if err := validateBlockTermText(*req.Text); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if err := validateBlockTermRendererState(req.Renderer, req.StateJSON); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.PresentationJSON != nil {
		if err := validateBlockTermPresentationJSON(*req.PresentationJSON); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if req.Output != nil && len(*req.Output) > blockTermMaxOutputBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "output is too large"})
		return
	}
	if err := validateBlockTermGeometry(valueOrZero(req.TermCols), valueOrZero(req.TermRows)); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.TermMaxPTYSize != nil {
		if err := validateBlockTermMaxPTYSize(*req.TermMaxPTYSize); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if req.BeforeStateJSON != nil {
		if err := validateBlockTermCommandState(*req.BeforeStateJSON, "before_state_json"); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if req.AfterStateJSON != nil {
		if err := validateBlockTermCommandState(*req.AfterStateJSON, "after_state_json"); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	updates := make(map[string]any)
	if req.TerminalID != nil {
		updates["terminal_id"] = *req.TerminalID
	}
	if req.LineNum != nil {
		updates["line_num"] = *req.LineNum
	}
	if req.Kind != nil {
		updates["kind"] = *req.Kind
	}
	if req.Command != nil {
		updates["command"] = *req.Command
	}
	if req.Text != nil {
		updates["text"] = *req.Text
	}
	if req.Cwd != nil {
		updates["cwd"] = *req.Cwd
	}
	if req.RuntimeType != nil {
		updates["runtime_type"] = strings.TrimSpace(*req.RuntimeType)
	}
	if req.SSHProfileID != nil {
		updates["ssh_profile_id"] = strings.TrimSpace(*req.SSHProfileID)
	}
	if req.Status != nil {
		updates["status"] = *req.Status
	}
	if req.Mode != nil {
		updates["mode"] = *req.Mode
	}
	if req.Output != nil {
		updates["output"] = *req.Output
		updates["output_cursor"] = nil
	}
	if req.TermCols != nil {
		updates["term_cols"] = *req.TermCols
	}
	if req.TermRows != nil {
		updates["term_rows"] = *req.TermRows
	}
	if req.TermFlexRows != nil {
		updates["term_flex_rows"] = *req.TermFlexRows
	}
	if req.TermMaxPTYSize != nil {
		updates["term_max_pty_size"] = *req.TermMaxPTYSize
	}
	if req.BeforeStateJSON != nil {
		updates["before_state_json"] = *req.BeforeStateJSON
	}
	if req.AfterStateJSON != nil {
		updates["after_state_json"] = *req.AfterStateJSON
	}
	if req.Collapsed != nil {
		updates["collapsed"] = *req.Collapsed
	}
	if req.Pinned != nil {
		updates["pinned"] = *req.Pinned
	}
	if req.Archived != nil {
		updates["archived"] = *req.Archived
	}
	if req.Starred != nil {
		updates["starred"] = *req.Starred
	}
	if req.Renderer != nil {
		updates["renderer"] = *req.Renderer
	}
	if req.StateJSON != nil {
		updates["state_json"] = *req.StateJSON
	}
	if req.PresentationJSON != nil {
		updates["presentation_json"] = *req.PresentationJSON
	}
	if len(req.ExitCode) > 0 {
		value, err := decodeNullableInt(req.ExitCode)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "exit_code must be an integer or null"})
			return
		}
		updates["exit_code"] = value
	}
	for _, field := range []struct {
		raw    json.RawMessage
		column string
	}{
		{req.CmdPID, "cmd_pid"},
		{req.RemotePID, "remote_pid"},
	} {
		if len(field.raw) == 0 {
			continue
		}
		value, err := decodeNullableInt64(field.raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": field.column + " must be an integer or null"})
			return
		}
		if err := validateBlockTermPID(value, field.column); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updates[field.column] = value
	}
	for _, field := range []struct {
		raw    json.RawMessage
		column string
	}{
		{req.StartedAt, "started_at"},
		{req.FinishedAt, "finished_at"},
	} {
		if len(field.raw) == 0 {
			continue
		}
		value, err := decodeNullableInt64(field.raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": field.column + " must be an integer or null"})
			return
		}
		updates[field.column] = value
	}
	updates["updated_at"] = time.Now().Unix()

	includeOutput := includeBlockTermOutput(c, true)
	var block model.BlockTermBlock
	var metadata blockTermMetadata
	if h.manager != nil {
		unlockLifecycle := h.manager.LockBlockRuntimeLifecycle("", id)
		defer unlockLifecycle()
	}
	// All mutable block fields, including output cursor and terminal/line
	// ownership, are committed while holding the same lock used by reads and
	// deletes. Request parsing and response writing remain outside this section.
	h.blockMu.Lock()
	err := func() error {
		return h.db.Transaction(func(tx *gorm.DB) error {
			var existing model.BlockTermBlock
			if err := tx.First(&existing, "id = ?", id).Error; err != nil {
				return err
			}
			if h.manager != nil && h.manager.HasActiveBlockRuntime(existing.TerminalID, existing.ID) &&
				req.mutatesIndependentRuntimeFields() {
				return fmt.Errorf("%w: block %s has an active independent runtime", terminal.ErrBlockTermRestartBusy, id)
			}
			if existing.Renderer == blockTermRendererOpenAI && req.mutatesModelOwnedFields() {
				return errBlockTermModelOwned
			}
			if req.Kind != nil && *req.Kind != existing.Kind {
				return &blockTermPatchMetadataValidationError{err: errors.New("kind cannot be changed")}
			}
			if req.TerminalID != nil {
				exists, err := terminalExists(tx, *req.TerminalID)
				if err != nil {
					return err
				}
				if !exists {
					return terminal.ErrTerminalNotFound
				}
			}
			ownershipChanged := (req.TerminalID != nil && *req.TerminalID != existing.TerminalID) ||
				(req.LineNum != nil && *req.LineNum != existing.LineNum)

			candidate := existing
			if req.TerminalID != nil {
				candidate.TerminalID = *req.TerminalID
			}
			if req.LineNum != nil {
				candidate.LineNum = *req.LineNum
			}
			if req.Status != nil {
				candidate.Status = *req.Status
			}
			if req.Kind != nil {
				candidate.Kind = *req.Kind
			}
			if req.Text != nil {
				candidate.Text = *req.Text
			}
			if req.RuntimeType != nil {
				candidate.RuntimeType = strings.TrimSpace(*req.RuntimeType)
			}
			if req.SSHProfileID != nil {
				candidate.SSHProfileID = strings.TrimSpace(*req.SSHProfileID)
			}
			if req.RuntimeType != nil || req.SSHProfileID != nil {
				if err := validateBlockTermRuntimeSelection(candidate.RuntimeType, candidate.SSHProfileID); err != nil {
					return &blockTermPatchMetadataValidationError{err: err}
				}
			}
			if req.Renderer != nil {
				candidate.Renderer = *req.Renderer
			}
			if req.StateJSON != nil {
				candidate.StateJSON = *req.StateJSON
			}
			if req.PresentationJSON != nil {
				candidate.PresentationJSON = *req.PresentationJSON
			}
			candidateKind, validationErr := normalizeBlockTermKind(candidate.Kind, candidate.Renderer)
			if validationErr != nil {
				return &blockTermPatchMetadataValidationError{err: validationErr}
			}
			candidate.Kind = candidateKind
			if validationErr := validateBlockTermMetadata(
				candidate.Kind,
				candidate.Text,
				candidate.Renderer,
				candidate.StateJSON,
				candidate.PresentationJSON,
			); validationErr != nil {
				return &blockTermPatchMetadataValidationError{err: validationErr}
			}
			if ownershipChanged && h.manager != nil {
				if err := h.manager.ValidateBlockTermOwnershipMutation(existing, candidate); err != nil {
					return err
				}
			}
			result := tx.Model(&model.BlockTermBlock{}).Where("id = ?", id).Updates(updates)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return gorm.ErrRecordNotFound
			}
			if req.Starred != nil {
				candidate.Starred = *req.Starred
				if err := syncBlockTermHistoryStarredFromBlock(tx, candidate, *req.Starred); err != nil {
					return err
				}
			}
			movedTerminal := req.TerminalID != nil && *req.TerminalID != existing.TerminalID
			if (req.Archived != nil && *req.Archived) || movedTerminal {
				if err := terminal.ClearBlockTermViewForBlock(tx, existing.TerminalID, id); err != nil {
					return err
				}
			}
			if movedTerminal {
				// A stale cross-terminal pointer can predate this move (for
				// example, from a legacy client). Clear it before the moved block
				// makes that pointer valid again.
				if err := terminal.ClearBlockTermViewForBlock(tx, *req.TerminalID, id); err != nil {
					return err
				}
			}
			if movedTerminal &&
				tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := tx.Model(&model.BlockTermOutputSegment{}).
					Where("block_id = ? AND terminal_id = ?", id, existing.TerminalID).
					Update("terminal_id", *req.TerminalID).Error; err != nil {
					return err
				}
			}
			if req.TermMaxPTYSize != nil && tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := terminal.TrimBlockTermOutputSegmentsForTerminal(tx, id, candidate.TerminalID, *req.TermMaxPTYSize); err != nil {
					return err
				}
			}
			var snapshot model.BlockTermBlock
			if err := tx.First(&snapshot, "id = ?", id).Error; err != nil {
				return err
			}
			if err := blocktermhistory.Sync(tx, snapshot); err != nil {
				return err
			}
			if includeOutput {
				block = snapshot
				return nil
			}
			return blockTermMetadataQuery(tx).Where("id = ?", id).Take(&metadata).Error
		})
	}()
	h.blockMu.Unlock()
	if err != nil {
		if errors.Is(err, errBlockTermModelOwned) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, terminal.ErrBlockTermRestartBusy) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, terminal.ErrTerminalNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "terminal not found"})
			return
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "block not found"})
			return
		}
		var metadataValidationErr *blockTermPatchMetadataValidationError
		if errors.As(err, &metadataValidationErr) {
			c.JSON(http.StatusBadRequest, gin.H{"error": metadataValidationErr.Error()})
			return
		}
		if isBlockTermConflict(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "terminal_id and line_num already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if includeOutput {
		c.JSON(http.StatusOK, gin.H{"block": block})
		return
	}
	c.JSON(http.StatusOK, gin.H{"block": metadata})
}

func (h *BlockTermHandler) Delete(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	if h.manager != nil {
		unlockLifecycle := h.manager.LockBlockRuntimeLifecycle("", id)
		defer unlockLifecycle()
	}
	var owner struct {
		TerminalID string `gorm:"column:terminal_id"`
	}
	h.blockMu.RLock()
	err := h.db.Model(&model.BlockTermBlock{}).
		Select("terminal_id").
		Where("id = ?", id).
		Take(&owner).Error
	h.blockMu.RUnlock()
	if err == nil && h.manager != nil {
		// Runtime close waits for PTY tail, recorder persistence, durable finalizer,
		// history sync, and final websocket frames. It must run outside blockMu
		// because the finalizer itself takes the same mutation gate.
		err = h.manager.CloseBlockRuntimeForBlock(owner.TerminalID, id)
	}
	if err == nil && h.manager != nil {
		err = h.manager.FlushTerminalOutput(owner.TerminalID)
	}
	if err == nil {
		h.blockMu.Lock()
		err = h.db.Transaction(func(tx *gorm.DB) error {
			var block model.BlockTermBlock
			if err := tx.First(&block, "id = ?", id).Error; err != nil {
				return err
			}
			if block.TerminalID != owner.TerminalID {
				return fmt.Errorf("%w: block %s owner changed", terminal.ErrBlockTermRestartBusy, id)
			}

			var terminalSession model.TerminalSession
			if err := tx.First(&terminalSession, "id = ?", block.TerminalID).Error; err != nil &&
				!errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			deletedAt := time.Now().Unix()
			history := blockTermCommandHistory(terminalSession, block)
			if !blockTermBlockWritesHistory(block) {
				// Keep a stable-ID tombstone without exposing notes or Line AI
				// prompts through command history.
				history.Command = ""
				history.Cwd = ""
			}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&history).Error; err != nil {
				return err
			}
			if err := blocktermhistory.Sync(tx, block); err != nil {
				return err
			}
			if err := blocktermhistory.SyncOutputFromSegments(tx, block); err != nil {
				return err
			}
			if err := tx.Model(&model.BlockTermCommandHistory{}).
				Where("id = ?", id).
				UpdateColumn("block_deleted_at", deletedAt).Error; err != nil {
				return err
			}
			if tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := tx.Where("block_id = ? AND terminal_id = ?", id, block.TerminalID).Delete(&model.BlockTermOutputSegment{}).Error; err != nil {
					return err
				}
			}
			if err := terminal.ClearBlockTermViewForBlock(tx, block.TerminalID, id); err != nil {
				return err
			}
			return tx.Delete(&model.BlockTermBlock{}, "id = ?", id).Error
		})
		h.blockMu.Unlock()
	}
	if err == nil && h.manager != nil {
		// A prepared independent restart has no active route to close. Once the
		// durable row is deleted, retire its reservation and cancel tombstone while
		// the per-block lifecycle lock still excludes a same-ID restart/create.
		h.manager.ClearBlockRuntimePreparation(owner.TerminalID, id)
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "block not found"})
		return
	}
	if err != nil {
		if errors.Is(err, terminal.ErrBlockTermRestartBusy) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func isBlockTermConflict(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") ||
		strings.Contains(message, "duplicate") ||
		strings.Contains(message, "constraint failed")
}
