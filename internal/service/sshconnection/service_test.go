package sshconnection

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/pkg/sftp"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
	"gorm.io/gorm"
)

type testSSHServer struct {
	listener      net.Listener
	signer        ssh.Signer
	password      string
	authorizedKey []byte

	mu            sync.Mutex
	connections   map[net.Conn]struct{}
	ptyRequests   int
	rejectPTYAt   int
	blockPTYAt    int
	ptyGate       <-chan struct{}
	authGate      <-chan struct{}
	authAttempts  chan struct{}
	resizes       chan [2]int
	execHandler   func(command string, channel ssh.Channel)
	execReplyGate <-chan struct{}
	execCommands  chan string
	sessionOpened chan struct{}
	sessionClosed chan struct{}
	sftpRoot      string
	done          chan struct{}
	wg            sync.WaitGroup
}

func newTestSSHServer(t *testing.T, password string) *testSSHServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := ssh.NewSignerFromKey(privateKey)
	require.NoError(t, err)
	server := &testSSHServer{
		listener:      listener,
		signer:        signer,
		password:      password,
		connections:   make(map[net.Conn]struct{}),
		authAttempts:  make(chan struct{}, 16),
		resizes:       make(chan [2]int, 16),
		execCommands:  make(chan string, 32),
		sessionOpened: make(chan struct{}, 64),
		sessionClosed: make(chan struct{}, 64),
		done:          make(chan struct{}),
	}
	server.wg.Add(1)
	go server.serve()
	t.Cleanup(server.Close)
	return server
}

func (s *testSSHServer) setPTYBehavior(rejectAt, blockAt int, gate <-chan struct{}) {
	s.mu.Lock()
	s.rejectPTYAt = rejectAt
	s.blockPTYAt = blockAt
	s.ptyGate = gate
	s.mu.Unlock()
}

func (s *testSSHServer) setAuthGate(gate <-chan struct{}) {
	s.mu.Lock()
	s.authGate = gate
	s.mu.Unlock()
}

func (s *testSSHServer) setSFTPRoot(root string) {
	s.mu.Lock()
	s.sftpRoot = root
	s.mu.Unlock()
}

func (s *testSSHServer) setExecHandler(handler func(command string, channel ssh.Channel)) {
	s.mu.Lock()
	s.execHandler = handler
	s.mu.Unlock()
}

func (s *testSSHServer) setExecReplyGate(gate <-chan struct{}) {
	s.mu.Lock()
	s.execReplyGate = gate
	s.mu.Unlock()
}

func newPublicKeyTestSSHServer(t *testing.T, authorizedKey ssh.PublicKey) *testSSHServer {
	t.Helper()
	server := newTestSSHServer(t, "")
	server.authorizedKey = append([]byte(nil), authorizedKey.Marshal()...)
	return server
}

func (s *testSSHServer) HostPort(t *testing.T) (string, int) {
	t.Helper()
	host, rawPort, err := net.SplitHostPort(s.listener.Addr().String())
	require.NoError(t, err)
	var port int
	_, err = fmt.Sscanf(rawPort, "%d", &port)
	require.NoError(t, err)
	return host, port
}

func (s *testSSHServer) Close() {
	select {
	case <-s.done:
		return
	default:
		close(s.done)
	}
	_ = s.listener.Close()
	s.mu.Lock()
	for connection := range s.connections {
		_ = connection.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *testSSHServer) serve() {
	defer s.wg.Done()
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.connections[connection] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go s.serveConnection(connection)
	}
}

func (s *testSSHServer) serveConnection(connection net.Conn) {
	defer s.wg.Done()
	defer func() {
		s.mu.Lock()
		delete(s.connections, connection)
		s.mu.Unlock()
		_ = connection.Close()
	}()
	config := &ssh.ServerConfig{
		PasswordCallback: func(metadata ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			select {
			case s.authAttempts <- struct{}{}:
			default:
			}
			s.mu.Lock()
			authGate := s.authGate
			s.mu.Unlock()
			if authGate != nil {
				select {
				case <-authGate:
				case <-s.done:
					return nil, errors.New("server closed")
				}
			}
			if metadata.User() == "tester" && string(password) == s.password {
				return nil, nil
			}
			return nil, errors.New("password rejected")
		},
		PublicKeyCallback: func(metadata ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if metadata.User() == "tester" && bytes.Equal(key.Marshal(), s.authorizedKey) {
				return nil, nil
			}
			return nil, errors.New("public key rejected")
		},
	}
	config.AddHostKey(s.signer)
	_, channels, requests, err := ssh.NewServerConn(connection, config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported channel")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		select {
		case s.sessionOpened <- struct{}{}:
		default:
		}
		s.wg.Add(1)
		go s.serveSession(channel, channelRequests)
	}
}

