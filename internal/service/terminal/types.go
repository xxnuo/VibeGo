package terminal

import (
	"context"
	"os"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

type TerminalInfo struct {
	ID                  string               `json:"id"`
	Name                string               `json:"name"`
	TabColor            string               `json:"tab_color"`
	TabIcon             string               `json:"tab_icon"`
	Shell               string               `json:"shell"`
	Cwd                 string               `json:"cwd"`
	CurrentCwd          string               `json:"current_cwd"`
	Cols                int                  `json:"cols"`
	Rows                int                  `json:"rows"`
	RuntimeType         string               `json:"runtime_type"`
	SSHProfileID        string               `json:"ssh_profile_id,omitempty"`
	Readonly            bool                 `json:"readonly"`
	Capabilities        TerminalCapabilities `json:"capabilities"`
	Status              string               `json:"status"`
	WorkspaceSessionID  string               `json:"workspace_session_id"`
	GroupID             string               `json:"group_id"`
	ParentID            string               `json:"parent_id"`
	ShellType           string               `json:"shell_type"`
	ShellState          string               `json:"shell_state"`
	ShellIntegration    bool                 `json:"shell_integration"`
	LastCommand         string               `json:"last_command"`
	LastCommandExitCode *int                 `json:"last_command_exit_code"`
	ExitCode            int                  `json:"exit_code"`
	HistorySize         int64                `json:"history_size"`
	CreatedAt           int64                `json:"created_at"`
	UpdatedAt           int64                `json:"updated_at"`
}

type CreateOptions struct {
	Name string
	Cwd  string
	// Command starts a one-shot PTY command when non-empty. An empty command
	// preserves the interactive shell behavior used by ordinary sessions.
	Command            string
	Cols               int
	Rows               int
	UserID             string
	WorkspaceSessionID string
	GroupID            string
	ParentID           string
	RuntimeType        string
	SSHProfileID       string
	SSHAuth            SSHAuthSecrets
	Context            context.Context
}

type ShellMetadataUpdate struct {
	CurrentCwd             *string
	ShellType              *string
	ShellState             *string
	ShellIntegration       *bool
	LastCommand            *string
	LastCommandExitCode    *int
	LastCommandExitCodeSet bool
}

type WorkspaceTerminalAssignment struct {
	ID       string
	GroupID  string
	ParentID string
}

type Connection struct {
	Done <-chan struct{}
}

type AttachOptions struct {
	Cursor uint64
}

type ManagerConfig struct {
	Shell                string
	BufferSize           int
	MaxConnections       int
	HistoryBufferSize    int
	HistoryFlushInterval time.Duration
	HistoryMaxRecords    int
	HistoryMaxAge        time.Duration
	WSPingInterval       time.Duration
	WSReadTimeout        time.Duration
	WSWriteTimeout       time.Duration
	RuntimeFactory       RuntimeFactory
	// BlockTermRuntimeRegistry optionally supplies a shared route table. When
	// omitted, NewManager creates an in-memory registry so session routes are
	// still fenced; legacy protocol messages remain compatible.
	BlockTermRuntimeRegistry *BlockTermRuntimeRegistry
}

func (c *ManagerConfig) applyDefaults() {
	if c.Shell == "" {
		c.Shell = os.Getenv("SHELL")
		if c.Shell == "" {
			c.Shell = "/bin/sh"
		}
	}
	if c.BufferSize <= 0 {
		c.BufferSize = 32 * 1024
	}
	if c.HistoryBufferSize <= 0 {
		c.HistoryBufferSize = 10 * 1024 * 1024
	}
	if c.HistoryFlushInterval <= 0 {
		c.HistoryFlushInterval = 5 * time.Second
	}
	if c.HistoryMaxRecords <= 0 {
		c.HistoryMaxRecords = 1
	}
	if c.HistoryMaxAge <= 0 {
		c.HistoryMaxAge = 7 * 24 * time.Hour
	}
	if c.WSPingInterval <= 0 {
		c.WSPingInterval = 25 * time.Second
	}
	if c.WSReadTimeout <= 0 {
		c.WSReadTimeout = 75 * time.Second
	}
	if c.WSWriteTimeout <= 0 {
		c.WSWriteTimeout = 10 * time.Second
	}
}

func sessionToInfo(s *model.TerminalSession) *TerminalInfo {
	capabilities := TerminalCapabilities{
		Resume:           true,
		Snapshot:         true,
		ShellIntegration: s.ShellIntegration,
		Durable:          false,
	}
	return &TerminalInfo{
		ID:                  s.ID,
		Name:                s.Name,
		TabColor:            s.TabColor,
		TabIcon:             s.TabIcon,
		Shell:               s.Shell,
		Cwd:                 s.Cwd,
		CurrentCwd:          s.CurrentCwd,
		Cols:                s.Cols,
		Rows:                s.Rows,
		RuntimeType:         s.RuntimeType,
		SSHProfileID:        s.SSHProfileID,
		Readonly:            s.Readonly,
		Capabilities:        capabilities,
		Status:              s.Status,
		WorkspaceSessionID:  s.WorkspaceSessionID,
		GroupID:             s.GroupID,
		ParentID:            s.ParentID,
		ShellType:           s.ShellType,
		ShellState:          s.ShellState,
		ShellIntegration:    s.ShellIntegration,
		LastCommand:         s.LastCommand,
		LastCommandExitCode: s.LastCommandExitCode,
		ExitCode:            s.ExitCode,
		HistorySize:         s.HistorySize,
		CreatedAt:           s.CreatedAt,
		UpdatedAt:           s.UpdatedAt,
	}
}

// cloneTerminalSession makes a stable value copy for callers that may run
// concurrently with PTY metadata updates. The exit-code pointer needs its own
// allocation so a caller never observes a later replacement.
func cloneTerminalSession(s *model.TerminalSession) model.TerminalSession {
	if s == nil {
		return model.TerminalSession{}
	}
	clone := *s
	if s.LastCommandExitCode != nil {
		exitCode := *s.LastCommandExitCode
		clone.LastCommandExitCode = &exitCode
	}
	return clone
}
