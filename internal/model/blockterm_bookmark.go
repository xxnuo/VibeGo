package model

// BlockTermBookmark stores a reusable command independently from terminals,
// blocks, and workspaces so it remains available across all BlockTerm sessions.
type BlockTermBookmark struct {
	ID          string `gorm:"column:id;primaryKey;not null" json:"id"`
	Title       string `gorm:"column:title;type:text;not null" json:"title"`
	Description string `gorm:"column:description;type:text;not null" json:"description"`
	Command     string `gorm:"column:command;type:text;not null" json:"command"`
	CreatedAt   int64  `gorm:"column:created_at;not null;index" json:"created_at"`
	UpdatedAt   int64  `gorm:"column:updated_at;not null;index" json:"updated_at"`
}

func (BlockTermBookmark) TableName() string {
	return "blockterm_bookmarks"
}