func (s *testSSHServer) serveSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer s.wg.Done()
	defer func() {
		select {
		case s.sessionClosed <- struct{}{}:
		default:
		}
	}()
	started := false
	for request := range requests {
		switch request.Type {
		case "pty-req":
			s.mu.Lock()
			s.ptyRequests++
			requestNumber := s.ptyRequests
			rejectAt := s.rejectPTYAt
			blockAt := s.blockPTYAt
			ptyGate := s.ptyGate
			s.mu.Unlock()
			if requestNumber == blockAt && ptyGate != nil {
				select {
				case <-ptyGate:
				case <-s.done:
					return
				}
			}
			_ = request.Reply(requestNumber != rejectAt, nil)
		case "window-change":
			if len(request.Payload) >= 8 {
				cols := int(binary.BigEndian.Uint32(request.Payload[:4]))
				rows := int(binary.BigEndian.Uint32(request.Payload[4:8]))
				select {
				case s.resizes <- [2]int{cols, rows}:
				default:
				}
			}
		case "shell":
			_ = request.Reply(true, nil)
			if !started {
				started = true
				go echoSSHSession(channel)
			}
		case "exec":
			var payload struct{ Command string }
			if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
				_ = request.Reply(false, nil)
				continue
			}
			s.mu.Lock()
			execHandler := s.execHandler
			execReplyGate := s.execReplyGate
			s.mu.Unlock()
			select {
			case s.execCommands <- payload.Command:
			default:
			}
			if execReplyGate != nil {
				select {
				case <-execReplyGate:
				case <-s.done:
					return
				}
			}
			_ = request.Reply(true, nil)
			if !started {
				started = true
				if execHandler == nil {
					go echoSSHSession(channel)
				} else {
					go execHandler(payload.Command, channel)
				}
			}
		case "subsystem":
			var payload struct{ Name string }
			if err := ssh.Unmarshal(request.Payload, &payload); err != nil || payload.Name != "sftp" {
				_ = request.Reply(false, nil)
				continue
			}
			s.mu.Lock()
			root := s.sftpRoot
			s.mu.Unlock()
			if root == "" {
				_ = request.Reply(false, nil)
				continue
			}
			_ = request.Reply(true, nil)
			server, err := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(root))
			if err == nil {
				_ = server.Serve()
			}
			_ = channel.Close()
			return
		default:
			_ = request.Reply(false, nil)
		}
	}
}

func echoSSHSession(channel ssh.Channel) {
	defer channel.Close()
	reader := bufio.NewReader(channel)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			_, _ = io.WriteString(channel, "remote:"+line)
		}
		if err != nil {
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: 0}))
			return
		}
	}
}

func runTestSSHExec(command string, channel ssh.Channel) {
	cmd := osexec.Command("bash", "-lc", command)
	cmd.Stdin = channel
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()
	err := cmd.Run()
	status := uint32(0)
	if err != nil {
		status = 1
		var exitErr *osexec.ExitError
		if errors.As(err, &exitErr) {
			status = uint32(exitErr.ExitCode())
		}
	}
	// OpenSSH sends exit-status before EOF/channel close. Match that order so
	// ssh.Session.Wait can observe the real command status reliably.
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: status}))
	// Close the whole session channel after exit-status. A half-close only
	// signals stdout EOF and leaves the request stream open, so Session.Wait
	// would keep waiting for channel-close.
	_ = channel.Close()
}

func runTestSSHInteractiveExec(command string, channel ssh.Channel) {
	defer channel.Close()
	// Feed one PTY line to the child and then close its stdin. This models a
	// client typing a line while avoiding an io.Copy stdin goroutine keeping
	// os/exec.Cmd.Wait alive after the child exits.
	line, _ := bufio.NewReader(channel).ReadString('\n')
	cmd := osexec.Command("bash", "-lc", command)
	cmd.Stdin = strings.NewReader(line)
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()
	err := cmd.Run()
	status := uint32(0)
	if err != nil {
		status = 1
		var exitErr *osexec.ExitError
		if errors.As(err, &exitErr) {
			status = uint32(exitErr.ExitCode())
		}
	}
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: status}))
	_ = channel.Close()
}

func setupSSHServiceTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.UserSession{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
		&model.SSHConnectionProfile{},
		&model.SSHKnownHost{},
	))
	return db
}

func createPasswordProfile(t *testing.T, service *Service, server *testSSHServer) *model.SSHConnectionProfile {
	t.Helper()
	host, port := server.HostPort(t)
	profile, err := service.CreateProfile(ProfileInput{
		Name:       "test ssh",
		Host:       host,
		Port:       port,
		User:       "tester",
		AuthMethod: AuthMethodPassword,
	})
	require.NoError(t, err)
	return profile
}

func createConnectedTestRuntime(t *testing.T, server *testSSHServer, cwd string) (*Service, *Runtime, *model.SSHConnectionProfile) {
	t.Helper()
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))
	runtimeValue, err := service.CreateRuntime(context.Background(), terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       cwd,
		Cols:      80,
		Rows:      24,
	})
	require.NoError(t, err)
	runtime, ok := runtimeValue.(*Runtime)
	require.True(t, ok)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	return service, runtime, profile
}

func completionValues(result terminal.CompletionResult) []string {
	values := make([]string, 0, len(result.Candidates))
	for _, candidate := range result.Candidates {
		values = append(values, candidate.Value)
	}
	return values
}

func readRuntimeUntil(t *testing.T, runtime *Runtime, marker string) string {
	t.Helper()
	type readResult struct {
		value string
		err   error
	}
	result := make(chan readResult, 1)
	go func() {
		buffer := make([]byte, 1024)
		var output strings.Builder
		for !strings.Contains(output.String(), marker) {
			n, err := runtime.Read(buffer)
			if n > 0 {
				output.Write(buffer[:n])
			}
			if err != nil {
				result <- readResult{value: output.String(), err: err}
				return
			}
		}
		result <- readResult{value: output.String()}
	}()
	select {
	case completed := <-result:
		require.NoError(t, completed.err)
		return completed.value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out reading SSH runtime output")
		return ""
	}
}

func readRuntimeToEOF(t *testing.T, runtime *Runtime) string {
	t.Helper()
	var output strings.Builder
	buffer := make([]byte, 1024)
	for {
		n, err := runtime.Read(buffer)
		if n > 0 {
			output.Write(buffer[:n])
		}
		if err != nil {
			return output.String()
		}
	}
}

