package model

type TerminalHistory struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	SessionID string `gorm:"column:session_id;index:idx_session_created;constraint:OnDelete:CASCADE" json:"session_id"`
	Data      []byte `gorm:"column:data" json:"data"`
	// Cursor is the absolute PTY byte offset at the end of Data. It is kept
	// separately from len(Data) because the in-memory history is a ring buffer.
	Cursor    uint64 `gorm:"column:cursor" json:"cursor"`
	CreatedAt int64  `gorm:"column:created_at;index:idx_session_created" json:"created_at"`
}

func (TerminalHistory) TableName() string {
	return "terminal_history"
}
