package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type legacyBlockTermBlockWithoutOutputCursor struct {
	ID         string `gorm:"column:id;primaryKey"`
	TerminalID string `gorm:"column:terminal_id;not null;uniqueIndex:idx_blockterm_terminal_line,priority:1"`
	LineNum    int    `gorm:"column:line_num;not null;uniqueIndex:idx_blockterm_terminal_line,priority:2"`
	Command    string `gorm:"column:command;type:text"`
	Cwd        string `gorm:"column:cwd"`
	Status     string `gorm:"column:status;index"`
	Mode       string `gorm:"column:mode"`
	Output     []byte `gorm:"column:output;type:blob"`
	ExitCode   *int   `gorm:"column:exit_code"`
	StartedAt  *int64 `gorm:"column:started_at"`
	FinishedAt *int64 `gorm:"column:finished_at"`
	Collapsed  bool   `gorm:"column:collapsed;not null;default:false"`
	Pinned     bool   `gorm:"column:pinned;not null;default:false"`
	Archived   bool   `gorm:"column:archived;not null;default:false"`
	Starred    bool   `gorm:"column:starred;not null;default:false"`
	Renderer   string `gorm:"column:renderer"`
	StateJSON  string `gorm:"column:state_json;type:text"`
	CreatedAt  int64  `gorm:"column:created_at;not null;index"`
	UpdatedAt  int64  `gorm:"column:updated_at;not null;index"`
}

func (legacyBlockTermBlockWithoutOutputCursor) TableName() string {
	return "blockterm_blocks"
}

type legacyBlockTermCommandHistory struct {
	ID                 string `gorm:"column:id;primaryKey"`
	TerminalID         string `gorm:"column:terminal_id;not null"`
	WorkspaceSessionID string `gorm:"column:workspace_session_id"`
	GroupID            string `gorm:"column:group_id"`
	UserID             string `gorm:"column:user_id"`
	RuntimeType        string `gorm:"column:runtime_type"`
	LineNum            int    `gorm:"column:line_num;not null"`
	Command            string `gorm:"column:command;type:text;not null"`
	Cwd                string `gorm:"column:cwd"`
	CreatedAt          int64  `gorm:"column:created_at;not null"`
	BlockDeletedAt     *int64 `gorm:"column:block_deleted_at"`
}

func (legacyBlockTermCommandHistory) TableName() string {
	return "blockterm_command_history"
}

type legacyBlockTermBookmark struct {
	ID          string `gorm:"column:id;primaryKey"`
	Title       string `gorm:"column:title;type:text;not null"`
	Description string `gorm:"column:description;type:text;not null"`
	Command     string `gorm:"column:command;type:text;not null"`
	CreatedAt   int64  `gorm:"column:created_at;not null"`
	UpdatedAt   int64  `gorm:"column:updated_at;not null"`
}

func (legacyBlockTermBookmark) TableName() string {
	return "blockterm_bookmarks"
}

type legacyTerminalSessionWithoutBlockTermView struct {
	ID                 string `gorm:"column:id;primaryKey"`
	UserID             string `gorm:"column:user_id"`
	WorkspaceSessionID string `gorm:"column:workspace_session_id"`
	GroupID            string `gorm:"column:group_id"`
	Name               string `gorm:"column:name"`
	RuntimeType        string `gorm:"column:runtime_type"`
	Status             string `gorm:"column:status"`
}

func (legacyTerminalSessionWithoutBlockTermView) TableName() string {
	return "terminal_sessions"
}