func TestBuildRemoteRuntimeCommand(t *testing.T) {
	command := "printf 'hello'; exit 7"
	got := buildRemoteRuntimeCommand("/tmp/work", command)
	want := `cd -- '/tmp/work' && exec "${SHELL:-/bin/sh}" -c 'printf '\''hello'\''; exit 7'`
	if got != want {
		t.Fatalf("remote command = %q, want %q", got, want)
	}

	if got := buildRemoteRuntimeCommand(".", "printf ok"); got != `exec "${SHELL:-/bin/sh}" -c 'printf ok'` {
		t.Fatalf("remote command without cwd = %q", got)
	}
	quoted := buildRemoteRuntimeCommand("/tmp/with'quote", "printf '%s' \"$VALUE\"")
	if !strings.Contains(quoted, "cd -- "+quotePOSIX("/tmp/with'quote")+" &&") ||
		!strings.Contains(quoted, `exec "${SHELL:-/bin/sh}" -c `+quotePOSIX("printf '%s' \"$VALUE\"")) {
		t.Fatalf("remote command did not quote cwd/command safely: %q", quoted)
	}
}

func TestRuntimeCommandModeUsesPTYExecAndNaturalExit(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	server.setExecHandler(runTestSSHInteractiveExec)
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))

	cwd := filepath.Join(t.TempDir(), "command cwd")
	require.NoError(t, os.Mkdir(cwd, 0o755))
	command := "printf 'ssh-ready\\n'; read value; printf 'ssh-received=%s\\n' \"$value\"; exit 7"
	runtimeValue, err := service.CreateRuntime(context.Background(), terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       cwd,
		Command:   command,
		Cols:      80,
		Rows:      24,
	})
	require.NoError(t, err)
	runtime, ok := runtimeValue.(*Runtime)
	require.True(t, ok)
	t.Cleanup(func() { _ = runtime.Close() })

	var startedCommand string
	select {
	case startedCommand = <-server.execCommands:
	case <-time.After(2 * time.Second):
		t.Fatal("SSH command session was not started")
	}
	require.Equal(t, buildRemoteRuntimeCommand(cwd, command), startedCommand)

	require.NoError(t, runtime.Resize(100, 30))
	select {
	case size := <-server.resizes:
		require.Equal(t, [2]int{100, 30}, size)
	case <-time.After(2 * time.Second):
		t.Fatal("command runtime resize was not delivered to SSH PTY")
	}
	if _, err := runtime.Write([]byte("remote-input\n")); err != nil {
		t.Fatalf("write command runtime stdin: %v", err)
	}
	output := readRuntimeUntil(t, runtime, "ssh-received=remote-input")
	require.Contains(t, output, "ssh-ready")
	require.Contains(t, output, "ssh-received=remote-input")
	// Drain the stream after the marker. SSH Session.Wait waits for all stdout
	// copy goroutines to finish, so observing the marker alone is insufficient
	// to establish natural process exit.
	output += readRuntimeToEOF(t, runtime)
	select {
	case <-runtime.done:
	case <-time.After(2 * time.Second):
		closed := false
		select {
		case <-runtime.closed:
			closed = true
		default:
		}
		t.Fatalf("SSH command runtime did not naturally exit (closed=%t, exit=%d, output=%q)", closed, runtime.ExitCode(), output)
	}
	require.Equal(t, 7, runtime.ExitCode())
}

func TestRuntimeCompletionUsesIndependentExecSessionAndRemoteCwd(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	server.setExecHandler(runTestSSHExec)
	remoteRoot := t.TempDir()
	remoteCwd := filepath.Join(remoteRoot, "dir with ' quote")
	require.NoError(t, os.Mkdir(remoteCwd, 0o755))
	require.NoError(t, os.Mkdir(filepath.Join(remoteCwd, "target-dir"), 0o755))
	require.NoError(t, os.Mkdir(filepath.Join(remoteCwd, "ec-dir"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(remoteCwd, "target-file.txt"), nil, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(remoteCwd, "target-exec"), []byte("#!/bin/sh\n"), 0o755))
	_, runtime, _ := createConnectedTestRuntime(t, server, ".")

	fileResult, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
		Cwd:    remoteCwd,
		Prefix: "target-",
		Kind:   terminal.CompletionKindFile,
		Limit:  sshCompletionLimit,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"target-dir/", "target-exec", "target-file.txt"}, completionValues(fileResult))
	require.False(t, fileResult.HasMore)

	executableResult, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
		Cwd:            remoteCwd,
		Prefix:         "./target-",
		Kind:           terminal.CompletionKindFile,
		ExecutableOnly: true,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"./target-dir/", "./target-exec"}, completionValues(executableResult))

	commandResult, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
		Cwd:    remoteCwd,
		Prefix: "ec",
		Kind:   terminal.CompletionKindCommand,
	})
	require.NoError(t, err)
	require.Contains(t, completionValues(commandResult), "echo")
	require.Contains(t, completionValues(commandResult), "ec-dir/")

	_, err = runtime.Write([]byte("after-completion\n"))
	require.NoError(t, err)
	interactiveOutput := readRuntimeUntil(t, runtime, "remote:after-completion")
	require.NotContains(t, interactiveOutput, "target-file.txt")
	require.NotContains(t, interactiveOutput, "compgen")

	select {
	case command := <-server.execCommands:
		require.Contains(t, command, "bash -lc")
		require.Contains(t, command, "bash --noprofile --norc -c")
	case <-time.After(time.Second):
		t.Fatal("SSH server did not receive a completion exec request")
	}
}

