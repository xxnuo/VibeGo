package handler

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type WorkspaceState struct {
	OpenGroups             []WorkspaceGroup                      `json:"openGroups"`
	OpenTools              []WorkspaceTool                       `json:"openTools"`
	TaskbarOrder           []string                              `json:"taskbarOrder"`
	TerminalsByGroup       map[string][]WorkspaceTerminalSession `json:"terminalsByGroup"`
	ActiveTerminalByGroup  map[string]*string                    `json:"activeTerminalByGroup"`
	ListManagerOpenByGroup map[string]bool                       `json:"listManagerOpenByGroup"`
	TerminalLayouts        map[string]WorkspaceLayoutNode        `json:"terminalLayouts"`
	FocusedIDByGroup       map[string]*string                    `json:"focusedIdByGroup"`
	SettingsOpen           bool                                  `json:"settingsOpen"`
	ActiveGroupID          *string                               `json:"activeGroupId"`
	FileManagerByGroup     map[string]WorkspaceFileManagerState  `json:"fileManagerByGroup"`
}

type WorkspaceGroup struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	Pages        []WorkspaceGroupPage `json:"pages"`
	ActivePageID *string              `json:"activePageId"`
}

type WorkspaceGroupPage struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Label       string         `json:"label"`
	Path        *string        `json:"path,omitempty"`
	Tabs        []WorkspaceTab `json:"tabs"`
	ActiveTabID *string        `json:"activeTabId"`
}

type WorkspaceTab struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Icon     *string        `json:"icon,omitempty"`
	Data     map[string]any `json:"data,omitempty"`
	Closable *bool          `json:"closable,omitempty"`
	Pinned   *bool          `json:"pinned,omitempty"`
}

type WorkspaceTool struct {
	ID          string         `json:"id"`
	PageID      string         `json:"pageId"`
	Name        string         `json:"name"`
	Tabs        []WorkspaceTab `json:"tabs,omitempty"`
	ActiveTabID *string        `json:"activeTabId,omitempty"`
}

type WorkspaceTerminalSession struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Pinned   *bool   `json:"pinned,omitempty"`
	Status   *string `json:"status,omitempty"`
	ParentID *string `json:"parentId,omitempty"`
}

type WorkspaceLayoutNode struct {
	Type       string               `json:"type"`
	Direction  *string              `json:"direction,omitempty"`
	Ratio      *float64             `json:"ratio,omitempty"`
	First      *WorkspaceLayoutNode `json:"first,omitempty"`
	Second     *WorkspaceLayoutNode `json:"second,omitempty"`
	TerminalID *string              `json:"terminalId,omitempty"`
}

type WorkspaceFileManagerState struct {
	CurrentPath  string   `json:"currentPath"`
	RootPath     string   `json:"rootPath"`
	PathHistory  []string `json:"pathHistory"`
	HistoryIndex int      `json:"historyIndex"`
	SearchQuery  string   `json:"searchQuery"`
	SearchActive bool     `json:"searchActive"`
	SortField    string   `json:"sortField"`
	SortOrder    string   `json:"sortOrder"`
	ShowHidden   bool     `json:"showHidden"`
	ViewMode     string   `json:"viewMode"`
}

type WorkspaceStatePatch struct {
	OpenGroups             *[]WorkspaceGroup                      `json:"openGroups,omitempty"`
	OpenTools              *[]WorkspaceTool                       `json:"openTools,omitempty"`
	TaskbarOrder           *[]string                              `json:"taskbarOrder,omitempty"`
	TerminalsByGroup       *map[string][]WorkspaceTerminalSession `json:"terminalsByGroup,omitempty"`
	ActiveTerminalByGroup  *map[string]*string                    `json:"activeTerminalByGroup,omitempty"`
	ListManagerOpenByGroup *map[string]bool                       `json:"listManagerOpenByGroup,omitempty"`
	TerminalLayouts        *map[string]WorkspaceLayoutNode        `json:"terminalLayouts,omitempty"`
	FocusedIDByGroup       *map[string]*string                    `json:"focusedIdByGroup,omitempty"`
	SettingsOpen           *bool                                  `json:"settingsOpen,omitempty"`
	ActiveGroupID          optionalStringPatch                    `json:"activeGroupId,omitempty"`
	FileManagerByGroup     *map[string]WorkspaceFileManagerState  `json:"fileManagerByGroup,omitempty"`
}

type optionalStringPatch struct {
	Set   bool
	Value *string
}

