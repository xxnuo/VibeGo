package model

type UserSession struct {
	ID        string `gorm:"column:id;primaryKey" json:"id"`
	UserID    string `gorm:"column:user_id;index" json:"user_id"`
	Name      string `gorm:"column:name" json:"name"`
	State     string `gorm:"column:state;type:text" json:"state"`
	CreatedAt int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt int64  `gorm:"column:updated_at" json:"updated_at"`
}

func (UserSession) TableName() string {
	return "user_sessions"
}
