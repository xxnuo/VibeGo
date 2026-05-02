package config

import (
	"encoding/json"
	"fmt"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

// Keep the original session JSON intact as a recovery copy. Viewport fields are
// deliberately not imported into the shared inventory.
func migrateSession(tx *gorm.DB, session model.UserSession) error {
	type tab struct {
		ID       string                     `json:"id"`
		Title    string                     `json:"title"`
		Icon     string                     `json:"icon"`
		Closable *bool                      `json:"closable"`
		Pinned   bool                       `json:"pinned"`
		Data     map[string]json.RawMessage `json:"data"`
	}
	type page struct {
		ID    string `json:"id"`
		Type  string `json:"type"`
		Label string `json:"label"`
		Path  string `json:"path"`
		Tabs  []tab  `json:"tabs,omitempty"`
	}
	var state struct {
		OpenGroups []struct {
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Data  json.RawMessage `json:"data"`
			Pages []page          `json:"pages"`
		} `json:"openGroups"`
		OpenTools []struct {
			ID     string          `json:"id"`
			Name   string          `json:"name"`
			PageID string          `json:"pageId"`
			Data   json.RawMessage `json:"data"`
			Tabs   []tab           `json:"tabs"`
		} `json:"openTools"`
	}
	if session.State != "" {
		if err := json.Unmarshal([]byte(session.State), &state); err != nil {
			return err
		}
	}
	ws := model.Workspace{ID: session.ID, UserID: session.UserID, Name: session.Name, Position: session.Position, Revision: 1, Data: "{}", LastActiveAt: session.LastActiveAt, CreatedAt: session.CreatedAt, UpdatedAt: session.UpdatedAt}
	if err := tx.Create(&ws).Error; err != nil {
		return err
	}
	importTabs := func(owner, pageID string, tabs []tab) error {
		for i, t := range tabs {
			if t.ID == "" {
				return fmt.Errorf("tab id is required")
			}
			data, err := json.Marshal(t.Data)
			if err != nil {
				return err
			}
			var path, kind, editorID string
			_ = json.Unmarshal(t.Data["path"], &path)
			_ = json.Unmarshal(t.Data["type"], &kind)
			_ = json.Unmarshal(t.Data["editorId"], &editorID)
			switch {
			case editorID != "" && editorID != "default":
				kind = "custom_editor"
			case kind == "diff":
			case kind == "preview":
			default:
				kind = "file"
			}
			if err := tx.Create(&model.WorkspaceTab{WorkspaceID: session.ID, FolderID: owner, ID: t.ID, PageID: pageID, Title: t.Title, Icon: t.Icon, Closable: t.Closable, Pinned: t.Pinned, Position: int64(i), FilePath: path, TabType: kind, Data: string(data), CreatedAt: session.CreatedAt}).Error; err != nil {
				return err
			}
		}
		return nil
	}
	for i, g := range state.OpenGroups {
		if g.ID == "" {
			return fmt.Errorf("folder id is required")
		}
		path := ""
		pages := append([]page(nil), g.Pages...)
		for j, p := range g.Pages {
			if p.Path != "" && (p.Type == "files" || path == "") {
				path = p.Path
			}
			if err := importTabs(g.ID, p.ID, p.Tabs); err != nil {
				return err
			}
			pages[j].Tabs = nil
		}
		data := map[string]any{}
		if len(g.Data) > 0 && string(g.Data) != "null" {
			if err := json.Unmarshal(g.Data, &data); err != nil {
				return err
			}
		}
		data["pages"] = pages
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if err := tx.Create(&model.WorkspaceFolder{WorkspaceID: session.ID, ID: g.ID, Path: path, Name: g.Name, Position: int64(i), Data: string(raw), CreatedAt: session.CreatedAt}).Error; err != nil {
			return err
		}
	}
	for i, t := range state.OpenTools {
		if t.ID == "" || t.PageID == "" {
			return fmt.Errorf("tool id and page id are required")
		}
		data := string(t.Data)
		if data == "" || data == "null" {
			data = "{}"
		}
		if err := tx.Create(&model.WorkspaceTool{WorkspaceID: session.ID, ID: t.ID, PageID: t.PageID, Name: t.Name, Position: int64(i), Data: data, CreatedAt: session.CreatedAt}).Error; err != nil {
			return err
		}
		if err := importTabs(t.ID, "", t.Tabs); err != nil {
			return err
		}
	}
	return nil
}
