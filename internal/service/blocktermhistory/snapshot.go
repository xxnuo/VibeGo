package blocktermhistory

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func ShouldWrite(block model.BlockTermBlock) bool {
	if block.Renderer == "openai" {
		var state struct {
			SourceBlockID string `json:"source_block_id"`
		}
		if json.Unmarshal([]byte(block.StateJSON), &state) == nil && state.SourceBlockID != "" {
			return false
		}
	}
	return block.Kind != "note"
}

func NewSnapshot(terminal model.TerminalSession, block model.BlockTermBlock) model.BlockTermCommandHistory {
	// Runtime selection belongs to the command block. Keep the terminal values
	// only as a compatibility fallback for rows written before per-block fields
	// existed; once a block has an explicit value, later terminal changes must
	// not rewrite its history identity or execution context.
	runtimeType := strings.TrimSpace(block.RuntimeType)
	sshProfileID := strings.TrimSpace(block.SSHProfileID)
	if runtimeType == "" {
		runtimeType = strings.TrimSpace(terminal.RuntimeType)
	}
	if runtimeType == "" {
		runtimeType = "local"
	}
	if sshProfileID == "" && runtimeType == "ssh" {
		sshProfileID = strings.TrimSpace(terminal.SSHProfileID)
	}
	return model.BlockTermCommandHistory{
		ID:                 block.ID,
		TerminalID:         block.TerminalID,
		WorkspaceSessionID: terminal.WorkspaceSessionID,
		GroupID:            terminal.GroupID,
		UserID:             terminal.UserID,
		RuntimeType:        runtimeType,
		SSHProfileID:       sshProfileID,
		LineNum:            block.LineNum,
		Command:            block.Command,
		Cwd:                block.Cwd,
		Starred:            block.Starred,
		CreatedAt:          block.CreatedAt,
		Kind:               block.Kind,
		Text:               block.Text,
		Status:             block.Status,
		Mode:               block.Mode,
		Output:             append([]byte(nil), block.Output...),
		OutputCursor:       block.OutputCursor,
		CmdPID:             block.CmdPID,
		RemotePID:          block.RemotePID,
		TermCols:           block.TermCols,
		TermRows:           block.TermRows,
		TermFlexRows:       block.TermFlexRows,
		TermMaxPTYSize:     block.TermMaxPTYSize,
		BeforeStateJSON:    block.BeforeStateJSON,
		AfterStateJSON:     block.AfterStateJSON,
		ExitCode:           block.ExitCode,
		StartedAt:          block.StartedAt,
		FinishedAt:         block.FinishedAt,
		Renderer:           block.Renderer,
		StateJSON:          block.StateJSON,
		PresentationJSON:   block.PresentationJSON,
		SnapshotUpdatedAt:  block.UpdatedAt,
	}
}

func snapshotUpdates(block model.BlockTermBlock) map[string]any {
	return map[string]any{
		"runtime_type":        block.RuntimeType,
		"ssh_profile_id":      block.SSHProfileID,
		"kind":                block.Kind,
		"text":                block.Text,
		"status":              block.Status,
		"mode":                block.Mode,
		"output":              block.Output,
		"output_cursor":       block.OutputCursor,
		"cmd_pid":             block.CmdPID,
		"remote_pid":          block.RemotePID,
		"term_cols":           block.TermCols,
		"term_rows":           block.TermRows,
		"term_flex_rows":      block.TermFlexRows,
		"term_max_pty_size":   block.TermMaxPTYSize,
		"before_state_json":   block.BeforeStateJSON,
		"after_state_json":    block.AfterStateJSON,
		"exit_code":           block.ExitCode,
		"started_at":          block.StartedAt,
		"finished_at":         block.FinishedAt,
		"renderer":            block.Renderer,
		"state_json":          block.StateJSON,
		"presentation_json":   block.PresentationJSON,
		"snapshot_updated_at": block.UpdatedAt,
	}
}

func snapshotTableReady(tx *gorm.DB) bool {
	return tx != nil &&
		tx.Migrator().HasTable(&model.BlockTermCommandHistory{})
}

func historyColumn(tx *gorm.DB, name string) bool {
	return snapshotTableReady(tx) && tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, name)
}

func applyHistoryColumns(tx *gorm.DB, updates map[string]any) map[string]any {
	filtered := make(map[string]any, len(updates))
	for column, value := range updates {
		if historyColumn(tx, column) {
			filtered[column] = value
		}
	}
	return filtered
}

func historyIdentityQuery(tx *gorm.DB, block model.BlockTermBlock) *gorm.DB {
	query := tx.Model(&model.BlockTermCommandHistory{}).
		Where("id = ? AND created_at = ?", block.ID, block.CreatedAt)
	if historyColumn(tx, "history_purged_at") {
		query = query.Where("history_purged_at IS NULL")
	}
	return query
}

// Sync updates only the mutable execution snapshot. Command ownership and the
// original command metadata remain fixed at history creation time.
func Sync(tx *gorm.DB, block model.BlockTermBlock) error {
	return sync(tx, block, false)
}

func SyncByID(tx *gorm.DB, blockID string) error {
	if !snapshotTableReady(tx) {
		return nil
	}
	var block model.BlockTermBlock
	if err := tx.First(&block, "id = ?", blockID).Error; err != nil {
		return err
	}
	return Sync(tx, block)
}