func (p *optionalStringPatch) UnmarshalJSON(data []byte) error {
	p.Set = true
	if string(data) == "null" {
		p.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	p.Value = &value
	return nil
}

func emptyWorkspaceState() WorkspaceState {
	return WorkspaceState{
		OpenGroups:             []WorkspaceGroup{},
		OpenTools:              []WorkspaceTool{},
		TaskbarOrder:           []string{},
		TerminalsByGroup:       map[string][]WorkspaceTerminalSession{},
		ActiveTerminalByGroup:  map[string]*string{},
		ListManagerOpenByGroup: map[string]bool{},
		TerminalLayouts:        map[string]WorkspaceLayoutNode{},
		FocusedIDByGroup:       map[string]*string{},
		FileManagerByGroup:     map[string]WorkspaceFileManagerState{},
	}
}

func parseWorkspaceState(raw string) (WorkspaceState, error) {
	if raw == "" || raw == "{}" {
		return emptyWorkspaceState(), nil
	}

	state := emptyWorkspaceState()
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return WorkspaceState{}, err
	}

	normalizeWorkspaceState(&state)
	if err := validateWorkspaceState(state); err != nil {
		return WorkspaceState{}, err
	}

	return state, nil
}

func marshalWorkspaceState(state WorkspaceState) (string, error) {
	normalizeWorkspaceState(&state)
	if err := validateWorkspaceState(state); err != nil {
		return "", err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func marshalWorkspaceStateFromString(raw string) (string, error) {
	state, err := parseWorkspaceState(raw)
	if err != nil {
		return "", err
	}
	return marshalWorkspaceState(state)
}

func normalizeWorkspaceState(state *WorkspaceState) {
	if state.OpenGroups == nil {
		state.OpenGroups = []WorkspaceGroup{}
	}
	if state.OpenTools == nil {
		state.OpenTools = []WorkspaceTool{}
	}
	if state.TaskbarOrder == nil {
		state.TaskbarOrder = []string{}
	}
	if state.TerminalsByGroup == nil {
		state.TerminalsByGroup = map[string][]WorkspaceTerminalSession{}
	}
	if state.ActiveTerminalByGroup == nil {
		state.ActiveTerminalByGroup = map[string]*string{}
	}
	if state.ListManagerOpenByGroup == nil {
		state.ListManagerOpenByGroup = map[string]bool{}
	}
	if state.TerminalLayouts == nil {
		state.TerminalLayouts = map[string]WorkspaceLayoutNode{}
	}
	if state.FocusedIDByGroup == nil {
		state.FocusedIDByGroup = map[string]*string{}
	}
	if state.FileManagerByGroup == nil {
		state.FileManagerByGroup = map[string]WorkspaceFileManagerState{}
	}

	for i := range state.OpenGroups {
		if state.OpenGroups[i].Pages == nil {
			state.OpenGroups[i].Pages = []WorkspaceGroupPage{}
		}
		for j := range state.OpenGroups[i].Pages {
			if state.OpenGroups[i].Pages[j].Tabs == nil {
				state.OpenGroups[i].Pages[j].Tabs = []WorkspaceTab{}
			}
		}
	}

	for i := range state.OpenTools {
		if state.OpenTools[i].Tabs == nil {
			state.OpenTools[i].Tabs = []WorkspaceTab{}
		}
	}

	for key, value := range state.TerminalsByGroup {
		if value == nil {
			state.TerminalsByGroup[key] = []WorkspaceTerminalSession{}
		}
	}

	for key, value := range state.FileManagerByGroup {
		if value.PathHistory == nil {
			value.PathHistory = []string{}
		}
		if len(value.PathHistory) == 0 {
			switch {
			case value.CurrentPath != "":
				value.PathHistory = []string{value.CurrentPath}
			case value.RootPath != "":
				value.PathHistory = []string{value.RootPath}
			default:
				value.PathHistory = []string{"."}
			}
		}
		if value.CurrentPath == "" {
			value.CurrentPath = value.PathHistory[0]
		}
		if value.RootPath == "" {
			value.RootPath = value.PathHistory[0]
		}
		if value.HistoryIndex < 0 {
			value.HistoryIndex = 0
		}
		if value.HistoryIndex >= len(value.PathHistory) {
			value.HistoryIndex = len(value.PathHistory) - 1
		}
		if value.SortField == "" {
			value.SortField = "name"
		}
		if value.SortOrder == "" {
			value.SortOrder = "asc"
		}
		if value.ViewMode == "" {
			value.ViewMode = "list"
		}
		state.FileManagerByGroup[key] = value
	}
}

func validateWorkspaceState(state WorkspaceState) error {
	for _, group := range state.OpenGroups {
		if group.ID == "" {
			return fmt.Errorf("openGroups.id is required")
		}
		for _, page := range group.Pages {
			if page.ID == "" {
				return fmt.Errorf("openGroups.pages.id is required")
			}
			switch page.Type {
			case "files", "git", "terminal":
			default:
				return fmt.Errorf("invalid page type: %s", page.Type)
			}
			for _, tab := range page.Tabs {
				if tab.ID == "" {
					return fmt.Errorf("openGroups.pages.tabs.id is required")
				}
			}
		}
	}

	for _, tool := range state.OpenTools {
		if tool.ID == "" || tool.PageID == "" {
			return fmt.Errorf("openTools.id and openTools.pageId are required")
		}
		for _, tab := range tool.Tabs {
			if tab.ID == "" {
				return fmt.Errorf("openTools.tabs.id is required")
			}
		}
	}

	for _, terminals := range state.TerminalsByGroup {
		for _, terminal := range terminals {
			if terminal.ID == "" {
				return fmt.Errorf("terminalsByGroup.id is required")
			}
			if terminal.Status != nil {
				switch *terminal.Status {
				case "running", "exited", "closed":
				default:
					return fmt.Errorf("invalid terminal status: %s", *terminal.Status)
				}
			}
		}
	}

	for _, layout := range state.TerminalLayouts {
		if err := validateWorkspaceLayoutNode(layout); err != nil {
			return err
		}
	}

	return nil
}

func validateWorkspaceLayoutNode(node WorkspaceLayoutNode) error {
	switch node.Type {
	case "terminal":
		if node.TerminalID == nil || *node.TerminalID == "" {
			return fmt.Errorf("terminal layout terminalId is required")
		}
	case "split":
		if node.Direction == nil {
			return fmt.Errorf("split layout direction is required")
		}
		switch *node.Direction {
		case "horizontal", "vertical":
		default:
			return fmt.Errorf("invalid split direction: %s", *node.Direction)
		}
		if node.Ratio == nil {
			return fmt.Errorf("split layout ratio is required")
		}
		if *node.Ratio <= 0 || *node.Ratio >= 1 {
			return fmt.Errorf("split layout ratio must be between 0 and 1")
		}
		if node.First == nil || node.Second == nil {
			return fmt.Errorf("split layout children are required")
		}
		if err := validateWorkspaceLayoutNode(*node.First); err != nil {
			return err
		}
		if err := validateWorkspaceLayoutNode(*node.Second); err != nil {
			return err
		}
	default:
		return fmt.Errorf("invalid layout node type: %s", node.Type)
	}

	return nil
}

func applyWorkspaceStatePatch(state *WorkspaceState, patch WorkspaceStatePatch) {
	if patch.OpenGroups != nil {
		state.OpenGroups = *patch.OpenGroups
	}
	if patch.OpenTools != nil {
		state.OpenTools = *patch.OpenTools
	}
	if patch.TaskbarOrder != nil {
		state.TaskbarOrder = *patch.TaskbarOrder
	}
	if patch.TerminalsByGroup != nil {
		state.TerminalsByGroup = *patch.TerminalsByGroup
	}
	if patch.ActiveTerminalByGroup != nil {
		state.ActiveTerminalByGroup = *patch.ActiveTerminalByGroup
	}
	if patch.ListManagerOpenByGroup != nil {
		state.ListManagerOpenByGroup = *patch.ListManagerOpenByGroup
	}
	if patch.TerminalLayouts != nil {
		state.TerminalLayouts = *patch.TerminalLayouts
	}
	if patch.FocusedIDByGroup != nil {
		state.FocusedIDByGroup = *patch.FocusedIDByGroup
	}
	if patch.SettingsOpen != nil {
		state.SettingsOpen = *patch.SettingsOpen
	}
	if patch.ActiveGroupID.Set {
		state.ActiveGroupID = patch.ActiveGroupID.Value
	}
	if patch.FileManagerByGroup != nil {
		state.FileManagerByGroup = *patch.FileManagerByGroup
	}
}

func updateSessionWorkspaceState(db *gorm.DB, sessionID string, patch WorkspaceStatePatch) (WorkspaceState, error) {
	var session model.UserSession
	if err := db.First(&session, "id = ?", sessionID).Error; err != nil {
		return WorkspaceState{}, err
	}

	state, err := parseWorkspaceState(session.State)
	if err != nil {
		return WorkspaceState{}, err
	}

	applyWorkspaceStatePatch(&state, patch)
	rawState, err := marshalWorkspaceState(state)
	if err != nil {
		return WorkspaceState{}, err
	}

	now := time.Now().Unix()
	if err := db.Model(&session).Updates(map[string]any{
		"state":          rawState,
		"updated_at":     now,
		"last_active_at": now,
	}).Error; err != nil {
		return WorkspaceState{}, err
	}

	return state, nil
}
