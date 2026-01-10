package model

type UserSession struct {
	ID         string `gorm:"column:id;primaryKey" json:"id"`
	UserID     string `gorm:"column:user_id;index" json:"user_id"`
	DeviceID   string `gorm:"column:device_id" json:"device_id"`
	DeviceName string `gorm:"column:device_name" json:"device_name"`
	State      string `gorm:"column:state;type:text" json:"state"`
	CreatedAt  int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt  int64  `gorm:"column:updated_at" json:"updated_at"`
	ExpiresAt  int64  `gorm:"column:expires_at" json:"expires_at"`
}

func (UserSession) TableName() string {
	return "user_sessions"
}
