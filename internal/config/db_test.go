package config

import (
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestMigrateWorkspaceSettingsAddsColumnsAndBackfillsPositions(t *testing.T) {
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

	require.NoError(t, MigrateWorkspaceSettings(db))
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

func TestMigrateWorkspaceSettingsDoesNotCreateTerminalTable(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "no-terminal-table.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, MigrateWorkspaceSettings(db))
	require.False(t, db.Migrator().HasTable(&model.TerminalSession{}))
}
