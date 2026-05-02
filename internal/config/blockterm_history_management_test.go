package config

import (
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestMigrateBlockTermBackfillsHistoryStarredWithoutRevivingPurge(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "history-management-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.TerminalSession{},
		&model.BlockTermBlock{},
		&legacyBlockTermCommandHistory{},
	))
	terminal := model.TerminalSession{
		ID: "history-migration-terminal", WorkspaceSessionID: "workspace",
		GroupID: "group", UserID: "user", RuntimeType: "local", SSHProfileID: "original-profile",
	}
	require.NoError(t, db.Create(&terminal).Error)
	movedTerminal := model.TerminalSession{
		ID: "history-migration-moved-terminal", WorkspaceSessionID: "moved-workspace",
		GroupID: "moved-group", UserID: "moved-user", RuntimeType: "ssh", SSHProfileID: "moved-profile",
	}
	require.NoError(t, db.Create(&movedTerminal).Error)
	require.NoError(t, db.Create([]model.BlockTermBlock{
		{ID: "legacy-history", TerminalID: movedTerminal.ID, LineNum: 1, Command: "echo legacy", Starred: true, CreatedAt: 10, UpdatedAt: 10},
		{ID: "missing-history", TerminalID: terminal.ID, LineNum: 2, Command: "echo missing", Starred: true, CreatedAt: 20, UpdatedAt: 20},
	}).Error)
	require.NoError(t, db.Create(&legacyBlockTermCommandHistory{
		ID:                 "legacy-history",
		TerminalID:         terminal.ID,
		WorkspaceSessionID: terminal.WorkspaceSessionID,
		GroupID:            terminal.GroupID,
		UserID:             terminal.UserID,
		RuntimeType:        terminal.RuntimeType,
		LineNum:            1,
		Command:            "immutable legacy command",
		Cwd:                "/legacy",
		CreatedAt:          10,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	require.True(t, db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "starred"))
	require.True(t, db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "history_purged_at"))
	for _, id := range []string{"legacy-history", "missing-history"} {
		var history model.BlockTermCommandHistory
		require.NoError(t, db.First(&history, "id = ?", id).Error)
		require.True(t, history.Starred, id)
	}
	var legacy model.BlockTermCommandHistory
	require.NoError(t, db.First(&legacy, "id = ?", "legacy-history").Error)
	require.Equal(t, "immutable legacy command", legacy.Command)
	require.Equal(t, "/legacy", legacy.Cwd)
	require.Equal(t, "local", legacy.RuntimeType)
	require.Equal(t, "original-profile", legacy.SSHProfileID)
	var missing model.BlockTermCommandHistory
	require.NoError(t, db.First(&missing, "id = ?", "missing-history").Error)
	require.Equal(t, "local", missing.RuntimeType)
	require.Equal(t, "original-profile", missing.SSHProfileID)

	purgedAt := int64(50)
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "legacy-history").Updates(map[string]any{
		"starred":           false,
		"history_purged_at": purgedAt,
	}).Error)
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, db.First(&legacy, "id = ?", "legacy-history").Error)
	require.False(t, legacy.Starred)
	require.NotNil(t, legacy.HistoryPurgedAt)
	require.Equal(t, purgedAt, *legacy.HistoryPurgedAt)
	require.Equal(t, "immutable legacy command", legacy.Command)
}
