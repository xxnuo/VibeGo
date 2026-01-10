package terminal

import (
	"os"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

type TerminalInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Shell     string `json:"shell"`
	Cwd       string `json:"cwd"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Status    string `json:"status"`
	PTYStatus string `json:"pty_status"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type CreateOptions struct {
	Name   string
	Cwd    string
	Cols   int
	Rows   int
	UserID string
}

type Connection struct {
	Done <-chan struct{}
}

type ManagerConfig struct {
	Shell                string
	BufferSize           int
	MaxConnections       int
	HistoryBufferSize    int
	HistoryFlushInterval time.Duration
	HistoryMaxRecords    int
	HistoryMaxAge        time.Duration
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
}

func sessionToInfo(s *model.TerminalSession) *TerminalInfo {
	return &TerminalInfo{
		ID:        s.ID,
		Name:      s.Name,
		Shell:     s.Shell,
		Cwd:       s.Cwd,
		Cols:      s.Cols,
		Rows:      s.Rows,
		Status:    s.Status,
		PTYStatus: s.PTYStatus,
		CreatedAt: s.CreatedAt,
		UpdatedAt: s.UpdatedAt,
	}
}
