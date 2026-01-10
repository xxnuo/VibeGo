package model

type TerminalHistory struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	SessionID string `gorm:"column:session_id;index" json:"session_id"`
	Sequence  int64  `gorm:"column:sequence" json:"sequence"`
	Data      []byte `gorm:"column:data" json:"data"`
	CreatedAt int64  `gorm:"column:created_at" json:"created_at"`
}

func (TerminalHistory) TableName() string {
	return "terminal_history"
}