func TestRuntimeCompletionBoundsResultsAndKeepsSharedConnectionUsable(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	server.setExecHandler(runTestSSHExec)
	remoteCwd := t.TempDir()
	for index := 0; index < sshCompletionLimit+1; index++ {
		name := fmt.Sprintf("bounded-%03d", index)
		require.NoError(t, os.WriteFile(filepath.Join(remoteCwd, name), nil, 0o644))
	}
	service, runtime, profile := createConnectedTestRuntime(t, server, ".")

	result, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
		Cwd: remoteCwd, Prefix: "bounded-", Kind: terminal.CompletionKindFile, Limit: sshCompletionLimit,
	})
	require.NoError(t, err)
	require.True(t, result.HasMore)
	require.Len(t, result.Candidates, sshCompletionLimit)
	require.Equal(t, "bounded-000", result.Candidates[0].Value)
	require.Equal(t, "bounded-099", result.Candidates[len(result.Candidates)-1].Value)
	require.True(t, service.IsConnected(profile.ID))

	second, err := service.CreateRuntime(context.Background(), terminal.RuntimeCreateRequest{
		Type: terminal.RuntimeTypeSSH, ProfileID: profile.ID, Cwd: ".", Cols: 80, Rows: 24,
	})
	require.NoError(t, err)
	require.NoError(t, second.Close())
	require.True(t, service.IsConnected(profile.ID))
}

func TestRuntimeCompletionReportsUnavailableBashAndCompgenWithoutLeakingStderr(t *testing.T) {
	tests := []struct {
		name      string
		handler   func(string, ssh.Channel)
		wantError string
		forbidden string
	}{
		{
			name: "bash unavailable",
			handler: func(_ string, channel ssh.Channel) {
				defer channel.Close()
				_, _ = io.WriteString(channel.Stderr(), "bash: command not found: super-secret-token\n")
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: 127}))
			},
			wantError: "remote command exited unsuccessfully",
			forbidden: "super-secret-token",
		},
		{
			name: "compgen unavailable",
			handler: func(_ string, channel ssh.Channel) {
				defer channel.Close()
				_, _ = io.WriteString(channel.Stderr(), "remote bash compgen is unavailable\nsecret-profile-value\n")
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: 127}))
			},
			wantError: "remote bash compgen is unavailable",
			forbidden: "secret-profile-value",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newTestSSHServer(t, "correct-password")
			server.setExecHandler(test.handler)
			_, runtime, _ := createConnectedTestRuntime(t, server, ".")
			_, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
				Cwd: ".", Prefix: "x", Kind: terminal.CompletionKindFile,
			})
			require.Error(t, err)
			require.Contains(t, err.Error(), test.wantError)
			require.NotContains(t, err.Error(), test.forbidden)
		})
	}
}

func TestRuntimeCompletionCancelAndConcurrentRequestsDoNotCloseSharedTransport(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	started := make(chan struct{}, sshCompletionMaxConcurrent+1)
	release := make(chan struct{})
	server.setExecHandler(func(command string, channel ssh.Channel) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		// Run the actual completion command after the gate is released so the
		// protocol markers and shell semantics remain covered by this test.
		runTestSSHExec(command, channel)
	})
	service, runtime, profile := createConnectedTestRuntime(t, server, ".")

	cancelCtx, cancel := context.WithCancel(context.Background())
	cancelDone := make(chan error, 1)
	go func() {
		_, err := runtime.Complete(cancelCtx, terminal.CompletionRequest{Cwd: ".", Prefix: "x", Kind: terminal.CompletionKindFile})
		cancelDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("completion exec did not start")
	}
	cancel()
	select {
	case err := <-cancelDone:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("canceled completion did not return promptly")
	}
	require.True(t, service.IsConnected(profile.ID))

	results := make(chan error, sshCompletionMaxConcurrent)
	for index := 0; index < sshCompletionMaxConcurrent; index++ {
		go func() {
			result, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
				Cwd: ".", Prefix: "x", Kind: terminal.CompletionKindFile,
			})
			_ = result
			results <- err
		}()
	}
	for index := 0; index < sshCompletionMaxConcurrent; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("concurrent completion did not open expected exec channels")
		}
	}
	close(release)
	for index := 0; index < sshCompletionMaxConcurrent; index++ {
		require.NoError(t, <-results)
	}
	require.True(t, service.IsConnected(profile.ID))
	_, err := runtime.Write([]byte("still-alive\n"))
	require.NoError(t, err)
	require.Contains(t, readRuntimeUntil(t, runtime, "remote:still-alive"), "remote:still-alive")
}

func TestOpenSFTPUsesTerminalProfileAndPreservesSharedConnection(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	remoteRoot := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(remoteRoot, "hello.txt"), []byte("remote-content"), 0644))
	server.setSFTPRoot(remoteRoot)
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))
	require.NoError(t, db.Create(&model.TerminalSession{
		ID:           "ssh-files",
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: profile.ID,
	}).Error)

	client, err := service.OpenSFTP(context.Background(), "ssh-files")
	require.NoError(t, err)
	file, err := client.Open("hello.txt")
	require.NoError(t, err)
	content, err := io.ReadAll(file)
	require.NoError(t, err)
	require.NoError(t, file.Close())
	require.Equal(t, "remote-content", string(content))
	require.NoError(t, client.Close())
	require.True(t, service.IsConnected(profile.ID))

	second, err := service.OpenSFTP(context.Background(), "ssh-files")
	require.NoError(t, err)
	require.NoError(t, second.Close())
	service.Disconnect(profile.ID)
	_, err = service.OpenSFTP(context.Background(), "ssh-files")
	require.ErrorIs(t, err, ErrReconnectRequired)
}

