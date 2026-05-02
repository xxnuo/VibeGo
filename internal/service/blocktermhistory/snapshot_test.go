package blocktermhistory

import (
	"bytes"
	"math"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func newSnapshotSyncDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "snapshot.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
		&model.BlockTermOutputSegment{},
	))
	return db
}

func seedSnapshotSyncBlock(t *testing.T, db *gorm.DB, id string, maxPTYSize int) model.BlockTermBlock {
	t.Helper()
	block := model.BlockTermBlock{
		ID: id, TerminalID: id + "-terminal", LineNum: 1,
		Kind: "command", Command: "printf snapshot", TermMaxPTYSize: maxPTYSize,
		CreatedAt: 10, UpdatedAt: 20,
	}
	require.NoError(t, db.Create(&block).Error)
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: block.ID, TerminalID: block.TerminalID, LineNum: block.LineNum,
		Command: block.Command, CreatedAt: block.CreatedAt,
	}).Error)
	return block
}

func snapshotHistoryOutput(t *testing.T, db *gorm.DB, blockID string) (model.BlockTermCommandHistory, []byte) {
	t.Helper()
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", blockID).Error)
	return history, append([]byte(nil), history.Output...)
}

func TestSyncOutputFromSegmentsAllowsGapsAndUsesMaximumEndCursor(t *testing.T) {
	db := newSnapshotSyncDB(t)
	block := seedSnapshotSyncBlock(t, db, "snapshot-gap", 64)
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).
		Where("id = ?", block.ID).Update("output", []byte("stale")).Error)
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{ID: "snapshot-gap-tail", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 20, EndCursor: 24, Data: []byte("WXYZ")},
		{ID: "snapshot-gap-head", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 10, EndCursor: 13, Data: []byte("abc")},
	}).Error)

	require.NoError(t, SyncOutputFromSegments(db, block))
	history, output := snapshotHistoryOutput(t, db, block.ID)
	require.Equal(t, []byte("abcWXYZ"), output)
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, 24, *history.OutputCursor)
}

func TestSyncOutputFromSegmentsRejectsOverlapWithoutUpdatingHistory(t *testing.T) {
	db := newSnapshotSyncDB(t)
	block := seedSnapshotSyncBlock(t, db, "snapshot-overlap", 64)
	initialCursor := int64(7)
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).
		Where("id = ?", block.ID).Updates(map[string]any{
		"output":        []byte("stale"),
		"output_cursor": &initialCursor,
	}).Error)
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{ID: "snapshot-overlap-first", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 10, EndCursor: 14, Data: []byte("abcd")},
		{ID: "snapshot-overlap-second", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 12, EndCursor: 15, Data: []byte("xyz")},
	}).Error)

	err := SyncOutputFromSegments(db, block)
	require.Error(t, err)
	require.ErrorContains(t, err, "invalid blockterm raw output segment snapshot-overlap-second")
	history, output := snapshotHistoryOutput(t, db, block.ID)
	require.Equal(t, []byte("stale"), output)
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, initialCursor, *history.OutputCursor)
}

func TestValidateRawOutputSegmentsRejectsDuplicateRange(t *testing.T) {
	_, err := validateRawOutputSegments([]model.BlockTermOutputSegment{
		{ID: "duplicate-first", StartCursor: 10, EndCursor: 14, Data: []byte("abcd")},
		{ID: "duplicate-second", StartCursor: 10, EndCursor: 14, Data: []byte("abcd")},
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "invalid blockterm raw output segment duplicate-second")
}

func TestValidateRawOutputSegmentsHonorsSignedCursorBoundary(t *testing.T) {
	require.NotPanics(t, func() {
		endCursor, err := validateRawOutputSegments([]model.BlockTermOutputSegment{{
			ID: "max-int64", StartCursor: uint64(math.MaxInt64 - 1),
			EndCursor: uint64(math.MaxInt64), Data: []byte("x"),
		}})
		require.NoError(t, err)
		require.Equal(t, uint64(math.MaxInt64), endCursor)
	})

	_, err := validateRawOutputSegments([]model.BlockTermOutputSegment{{
		ID: "over-max-int64", StartCursor: uint64(math.MaxInt64),
		EndCursor: uint64(math.MaxInt64) + 1, Data: []byte("x"),
	}})
	require.Error(t, err)
	require.ErrorContains(t, err, "exceeds signed history range")
}

func TestSyncOutputFromSegmentsAcceptsMaxInt64EndCursor(t *testing.T) {
	db := newSnapshotSyncDB(t)
	block := seedSnapshotSyncBlock(t, db, "snapshot-max-int64", 8)
	require.NoError(t, db.Create(&model.BlockTermOutputSegment{
		ID: "snapshot-max-int64-segment", TerminalID: block.TerminalID, BlockID: block.ID,
		StartCursor: uint64(math.MaxInt64 - 1), EndCursor: uint64(math.MaxInt64), Data: []byte("x"),
	}).Error)

	require.NoError(t, SyncOutputFromSegments(db, block))
	history, output := snapshotHistoryOutput(t, db, block.ID)
	require.Equal(t, []byte("x"), output)
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, math.MaxInt64, *history.OutputCursor)
}

