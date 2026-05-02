//go:build windows

package sshconnection

import (
	"context"

	"golang.org/x/crypto/ssh"
)

func loadAgentSigners(context.Context) ([]ssh.Signer, func(), error) {
	return nil, nil, nil
}
