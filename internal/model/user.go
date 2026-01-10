package model

type User struct {
	ID          string `gorm:"column:id;primaryKey" json:"id"`
	Username    string `gorm:"column:username;uniqueIndex" json:"username"`
	TokenHash   string `gorm:"column:token_hash" json:"-"`
	CreatedAt   int64  `gorm:"column:created_at" json:"created_at"`
	LastLoginAt int64  `gorm:"column:last_login_at" json:"last_login_at"`
}

func (User) TableName() string {
	return "users"
}
