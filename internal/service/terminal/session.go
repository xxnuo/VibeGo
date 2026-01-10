package terminal

type TerminalSession struct {
	ID          string `gorm:"column:id;primaryKey" json:"id"`
	Name        string `gorm:"column:name" json:"name"`
	Shell       string `gorm:"column:shell" json:"shell"`
	Cwd         string `gorm:"column:cwd" json:"cwd"`
	Cols        int    `gorm:"column:cols" json:"cols"`
	Rows        int    `gorm:"column:rows" json:"rows"`
	Status      string `gorm:"column:status" json:"status"`
	PTYStatus   string `gorm:"column:pty_status" json:"pty_status"`
	ExitCode    int    `gorm:"column:exit_code" json:"exit_code"`
	HistorySize int64  `gorm:"column:history_size" json:"history_size"`
	CreatedAt   int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt   int64  `gorm:"column:updated_at" json:"updated_at"`
}

func (TerminalSession) TableName() string {
	return "terminal_sessions"
}

const (
	StatusActive = "active"
	StatusClosed = "closed"

	PTYStatusRunning = "running"
	PTYStatusExited  = "exited"
)
