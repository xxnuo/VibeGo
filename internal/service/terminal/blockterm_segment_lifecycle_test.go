package terminal

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestManagerCleanupOnStartReclaimsOrphanOutputSegments(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	old := time.Now().Add(-time.Hour).Unix()
	require.NoError(t, db.Create(&model.BlockTermOutputSegment{
		ID: "startup-orphan-segment", TerminalID: "startup-orphan-terminal", BlockID: "missing-block",
		StartCursor: 1, EndCursor: 7, Data: []byte("orphan"), CreatedAt: old,
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	manager.CleanupOnStart()

	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("id = ?", "startup-orphan-segment").Count(&count).Error)
	require.Zero(t, count)
}

func TestManagerDeleteRemovesBlockTermOutputSegments(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: "segment-delete-terminal", Name: "segment-delete", Status: model.StatusClosed,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermOutputSegment{
		ID: "segment-delete-row", TerminalID: "segment-delete-terminal", BlockID: "segment-delete-block",
		StartCursor: 1, EndCursor: 4, Data: []byte("raw"), CreatedAt: 1,
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	require.NoError(t, manager.Delete("segment-delete-terminal"))

	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("terminal_id = ?", "segment-delete-terminal").Count(&count).Error)
	require.Zero(t, count)
}

func TestManagerDeleteWorkspaceRemovesBlockTermOutputSegments(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.BlockTermOutputSegment{}))
	require.NoError(t, db.Create(&model.UserSession{ID: "segment-delete-workspace", Name: "segment-delete-workspace", State: "{}"}).Error)
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: "segment-workspace-terminal", WorkspaceSessionID: "segment-delete-workspace",
		Name: "segment-workspace-terminal", Status: model.StatusClosed,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermOutputSegment{
		ID: "segment-workspace-row", TerminalID: "segment-workspace-terminal", BlockID: "segment-workspace-block",
		StartCursor: 5, EndCursor: 8, Data: []byte("raw"), CreatedAt: 1,
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	require.NoError(t, manager.DeleteWorkspace("segment-delete-workspace"))

	var count int64
	require.NoError(t, db.Model(&model.BlockTermOutputSegment{}).
		Where("terminal_id = ?", "segment-workspace-terminal").Count(&count).Error)
	require.Zero(t, count)
}
