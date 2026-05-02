package terminal

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/xxnuo/vibego/internal/model"
)

const MaxTerminalNameLength = 50

var validTabColors = map[string]struct{}{
	"red":    {},
	"orange": {},
	"yellow": {},
	"green":  {},
	"mint":   {},
	"cyan":   {},
	"blue":   {},
	"violet": {},
	"pink":   {},
	"white":  {},
}

var validTabIcons = map[string]struct{}{
	"square":         {},
	"sparkle":        {},
	"fire":           {},
	"ghost":          {},
	"cloud":          {},
	"compass":        {},
	"crown":          {},
	"droplet":        {},
	"graduation-cap": {},
	"heart":          {},
	"file":           {},
}

type SettingsUpdate struct {
	Name     *string
	TabColor *string
	TabIcon  *string
}

func NormalizeTerminalName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: name is required", ErrInvalidTerminalSettings)
	}
	if utf8.RuneCountInString(value) > MaxTerminalNameLength {
		return "", fmt.Errorf("%w: name must be at most %d characters", ErrInvalidTerminalSettings, MaxTerminalNameLength)
	}
	return value, nil
}

func NormalizeTabColor(value string) (string, error) {
	return normalizeTabAppearance("tab_color", value, validTabColors)
}

func NormalizeTabIcon(value string) (string, error) {
	return normalizeTabAppearance("tab_icon", value, validTabIcons)
}

func normalizeTabAppearance(field, value string, allowed map[string]struct{}) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "default" {
		return "", nil
	}
	if _, ok := allowed[value]; !ok {
		return value, fmt.Errorf("%w: invalid %s %q", ErrInvalidTerminalSettings, field, value)
	}
	return value, nil
}

func normalizeSettingsUpdate(update SettingsUpdate) (SettingsUpdate, error) {
	if update.Name == nil && update.TabColor == nil && update.TabIcon == nil {
		return SettingsUpdate{}, fmt.Errorf("%w: at least one setting is required", ErrInvalidTerminalSettings)
	}

	normalized := SettingsUpdate{}
	if update.Name != nil {
		value, err := NormalizeTerminalName(*update.Name)
		if err != nil {
			return SettingsUpdate{}, err
		}
		normalized.Name = &value
	}
	if update.TabColor != nil {
		value, err := NormalizeTabColor(*update.TabColor)
		if err != nil {
			return SettingsUpdate{}, err
		}
		normalized.TabColor = &value
	}
	if update.TabIcon != nil {
		value, err := NormalizeTabIcon(*update.TabIcon)
		if err != nil {
			return SettingsUpdate{}, err
		}
		normalized.TabIcon = &value
	}
	return normalized, nil
}

func updateWorkspaceTerminalSettingsState(raw string, session model.TerminalSession) (string, error) {
	state := make(map[string]json.RawMessage)
	if strings.TrimSpace(raw) != "" && strings.TrimSpace(raw) != "{}" {
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return "", fmt.Errorf("%w: %v", ErrInvalidWorkspaceState, err)
		}
	}

	groups := make(map[string][]map[string]json.RawMessage)
	if encoded, ok := state["terminalsByGroup"]; ok && string(encoded) != "null" {
		if err := json.Unmarshal(encoded, &groups); err != nil {
			return "", fmt.Errorf("%w: terminalsByGroup: %v", ErrInvalidWorkspaceState, err)
		}
	}
	if groups == nil {
		groups = make(map[string][]map[string]json.RawMessage)
	}

	var target map[string]json.RawMessage
	foundGroup := ""
	seenIDs := make(map[string]struct{})
	for groupID, terminals := range groups {
		for _, candidate := range terminals {
			var id string
			encodedID, ok := candidate["id"]
			if !ok {
				return "", fmt.Errorf("%w: terminalsByGroup.id is required", ErrInvalidWorkspaceState)
			}
			if err := json.Unmarshal(encodedID, &id); err != nil || id == "" {
				return "", fmt.Errorf("%w: invalid terminalsByGroup.id", ErrInvalidWorkspaceState)
			}
			if _, duplicate := seenIDs[id]; duplicate {
				return "", fmt.Errorf("%w: terminal %s appears more than once", ErrInvalidWorkspaceState, id)
			}
			seenIDs[id] = struct{}{}
			if err := validateWorkspaceAppearance(candidate, "tabColor", NormalizeTabColor); err != nil {
				return "", err
			}
			if err := validateWorkspaceAppearance(candidate, "tabIcon", NormalizeTabIcon); err != nil {
				return "", err
			}
			if id != session.ID {
				continue
			}
			target = candidate
			foundGroup = groupID
		}
	}
	if target != nil && foundGroup != session.GroupID {
		return "", fmt.Errorf(
			"%w: terminal %s belongs to group %q in workspace state, not %q",
			ErrInvalidWorkspaceState,
			session.ID,
			foundGroup,
			session.GroupID,
		)
	}
	if target == nil {
		target = make(map[string]json.RawMessage)
		target["id"] = mustMarshalWorkspaceSetting(session.ID)
		if session.ParentID != "" {
			target["parentId"] = mustMarshalWorkspaceSetting(session.ParentID)
		}
		groups[session.GroupID] = append(groups[session.GroupID], target)
	}

	target["name"] = mustMarshalWorkspaceSetting(session.Name)
	setOptionalWorkspaceSetting(target, "tabColor", session.TabColor)
	setOptionalWorkspaceSetting(target, "tabIcon", session.TabIcon)
	encodedGroups, err := json.Marshal(groups)
	if err != nil {
		return "", fmt.Errorf("%w: encode terminalsByGroup: %v", ErrInvalidWorkspaceState, err)
	}
	state["terminalsByGroup"] = encodedGroups
	encodedState, err := json.Marshal(state)
	if err != nil {
		return "", fmt.Errorf("%w: encode state: %v", ErrInvalidWorkspaceState, err)
	}
	return string(encodedState), nil
}

func validateWorkspaceAppearance(
	terminal map[string]json.RawMessage,
	field string,
	normalize func(string) (string, error),
) error {
	encoded, ok := terminal[field]
	if !ok {
		return nil
	}
	var value string
	if err := json.Unmarshal(encoded, &value); err != nil {
		return fmt.Errorf("%w: invalid %s", ErrInvalidWorkspaceState, field)
	}
	if _, err := normalize(value); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidWorkspaceState, err)
	}
	return nil
}

func mustMarshalWorkspaceSetting(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func setOptionalWorkspaceSetting(target map[string]json.RawMessage, key, value string) {
	if value == "" {
		delete(target, key)
		return
	}
	target[key] = mustMarshalWorkspaceSetting(value)
}