func TestOpenSFTPRejectsMissingAndLocalTerminals(t *testing.T) {
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)

	_, err := service.OpenSFTP(context.Background(), "missing")
	require.ErrorIs(t, err, terminal.ErrTerminalNotFound)
	require.NoError(t, db.Create(&model.TerminalSession{ID: "local-files", RuntimeType: terminal.RuntimeTypeLocal}).Error)
	_, err = service.OpenSFTP(context.Background(), "local-files")
	require.ErrorIs(t, err, ErrRemoteFilesUnsupported)
}

func TestOpenBlockSFTPUsesDurableBlockSelectionAndHistoryFallback(t *testing.T) {
	serverA := newTestSSHServer(t, "password-a")
	serverB := newTestSSHServer(t, "password-b")
	rootA := t.TempDir()
	rootB := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(rootA, "profile.txt"), []byte("profile-a"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(rootB, "profile.txt"), []byte("profile-b"), 0644))
	serverA.setSFTPRoot(rootA)
	serverB.setSFTPRoot(rootB)

	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profileA := createPasswordProfile(t, service, serverA)
	profileB := createPasswordProfile(t, service, serverB)
	trustTestServer(t, service, profileA.ID, "password-a")
	trustTestServer(t, service, profileB.ID, "password-b")
	require.NoError(t, service.Connect(context.Background(), profileA.ID, terminal.SSHAuthSecrets{Password: "password-a"}))
	require.NoError(t, service.Connect(context.Background(), profileB.ID, terminal.SSHAuthSecrets{Password: "password-b"}))

	// A local parent may own an SSH child. The child selection, rather than the
	// parent terminal row, determines which connected profile opens SFTP.
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: "block-files-local-parent", RuntimeType: terminal.RuntimeTypeLocal,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "block-files-child-b", TerminalID: "block-files-local-parent", LineNum: 1, CreatedAt: 11,
		RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: profileB.ID,
	}).Error)
	client, err := service.OpenBlockSFTP(context.Background(), "block-files-local-parent", "block-files-child-b", 11)
	require.NoError(t, err)
	require.Equal(t, "profile-b", readSFTPTestFile(t, client, "profile.txt"))
	require.NoError(t, client.Close())

	// An SSH parent connected through profile A may still have a child pinned to
	// profile B; the parent profile must not leak into the child transport.
	require.NoError(t, db.Create(&model.TerminalSession{
		ID: "block-files-ssh-parent", RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: profileA.ID,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "block-files-child-cross-profile", TerminalID: "block-files-ssh-parent", LineNum: 1, CreatedAt: 12,
		RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: profileB.ID,
	}).Error)
	client, err = service.OpenBlockSFTP(context.Background(), "block-files-ssh-parent", "block-files-child-cross-profile", 12)
	require.NoError(t, err)
	require.Equal(t, "profile-b", readSFTPTestFile(t, client, "profile.txt"))
	require.NoError(t, client.Close())
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "block-files-local-child", TerminalID: "block-files-ssh-parent", LineNum: 2, CreatedAt: 14,
		RuntimeType: terminal.RuntimeTypeLocal,
	}).Error)
	_, err = service.OpenBlockSFTP(context.Background(), "block-files-ssh-parent", "block-files-local-child", 14)
	require.ErrorIs(t, err, ErrRemoteFilesUnsupported)

	// The immutable history row remains usable after the source block is
	// removed, while a purged row is no longer an authorized file scope.
	require.NoError(t, db.Create(&model.BlockTermCommandHistory{
		ID: "block-files-history-fallback", TerminalID: "block-files-ssh-parent", LineNum: 2,
		Command: "echo history", CreatedAt: 13,
		RuntimeType: terminal.RuntimeTypeSSH, SSHProfileID: profileB.ID,
	}).Error)
	client, err = service.OpenBlockSFTP(context.Background(), "block-files-ssh-parent", "block-files-history-fallback", 13)
	require.NoError(t, err)
	require.NoError(t, client.Close())
	require.NoError(t, db.Model(&model.BlockTermCommandHistory{}).
		Where("id = ?", "block-files-history-fallback").Update("history_purged_at", int64(14)).Error)
	_, err = service.OpenBlockSFTP(context.Background(), "block-files-ssh-parent", "block-files-history-fallback", 13)
	require.ErrorIs(t, err, ErrRemoteFileBlockNotFound)

	// The lookup is exact on both terminal and creation identity; a client cannot
	// borrow a valid child block from another terminal or lifecycle.
	_, err = service.OpenBlockSFTP(context.Background(), "block-files-local-parent", "block-files-child-cross-profile", 12)
	require.ErrorIs(t, err, ErrRemoteFileBlockNotFound)
	_, err = service.OpenBlockSFTP(context.Background(), "block-files-ssh-parent", "block-files-child-cross-profile", 99)
	require.ErrorIs(t, err, ErrRemoteFileBlockNotFound)
}

func readSFTPTestFile(t *testing.T, client *sftp.Client, name string) string {
	t.Helper()
	file, err := client.Open(name)
	require.NoError(t, err)
	content, err := io.ReadAll(file)
	require.NoError(t, err)
	require.NoError(t, file.Close())
	return string(content)
}

