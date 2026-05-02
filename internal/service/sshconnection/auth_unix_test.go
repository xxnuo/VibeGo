//go:build !windows

package sshconnection

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"net"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

func TestAutoAuthTriesExplicitKeyBeforeAgentSigners(t *testing.T) {
	_, agentPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	keyring := agent.NewKeyring()
	require.NoError(t, keyring.Add(agent.AddedKey{PrivateKey: agentPrivateKey}))

	socket := filepath.Join(t.TempDir(), "agent.sock")
	listener, err := net.Listen("unix", socket)
	require.NoError(t, err)
	var agentWG sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			agentWG.Add(1)
			go func() {
				defer agentWG.Done()
				_ = agent.ServeAgent(keyring, connection)
				_ = connection.Close()
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		<-acceptDone
		agentWG.Wait()
	})
	t.Setenv("SSH_AUTH_SOCK", socket)

	_, explicitPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	explicitSigner, err := ssh.NewSignerFromKey(explicitPrivateKey)
	require.NoError(t, err)
	privateKeyBlock, err := ssh.MarshalPrivateKey(explicitPrivateKey, "explicit")
	require.NoError(t, err)
	privateKeyPEM := string(pem.EncodeToMemory(privateKeyBlock))

	server := newPublicKeyTestSSHServer(t, explicitSigner.PublicKey())
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	host, port := server.HostPort(t)
	profile, err := service.CreateProfile(ProfileInput{
		Name:       "auto auth",
		Host:       host,
		Port:       port,
		User:       "tester",
		AuthMethod: AuthMethodAuto,
	})
	require.NoError(t, err)
	auth := terminal.SSHAuthSecrets{PrivateKey: privateKeyPEM}
	err = service.Connect(context.Background(), profile.ID, auth)
	var challengeErr *HostKeyChallengeError
	require.ErrorAs(t, err, &challengeErr)
	_, err = service.ConfirmHostKey(challengeErr.Challenge.ID)
	require.NoError(t, err)
	require.NoError(t, service.Connect(context.Background(), profile.ID, auth))
	require.True(t, service.IsConnected(profile.ID))
}
