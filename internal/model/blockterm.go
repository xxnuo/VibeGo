package model

// BlockTermBlock stores the durable state of one BlockTerm command block.
// Output is kept as raw PTY bytes so callers can replay terminal output
// without losing encoding or control sequences.
type BlockTermBlock struct {
	ID           string `gorm:"column:id;primaryKey;not null" json:"id"`
	TerminalID   string `gorm:"column:terminal_id;not null;uniqueIndex:idx_blockterm_terminal_line,priority:1;constraint:OnDelete:CASCADE" json:"terminal_id"`
	LineNum      int    `gorm:"column:line_num;not null;uniqueIndex:idx_blockterm_terminal_line,priority:2" json:"line_num"`
	Kind         string `gorm:"column:kind;not null;default:command;index" json:"kind"`
	Command      string `gorm:"column:command;type:text" json:"command"`
	Text         string `gorm:"column:text;type:text" json:"text"`
	Cwd          string `gorm:"column:cwd" json:"cwd"`
	RuntimeType  string `gorm:"column:runtime_type" json:"runtime_type"`
	SSHProfileID string `gorm:"column:ssh_profile_id" json:"ssh_profile_id,omitempty"`
	Status       string `gorm:"column:status;index" json:"status"`
	Mode         string `gorm:"column:mode" json:"mode"`
	Output       []byte `gorm:"column:output;type:blob" json:"output"`
	OutputCursor *int64 `gorm:"column:output_cursor" json:"output_cursor,omitempty"`
	// CmdPID is the best-effort leader of the local terminal foreground process
	// group. It stays unset for shell builtins, short-lived commands, SSH, and
	// runtimes that cannot verify a distinct foreground child.
	CmdPID           *int64 `gorm:"column:cmd_pid" json:"cmd_pid,omitempty"`
	RemotePID        *int64 `gorm:"column:remote_pid" json:"remote_pid,omitempty"`
	TermCols         int    `gorm:"column:term_cols" json:"term_cols,omitempty"`
	TermRows         int    `gorm:"column:term_rows" json:"term_rows,omitempty"`
	TermFlexRows     bool   `gorm:"column:term_flex_rows;not null;default:false" json:"term_flex_rows,omitempty"`
	TermMaxPTYSize   int    `gorm:"column:term_max_pty_size" json:"term_max_pty_size,omitempty"`
	BeforeStateJSON  string `gorm:"column:before_state_json;type:text" json:"before_state_json,omitempty"`
	AfterStateJSON   string `gorm:"column:after_state_json;type:text" json:"after_state_json,omitempty"`
	ExitCode         *int   `gorm:"column:exit_code" json:"exit_code"`
	StartedAt        *int64 `gorm:"column:started_at" json:"started_at"`
	FinishedAt       *int64 `gorm:"column:finished_at" json:"finished_at"`
	Collapsed        bool   `gorm:"column:collapsed;not null;default:false" json:"collapsed"`
	Pinned           bool   `gorm:"column:pinned;not null;default:false" json:"pinned"`
	Archived         bool   `gorm:"column:archived;not null;default:false" json:"archived"`
	Starred          bool   `gorm:"column:starred;not null;default:false" json:"starred"`
	Renderer         string `gorm:"column:renderer" json:"renderer"`
	StateJSON        string `gorm:"column:state_json;type:text" json:"state_json"`
	PresentationJSON string `gorm:"column:presentation_json;type:text" json:"presentation_json"`
	CreatedAt        int64  `gorm:"column:created_at;not null;index" json:"created_at"`
	UpdatedAt        int64  `gorm:"column:updated_at;not null;index" json:"updated_at"`
}

func (BlockTermBlock) TableName() string {
	return "blockterm_blocks"
}
