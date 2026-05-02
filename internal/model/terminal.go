package model

type TerminalSession struct {
	ID                  string `gorm:"column:id;primaryKey" json:"id"`
	UserID              string `gorm:"column:user_id;index:idx_user_status;constraint:OnDelete:CASCADE" json:"user_id"`
	WorkspaceSessionID  string `gorm:"column:workspace_session_id;index" json:"workspace_session_id"`
	GroupID             string `gorm:"column:group_id;index" json:"group_id"`
	ParentID            string `gorm:"column:parent_id;index" json:"parent_id"`
	Name                string `gorm:"column:name" json:"name"`
	TabColor            string `gorm:"column:tab_color" json:"tab_color"`
	TabIcon             string `gorm:"column:tab_icon" json:"tab_icon"`
	Shell               string `gorm:"column:shell" json:"shell"`
	Cwd                 string `gorm:"column:cwd" json:"cwd"`
	CurrentCwd          string `gorm:"column:current_cwd" json:"current_cwd"`
	Cols                int    `gorm:"column:cols" json:"cols"`
	Rows                int    `gorm:"column:rows" json:"rows"`
	RuntimeType         string `gorm:"column:runtime_type" json:"runtime_type"`
	SSHProfileID        string `gorm:"column:ssh_profile_id;index" json:"ssh_profile_id,omitempty"`
	Readonly            bool   `gorm:"column:readonly" json:"readonly"`
	Status              string `gorm:"column:status;index:idx_user_status" json:"status"`
	ExitCode            int    `gorm:"column:exit_code" json:"exit_code"`
	HistorySize         int64  `gorm:"column:history_size" json:"history_size"`
	ShellType           string `gorm:"column:shell_type" json:"shell_type"`
	ShellState          string `gorm:"column:shell_state" json:"shell_state"`
	ShellIntegration    bool   `gorm:"column:shell_integration" json:"shell_integration"`
	LastCommand         string `gorm:"column:last_command;type:text" json:"last_command"`
	LastCommandExitCode *int   `gorm:"column:last_command_exit_code" json:"last_command_exit_code"`
	// BlockTermViewJSON stores terminal-scoped presentation state such as the
	// desktop BlockTerm sidebar. It is separate from workspace state and block
	// presentation metadata.
	BlockTermViewJSON string `gorm:"column:blockterm_view_json;type:text" json:"blockterm_view_json,omitempty"`
	CreatedAt         int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt         int64  `gorm:"column:updated_at" json:"updated_at"`
}

func (TerminalSession) TableName() string {
	return "terminal_sessions"
}

const (
	StatusRunning = "running"
	StatusExited  = "exited"
	StatusClosed  = "closed"
)
