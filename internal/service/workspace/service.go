package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrInvalid = errors.New("invalid mutation")
var ErrConflict = errors.New("mutation conflict")

type Snapshot struct {
	Workspace model.Workspace                `json:"workspace"`
	Folders   []model.WorkspaceFolder        `json:"folders"`
	Tools     []model.WorkspaceTool          `json:"tools"`
	Tabs      []model.WorkspaceTab           `json:"tabs"`
	Storage   []model.WorkspacePluginStorage `json:"storage"`
	Terminals []model.TerminalSession        `json:"terminals"`
}

type Service struct {
	writerDB *gorm.DB
	readerDB *gorm.DB
	// Commit and fan-out share one lock so peers never observe reversed revisions.
	mu      sync.Mutex
	clients map[*subscriber]struct{}
}

func New(writerDB *gorm.DB, readers ...*gorm.DB) *Service {
	readerDB := writerDB
	if len(readers) > 0 && readers[0] != nil {
		readerDB = readers[0]
	}
	return &Service{writerDB: writerDB, readerDB: readerDB, clients: make(map[*subscriber]struct{})}
}

func (s *Service) TerminalsChanged(id, terminalID, action string) {
	if id == "" {
		return
	}
	_, err := s.Commit(ClientMutation{ID: uuid.NewString(), WorkspaceID: id, ClientID: "server", Type: action, Payload: json.RawMessage(fmt.Sprintf(`{"id":%q}`, terminalID)), CreatedAt: time.Now().UnixMilli()})
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		fmt.Printf("workspace terminal notification failed: %v\n", err)
	}
}

func (s *Service) Snapshot(id string) (Snapshot, error) {
	result := Snapshot{Folders: []model.WorkspaceFolder{}, Tools: []model.WorkspaceTool{}, Tabs: []model.WorkspaceTab{}, Storage: []model.WorkspacePluginStorage{}, Terminals: []model.TerminalSession{}}
	err := s.readerDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&result.Workspace, "id = ?", id).Error; err != nil {
			return err
		}
		for _, query := range []struct {
			dest  any
			order string
			scope string
		}{
			{&result.Folders, "position, created_at, id", "workspace_id"}, {&result.Tools, "position, created_at, id", "workspace_id"},
			{&result.Tabs, "position, created_at, id", "workspace_id"}, {&result.Storage, "plugin_id, scope, key", "workspace_id"},
			{&result.Terminals, "created_at, id", "workspace_session_id"},
		} {
			if err := tx.Where(query.scope+" = ?", id).Order(query.order).Find(query.dest).Error; err != nil {
				return err
			}
		}
		return nil
	})
	return result, err
}

func (s *Service) Events(id string, after int64) ([]MutationEvent, error) {
	var rows []model.WorkspaceMutation
	if err := s.readerDB.Where("workspace_id = ? AND revision > ?", id, after).Order("revision").Limit(1000).Find(&rows).Error; err != nil {
		return nil, err
	}
	result := make([]MutationEvent, 0, len(rows))
	for _, row := range rows {
		var m ClientMutation
		if err := json.Unmarshal([]byte(row.Mutation), &m); err != nil {
			return nil, err
		}
		result = append(result, MutationEvent{Type: "mutation:committed", Revision: row.Revision, ClientID: m.ClientID, Mutation: &m})
	}
	return result, nil
}

func invalid(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }

func ValidateEnvelope(m ClientMutation) error {
	if m.ID == "" || m.WorkspaceID == "" || m.ClientID == "" || len(m.ID) > 200 || len(m.WorkspaceID) > 200 || len(m.ClientID) > 200 || m.CreatedAt <= 0 || m.BaseRevision < 0 || !json.Valid(m.Payload) {
		return invalid("invalid envelope")
	}
	_, _, err := parsePayload(m)
	return err
}

func (s *Service) HasMutation(workspaceID, id string) (bool, error) {
	var n int64
	err := s.readerDB.Model(&model.WorkspaceMutation{}).Where("workspace_id = ? AND id = ?", workspaceID, id).Count(&n).Error
	return n > 0, err
}

