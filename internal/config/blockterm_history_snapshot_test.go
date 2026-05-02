package config

import (
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestMigrateBlockTermBackfillsMutableHistorySnapshotWithoutChangingIdentity(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "history-snapshot-migration.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TerminalSession{}, &model.BlockTermBlock{}))

	terminal := model.TerminalSession{
		ID:                 "snapshot-terminal",
		WorkspaceSessionID: "snapshot-workspace",
		GroupID:            "snapshot-group",
		UserID:             "snapshot-user",
		RuntimeType:        "ssh",
		SSHProfileID:       "snapshot-profile",
		Status:             model.StatusClosed,
	}
	require.NoError(t, db.Create(&terminal).Error)

	outputCursor := int64(21)
	cmdPID := int64(101)
	remotePID := int64(202)
	exitCode := 7
	startedAt := int64(11)
	finishedAt := int64(12)
	block := model.BlockTermBlock{
		ID:               "snapshot-block",
		TerminalID:       terminal.ID,
		LineNum:          3,
		Kind:             "renderer",
		Command:          "/markdown report.md",
		Text:             "original text",
		Cwd:              "/original",
		Status:           "success",
		Mode:             "shell",
		Output:           []byte("original\x00output"),
		OutputCursor:     &outputCursor,
		CmdPID:           &cmdPID,
		RemotePID:        &remotePID,
		TermCols:         120,
		TermRows:         32,
		TermFlexRows:     true,
		TermMaxPTYSize:   64,
		BeforeStateJSON:  `{"cwd":"/before"}`,
		AfterStateJSON:   `{"cwd":"/after"}`,
		ExitCode:         &exitCode,
		StartedAt:        &startedAt,
		FinishedAt:       &finishedAt,
		Starred:          true,
		Renderer:         "markdownview",
		StateJSON:        `{"file":"report.md"}`,
		PresentationJSON: `{"height":320}`,
		CreatedAt:        10,
		UpdatedAt:        13,
	}
	require.NoError(t, db.Create(&block).Error)
	require.NoError(t, MigrateBlockTerm(db))

	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, block.Output, history.Output)
	require.Equal(t, block.OutputCursor, history.OutputCursor)
	require.Equal(t, terminal.SSHProfileID, history.SSHProfileID)
	require.Equal(t, block.Renderer, history.Renderer)
	require.EqualValues(t, block.UpdatedAt, history.SnapshotUpdatedAt)

	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).Where("id = ?", block.ID).Updates(map[string]any{
		"terminal_id":          "preserved-terminal",
		"workspace_session_id": "preserved-workspace",
		"group_id":             "preserved-group",
		"user_id":              "preserved-user",
		"line_num":             99,
		"command":              "preserved command",
		"cwd":                  "/preserved",
		"starred":              false,
	}).Error)

	newOutputCursor := int64(44)
	newRemotePID := int64(303)
	newExitCode := 0
	newFinishedAt := int64(30)
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", terminal.ID).Updates(map[string]any{
		"runtime_type":   "local",
		"ssh_profile_id": "replacement-profile",
	}).Error)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Updates(map[string]any{
		"line_num":          4,
		"command":           "changed command",
		"cwd":               "/changed",
		"kind":              "command",
		"text":              "updated text",
		"status":            "failed",
		"mode":              "restart",
		"output":            []byte("updated\x00output"),
		"output_cursor":     newOutputCursor,
		"cmd_pid":           nil,
		"remote_pid":        newRemotePID,
		"term_cols":         90,
		"term_rows":         20,
		"term_flex_rows":    false,
		"term_max_pty_size": 48,
		"before_state_json": `{"cwd":"/new-before"}`,
		"after_state_json":  `{"cwd":"/new-after"}`,
		"exit_code":         newExitCode,
		"started_at":        nil,
		"finished_at":       newFinishedAt,
		"renderer":          "terminal",
		"state_json":        `{"source":"pty"}`,
		"presentation_json": `{"height":240}`,
		"updated_at":        31,
	}).Error)

	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, MigrateBlockTerm(db))
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)

	require.Equal(t, "preserved-terminal", history.TerminalID)
	require.Equal(t, "preserved-workspace", history.WorkspaceSessionID)
	require.Equal(t, "preserved-group", history.GroupID)
	require.Equal(t, "preserved-user", history.UserID)
	require.Equal(t, 99, history.LineNum)
	require.Equal(t, "preserved command", history.Command)
	require.Equal(t, "/preserved", history.Cwd)
	require.False(t, history.Starred)

	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "snapshot-profile", history.SSHProfileID)
	require.Equal(t, "command", history.Kind)
	require.Equal(t, "updated text", history.Text)
	require.Equal(t, "failed", history.Status)
	require.Equal(t, "restart", history.Mode)
	require.Equal(t, []byte("updated\x00output"), history.Output)
	require.Equal(t, &newOutputCursor, history.OutputCursor)
	require.Nil(t, history.CmdPID)
	require.Equal(t, &newRemotePID, history.RemotePID)
	require.Equal(t, 90, history.TermCols)
	require.Equal(t, 20, history.TermRows)
	require.False(t, history.TermFlexRows)
	require.Equal(t, 48, history.TermMaxPTYSize)
	require.Equal(t, `{"cwd":"/new-before"}`, history.BeforeStateJSON)
	require.Equal(t, `{"cwd":"/new-after"}`, history.AfterStateJSON)
	require.Equal(t, &newExitCode, history.ExitCode)
	require.Nil(t, history.StartedAt)
	require.Equal(t, &newFinishedAt, history.FinishedAt)
	require.Equal(t, "terminal", history.Renderer)
	require.Equal(t, `{"source":"pty"}`, history.StateJSON)
	require.Equal(t, `{"height":240}`, history.PresentationJSON)
	require.EqualValues(t, 31, history.SnapshotUpdatedAt)
}