func trustTestServer(t *testing.T, service *Service, profileID, password string) HostKeyChallenge {
	t.Helper()
	err := service.Connect(context.Background(), profileID, terminal.SSHAuthSecrets{Password: password})
	var challengeErr *HostKeyChallengeError
	require.ErrorAs(t, err, &challengeErr)
	require.NotEmpty(t, challengeErr.Challenge.ID)
	require.Contains(t, challengeErr.Challenge.Fingerprint, "SHA256:")
	knownHost, err := service.ConfirmHostKey(challengeErr.Challenge.ID)
	require.NoError(t, err)
	require.Equal(t, challengeErr.Challenge.Fingerprint, knownHost.Fingerprint)
	return challengeErr.Challenge
}

func TestServiceRequiresHostKeyConfirmationAndRejectsChangedKey(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)

	challenge := trustTestServer(t, service, profile.ID, "correct-password")
	require.False(t, service.IsConnected(profile.ID))
	require.Equal(t, profile.ID, challenge.ProfileID)

	err := service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "wrong-password"})
	require.ErrorIs(t, err, ErrAuthenticationFailed)
	require.False(t, service.IsConnected(profile.ID))

	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))
	require.True(t, service.IsConnected(profile.ID))
	service.Disconnect(profile.ID)

	_, replacementKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	replacementSigner, err := ssh.NewSignerFromKey(replacementKey)
	require.NoError(t, err)
	require.NoError(t, db.Model(&model.SSHKnownHost{}).Where("endpoint = ?", challenge.Endpoint).Updates(map[string]any{
		"key_type":    replacementSigner.PublicKey().Type(),
		"public_key":  base64.StdEncoding.EncodeToString(replacementSigner.PublicKey().Marshal()),
		"fingerprint": ssh.FingerprintSHA256(replacementSigner.PublicKey()),
	}).Error)

	err = service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"})
	var changedErr *HostKeyChangedError
	require.ErrorAs(t, err, &changedErr)
	require.Equal(t, challenge.Endpoint, changedErr.Endpoint)
	require.Equal(t, ssh.FingerprintSHA256(replacementSigner.PublicKey()), changedErr.ExpectedFingerprint)
	require.Equal(t, challenge.Fingerprint, changedErr.PresentedFingerprint)
	require.False(t, service.IsConnected(profile.ID))

	replacementFingerprint := ssh.FingerprintSHA256(replacementSigner.PublicKey())
	_, err = service.ResetKnownHost(profile.ID, challenge.Fingerprint)
	var mismatchErr *KnownHostFingerprintMismatchError
	require.ErrorAs(t, err, &mismatchErr)
	require.Equal(t, replacementFingerprint, mismatchErr.ActualFingerprint)
	removed, err := service.ResetKnownHost(profile.ID, replacementFingerprint)
	require.NoError(t, err)
	require.Equal(t, replacementFingerprint, removed.Fingerprint)

	err = service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"})
	var newChallengeErr *HostKeyChallengeError
	require.ErrorAs(t, err, &newChallengeErr)
	require.Equal(t, challenge.Fingerprint, newChallengeErr.Challenge.Fingerprint)
	require.NotEqual(t, challenge.ID, newChallengeErr.Challenge.ID)
}

func TestResetKnownHostRollsBackWhenEndpointProfileQueryFails(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	challenge := trustTestServer(t, service, profile.ID, "correct-password")

	forcedErr := errors.New("forced endpoint profile query failure")
	const callbackName = "test:ssh_known_host_reset_profile_query_failure"
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != (model.SSHConnectionProfile{}).TableName() {
			return
		}
		if _, ok := tx.Statement.Dest.(*[]string); ok {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

	_, err := service.ResetKnownHost(profile.ID, challenge.Fingerprint)
	require.ErrorIs(t, err, forcedErr)
	var knownHost model.SSHKnownHost
	require.NoError(t, db.First(&knownHost, "endpoint = ?", challenge.Endpoint).Error)
	require.Equal(t, challenge.Fingerprint, knownHost.Fingerprint)
}

func TestConfirmHostKeyCanRetryAfterDatabaseFailure(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	challenge := service.issueHostKeyChallenge(profile.ID, profileEndpoint(profile), server.signer.PublicKey())

	forcedErr := errors.New("forced known host insert failure")
	failed := false
	const callbackName = "test:ssh_known_host_confirm_insert_failure"
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if failed || tx.Statement.Table != (model.SSHKnownHost{}).TableName() {
			return
		}
		failed = true
		tx.AddError(forcedErr)
	}))
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	_, err := service.ConfirmHostKey(challenge.ID)
	require.ErrorIs(t, err, forcedErr)
	knownHost, err := service.ConfirmHostKey(challenge.ID)
	require.NoError(t, err)
	require.Equal(t, challenge.Fingerprint, knownHost.Fingerprint)
	_, err = service.ConfirmHostKey(challenge.ID)
	require.ErrorIs(t, err, ErrChallengeNotFound)
}

func TestResetKnownHostInvalidatesConfirmWaitingOnProfileLock(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profileA := createPasswordProfile(t, service, server)
	profileB := createPasswordProfile(t, service, server)
	endpoint := profileEndpoint(profileA)
	challengeA := service.issueHostKeyChallenge(profileA.ID, endpoint, server.signer.PublicKey())
	challengeB := service.issueHostKeyChallenge(profileB.ID, endpoint, server.signer.PublicKey())
	_, err := service.ConfirmHostKey(challengeB.ID)
	require.NoError(t, err)

	profileLock := service.profileConnectLock(profileA.ID)
	profileLock.Lock()
	var releaseOnce sync.Once
	releaseProfileLock := func() { releaseOnce.Do(profileLock.Unlock) }
	t.Cleanup(releaseProfileLock)
	confirmDone := make(chan error, 1)
	go func() {
		_, confirmErr := service.ConfirmHostKey(challengeA.ID)
		confirmDone <- confirmErr
	}()
	require.Eventually(t, func() bool {
		service.mu.Lock()
		defer service.mu.Unlock()
		pending, ok := service.challenges[challengeA.ID]
		return ok && pending.confirming
	}, time.Second, time.Millisecond)

	removed, err := service.ResetKnownHost(profileB.ID, challengeB.Fingerprint)
	require.NoError(t, err)
	require.Equal(t, challengeB.Fingerprint, removed.Fingerprint)
	releaseProfileLock()
	require.ErrorIs(t, <-confirmDone, ErrChallengeNotFound)

	var count int64
	require.NoError(t, db.Model(&model.SSHKnownHost{}).Where("endpoint = ?", endpoint).Count(&count).Error)
	require.Zero(t, count)
}