func TestMigrateBlockTermAddsTerminalViewColumnIdempotently(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "terminal-view-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&legacyTerminalSessionWithoutBlockTermView{}))
	require.NoError(t, db.Create(&legacyTerminalSessionWithoutBlockTermView{
		ID:     "legacy-terminal-view",
		Name:   "legacy",
		Status: model.StatusClosed,
	}).Error)
	require.False(t, db.Migrator().HasColumn(&legacyTerminalSessionWithoutBlockTermView{}, "blockterm_view_json"))

	require.NoError(t, MigrateBlockTerm(db))
	require.True(t, db.Migrator().HasColumn(&model.TerminalSession{}, "blockterm_view_json"))
	var session model.TerminalSession
	require.NoError(t, db.First(&session, "id = ?", "legacy-terminal-view").Error)
	require.Empty(t, session.BlockTermViewJSON)

	state := `{"sidebar":{"open":true,"width":"500px","block_id":null}}`
	require.NoError(t, db.Table("terminal_sessions").Where("id = ?", session.ID).UpdateColumn("blockterm_view_json", state).Error)
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, db.First(&session, "id = ?", session.ID).Error)
	require.Equal(t, state, session.BlockTermViewJSON)
}

func TestMigrateBlockTermAddsWorkspaceSettingsColumnsAndBackfillsPositions(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "workspace-settings-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)

	require.NoError(t, db.Exec(`CREATE TABLE user_sessions (id TEXT PRIMARY KEY, name TEXT, state TEXT, updated_at INTEGER)`).Error)
	require.NoError(t, db.Exec(`CREATE TABLE terminal_sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT,
		workspace_session_id TEXT,
		group_id TEXT,
		name TEXT,
		runtime_type TEXT,
		status TEXT
	)`).Error)
	require.NoError(t, db.Exec(`INSERT INTO user_sessions (id,name,state,updated_at) VALUES ('late','Late','{}',300),('early','Early','{}',100),('middle','Middle','{}',200)`).Error)
	require.NoError(t, db.Exec(`INSERT INTO terminal_sessions (id,name,status) VALUES ('terminal-1','Terminal','exited')`).Error)

	require.NoError(t, MigrateBlockTerm(db))
	require.True(t, db.Migrator().HasColumn(&model.UserSession{}, "position"))
	require.True(t, db.Migrator().HasColumn(&model.TerminalSession{}, "tab_color"))
	require.True(t, db.Migrator().HasColumn(&model.TerminalSession{}, "tab_icon"))

	var sessions []model.UserSession
	require.NoError(t, db.Order("position ASC").Find(&sessions).Error)
	require.Equal(t, []string{"late", "middle", "early"}, []string{sessions[0].ID, sessions[1].ID, sessions[2].ID})
	for i, session := range sessions {
		require.EqualValues(t, i+1, session.Position)
	}
}

func TestMigrateBlockTermDoesNotCreateTerminalTable(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "no-terminal-table.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, MigrateBlockTerm(db))
	require.False(t, db.Migrator().HasTable(&model.TerminalSession{}))
}