func SyncAll(tx *gorm.DB) error {
	// Bulk reconciliation repairs mutable snapshots only. Connection selection is
	// execution identity and must not drift because a durable block or its parent
	// terminal was edited after the history row was created.
	return syncBlocks(tx, nil, true)
}

func SyncTerminals(tx *gorm.DB, terminalIDs []string) error {
	if len(terminalIDs) == 0 {
		return nil
	}
	return syncBlocks(tx, terminalIDs, false)
}

// SyncAllForMigration refreshes mutable block state while preserving the
// immutable connection identity already recorded by an existing history row.
// Migration fills missing connection columns explicitly before calling this
// function; an existing non-empty value must never be replaced by a block that
// was moved or by a later parent-terminal change.
func SyncAllForMigration(tx *gorm.DB) error {
	return syncBlocks(tx, nil, true)
}

func syncBlocks(tx *gorm.DB, terminalIDs []string, preserveHistoryIdentity bool) error {
	if !snapshotTableReady(tx) || !tx.Migrator().HasTable(&model.BlockTermBlock{}) {
		return nil
	}
	query := tx.Model(&model.BlockTermBlock{}).Where("kind <> ?", "note")
	if len(terminalIDs) > 0 {
		query = query.Where("terminal_id IN ?", terminalIDs)
	}
	var blocks []model.BlockTermBlock
	if err := query.Find(&blocks).Error; err != nil {
		return err
	}
	for _, block := range blocks {
		if !ShouldWrite(block) {
			continue
		}
		if err := sync(tx, block, preserveHistoryIdentity); err != nil {
			return err
		}
		if err := SyncOutputFromSegments(tx, block); err != nil {
			return err
		}
	}
	return nil
}

func sync(tx *gorm.DB, block model.BlockTermBlock, preserveHistoryIdentity bool) error {
	if !snapshotTableReady(tx) || !ShouldWrite(block) {
		return nil
	}
	updates := snapshotUpdates(block)
	if preserveHistoryIdentity {
		delete(updates, "runtime_type")
		delete(updates, "ssh_profile_id")
	}
	updates = applyHistoryColumns(tx, updates)
	if len(updates) == 0 {
		return nil
	}
	return historyIdentityQuery(tx, block).Updates(updates).Error
}

// SyncOutputFromSegments materializes the retained raw PTY ranges into the
// immutable history row before the source block or its segment rows are
// removed. Recorder segments are authoritative because their asynchronous
// persistence can be ahead of the block's display projection.
func SyncOutputFromSegments(tx *gorm.DB, block model.BlockTermBlock) error {
	if !snapshotTableReady(tx) || !ShouldWrite(block) ||
		!tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
		return nil
	}
	var segments []model.BlockTermOutputSegment
	if err := tx.Where("block_id = ? AND terminal_id = ?", block.ID, block.TerminalID).
		Order("start_cursor ASC, end_cursor ASC, id ASC").Find(&segments).Error; err != nil {
		return err
	}
	if len(segments) == 0 {
		return nil
	}
	endCursor, err := validateRawOutputSegments(segments)
	if err != nil {
		return err
	}
	maxBytes := block.TermMaxPTYSize
	if maxBytes <= 0 || maxBytes > model.BlockTermMaxPTYSize {
		maxBytes = model.BlockTermMaxPTYSize
	}
	materialized := make([]byte, 0, maxBytes)
	for _, segment := range segments {
		materialized = append(materialized, segment.Data...)
		if len(materialized) > maxBytes {
			materialized = materialized[len(materialized)-maxBytes:]
		}
	}
	cursor := int64(endCursor)
	updates := applyHistoryColumns(tx, map[string]any{
		"output":              materialized,
		"output_cursor":       &cursor,
		"snapshot_updated_at": block.UpdatedAt,
	})
	if len(updates) == 0 {
		return nil
	}
	return historyIdentityQuery(tx, block).Updates(updates).Error
}

// validateRawOutputSegments applies the same half-open range rules used by
// the raw-output reader. Gaps are allowed because OSC framing can leave bytes
// that belong to another lifecycle, while overlapping ranges are ambiguous
// and must never be materialized twice.
func validateRawOutputSegments(segments []model.BlockTermOutputSegment) (uint64, error) {
	var maxEndCursor uint64
	for index, segment := range segments {
		if segment.EndCursor < segment.StartCursor ||
			segment.EndCursor-segment.StartCursor != uint64(len(segment.Data)) {
			return 0, fmt.Errorf("invalid blockterm raw output segment %s", segment.ID)
		}
		if segment.EndCursor > math.MaxInt64 {
			return 0, fmt.Errorf("blockterm raw output cursor exceeds signed history range")
		}
		if index > 0 {
			previous := segments[index-1]
			if segment.StartCursor < previous.EndCursor ||
				(segment.StartCursor == previous.StartCursor && segment.EndCursor == previous.EndCursor) {
				return 0, fmt.Errorf("invalid blockterm raw output segment %s", segment.ID)
			}
		}
		if segment.EndCursor > maxEndCursor {
			maxEndCursor = segment.EndCursor
		}
	}
	return maxEndCursor, nil
}