func TestProfileMetadataUpdateKeepsConnection(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))

	name := "renamed SSH profile"
	updated, err := service.UpdateProfile(profile.ID, ProfilePatch{Name: &name})
	require.NoError(t, err)
	require.Equal(t, name, updated.Name)
	require.True(t, service.IsConnected(profile.ID))
	_, err = service.UpdateProfile(profile.ID, ProfilePatch{})
	require.NoError(t, err)
	require.True(t, service.IsConnected(profile.ID))

	connectTimeout := profile.ConnectTimeout + 1
	_, err = service.UpdateProfile(profile.ID, ProfilePatch{ConnectTimeout: &connectTimeout})
	require.NoError(t, err)
	require.True(t, service.IsConnected(profile.ID))
	authMethod := AuthMethodAgent
	_, err = service.UpdateProfile(profile.ID, ProfilePatch{AuthMethod: &authMethod})
	require.NoError(t, err)
	require.False(t, service.IsConnected(profile.ID))
}

func TestDeleteProfileSerializesConcurrentConnect(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")

	deleteEntered := make(chan struct{})
	releaseDelete := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseDelete) }) }
	t.Cleanup(release)
	const callbackName = "test:ssh_profile_delete_gate"
	require.NoError(t, db.Callback().Delete().Before("gorm:delete").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.SSHConnectionProfile{}).TableName() {
			return
		}
		close(deleteEntered)
		<-releaseDelete
	}))
	t.Cleanup(func() { _ = db.Callback().Delete().Remove(callbackName) })

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- service.DeleteProfile(profile.ID)
	}()
	select {
	case <-deleteEntered:
	case <-time.After(time.Second):
		t.Fatal("profile delete did not enter the database callback")
	}

	connectDone := make(chan error, 1)
	go func() {
		connectDone <- service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"})
	}()
	select {
	case err := <-connectDone:
		release()
		t.Fatalf("connect bypassed in-flight profile delete: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	release()
	require.NoError(t, <-deleteDone)
	require.ErrorIs(t, <-connectDone, ErrProfileNotFound)
	require.False(t, service.IsConnected(profile.ID))
}

func TestSessionCreationFailureDoesNotCloseSharedConnection(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))
	server.setPTYBehavior(2, 0, nil)

	first, err := service.CreateRuntime(context.Background(), terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       ".",
		Cols:      80,
		Rows:      24,
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = first.Close() })

	_, err = service.CreateRuntime(context.Background(), terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       ".",
		Cols:      80,
		Rows:      24,
	})
	require.Error(t, err)
	require.True(t, service.IsConnected(profile.ID))

	_, err = first.Write([]byte("still-alive\n"))
	require.NoError(t, err)
	readDone := make(chan string, 1)
	go func() {
		buffer := make([]byte, 256)
		n, _ := first.Read(buffer)
		readDone <- string(buffer[:n])
	}()
	select {
	case output := <-readDone:
		require.Contains(t, output, "remote:still-alive")
	case <-time.After(time.Second):
		t.Fatal("existing SSH runtime stopped responding after a second session failed")
	}
}

func TestRuntimeCreationReturnsWhenContextExpires(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))
	first, err := service.CreateRuntime(context.Background(), terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       ".",
		Cols:      80,
		Rows:      24,
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = first.Close() })
	server.setPTYBehavior(0, 2, make(chan struct{}))

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	startedAt := time.Now()
	_, err = service.CreateRuntime(ctx, terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       ".",
		Cols:      80,
		Rows:      24,
	})
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Less(t, time.Since(startedAt), time.Second)
	require.True(t, service.IsConnected(profile.ID))

	_, err = first.Write([]byte("survived-timeout\n"))
	require.NoError(t, err)
	readDone := make(chan string, 1)
	go func() {
		buffer := make([]byte, 256)
		n, _ := first.Read(buffer)
		readDone <- string(buffer[:n])
	}()
	select {
	case output := <-readDone:
		require.Contains(t, output, "remote:survived-timeout")
	case <-time.After(time.Second):
		t.Fatal("existing SSH runtime stopped responding after another session timed out")
	}

	thirdCtx, cancelThird := context.WithTimeout(context.Background(), time.Second)
	defer cancelThird()
	third, err := service.CreateRuntime(thirdCtx, terminal.RuntimeCreateRequest{
		Type:      terminal.RuntimeTypeSSH,
		ProfileID: profile.ID,
		Cwd:       ".",
		Cols:      80,
		Rows:      24,
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = third.Close() })
}

