package config

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestPageTaskMigrationPreservesTerminalsTabsAndRecoveryCopy(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "pages.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	require.NoError(t, db.AutoMigrate(&model.UserSession{}, &model.TerminalSession{}))
	require.NoError(t, MigrateLegacySessionsToWorkspaces(db))
	require.NoError(t, db.Create(&model.WorkspacePluginStorage{WorkspaceID: "ws", PluginID: "fixture", Scope: "folder", Key: "draft", Value: `{"query":"saved"}`}).Error)
	raw := `{"openGroups":[{"id":"folder","name":"Repo","pages":[{"id":"f","type":"files","path":"/repo","tabs":[{"id":"same","title":"File","pinned":true,"data":{"path":"/repo/file"}}]},{"id":"g","type":"git","path":"/repo","tabs":[{"id":"same","title":"Diff","data":{"type":"diff","original":"old","modified":"new"}}]},{"id":"t","type":"terminal","path":"/repo"}]},{"id":"standalone","name":"Terminal","pages":[{"id":"standalone-t","type":"terminal"}]}]}`
	require.NoError(t, db.Create(&model.UserSession{ID: "ws", Name: "Workspace", State: raw}).Error)
	require.NoError(t, db.Create(&model.TerminalSession{ID: "pty", WorkspaceSessionID: "ws", GroupID: "folder", Name: "Shell", Status: "running"}).Error)
	require.NoError(t, db.Create(&model.TerminalSession{ID: "split", WorkspaceSessionID: "ws", GroupID: "folder", ParentID: "pty", Name: "Split", Status: "running"}).Error)
	require.NoError(t, MigrateLegacySessionsToWorkspaces(db))
	var folders []model.WorkspaceFolder
	require.NoError(t, db.Find(&folders).Error)
	require.Len(t, folders, 1)
	var data map[string]any
	require.NoError(t, json.Unmarshal([]byte(folders[0].Data), &data))
	require.Len(t, data["pages"], 1)
	var tools []model.WorkspaceTool
	require.NoError(t, db.Order("id").Find(&tools).Error)
	require.Len(t, tools, 3)
	require.Equal(t, "git", tools[0].PageID)
	require.Contains(t, tools[0].Data, `"repoPath":"/repo"`)
	require.Equal(t, "terminal", tools[1].PageID)
	require.Contains(t, tools[1].Data, `"associatedFolderId":"folder"`)
	require.Equal(t, "standalone", tools[2].ID)
	var ptys []model.TerminalSession
	require.NoError(t, db.Order("id").Find(&ptys).Error)
	for _, pty := range ptys {
		require.Equal(t, "page:folder:t", pty.GroupID)
		require.Equal(t, "running", pty.Status)
	}
	require.Equal(t, "pty", ptys[1].ParentID)
	var tabs []model.WorkspaceTab
	require.NoError(t, db.Order("folder_id").Find(&tabs).Error)
	require.Len(t, tabs, 2)
	require.Equal(t, "folder", tabs[0].FolderID)
	require.True(t, tabs[0].Pinned)
	require.Equal(t, "page:folder:g", tabs[1].FolderID)
	require.Equal(t, "", tabs[1].PageID)
	require.Contains(t, tabs[1].Data, `"modified":"new"`)
	var storage model.WorkspacePluginStorage
	require.NoError(t, db.First(&storage, "workspace_id = ? AND plugin_id = ? AND scope = ? AND key = ?", "ws", "fixture", "page:folder:g", "draft").Error)
	require.Equal(t, `{"query":"saved"}`, storage.Value)
	var workspace model.Workspace
	require.NoError(t, db.First(&workspace, "id = ?", "ws").Error)
	revision := workspace.Revision
	require.NoError(t, MigrateLegacySessionsToWorkspaces(db))
	require.NoError(t, db.First(&workspace, "id = ?", "ws").Error)
	require.Equal(t, revision, workspace.Revision)
	var count int64
	require.NoError(t, db.Model(&model.WorkspaceTool{}).Count(&count).Error)
	require.EqualValues(t, 3, count)
	var recovery model.UserSession
	require.NoError(t, db.First(&recovery, "id = ?", "ws").Error)
	require.Equal(t, raw, recovery.State)
}