func TestMigrateBlockTermCommandHistoryBackfillsIdempotently(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "history-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &model.BlockTermBlock{}))
	require.NoError(t, db.Create(&model.TerminalSession{
		ID:                 "terminal-1",
		WorkspaceSessionID: "workspace-1",
		GroupID:            "group-1",
		UserID:             "user-1",
		RuntimeType:        "local",
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-existing",
		TerminalID: "terminal-1",
		LineNum:    4,
		Command:    "echo original",
		Cwd:        "/original",
		CreatedAt:  10,
		UpdatedAt:  11,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "line-ai-hidden",
		TerminalID: "terminal-1",
		LineNum:    6,
		Kind:       "renderer",
		Command:    "/chat explain",
		Status:     "success",
		Renderer:   "openai",
		Archived:   true,
		StateJSON:  `{"prompt:source":"model","model":"test-model","source_block_id":"block-existing"}`,
		CreatedAt:  12,
		UpdatedAt:  13,
	}).Error)
	require.NoError(t, db.Create([]model.BlockTermBlock{
		{
			ID:         "openai-empty-source",
			TerminalID: "terminal-1",
			LineNum:    7,
			Kind:       "renderer",
			Command:    "/chat ordinary empty",
			Renderer:   "openai",
			StateJSON:  `{"prompt:source":"model","model":"test-model","source_block_id":""}`,
			CreatedAt:  14,
			UpdatedAt:  15,
		},
		{
			ID:         "openai-null-source",
			TerminalID: "terminal-1",
			LineNum:    8,
			Kind:       "renderer",
			Command:    "/chat ordinary null",
			Renderer:   "openai",
			StateJSON:  `{"prompt:source":"model","model":"test-model","source_block_id":null}`,
			CreatedAt:  16,
			UpdatedAt:  17,
		},
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	type foreignKeyRow struct {
		ID int `gorm:"column:id"`
	}
	var foreignKeys []foreignKeyRow
	require.NoError(t, db.Raw("PRAGMA foreign_key_list(blockterm_command_history)").Scan(&foreignKeys).Error)
	require.Empty(t, foreignKeys)

	var existing model.BlockTermCommandHistory
	require.NoError(t, db.First(&existing, "id = ?", "block-existing").Error)
	require.Equal(t, "workspace-1", existing.WorkspaceSessionID)
	require.Equal(t, "group-1", existing.GroupID)
	require.Equal(t, "user-1", existing.UserID)
	require.Equal(t, "local", existing.RuntimeType)
	require.Equal(t, 4, existing.LineNum)
	require.Equal(t, "echo original", existing.Command)
	require.Equal(t, "/original", existing.Cwd)
	require.EqualValues(t, 10, existing.CreatedAt)
	var lineAIHistoryCount int64
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "line-ai-hidden").Count(&lineAIHistoryCount).Error)
	require.Zero(t, lineAIHistoryCount)
	for _, id := range []string{"openai-empty-source", "openai-null-source"} {
		var ordinaryOpenAIHistoryCount int64
		require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", id).Count(&ordinaryOpenAIHistoryCount).Error)
		require.EqualValues(t, 1, ordinaryOpenAIHistoryCount, id)
	}

	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", "block-existing").Updates(map[string]any{
		"workspace_session_id": "preserved-workspace",
		"command":              "preserved command",
		"cwd":                  "/preserved",
	}).Error)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", "block-existing").Updates(map[string]any{
		"command": "echo changed block",
		"cwd":     "/changed",
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-missing",
		TerminalID: "terminal-1",
		LineNum:    5,
		Command:    "echo missing",
		Cwd:        "/missing",
		CreatedAt:  20,
		UpdatedAt:  21,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, MigrateBlockTerm(db))

	require.NoError(t, db.First(&existing, "id = ?", "block-existing").Error)
	require.Equal(t, "preserved-workspace", existing.WorkspaceSessionID)
	require.Equal(t, "preserved command", existing.Command)
	require.Equal(t, "/preserved", existing.Cwd)

	var missing model.BlockTermCommandHistory
	require.NoError(t, db.First(&missing, "id = ?", "block-missing").Error)
	require.Equal(t, "workspace-1", missing.WorkspaceSessionID)
	require.Equal(t, "echo missing", missing.Command)
	require.Equal(t, "/missing", missing.Cwd)

	var count int64
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Count(&count).Error)
	require.EqualValues(t, 4, count)
}

func TestAutoMigrateBlockTermOutputCursorPreservesExistingOutput(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-output-cursor-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&legacyBlockTermBlockWithoutOutputCursor{}))

	originalOutput := []byte("\x1b[31mlegacy-output\x00\xff")
	require.NoError(t, db.Create(&legacyBlockTermBlockWithoutOutputCursor{
		ID:         "legacy-block",
		TerminalID: "legacy-terminal",
		LineNum:    0,
		Output:     originalOutput,
		CreatedAt:  10,
		UpdatedAt:  11,
	}).Error)

	require.NoError(t, db.AutoMigrate(&model.BlockTermBlock{}))
	require.True(t, db.Migrator().HasColumn(&model.BlockTermBlock{}, "output_cursor"))

	var migrated model.BlockTermBlock
	require.NoError(t, db.First(&migrated, "id = ?", "legacy-block").Error)
	require.Equal(t, originalOutput, migrated.Output)
	require.Nil(t, migrated.OutputCursor)
}