func TestSyncOutputFromSegmentsKeepsExactSixteenMiB(t *testing.T) {
	db := newSnapshotSyncDB(t)
	block := seedSnapshotSyncBlock(t, db, "snapshot-exact-max", model.BlockTermMaxPTYSize)
	firstSize := model.BlockTermMaxPTYSize / 2
	secondSize := model.BlockTermMaxPTYSize - firstSize
	first := bytes.Repeat([]byte{'a'}, firstSize)
	second := bytes.Repeat([]byte{'b'}, secondSize)
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{ID: "snapshot-exact-max-first", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 100, EndCursor: 100 + uint64(firstSize), Data: first},
		{ID: "snapshot-exact-max-second", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 100 + uint64(firstSize),
			EndCursor:   100 + uint64(model.BlockTermMaxPTYSize), Data: second},
	}).Error)

	require.NoError(t, SyncOutputFromSegments(db, block))
	history, output := snapshotHistoryOutput(t, db, block.ID)
	require.Len(t, output, model.BlockTermMaxPTYSize)
	require.Equal(t, first, output[:firstSize])
	require.Equal(t, second, output[firstSize:])
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, 100+model.BlockTermMaxPTYSize, *history.OutputCursor)
}

func TestSyncOutputFromSegmentsTruncatesGlobalTailAcrossSegments(t *testing.T) {
	db := newSnapshotSyncDB(t)
	block := seedSnapshotSyncBlock(t, db, "snapshot-truncate", 8)
	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{ID: "snapshot-truncate-first", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 100, EndCursor: 105, Data: []byte("abcde")},
		{ID: "snapshot-truncate-second", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 110, EndCursor: 116, Data: []byte("123456")},
	}).Error)

	require.NoError(t, SyncOutputFromSegments(db, block))
	history, output := snapshotHistoryOutput(t, db, block.ID)
	require.Equal(t, []byte("de123456"), output)
	require.Len(t, output, 8)
	require.NotNil(t, history.OutputCursor)
	require.EqualValues(t, 116, *history.OutputCursor)
}

func TestSnapshotSyncSupportsPartialHistorySchema(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "partial-history.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.Exec(`
		CREATE TABLE blockterm_command_history (
			id TEXT PRIMARY KEY NOT NULL,
			terminal_id TEXT NOT NULL,
			workspace_session_id TEXT,
			group_id TEXT,
			user_id TEXT,
			line_num INTEGER NOT NULL,
			command TEXT NOT NULL,
			cwd TEXT,
			starred NUMERIC NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			kind TEXT,
			text TEXT,
			status TEXT,
			mode TEXT,
			output BLOB,
			output_cursor INTEGER,
			cmd_pid INTEGER,
			remote_pid INTEGER,
			term_cols INTEGER,
			term_rows INTEGER,
			term_flex_rows NUMERIC,
			term_max_pty_size INTEGER,
			before_state_json TEXT,
			after_state_json TEXT,
			exit_code INTEGER,
			started_at INTEGER,
			finished_at INTEGER,
			renderer TEXT,
			state_json TEXT,
			presentation_json TEXT
		)
	`).Error)
	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}, &model.BlockTermOutputSegment{}))
	require.False(t, db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "history_purged_at"))
	require.False(t, db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "snapshot_updated_at"))
	require.False(t, db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "ssh_profile_id"))

	displayCursor := int64(5)
	block := model.BlockTermBlock{
		ID: "partial-history-block", TerminalID: "partial-history-terminal", LineNum: 1,
		Kind: "command", Command: "printf partial", Output: []byte("stale"),
		OutputCursor: &displayCursor, Renderer: "terminal", CreatedAt: 10, UpdatedAt: 20,
	}
	require.NoError(t, db.Create(&block).Error)
	require.NoError(t, db.Exec(`
		INSERT INTO blockterm_command_history (
			id, terminal_id, line_num, command, cwd, starred, created_at, output, output_cursor
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, block.ID, block.TerminalID, block.LineNum, block.Command, block.Cwd, false, block.CreatedAt, []byte("old"), 3).Error)

	require.NoError(t, Sync(db, block))
	var display struct {
		Output       []byte `gorm:"column:output"`
		OutputCursor *int64 `gorm:"column:output_cursor"`
	}
	require.NoError(t, db.Table((model.BlockTermCommandHistory{}).TableName()).
		Select("output", "output_cursor").Where("id = ?", block.ID).Take(&display).Error)
	require.Equal(t, block.Output, display.Output)
	require.Equal(t, block.OutputCursor, display.OutputCursor)

	require.NoError(t, db.Create([]model.BlockTermOutputSegment{
		{ID: "partial-history-tail", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 9, EndCursor: 13, Data: []byte("tail"), CreatedAt: 12},
		{ID: "partial-history-head", TerminalID: block.TerminalID, BlockID: block.ID,
			StartCursor: 5, EndCursor: 9, Data: []byte("raw\x00"), CreatedAt: 11},
	}).Error)
	require.NoError(t, SyncTerminals(db, []string{block.TerminalID}))
	require.NoError(t, SyncAll(db))

	var materialized struct {
		Output       []byte `gorm:"column:output"`
		OutputCursor *int64 `gorm:"column:output_cursor"`
	}
	require.NoError(t, db.Table((model.BlockTermCommandHistory{}).TableName()).
		Select("output", "output_cursor").Where("id = ?", block.ID).Take(&materialized).Error)
	require.Equal(t, []byte("raw\x00tail"), materialized.Output)
	require.NotNil(t, materialized.OutputCursor)
	require.EqualValues(t, 13, *materialized.OutputCursor)
}

func TestSyncAllPreservesHistoryRuntimeSelection(t *testing.T) {
	db := newSnapshotSyncDB(t)
	block := seedSnapshotSyncBlock(t, db, "snapshot-runtime-identity", 64)
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", block.ID).Updates(map[string]any{
		"runtime_type": "ssh", "ssh_profile_id": "original-profile",
	}).Error)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Updates(map[string]any{
		"runtime_type": "local", "ssh_profile_id": "", "status": "success",
	}).Error)

	require.NoError(t, SyncAll(db))
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "original-profile", history.SSHProfileID)
	require.Equal(t, "success", history.Status)
}
