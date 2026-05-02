package config

import (
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestMigrateBlockTermBackfillsLegacyBlockRuntimeSelectionIdempotently(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "legacy-block-runtime.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &legacyBlockTermBlockWithoutOutputCursor{}))

	terminal := model.TerminalSession{
		ID:           "legacy-runtime-terminal",
		RuntimeType:  "ssh",
		SSHProfileID: "parent-profile",
		Status:       model.StatusClosed,
	}
	require.NoError(t, db.Create(&terminal).Error)
	require.NoError(t, db.Create(&legacyBlockTermBlockWithoutOutputCursor{
		ID:         "legacy-runtime-block",
		TerminalID: terminal.ID,
		LineNum:    1,
		Command:    "echo legacy",
		CreatedAt:  10,
		UpdatedAt:  11,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	require.True(t, db.Migrator().HasColumn(&model.BlockTermBlock{}, "runtime_type"))
	require.True(t, db.Migrator().HasColumn(&model.BlockTermBlock{}, "ssh_profile_id"))

	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", "legacy-runtime-block").Error)
	require.Equal(t, "ssh", block.RuntimeType)
	require.Equal(t, "parent-profile", block.SSHProfileID)

	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "parent-profile", history.SSHProfileID)

	// A later terminal change must not rewrite the durable block selection.
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).
		Updates(map[string]any{"runtime_type": "local", "ssh_profile_id": "replacement-profile"}).Error)
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, db.First(&block, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", block.RuntimeType)
	require.Equal(t, "parent-profile", block.SSHProfileID)
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "parent-profile", history.SSHProfileID)
}

func TestMigrateBlockTermHistoryUsesExplicitBlockRuntimeSelection(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "explicit-block-runtime.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &model.BlockTermBlock{}))

	terminal := model.TerminalSession{
		ID:           "explicit-runtime-terminal",
		RuntimeType:  "local",
		SSHProfileID: "parent-profile",
		Status:       model.StatusClosed,
	}
	require.NoError(t, db.Create(&terminal).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:           "explicit-runtime-block",
		TerminalID:   terminal.ID,
		LineNum:      1,
		Command:      "echo child",
		RuntimeType:  "ssh",
		SSHProfileID: "child-profile",
		CreatedAt:    20,
		UpdatedAt:    21,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", "explicit-runtime-block").Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "child-profile", history.SSHProfileID)

	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).
		Updates(map[string]any{"runtime_type": "ssh", "ssh_profile_id": "replacement-profile"}).Error)
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, db.First(&history, "id = ?", "explicit-runtime-block").Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "child-profile", history.SSHProfileID)
}

func TestMigrateBlockTermDefaultsBlankLegacyRuntimeToLocal(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blank-block-runtime.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &legacyBlockTermBlockWithoutOutputCursor{}))

	terminal := model.TerminalSession{ID: "blank-runtime-terminal", Status: model.StatusClosed}
	require.NoError(t, db.Create(&terminal).Error)
	require.NoError(t, db.Create(&legacyBlockTermBlockWithoutOutputCursor{
		ID:         "blank-runtime-block",
		TerminalID: terminal.ID,
		LineNum:    1,
		Command:    "echo local",
		CreatedAt:  30,
		UpdatedAt:  31,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", "blank-runtime-block").Error)
	require.Equal(t, "local", block.RuntimeType)
	require.Empty(t, block.SSHProfileID)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "local", history.RuntimeType)
}

func TestMigrateBlockTermBackfillsNewHistoryProfileFromExactBlockIdentity(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "history-profile-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.TerminalSession{},
		&model.BlockTermBlock{},
		&legacyBlockTermCommandHistory{},
	))

	terminal := model.TerminalSession{
		ID: "history-profile-terminal", RuntimeType: "ssh", SSHProfileID: "parent-profile",
		Status: model.StatusClosed,
	}
	require.NoError(t, db.Create(&terminal).Error)
	block := model.BlockTermBlock{
		ID: "history-profile-block", TerminalID: terminal.ID, LineNum: 1,
		Command: "echo child", RuntimeType: "ssh", SSHProfileID: "child-profile",
		CreatedAt: 40, UpdatedAt: 41,
	}
	require.NoError(t, db.Create(&block).Error)
	require.NoError(t, db.Create(&legacyBlockTermCommandHistory{
		ID: block.ID, TerminalID: block.TerminalID, RuntimeType: "ssh",
		LineNum: block.LineNum, Command: block.Command, CreatedAt: block.CreatedAt,
	}).Error)
	require.False(t, db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "ssh_profile_id"))

	require.NoError(t, MigrateBlockTerm(db))
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "child-profile", history.SSHProfileID)

	// Once populated, the immutable history selection is not rewritten by later
	// changes to either the parent terminal or the durable block.
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).
		Updates(map[string]any{"ssh_profile_id": "replacement-parent"}).Error)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).
		Updates(map[string]any{"ssh_profile_id": "replacement-child"}).Error)
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "child-profile", history.SSHProfileID)
}