func TestMigrateBlockTermLineMetadataClassifiesLegacyRowsAndSkipsNotes(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-line-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &legacyBlockTermBlockWithoutOutputCursor{}))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "legacy-terminal"}).Error)
	exitCode := 7
	startedAt := int64(8)
	finishedAt := int64(9)
	legacyOutput := []byte("\x1b[32mlegacy command\x00\xff")
	require.NoError(t, db.Create([]legacyBlockTermBlockWithoutOutputCursor{
		{
			ID:         "legacy-command",
			TerminalID: "legacy-terminal",
			LineNum:    0,
			Command:    "echo legacy",
			Cwd:        "/legacy/cwd",
			Status:     "success",
			Mode:       "text",
			Output:     legacyOutput,
			ExitCode:   &exitCode,
			StartedAt:  &startedAt,
			FinishedAt: &finishedAt,
			CreatedAt:  10,
			UpdatedAt:  11,
		},
		{
			ID:         "legacy-renderer",
			TerminalID: "legacy-terminal",
			LineNum:    1,
			Command:    "markdownview README.md",
			Renderer:   "markdown",
			CreatedAt:  20,
			UpdatedAt:  21,
		},
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	for _, column := range []string{
		"kind",
		"text",
		"presentation_json",
		"output_cursor",
		"cmd_pid",
		"remote_pid",
		"term_cols",
		"term_rows",
		"term_flex_rows",
		"term_max_pty_size",
		"before_state_json",
		"after_state_json",
	} {
		require.True(t, db.Migrator().HasColumn(&model.BlockTermBlock{}, column), column)
	}

	var blocks []model.BlockTermBlock
	require.NoError(t, db.Order("line_num ASC").Find(&blocks).Error)
	require.Len(t, blocks, 2)
	require.Equal(t, "command", blocks[0].Kind)
	require.Equal(t, "renderer", blocks[1].Kind)
	require.Equal(t, "echo legacy", blocks[0].Command)
	require.Equal(t, "/legacy/cwd", blocks[0].Cwd)
	require.Equal(t, "success", blocks[0].Status)
	require.Equal(t, "text", blocks[0].Mode)
	require.Equal(t, legacyOutput, blocks[0].Output)
	require.Equal(t, exitCode, *blocks[0].ExitCode)
	require.Equal(t, startedAt, *blocks[0].StartedAt)
	require.Equal(t, finishedAt, *blocks[0].FinishedAt)
	require.Empty(t, blocks[0].Text)
	require.Empty(t, blocks[0].PresentationJSON)
	for _, block := range blocks {
		require.Nil(t, block.CmdPID)
		require.Nil(t, block.RemotePID)
		require.Zero(t, block.TermCols)
		require.Zero(t, block.TermRows)
		require.False(t, block.TermFlexRows)
		require.Zero(t, block.TermMaxPTYSize)
		require.Empty(t, block.BeforeStateJSON)
		require.Empty(t, block.AfterStateJSON)
	}

	var tableInfo []struct {
		Name       string  `gorm:"column:name"`
		NotNull    int     `gorm:"column:notnull"`
		DefaultRaw *string `gorm:"column:dflt_value"`
	}
	require.NoError(t, db.Raw("PRAGMA table_info(blockterm_blocks)").Scan(&tableInfo).Error)
	flexRowsFound := false
	for _, column := range tableInfo {
		if column.Name != "term_flex_rows" {
			continue
		}
		flexRowsFound = true
		require.Equal(t, 1, column.NotNull)
		require.NotNil(t, column.DefaultRaw)
		require.Equal(t, "false", strings.ToLower(strings.Trim(*column.DefaultRaw, "()'\"")))
	}
	require.True(t, flexRowsFound)

	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:               "note-after-migration",
		TerminalID:       "legacy-terminal",
		LineNum:          2,
		Kind:             "note",
		Text:             "do not index me",
		PresentationJSON: `{"height":240}`,
		CreatedAt:        30,
		UpdatedAt:        31,
	}).Error)
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, MigrateBlockTerm(db))

	var history []model.BlockTermCommandHistory
	require.NoError(t, db.Order("created_at ASC").Find(&history).Error)
	require.Len(t, history, 2)
	require.Equal(t, []string{"legacy-command", "legacy-renderer"}, []string{history[0].ID, history[1].ID})
}

