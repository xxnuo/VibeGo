package model

type UserSession struct {
	ID           string `gorm:"column:id;primaryKey" json:"id"`
	UserID       string `gorm:"column:user_id;index;constraint:OnDelete:CASCADE" json:"user_id"`
	Name         string `gorm:"column:name" json:"name"`
	Position     int64  `gorm:"column:position;index" json:"position"`
	State        string `gorm:"column:state;type:text" json:"state"`
	LastActiveAt int64  `gorm:"column:last_active_at" json:"last_active_at"`
	ExpiredAt    int64  `gorm:"column:expired_at;index" json:"expired_at"`
	CreatedAt    int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt    int64  `gorm:"column:updated_at" json:"updated_at"`
}

func (UserSession) TableName() string {
	return "user_sessions"
}
