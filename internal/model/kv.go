package model

type KV struct {
	Key    string `gorm:"column:key;primaryKey" json:"key"`
	Value  string `gorm:"column:value;type:text" json:"value"`
	UserID string `gorm:"column:user_id;index" json:"user_id"`
}

func (KV) TableName() string {
	return "kvs"
}
