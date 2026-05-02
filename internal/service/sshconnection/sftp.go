package sshconnection

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/pkg/sftp"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

var ErrRemoteFileBlockNotFound = errors.New("remote file block not found")

// OpenSFTP returns a short-lived SFTP client backed by the SSH connection
// shared by the terminal runtime. The caller owns the returned client and
// must close it before returning the HTTP response.
func (s *Service) OpenSFTP(ctx context.Context, terminalID string) (*sftp.Client, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	terminalID = strings.TrimSpace(terminalID)
	if terminalID == "" {
		return nil, terminal.ErrTerminalNotFound
	}

	var session model.TerminalSession
	if err := s.db.WithContext(ctx).First(&session, "id = ?", terminalID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, terminal.ErrTerminalNotFound
		}
		return nil, err
	}
	if session.RuntimeType != terminal.RuntimeTypeSSH || strings.TrimSpace(session.SSHProfileID) == "" {
		return nil, ErrRemoteFilesUnsupported
	}
	return s.openSFTPForProfile(ctx, session.SSHProfileID)
}

// OpenBlockSFTP resolves the connection exclusively from a durable BlockTerm
// identity. The terminal is part of the lookup key and is never used as a
// runtime/profile fallback, so a child block may safely select a different SSH
// profile from its parent terminal. Deleted blocks fall back to their visible
// immutable history snapshot.
func (s *Service) OpenBlockSFTP(
	ctx context.Context,
	terminalID string,
	blockID string,
	blockCreatedAt int64,
) (*sftp.Client, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	terminalID = strings.TrimSpace(terminalID)
	blockID = strings.TrimSpace(blockID)
	if terminalID == "" || blockID == "" || blockCreatedAt < 0 {
		return nil, ErrRemoteFileBlockNotFound
	}
	if s == nil || s.db == nil {
		return nil, ErrRemoteFileBlockNotFound
	}

	type runtimeSelection struct {
		ID           string `gorm:"column:id"`
		RuntimeType  string `gorm:"column:runtime_type"`
		SSHProfileID string `gorm:"column:ssh_profile_id"`
	}
	selection := runtimeSelection{}
	found := false
	if s.db.Migrator().HasTable(&model.BlockTermBlock{}) {
		columns := []string{"id"}
		if s.db.Migrator().HasColumn(&model.BlockTermBlock{}, "runtime_type") {
			columns = append(columns, "runtime_type")
		}
		if s.db.Migrator().HasColumn(&model.BlockTermBlock{}, "ssh_profile_id") {
			columns = append(columns, "ssh_profile_id")
		}
		err := s.db.WithContext(ctx).
			Table((model.BlockTermBlock{}).TableName()).
			Select(columns).
			Where("id = ? AND terminal_id = ? AND created_at = ?", blockID, terminalID, blockCreatedAt).
			Take(&selection).Error
		switch {
		case err == nil:
			found = true
		case errors.Is(err, gorm.ErrRecordNotFound):
		default:
			return nil, err
		}
	}
	if !found && s.db.Migrator().HasTable(&model.BlockTermCommandHistory{}) {
		columns := []string{"id"}
		if s.db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "runtime_type") {
			columns = append(columns, "runtime_type")
		}
		if s.db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "ssh_profile_id") {
			columns = append(columns, "ssh_profile_id")
		}
		historyQuery := s.db.WithContext(ctx).
			Table((model.BlockTermCommandHistory{}).TableName()).
			Select(columns).
			Where("id = ? AND terminal_id = ? AND created_at = ?", blockID, terminalID, blockCreatedAt)
		if s.db.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "history_purged_at") {
			historyQuery = historyQuery.Where("history_purged_at IS NULL")
		}
		err := historyQuery.Take(&selection).Error
		switch {
		case err == nil:
			found = true
		case errors.Is(err, gorm.ErrRecordNotFound):
		default:
			return nil, err
		}
	}
	if !found {
		return nil, ErrRemoteFileBlockNotFound
	}
	if strings.TrimSpace(selection.RuntimeType) != terminal.RuntimeTypeSSH ||
		strings.TrimSpace(selection.SSHProfileID) == "" {
		return nil, ErrRemoteFilesUnsupported
	}
	return s.openSFTPForProfile(ctx, selection.SSHProfileID)
}

func (s *Service) openSFTPForProfile(ctx context.Context, profileID string) (*sftp.Client, error) {
	profileID = strings.TrimSpace(profileID)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.isClosed() {
		return nil, ErrServiceClosed
	}
	if _, err := s.GetProfile(profileID); err != nil {
		return nil, err
	}
	client := s.getConnection(profileID)
	if client == nil {
		return nil, ErrReconnectRequired
	}

	// sftp.NewClient opens a new SSH session and never closes the shared
	// transport. Closing the returned client therefore leaves the terminal
	// runtime usable while releasing this request's SFTP channel.
	clientSFTP, err := sftp.NewClient(client, sftp.UseConcurrentReads(false))
	if err != nil {
		if s.isClosed() {
			return nil, ErrServiceClosed
		}
		return nil, fmt.Errorf("open ssh sftp session: %w", err)
	}
	if err := ctx.Err(); err != nil {
		_ = clientSFTP.Close()
		return nil, err
	}
	return clientSFTP, nil
}