func TestServiceCloseCancelsInFlightConnect(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	authGate := make(chan struct{})
	server.setAuthGate(authGate)

	connectDone := make(chan error, 1)
	go func() {
		connectDone <- service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"})
	}()
	select {
	case <-server.authAttempts:
	case <-time.After(time.Second):
		close(authGate)
		t.Fatal("SSH server did not receive the authentication attempt")
	}

	closeDone := make(chan struct{})
	go func() {
		service.Close()
		close(closeDone)
	}()
	select {
	case <-closeDone:
	case <-time.After(time.Second):
		close(authGate)
		t.Fatal("Service.Close() did not cancel the in-flight connection")
	}
	close(authGate)
	require.ErrorIs(t, <-connectDone, ErrServiceClosed)
	require.False(t, service.IsConnected(profile.ID))
	require.ErrorIs(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}), ErrServiceClosed)
}

func TestServiceRejectsExpiredHostKeyChallenge(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)

	err := service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"})
	var challengeErr *HostKeyChallengeError
	require.ErrorAs(t, err, &challengeErr)
	service.now = func() time.Time {
		return time.Unix(challengeErr.Challenge.ExpiresAt, 0)
	}

	_, err = service.ConfirmHostKey(challengeErr.Challenge.ID)
	require.ErrorIs(t, err, ErrChallengeExpired)
	var count int64
	require.NoError(t, db.Model(&model.SSHKnownHost{}).Count(&count).Error)
	require.Zero(t, count)
}

func TestSSHRuntimeUsesExistingTerminalWebSocketProtocol(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))

	manager := terminal.NewManager(db, &terminal.ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: service,
	})
	info, err := manager.Create(terminal.CreateOptions{
		Name:         "SSH terminal",
		Cwd:          ".",
		Cols:         80,
		Rows:         24,
		RuntimeType:  terminal.RuntimeTypeSSH,
		SSHProfileID: profile.ID,
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = manager.Close(info.ID) })
	require.Equal(t, terminal.RuntimeTypeSSH, info.RuntimeType)
	require.Equal(t, profile.ID, info.SSHProfileID)
	require.True(t, info.Capabilities.Resume)
	require.True(t, info.Capabilities.Snapshot)
	require.False(t, info.Capabilities.Durable)

	httpServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		_, _ = manager.Attach(info.ID, connection)
	}))
	defer httpServer.Close()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	connection, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer connection.Close()

	foundState := false
	for !foundState {
		_, data, readErr := connection.ReadMessage()
		require.NoError(t, readErr)
		var message terminal.WSMessage
		require.NoError(t, json.Unmarshal(data, &message))
		if message.Type == terminal.MsgTypeState {
			require.Equal(t, terminal.RuntimeTypeSSH, message.RuntimeType)
			foundState = true
		}
	}

	input := terminal.WSMessage{Type: terminal.MsgTypeInput, Data: base64.StdEncoding.EncodeToString([]byte("ping\n"))}
	require.NoError(t, connection.WriteJSON(input))
	output := ""
	for !strings.Contains(output, "remote:ping") {
		_, data, readErr := connection.ReadMessage()
		require.NoError(t, readErr)
		var message terminal.WSMessage
		require.NoError(t, json.Unmarshal(data, &message))
		if message.Type == terminal.MsgTypeOutput {
			decoded, decodeErr := base64.StdEncoding.DecodeString(message.Data)
			require.NoError(t, decodeErr)
			output += string(decoded)
		}
	}

	require.NoError(t, connection.WriteJSON(terminal.WSMessage{Type: terminal.MsgTypeResize, Cols: 132, Rows: 43}))
	select {
	case size := <-server.resizes:
		require.Equal(t, [2]int{132, 43}, size)
	case <-time.After(3 * time.Second):
		t.Fatal("ssh server did not receive terminal resize")
	}
}

func TestServiceUsesRequestOnlyEncryptedPrivateKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	authorizedSigner, err := ssh.NewSignerFromKey(privateKey)
	require.NoError(t, err)
	server := newPublicKeyTestSSHServer(t, authorizedSigner.PublicKey())
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	host, port := server.HostPort(t)
	profile, err := service.CreateProfile(ProfileInput{
		Name:       "key host",
		Host:       host,
		Port:       port,
		User:       "tester",
		AuthMethod: AuthMethodPrivateKey,
	})
	require.NoError(t, err)

	const passphrase = "request-only-passphrase"
	privateKeyPEM, err := ssh.MarshalPrivateKeyWithPassphrase(privateKey, "test", []byte(passphrase))
	require.NoError(t, err)
	encodedPrivateKey := string(pem.EncodeToMemory(privateKeyPEM))
	auth := terminal.SSHAuthSecrets{
		PrivateKey: encodedPrivateKey,
		Passphrase: passphrase,
	}
	err = service.Connect(context.Background(), profile.ID, auth)
	var challengeErr *HostKeyChallengeError
	require.ErrorAs(t, err, &challengeErr)
	_, err = service.ConfirmHostKey(challengeErr.Challenge.ID)
	require.NoError(t, err)
	require.NoError(t, service.Connect(context.Background(), profile.ID, auth))
	require.True(t, service.IsConnected(profile.ID))

	var stored model.SSHConnectionProfile
	require.NoError(t, db.First(&stored, "id = ?", profile.ID).Error)
	serialized, err := json.Marshal(stored)
	require.NoError(t, err)
	require.NotContains(t, string(serialized), passphrase)
	require.NotContains(t, string(serialized), string(publicKey))
	require.NotContains(t, string(serialized), "OPENSSH PRIVATE KEY")
}

func TestNormalizeHostRejectsEmbeddedPort(t *testing.T) {
	_, err := normalizeHost("example.com:2222")
	require.Error(t, err)
	_, err = normalizeHost("[]")
	require.Error(t, err)

	host, err := normalizeHost("[2001:db8::1]")
	require.NoError(t, err)
	require.Equal(t, "2001:db8::1", host)
}
