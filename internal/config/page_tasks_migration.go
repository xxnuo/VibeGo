package config

import (
	"encoding/json"
	"fmt"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

// Runs before terminal runtimes start. Original UserSession.State remains a recovery copy.
func migratePageTasks(tx *gorm.DB) error {
	var folders []model.WorkspaceFolder
	if err := tx.Find(&folders).Error; err != nil {
		return err
	}
	changed := map[string]bool{}
	for _, folder := range folders {
		var data map[string]json.RawMessage
		if err := json.Unmarshal([]byte(folder.Data), &data); err != nil {
			return err
		}
		var pages []struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Label string `json:"label"`
			Path  string `json:"path"`
		}
		if raw := data["pages"]; len(raw) > 0 {
			if err := json.Unmarshal(raw, &pages); err != nil {
				return err
			}
		}
		hasFiles := false
		for _, page := range pages {
			if page.Type == "files" {
				hasFiles = true
			}
		}
		folderChanged := false
		filePages := []any{}
		for _, page := range pages {
			if page.Type == "files" {
				filePages = append(filePages, page)
				continue
			}
			id := "page:" + folder.ID + ":" + page.ID
			if !hasFiles && len(pages) == 1 {
				id = folder.ID
			}
			var count int64
			if err := tx.Model(&model.WorkspaceTool{}).Where("workspace_id = ? AND id = ?", folder.WorkspaceID, id).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				return fmt.Errorf("page task migration: duplicate owner %s", id)
			}
			if id != folder.ID {
				if err := tx.Model(&model.WorkspaceFolder{}).Where("workspace_id = ? AND id = ?", folder.WorkspaceID, id).Count(&count).Error; err != nil {
					return err
				}
				if count > 0 {
					return fmt.Errorf("page task migration: duplicate folder %s", id)
				}
			}
			toolData := map[string]json.RawMessage{}
			for key, value := range data {
				if key != "pages" {
					toolData[key] = value
				}
			}
			set := func(key, value string) { raw, _ := json.Marshal(value); toolData[key] = raw }
			set("sourceGroupId", folder.ID)
			set("sourcePageId", page.ID)
			pagePath := page.Path
			if pagePath == "" {
				pagePath = folder.Path
			}
			set("path", pagePath)
			if hasFiles {
				set("associatedFolderId", folder.ID)
			}
			if page.Type == "terminal" {
				set("cwd", pagePath)
			}
			if page.Type == "git" {
				set("repoPath", pagePath)
			}
			raw, err := json.Marshal(toolData)
			if err != nil {
				return err
			}
			name := page.Label
			if name == "" {
				name = page.Type
			}
			if err := tx.Create(&model.WorkspaceTool{WorkspaceID: folder.WorkspaceID, ID: id, PageID: page.Type, Name: name, Position: folder.Position, Data: string(raw), CreatedAt: folder.CreatedAt}).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.WorkspaceTab{}).Where("workspace_id = ? AND folder_id = ? AND page_id = ?", folder.WorkspaceID, folder.ID, page.ID).Updates(map[string]any{"folder_id": id, "page_id": ""}).Error; err != nil {
				return err
			}
			if id != folder.ID {
				var storage []model.WorkspacePluginStorage
				if err := tx.Where("workspace_id = ? AND scope = ?", folder.WorkspaceID, folder.ID).Find(&storage).Error; err != nil {
					return err
				}
				for _, item := range storage {
					item.Scope = id
					if err := tx.Create(&item).Error; err != nil {
						return err
					}
				}
			}

			if page.Type == "terminal" {
				if err := tx.Model(&model.TerminalSession{}).Where("workspace_session_id = ? AND group_id = ?", folder.WorkspaceID, folder.ID).Update("group_id", id).Error; err != nil {
					return err
				}
			}
			folderChanged = true
			changed[folder.WorkspaceID] = true
		}
		if !folderChanged {
			continue
		}
		if hasFiles {
			rawPages, _ := json.Marshal(filePages)
			data["pages"] = rawPages
			raw, err := json.Marshal(data)
			if err != nil {
				return err
			}
			if err := tx.Model(&folder).Update("data", string(raw)).Error; err != nil {
				return err
			}
		} else if len(pages) > 0 {
			if err := tx.Delete(&folder).Error; err != nil {
				return err
			}
		}
	}
	for id := range changed {
		// Force reconnects to take the migrated snapshot before accepting further deltas.
		if err := tx.Model(&model.Workspace{}).Where("id = ?", id).Update("revision", gorm.Expr("revision + 1")).Error; err != nil {
			return err
		}
	}
	return nil
}
