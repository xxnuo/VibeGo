//go:build !windows

package sshconnection

import (
	"context"
	"net"
	"os"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

func loadAgentSigners(ctx context.Context) ([]ssh.Signer, func(), error) {
	socket := os.Getenv("SSH_AUTH_SOCK")
	if socket == "" {
		return nil, nil, nil
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	stopContextDeadline := context.AfterFunc(ctx, func() {
		_ = connection.SetDeadline(time.Now())
	})
	signers, err := agent.NewClient(connection).Signers()
	if err != nil {
		stopContextDeadline()
		_ = connection.Close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, nil, ctxErr
		}
		if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
			return nil, nil, context.DeadlineExceeded
		}
		return nil, nil, err
	}
	return signers, func() {
		stopContextDeadline()
		_ = connection.Close()
	}, nil
}
