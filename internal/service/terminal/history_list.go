package terminal

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/xxnuo/vibego/internal/model"
)

var ErrInvalidHistoryCursor = errors.New("invalid terminal history cursor")

type historyCursor struct {
	CreatedAt int64  `json:"created_at"`
	ID        string `json:"id"`
}
type HistoryPage struct {
	Terminals  []TerminalInfo `json:"terminals"`
	NextCursor string         `json:"next_cursor,omitempty"`
}

func (m *Manager) ListHistory(workspaceID, groupID, before string, limit int) (*HistoryPage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	query := m.db.Where("status IN ?", []string{model.StatusExited, model.StatusClosed}).Order("created_at DESC, id DESC").Limit(limit + 1)
	if workspaceID != "" {
		query = query.Where("workspace_session_id = ?", workspaceID)
	}
	if groupID != "" {
		query = query.Where("group_id = ?", groupID)
	}
	if before != "" {
		data, err := base64.RawURLEncoding.DecodeString(before)
		var cursor historyCursor
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.ID == "" {
			return nil, ErrInvalidHistoryCursor
		}
		query = query.Where("created_at < ? OR (created_at = ? AND id < ?)", cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	var sessions []model.TerminalSession
	if err := query.Find(&sessions).Error; err != nil {
		return nil, err
	}
	page := &HistoryPage{Terminals: []TerminalInfo{}}
	if len(sessions) > limit {
		sessions = sessions[:limit]
		last := sessions[len(sessions)-1]
		encoded, _ := json.Marshal(historyCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	for i := range sessions {
		page.Terminals = append(page.Terminals, *sessionToInfo(&sessions[i]))
	}
	return page, nil
}
