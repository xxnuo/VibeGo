package model

type UserSetting struct {
	ID        uint   `gorm:"primaryKey;autoIncrement"`
	UserID    string `gorm:"column:user_id;uniqueIndex:idx_user_key"`
	Key       string `gorm:"column:key;uniqueIndex:idx_user_key"`
	Value     string `gorm:"column:value;type:text"`
	UpdatedAt int64  `gorm:"column:updated_at;autoUpdateTime"`
}

func (UserSetting) TableName() string {
	return "user_settings"
}