func (s *Service) ReorderWorkspaces(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var events []MutationEvent
	err := s.writerDB.Transaction(func(tx *gorm.DB) error {
		var rows []model.Workspace
		if err := tx.Order("position, id").Find(&rows).Error; err != nil {
			return err
		}
		byID := map[string]model.Workspace{}
		for _, row := range rows {
			byID[row.ID] = row
		}
		ordered := make([]model.Workspace, 0, len(rows))
		seen := map[string]bool{}
		for _, id := range ids {
			row, ok := byID[id]
			if !ok || seen[id] {
				return invalid("invalid workspace order")
			}
			seen[id] = true
			ordered = append(ordered, row)
		}
		for _, row := range rows {
			if !seen[row.ID] {
				ordered = append(ordered, row)
			}
		}
		for i, row := range ordered {
			position := int64(i + 1)
			if row.Position == position {
				continue
			}
			payload, _ := json.Marshal(map[string]any{"position": position})
			m := ClientMutation{ID: uuid.NewString(), WorkspaceID: row.ID, ClientID: "server", Type: "workspace/reorder", Payload: payload, BaseRevision: row.Revision, CreatedAt: time.Now().UnixMilli()}
			if err := reduce(tx, &row, m); err != nil {
				return err
			}
			row.Revision++
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
			raw, _ := json.Marshal(m)
			if err := tx.Create(&model.WorkspaceMutation{WorkspaceID: row.ID, ID: m.ID, Revision: row.Revision, Mutation: string(raw), Request: string(raw)}).Error; err != nil {
				return err
			}
			if _, err := compactMutations(tx, row.ID, row.Revision, KeepRecentRevisions); err != nil {
				return err
			}
			events = append(events, MutationEvent{Type: "mutation:committed", Revision: row.Revision, ClientID: "server", Mutation: &m})
		}
		return nil
	})
	if err == nil {
		for _, event := range events {
			s.broadcast(event)
		}
	}
	return err
}