func TestMigrateBlockTermPreservesExplicitCommandRendererAcrossReruns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-command-renderer.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &model.BlockTermBlock{}))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "terminal-command-renderer"}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "switched-command",
		TerminalID: "terminal-command-renderer",
		LineNum:    0,
		Kind:       "command",
		Command:    "printf '# title\\n'",
		Renderer:   "markdown",
		StateJSON:  `{"prompt:source":"pty"}`,
		CreatedAt:  10,
		UpdatedAt:  11,
	}).Error)

	for range 2 {
		require.NoError(t, MigrateBlockTerm(db))
		var block model.BlockTermBlock
		require.NoError(t, db.First(&block, "id = ?", "switched-command").Error)
		require.Equal(t, "command", block.Kind)
		require.Equal(t, "markdown", block.Renderer)
		require.JSONEq(t, `{"prompt:source":"pty"}`, block.StateJSON)
	}
}

func TestMigrateBlockTermCommandHistoryCoalescesNullLegacyCommand(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-null-command.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &legacyBlockTermBlockWithoutOutputCursor{}))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "legacy-terminal"}).Error)
	require.NoError(t, db.Create(&legacyBlockTermBlockWithoutOutputCursor{
		ID:         "legacy-null-command",
		TerminalID: "legacy-terminal",
		LineNum:    0,
		CreatedAt:  10,
		UpdatedAt:  11,
	}).Error)
	require.NoError(t, db.Exec("UPDATE blockterm_blocks SET command = NULL WHERE id = ?", "legacy-null-command").Error)

	require.NoError(t, MigrateBlockTerm(db))

	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", "legacy-null-command").Error)
	require.Empty(t, history.Command)
}

func TestMigrateBlockTermPreparesNullableKindBeforeConstraint(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-null-kind.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &legacyBlockTermBlockWithoutOutputCursor{}))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "legacy-terminal"}).Error)
	require.NoError(t, db.Create([]legacyBlockTermBlockWithoutOutputCursor{
		{
			ID:         "legacy-command",
			TerminalID: "legacy-terminal",
			LineNum:    0,
			Command:    "echo legacy",
			CreatedAt:  10,
			UpdatedAt:  11,
		},
		{
			ID:         "legacy-renderer",
			TerminalID: "legacy-terminal",
			LineNum:    1,
			Command:    "markdownview README.md",
			Renderer:   "markdown",
			CreatedAt:  20,
			UpdatedAt:  21,
		},
	}).Error)
	require.NoError(t, db.Exec("ALTER TABLE blockterm_blocks ADD COLUMN kind text").Error)

	require.NoError(t, MigrateBlockTerm(db))

	var blocks []model.BlockTermBlock
	require.NoError(t, db.Order("line_num ASC").Find(&blocks).Error)
	require.Len(t, blocks, 2)
	require.Equal(t, "command", blocks[0].Kind)
	require.Equal(t, "renderer", blocks[1].Kind)
	requireSQLiteColumnNotNull(t, db, "blockterm_blocks", "kind")
}

func TestMigrateBlockTermRejectsNullPrimaryKeys(t *testing.T) {
	for _, table := range []string{
		"blockterm_blocks",
		"blockterm_command_history",
		"blockterm_bookmarks",
	} {
		t.Run(table, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-null-id.sqlite")), &gorm.Config{})
			require.NoError(t, err)
			require.NoError(t, db.Exec(fmt.Sprintf("CREATE TABLE %s (id text PRIMARY KEY)", table)).Error)
			require.NoError(t, db.Exec(fmt.Sprintf("INSERT INTO %s DEFAULT VALUES", table)).Error)

			err = MigrateBlockTerm(db)
			require.EqualError(t, err, fmt.Sprintf("%s contains 1 row(s) with NULL id", table))
		})
	}
}

