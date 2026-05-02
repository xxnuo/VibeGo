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
