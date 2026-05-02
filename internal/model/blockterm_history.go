package model

// BlockTermCommandHistory is an immutable command snapshot. It intentionally
// has no foreign keys so command history survives block, terminal, and
// workspace deletion.
type BlockTermCommandHistory struct {
	ID                 string `gorm:"column:id;primaryKey;not null" json:"id"`
	TerminalID         string `gorm:"column:terminal_id;not null;index:idx_blockterm_history_terminal_created,priority:1" json:"terminal_id"`
	WorkspaceSessionID string `gorm:"column:workspace_session_id;index" json:"workspace_session_id"`
	GroupID            string `gorm:"column:group_id;index" json:"group_id"`
	UserID             string `gorm:"column:user_id;index" json:"user_id"`
	RuntimeType        string `gorm:"column:runtime_type" json:"runtime_type"`
	SSHProfileID       string `gorm:"column:ssh_profile_id" json:"ssh_profile_id,omitempty"`
	LineNum            int    `gorm:"column:line_num;not null" json:"line_num"`
	Command            string `gorm:"column:command;type:text;not null" json:"command"`
	Cwd                string `gorm:"column:cwd" json:"cwd"`
	Starred            bool   `gorm:"column:starred;not null;default:false;index" json:"starred"`
	CreatedAt          int64  `gorm:"column:created_at;not null;index:idx_blockterm_history_terminal_created,priority:2;index" json:"created_at"`

	Kind              string `gorm:"column:kind;not null;default:command" json:"kind"`
	Text              string `gorm:"column:text;type:text" json:"text"`
	Status            string `gorm:"column:status" json:"status"`
	Mode              string `gorm:"column:mode" json:"mode"`
	Output            []byte `gorm:"column:output;type:blob" json:"-"`
	OutputCursor      *int64 `gorm:"column:output_cursor" json:"output_cursor,omitempty"`
	CmdPID            *int64 `gorm:"column:cmd_pid" json:"cmd_pid,omitempty"`
	RemotePID         *int64 `gorm:"column:remote_pid" json:"remote_pid,omitempty"`
	TermCols          int    `gorm:"column:term_cols" json:"term_cols,omitempty"`
	TermRows          int    `gorm:"column:term_rows" json:"term_rows,omitempty"`
	TermFlexRows      bool   `gorm:"column:term_flex_rows;not null;default:false" json:"term_flex_rows,omitempty"`
	TermMaxPTYSize    int    `gorm:"column:term_max_pty_size" json:"term_max_pty_size,omitempty"`
	BeforeStateJSON   string `gorm:"column:before_state_json;type:text" json:"before_state_json,omitempty"`
	AfterStateJSON    string `gorm:"column:after_state_json;type:text" json:"after_state_json,omitempty"`
	ExitCode          *int   `gorm:"column:exit_code" json:"exit_code"`
	StartedAt         *int64 `gorm:"column:started_at" json:"started_at"`
	FinishedAt        *int64 `gorm:"column:finished_at" json:"finished_at"`
	Renderer          string `gorm:"column:renderer" json:"renderer"`
	StateJSON         string `gorm:"column:state_json;type:text" json:"state_json"`
	PresentationJSON  string `gorm:"column:presentation_json;type:text" json:"presentation_json"`
	SnapshotUpdatedAt int64  `gorm:"column:snapshot_updated_at;not null;default:0" json:"snapshot_updated_at"`
	BlockDeletedAt    *int64 `gorm:"column:block_deleted_at;index" json:"block_deleted_at,omitempty"`
	HistoryPurgedAt   *int64 `gorm:"column:history_purged_at;index" json:"-"`
}

func (BlockTermCommandHistory) TableName() string {
	return "blockterm_command_history"
}
