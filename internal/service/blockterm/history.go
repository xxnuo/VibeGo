package blockterm

import (
	"encoding/base64"
	"encoding/json"
	"errors"
)

type HistoryPage struct {
	Blocks     []Block `json:"blocks"`
	HasMore    bool    `json:"has_more"`
	NextCursor string  `json:"next_cursor"`
}

type historyCursor struct {
	CreatedAt int64  `json:"t"`
	ID        string `json:"id"`
}

// Page by immutable ordering keys, not positions shifted by new commands.
func (s *Service) History(group, query, cursor string) (HistoryPage, error) {
	page := HistoryPage{Blocks: []Block{}}
	db := s.db.Table("blocks").Select("blocks.*").Joins("JOIN sessions ON sessions.id = blocks.session_id").Where("sessions.group_id = ? AND blocks.command <> ''", group)
	if query != "" {
		db = db.Where("instr(lower(blocks.command), lower(?)) > 0", query)
	}
	if cursor != "" {
		if len(cursor) > 512 {
			return page, errors.New("invalid history cursor")
		}
		var before historyCursor
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(data, &before) != nil || before.ID == "" || len(before.ID) > 128 || before.CreatedAt < 0 {
			return page, errors.New("invalid history cursor")
		}
		db = db.Where("blocks.created_at < ? OR (blocks.created_at = ? AND blocks.id < ?)", before.CreatedAt, before.CreatedAt, before.ID)
	}
	if err := db.Order("blocks.created_at DESC, blocks.id DESC").Limit(201).Find(&page.Blocks).Error; err != nil {
		return page, err
	}
	page.HasMore = len(page.Blocks) > 200
	if page.HasMore {
		page.Blocks = page.Blocks[:200]
		last := page.Blocks[len(page.Blocks)-1]
		data, _ := json.Marshal(historyCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	return page, nil
}