func (s *Service) Commit(m ClientMutation) (MutationEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var event MutationEvent
	if err := ValidateEnvelope(m); err != nil {
		return event, err
	}
	duplicate := false
	requestRaw, err := json.Marshal(m)
	if err != nil {
		return event, err
	}
	err = s.writerDB.Transaction(func(tx *gorm.DB) error {
		var previous model.WorkspaceMutation
		err := tx.First(&previous, "workspace_id = ? AND id = ?", m.WorkspaceID, m.ID).Error
		if err == nil {
			var original ClientMutation
			if err := json.Unmarshal([]byte(previous.Mutation), &original); err != nil {
				return err
			}
			var request ClientMutation
			if err := json.Unmarshal([]byte(previous.Request), &request); err != nil {
				return err
			}
			if request.ClientID != m.ClientID || request.Type != m.Type || string(request.Payload) != string(m.Payload) {
				return fmt.Errorf("%w: mutation id reused", ErrConflict)
			}
			event = MutationEvent{Type: "mutation:committed", Revision: previous.Revision, ClientID: original.ClientID, Mutation: &original}
			duplicate = true
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var ws model.Workspace
		if m.Type == "workspace/create" {
			if err := tx.First(&ws, "id = ?", m.WorkspaceID).Error; err == nil {
				return fmt.Errorf("%w: workspace exists", ErrConflict)
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			ws = model.Workspace{ID: m.WorkspaceID, Revision: 0, Data: "{}", CreatedAt: time.Now().Unix()}
		} else if err := tx.First(&ws, "id = ?", m.WorkspaceID).Error; err != nil {
			return err
		}
		// Once an ID receipt has been pruned, an ancient retry must not replay
		// destructive operations or resurrect previously closed assets.
		if m.ClientID != "server" && m.BaseRevision < ws.CompactedRevision {
			return fmt.Errorf("%w: mutation base was compacted", ErrConflict)
		}
		if m.BaseRevision > ws.Revision {
			return fmt.Errorf("%w: future base revision", ErrConflict)
		}
		if err := normalizeTabMutation(tx, &m); err != nil {
			return err
		}
		// Stale bases are accepted: reducers modify only the explicitly addressed entity.
		if err := reduce(tx, &ws, m); err != nil {
			return err
		}
		if m.Type == "folder/reorder" {
			var ids []string
			if err := tx.Model(&model.WorkspaceFolder{}).Where("workspace_id = ?", ws.ID).Order("position, id").Pluck("id", &ids).Error; err != nil {
				return err
			}
			m.Payload, _ = json.Marshal(map[string]any{"folder_ids": ids})
		}
		if strings.HasPrefix(m.Type, "terminal/") && m.ClientID == "server" {
			terminals := []model.TerminalSession{}
			if err := tx.Where("workspace_session_id = ?", ws.ID).Order("created_at, id").Find(&terminals).Error; err != nil {
				return err
			}
			var p map[string]any
			if err := json.Unmarshal(m.Payload, &p); err != nil {
				return err
			}
			p["terminals"] = terminals
			encoded, err := json.Marshal(p)
			if err != nil {
				return err
			}
			m.Payload = encoded
		}
		ws.Revision++
		ws.UpdatedAt = time.Now().Unix()
		ws.LastActiveAt = ws.UpdatedAt
		if m.Type != "workspace/delete" {
			if err := tx.Save(&ws).Error; err != nil {
				return err
			}
		}
		raw, err := json.Marshal(m)
		if err != nil {
			return err
		}
		if err := tx.Create(&model.WorkspaceMutation{WorkspaceID: m.WorkspaceID, ID: m.ID, Revision: ws.Revision, Mutation: string(raw), Request: string(requestRaw)}).Error; err != nil {
			return err
		}
		if _, err := compactMutations(tx, ws.ID, ws.Revision, KeepRecentRevisions); err != nil {
			return err
		}
		event = MutationEvent{Type: "mutation:committed", Revision: ws.Revision, ClientID: m.ClientID, Mutation: &m}
		return nil
	})
	if err == nil && !duplicate {
		s.broadcast(event)
		if event.Revision > KeepRecentRevisions && event.Revision%50 == 0 {
			go func() {
				if _, err := s.CompactWorkspaceMutations(m.WorkspaceID); err != nil {
					fmt.Printf("workspace compaction failed: %v\n", err)
				}
			}()
		}
	}
	return event, err
}

type payload struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Path      string          `json:"path"`
	PageID    string          `json:"page_id"`
	FolderID  string          `json:"folder_id"`
	TabType   string          `json:"tab_type"`
	FilePath  string          `json:"file_path"`
	Title     string          `json:"title"`
	Icon      string          `json:"icon"`
	Closable  *bool           `json:"closable"`
	Pinned    bool            `json:"pinned"`
	Position  *int64          `json:"position"`
	Data      json.RawMessage `json:"data"`
	FolderIDs []string        `json:"folder_ids"`
	PluginID  string          `json:"plugin_id"`
	Action    string          `json:"action"`
	Scope     string          `json:"scope"`
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	Deleted   bool            `json:"deleted"`
	Cwd       string          `json:"cwd"`
}

func normalizeTabMutation(tx *gorm.DB, m *ClientMutation) error {
	if !strings.HasPrefix(m.Type, "tab/") {
		return nil
	}
	var p payload
	if err := json.Unmarshal(m.Payload, &p); err != nil {
		return invalid("invalid tab payload")
	}
	var object map[string]any
	if err := json.Unmarshal(m.Payload, &object); err != nil || object == nil {
		return invalid("tab payload required")
	}
	if (m.Type == "tab/pin" || m.Type == "tab/close") && p.FolderID == "" {
		var tabs []model.WorkspaceTab
		if err := tx.Where("workspace_id = ? AND id = ?", m.WorkspaceID, p.ID).Limit(2).Find(&tabs).Error; err != nil {
			return err
		}
		if len(tabs) != 1 {
			return invalid("folder_id required for unknown or ambiguous tab")
		}
		p.FolderID = tabs[0].FolderID
		p.PageID = tabs[0].PageID
		object["folder_id"] = p.FolderID
		object["page_id"] = p.PageID
	}
	if m.Type == "tab/open" && p.PageID == "" {
		var folder model.WorkspaceFolder
		if err := tx.First(&folder, "workspace_id = ? AND id = ?", m.WorkspaceID, p.FolderID).Error; err == nil {
			p.PageID = p.FolderID + "-files"
			var data struct {
				Pages []struct {
					ID   string `json:"id"`
					Type string `json:"type"`
				} `json:"pages"`
			}
			if err := json.Unmarshal([]byte(folder.Data), &data); err != nil {
				return err
			}
			for _, page := range data.Pages {
				if page.Type == "files" {
					p.PageID = page.ID
					break
				}
			}
			object["page_id"] = p.PageID
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
	}
	raw, err := json.Marshal(object)
	if err != nil {
		return err
	}
	m.Payload = raw
	return nil
}

func parsePayload(m ClientMutation) (payload, string, error) {
	var p payload
	if err := json.Unmarshal(m.Payload, &p); err != nil || string(m.Payload) == "null" {
		return p, "", invalid("payload must be an object")
	}
	if len(p.ID) > 500 || len(p.PluginID) > 200 || len(p.Key) > 500 || len(p.Scope) > 500 {
		return p, "", invalid("identifier too long")
	}
	data := string(p.Data)
	if data == "" || data == "null" {
		data = "{}"
	}
	var object map[string]json.RawMessage
	if m.Type != "plugin/mutate" && (json.Unmarshal([]byte(data), &object) != nil || object == nil) {
		return p, "", invalid("data must be an object")
	}
	return p, data, nil
}

func reduce(tx *gorm.DB, ws *model.Workspace, m ClientMutation) error {
	p, data, err := parsePayload(m)
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	scope := func() *gorm.DB { return tx.Where("workspace_id = ? AND id = ?", ws.ID, p.ID) }
	position := func(dest any) (int64, error) {
		if p.Position != nil {
			return *p.Position, nil
		}
		var max int64
		err := tx.Model(dest).Where("workspace_id = ?", ws.ID).Select("COALESCE(MAX(position), -1) + 1").Scan(&max).Error
		return max, err
	}
	exists := func(dest any) error {
		var n int64
		if err := scope().Model(dest).Count(&n).Error; err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: entity does not exist", ErrConflict)
		}
		return nil
	}
	ownerExists := func(id string) error {
		var n int64
		for _, dest := range []any{&model.WorkspaceFolder{}, &model.WorkspaceTool{}} {
			var count int64
			if err := tx.Model(dest).Where("workspace_id = ? AND id = ?", ws.ID, id).Count(&count).Error; err != nil {
				return err
			}
			n += count
		}
		if n == 0 {
			return fmt.Errorf("%w: tab/terminal owner does not exist", ErrConflict)
		}
		return nil
	}
	switch m.Type {
	case "workspace/create", "workspace/rename":
		name := strings.TrimSpace(p.Name)
		if name == "" || utf8.RuneCountInString(name) > 50 {
			return invalid("name must contain 1 to 50 characters")
		}
		ws.Name = name
		if m.Type == "workspace/create" {
			if p.ID != ws.ID {
				return invalid("workspace id mismatch")
			}
			if err := tx.Model(&model.UserSession{}).Select("COALESCE(MAX(position), 0) + 1").Scan(&ws.Position).Error; err != nil {
				return err
			}
			return tx.Create(&model.UserSession{ID: ws.ID, Name: name, Position: ws.Position, State: "{}", CreatedAt: now, UpdatedAt: now, LastActiveAt: now, ExpiredAt: now + 7*24*60*60}).Error
		}
		return tx.Model(&model.UserSession{}).Where("id = ?", ws.ID).Update("name", name).Error
	case "workspace/reorder":
		if p.Position == nil || *p.Position < 1 {
			return invalid("position required")
		}
		ws.Position = *p.Position
		return tx.Model(&model.UserSession{}).Where("id = ?", ws.ID).Update("position", ws.Position).Error
	case "workspace/delete":
		if p.ID != ws.ID {
			return invalid("workspace id mismatch")
		}
		var n int64
		if err := tx.Model(&model.TerminalSession{}).Where("workspace_session_id = ?", ws.ID).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: delete terminals through lifecycle API first", ErrConflict)
		}
		return DeleteInventory(tx, ws.ID)
	case "folder/add":
		if p.ID == "" || p.Name == "" {
			return invalid("folder id and name are required")
		}
		var other int64
		if err := scope().Model(&model.WorkspaceTool{}).Count(&other).Error; err != nil {
			return err
		}
		if other > 0 {
			return fmt.Errorf("%w: owner id already used", ErrConflict)
		}
		pos, err := position(&model.WorkspaceFolder{})
		if err != nil {
			return err
		}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.WorkspaceFolder{WorkspaceID: ws.ID, ID: p.ID, Path: p.Path, Name: p.Name, Position: pos, Data: data, CreatedAt: now}).Error
	case "folder/remove", "tool/close":
		dest := any(&model.WorkspaceFolder{})
		if m.Type == "tool/close" {
			dest = &model.WorkspaceTool{}
		}
		if p.ID == "" {
			return invalid("id required")
		}
		if err := scope().Delete(dest).Error; err != nil {
			return err
		}
		return tx.Where("workspace_id = ? AND folder_id = ?", ws.ID, p.ID).Delete(&model.WorkspaceTab{}).Error
	case "folder/reorder":
		seen := map[string]bool{}
		var folders []model.WorkspaceFolder
		if err := tx.Where("workspace_id = ?", ws.ID).Order("position, id").Find(&folders).Error; err != nil {
			return err
		}
		known := map[string]bool{}
		for _, folder := range folders {
			known[folder.ID] = true
		}
		for _, id := range p.FolderIDs {
			if id == "" || seen[id] {
				return invalid("invalid folder order")
			}
			if !known[id] {
				return invalid("unknown folder id")
			}
			seen[id] = true
		}
		ordered := append([]string{}, p.FolderIDs...)
		for _, folder := range folders {
			if !seen[folder.ID] {
				ordered = append(ordered, folder.ID)
			}
		}
		for i, id := range ordered {
			result := tx.Model(&model.WorkspaceFolder{}).Where("workspace_id = ? AND id = ?", ws.ID, id).Update("position", i)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return invalid("unknown folder id")
			}
		}
		return nil
	case "tool/open":
		if p.ID == "" || p.PageID == "" || p.Name == "" {
			return invalid("tool id, page_id and name required")
		}
		var other int64
		if err := scope().Model(&model.WorkspaceFolder{}).Count(&other).Error; err != nil {
			return err
		}
		if other > 0 {
			return fmt.Errorf("%w: owner id already used", ErrConflict)
		}
		pos, err := position(&model.WorkspaceTool{})
		if err != nil {
			return err
		}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.WorkspaceTool{WorkspaceID: ws.ID, ID: p.ID, PageID: p.PageID, Name: p.Name, Position: pos, Data: data, CreatedAt: now}).Error
	case "tool/update-data":
		if err := exists(&model.WorkspaceTool{}); err != nil {
			return err
		}
		updates := map[string]any{"data": data}
		if p.Name != "" {
			updates["name"] = p.Name
		}
		if p.Position != nil {
			updates["position"] = *p.Position
		}
		return scope().Model(&model.WorkspaceTool{}).Updates(updates).Error
	case "folder/update-data":
		if err := exists(&model.WorkspaceFolder{}); err != nil {
			return err
		}
		return scope().Model(&model.WorkspaceFolder{}).Updates(map[string]any{"data": data, "path": p.Path, "name": p.Name}).Error
	case "tab/open", "tab/update":
		if p.ID == "" || p.FolderID == "" || p.Title == "" {
			return invalid("tab id, folder_id and title required")
		}
		if err := ownerExists(p.FolderID); err != nil {
			return err
		}
		if p.TabType == "" {
			p.TabType = "file"
		}
		switch p.TabType {
		case "file", "diff", "preview", "custom_editor":
		default:
			return invalid("unknown tab_type")
		}
		pos, err := position(&model.WorkspaceTab{})
		if err != nil {
			return err
		}
		tab := model.WorkspaceTab{WorkspaceID: ws.ID, FolderID: p.FolderID, ID: p.ID, PageID: p.PageID, TabType: p.TabType, FilePath: p.FilePath, Title: p.Title, Icon: p.Icon, Closable: p.Closable, Pinned: p.Pinned, Position: pos, Data: data, CreatedAt: now}
		if m.Type == "tab/open" {
			return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&tab).Error
		}
		result := scope().Where("folder_id = ? AND page_id = ?", p.FolderID, p.PageID).Model(&model.WorkspaceTab{}).Select("tab_type", "file_path", "title", "icon", "closable", "pinned", "position", "data").Updates(&tab)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return fmt.Errorf("%w: tab was closed", ErrConflict)
		}
		return nil
	case "tab/close", "tab/pin":
		if p.ID == "" || p.FolderID == "" {
			return invalid("tab id and folder_id required")
		}
		query := scope().Where("folder_id = ?", p.FolderID)
		if p.PageID != "" {
			query = query.Where("page_id = ?", p.PageID)
		}
		if m.Type == "tab/close" {
			return query.Delete(&model.WorkspaceTab{}).Error
		}
		return query.Model(&model.WorkspaceTab{}).Update("pinned", p.Pinned).Error
	case "terminal/open":
		if m.ClientID == "server" {
			return nil
		}
		if p.ID == "" || p.FolderID == "" {
			return invalid("terminal id and folder_id required")
		}
		if err := ownerExists(p.FolderID); err != nil {
			return err
		}
		var term model.TerminalSession
		if err := tx.First(&term, "id = ?", p.ID).Error; err != nil {
			return err
		}
		if term.WorkspaceSessionID != ws.ID || term.GroupID != p.FolderID {
			return fmt.Errorf("%w: terminal belongs to another scope", ErrConflict)
		}
		return nil
	case "terminal/close":
		if m.ClientID == "server" {
			return nil
		}
		if p.ID == "" {
			return invalid("terminal id required")
		}
		var n int64
		if err := tx.Model(&model.TerminalSession{}).Where("id = ?", p.ID).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: terminal lifecycle API required", ErrConflict)
		}
		return nil
	case "terminal/update":
		// Runtime changes are committed by the terminal lifecycle service. Clients
		// cannot fabricate or move terminal assets through the mutation endpoint.
		if m.ClientID != "server" {
			return invalid("terminal lifecycle API required")
		}
		return nil
	case "plugin/mutate":
		if p.PluginID == "" || p.Action == "" {
			return invalid("plugin_id and action required")
		}
		return nil
	case "plugin/storage-update":
		if p.PluginID == "" || p.Key == "" {
			return invalid("plugin_id and key required")
		}
		if p.Deleted {
			return tx.Where("workspace_id = ? AND plugin_id = ? AND scope = ? AND key = ?", ws.ID, p.PluginID, p.Scope, p.Key).Delete(&model.WorkspacePluginStorage{}).Error
		}
		if len(p.Value) == 0 {
			return invalid("value required")
		}
		return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&model.WorkspacePluginStorage{WorkspaceID: ws.ID, PluginID: p.PluginID, Scope: p.Scope, Key: p.Key, Value: string(p.Value)}).Error
	default:
		return invalid("unsupported type: " + m.Type)
	}
}

func DeleteInventory(tx *gorm.DB, id string) error {
	for _, dest := range []any{&model.WorkspaceFolder{}, &model.WorkspaceTool{}, &model.WorkspaceTab{}, &model.WorkspacePluginStorage{}, &model.WorkspaceMutation{}} {
		if err := tx.Where("workspace_id = ?", id).Delete(dest).Error; err != nil {
			return err
		}
	}
	if err := tx.Delete(&model.Workspace{}, "id = ?", id).Error; err != nil {
		return err
	}
	return tx.Delete(&model.UserSession{}, "id = ?", id).Error
}