func TestMigrateBlockTermCreatesNonNullPrimaryKeys(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-primary-keys.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}))
	require.NoError(t, MigrateBlockTerm(db))

	for _, table := range []string{
		"blockterm_blocks",
		"blockterm_command_history",
		"blockterm_bookmarks",
	} {
		requireSQLiteColumnNotNull(t, db, table, "id")
		require.Error(t, db.Exec(fmt.Sprintf("INSERT INTO %s (id) VALUES (NULL)", table)).Error)
	}
}

func TestMigrateBlockTermGuardsNullablePrimaryKeysOnLegacyTables(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "blockterm-legacy-primary-keys.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.TerminalSession{},
		&legacyBlockTermBlockWithoutOutputCursor{},
		&legacyBlockTermCommandHistory{},
		&legacyBlockTermBookmark{},
	))
	require.NoError(t, db.Create(&model.TerminalSession{ID: "legacy-terminal"}).Error)
	require.NoError(t, db.Create(&legacyBlockTermBlockWithoutOutputCursor{
		ID:         "legacy-block",
		TerminalID: "legacy-terminal",
		LineNum:    0,
		Command:    "echo legacy",
		CreatedAt:  10,
		UpdatedAt:  11,
	}).Error)
	require.NoError(t, db.Exec("ALTER TABLE blockterm_blocks ADD COLUMN kind text").Error)
	require.NoError(t, db.Create(&legacyBlockTermCommandHistory{
		ID:         "legacy-history",
		TerminalID: "legacy-terminal",
		LineNum:    1,
		Command:    "echo history",
		CreatedAt:  12,
	}).Error)
	require.NoError(t, db.Create(&legacyBlockTermBookmark{
		ID:          "legacy-bookmark",
		Title:       "Legacy",
		Description: "",
		Command:     "echo bookmark",
		CreatedAt:   13,
		UpdatedAt:   14,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))

	for _, table := range []string{
		"blockterm_blocks",
		"blockterm_command_history",
		"blockterm_bookmarks",
	} {
		switch table {
		case "blockterm_blocks":
			require.Error(t, db.Exec("INSERT INTO blockterm_blocks (id, terminal_id, line_num, created_at, updated_at) VALUES (NULL, 'legacy-terminal', 2, 20, 21)").Error)
			require.Error(t, db.Exec("UPDATE blockterm_blocks SET id = NULL WHERE id = 'legacy-block'").Error)
		case "blockterm_command_history":
			require.Error(t, db.Exec("INSERT INTO blockterm_command_history (id, terminal_id, line_num, command, created_at) VALUES (NULL, 'legacy-terminal', 2, 'echo null', 20)").Error)
			require.Error(t, db.Exec("UPDATE blockterm_command_history SET id = NULL WHERE id = 'legacy-history'").Error)
		case "blockterm_bookmarks":
			require.Error(t, db.Exec("INSERT INTO blockterm_bookmarks (id, title, description, command, created_at, updated_at) VALUES (NULL, 'Null', '', 'echo null', 20, 21)").Error)
			require.Error(t, db.Exec("UPDATE blockterm_bookmarks SET id = NULL WHERE id = 'legacy-bookmark'").Error)
		}
	}
	var block model.BlockTermBlock
	require.NoError(t, db.First(&block, "id = ?", "legacy-block").Error)
	require.Equal(t, "command", block.Kind)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", "legacy-history").Error)
	var bookmark model.BlockTermBookmark
	require.NoError(t, db.First(&bookmark, "id = ?", "legacy-bookmark").Error)
}

func requireSQLiteColumnNotNull(t *testing.T, db *gorm.DB, table string, columnName string) {
	t.Helper()
	type tableColumn struct {
		Name    string `gorm:"column:name"`
		NotNull int    `gorm:"column:notnull"`
	}

	var columns []tableColumn
	require.NoError(t, db.Raw(fmt.Sprintf("PRAGMA table_info(%s)", table)).Scan(&columns).Error)
	for _, column := range columns {
		if column.Name == columnName {
			require.Equal(t, 1, column.NotNull, "%s.%s", table, columnName)
			return
		}
	}
	t.Fatalf("column %s.%s not found", table, columnName)
}
