package model

type Workspace struct {
	ID         string `gorm:"column:id;primaryKey" json:"id"`
	UserID     string `gorm:"column:user_id;index" json:"user_id"`
	Name       string `gorm:"column:name" json:"name"`
	Path       string `gorm:"column:path;index" json:"path"`
	State      string `gorm:"column:state;type:text" json:"state"`
	IsPinned   bool   `gorm:"column:is_pinned" json:"is_pinned"`
	LastOpenAt int64  `gorm:"column:last_open_at" json:"last_open_at"`
	CreatedAt  int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt  int64  `gorm:"column:updated_at" json:"updated_at"`
}

func (Workspace) TableName() string {
	return "workspaces"
}
