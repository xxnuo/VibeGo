package sshconnection

import (
	"bytes"
	"context"
	"errors"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
)

func TestCompletionBufferBoundsBytesAndPartialLines(t *testing.T) {
	buffer := newCompletionBuffer(128, 2)
	n, err := buffer.Write([]byte("first"))
	require.NoError(t, err)
	require.Equal(t, 5, n)
	_, overflow := buffer.snapshot()
	require.False(t, overflow)

	_, err = buffer.Write([]byte("-continued\nsecond"))
	require.NoError(t, err)
	_, overflow = buffer.snapshot()
	require.False(t, overflow)

	_, err = buffer.Write([]byte("-continued\nthird"))
	require.NoError(t, err)
	output, overflow := buffer.snapshot()
	require.True(t, overflow)
	require.Equal(t, "first-continued\nsecond-continued\nthird", string(output))

	byteBound := newCompletionBuffer(4, 10)
	n, err = byteBound.Write([]byte("abcdef"))
	require.NoError(t, err)
	require.Equal(t, 6, n)
	output, overflow = byteBound.snapshot()
	require.Equal(t, []byte("abcd"), output)
	require.True(t, overflow)
}

func TestParseRemoteCompletionOutputFiltersMalformedValuesAndPrefersDirectories(t *testing.T) {
	output := bytes.Join([][]byte{
		[]byte("malformed"),
		[]byte("X\tunknown-tag"),
		[]byte("V\t"),
		[]byte("V\tfile"),
		[]byte("V\tdir"),
		[]byte("D\tdir"),
		[]byte("V\tcontrol\x01value"),
		append([]byte("V\tinvalid-"), 0xff),
		[]byte("D\tother"),
	}, []byte{'\n'})

	var result terminal.CompletionResult
	require.NotPanics(t, func() {
		result, _ = parseRemoteCompletionOutput(output, 10)
	})
	require.False(t, result.HasMore)
	require.Equal(t, []terminal.CompletionCandidate{
		{Value: "dir/", IsDirectory: true},
		{Value: "file"},
		{Value: "other/", IsDirectory: true},
	}, result.Candidates)
}

func TestParseRemoteCompletionOutputPreservesSourceHasMoreAfterOverlap(t *testing.T) {
	var output bytes.Buffer
	for index := 0; index < sshCompletionLimit+1; index++ {
		output.WriteString("D\toverlap\n")
	}
	output.WriteString("V\toverlap\n")
	result, err := parseRemoteCompletionOutput(output.Bytes(), sshCompletionLimit)
	require.NoError(t, err)
	require.True(t, result.HasMore)
	require.Equal(t, []terminal.CompletionCandidate{{Value: "overlap/", IsDirectory: true}}, result.Candidates)
}

func TestRemoteCompletionScriptRejectsNULAndQuotesNestedShells(t *testing.T) {
	for _, request := range []terminal.CompletionRequest{
		{Cwd: "bad\x00cwd", Prefix: "x", Kind: terminal.CompletionKindFile},
		{Cwd: ".", Prefix: "bad\x00prefix", Kind: terminal.CompletionKindFile},
	} {
		_, err := remoteCompletionScript(request, sshCompletionLimit+1)
		require.Error(t, err)
	}

	root := t.TempDir()
	cwd := filepath.Join(root, "cwd with ' quote")
	require.NoError(t, os.Mkdir(cwd, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(cwd, "target'file"), nil, 0o644))
	script, err := remoteCompletionScript(terminal.CompletionRequest{
		Cwd: cwd, Prefix: "target'", Kind: terminal.CompletionKindFile,
	}, sshCompletionLimit+1)
	require.NoError(t, err)
	command := remoteCompletionCommand(script)
	require.Contains(t, command, "bash -lc")
	require.Contains(t, command, "bash --noprofile --norc -c")
	cmd := osexec.Command("bash", "-c", command)
	output, err := cmd.Output()
	require.NoError(t, err)
	result, err := parseRemoteCompletionOutput(output, sshCompletionLimit)
	require.NoError(t, err)
	require.Contains(t, completionValues(result), "target'file")
}

func TestRemoteCompletionProtocolIgnoresProfileOutput(t *testing.T) {
	marker, err := newCompletionProtocolMarker()
	require.NoError(t, err)
	second, err := newCompletionProtocolMarker()
	require.NoError(t, err)
	require.NotEqual(t, marker, second)

	output := strings.Join([]string{
		"V\tprofile-injected",
		marker + "BEGIN",
		"V\tactual",
		marker + "END",
		"V\tafter-frame",
	}, "\n")
	payload, err := extractRemoteCompletionProtocol([]byte(output), marker)
	require.NoError(t, err)
	result, err := parseRemoteCompletionOutput(payload, sshCompletionLimit)
	require.NoError(t, err)
	require.Equal(t, []terminal.CompletionCandidate{{Value: "actual"}}, result.Candidates)
	_, err = extractRemoteCompletionProtocol([]byte("V\tmissing-markers\n"), marker)
	require.Error(t, err)
}

func TestRemoteCompletionCommandSuppressesBashEnvironmentInjection(t *testing.T) {
	envFile := filepath.Join(t.TempDir(), "bash-env.sh")
	require.NoError(t, os.WriteFile(envFile, []byte("printf 'V\\tfrom-bash-env\\n'\n"), 0o600))
	marker, err := newCompletionProtocolMarker()
	require.NoError(t, err)
	script, err := remoteCompletionScript(terminal.CompletionRequest{
		Cwd: ".", Prefix: "", Kind: terminal.CompletionKindFile,
	}, 2)
	require.NoError(t, err)
	command := remoteCompletionCommand(wrapRemoteCompletionProtocol(script, marker))
	cmd := osexec.Command("bash", "-c", command)
	cmd.Env = append(os.Environ(), "BASH_ENV="+envFile)
	output, err := cmd.Output()
	require.NoError(t, err)
	payload, err := extractRemoteCompletionProtocol(output, marker)
	require.NoError(t, err)
	require.NotContains(t, string(payload), "from-bash-env")
}

func TestParseRemoteCompletionOutputNormalizesDirectorySlashBeforeDeduplication(t *testing.T) {
	result, err := parseRemoteCompletionOutput([]byte("D\tdir/\nV\tdir\nD\tother\n"), 10)
	require.NoError(t, err)
	require.Equal(t, []terminal.CompletionCandidate{
		{Value: "dir/", IsDirectory: true},
		{Value: "other/", IsDirectory: true},
	}, result.Candidates)
}

func connectedCompletionClient(t *testing.T, server *testSSHServer) (*Service, *ssh.Client, string) {
	t.Helper()
	db := setupSSHServiceTestDB(t)
	service := New(db)
	t.Cleanup(service.Close)
	profile := createPasswordProfile(t, service, server)
	trustTestServer(t, service, profile.ID, "correct-password")
	require.NoError(t, service.Connect(context.Background(), profile.ID, terminal.SSHAuthSecrets{Password: "correct-password"}))
	client := service.getConnection(profile.ID)
	require.NotNil(t, client)
	return service, client, profile.ID
}

func TestRuntimeCompletionClosesLateSessionAfterTimeout(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	service, client, profileID := connectedCompletionClient(t, server)
	started := make(chan struct{})
	release := make(chan struct{})
	runtime := &Runtime{
		client:            client,
		closed:            make(chan struct{}),
		completionTimeout: 30 * time.Millisecond,
		newSession: func() (*ssh.Session, error) {
			close(started)
			<-release
			return client.NewSession()
		},
	}

	done := make(chan error, 1)
	go func() {
		_, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
			Cwd: ".", Prefix: "late", Kind: terminal.CompletionKindFile,
		})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("NewSession injection was not reached")
	}
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.DeadlineExceeded)
	case <-time.After(time.Second):
		t.Fatal("timed-out NewSession did not return promptly")
	}
	close(release)
	select {
	case <-server.sessionOpened:
	case <-time.After(time.Second):
		t.Fatal("late SSH session was not opened")
	}
	select {
	case <-server.sessionClosed:
	case <-time.After(time.Second):
		t.Fatal("late SSH session was not closed")
	}
	require.True(t, service.IsConnected(profileID))
}

func TestRuntimeCompletionKeepsTimedOutNewSessionWorkersBounded(t *testing.T) {
	started := make(chan struct{}, sshCompletionMaxConcurrent+2)
	finished := make(chan struct{}, sshCompletionMaxConcurrent+2)
	release := make(chan struct{})
	runtime := &Runtime{
		closed:            make(chan struct{}),
		completionTimeout: 150 * time.Millisecond,
		newSession: func() (*ssh.Session, error) {
			started <- struct{}{}
			<-release
			finished <- struct{}{}
			return nil, errors.New("blocked NewSession released")
		},
	}
	results := make(chan error, sshCompletionMaxConcurrent+2)
	request := terminal.CompletionRequest{Cwd: ".", Prefix: "bounded", Kind: terminal.CompletionKindFile}
	for index := 0; index < sshCompletionMaxConcurrent+1; index++ {
		go func() {
			_, err := runtime.Complete(context.Background(), request)
			results <- err
		}()
	}
	for index := 0; index < sshCompletionMaxConcurrent; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("expected bounded NewSession worker did not start")
		}
	}
	select {
	case <-started:
		t.Fatal("completion started more than the configured NewSession worker limit")
	case <-time.After(30 * time.Millisecond):
	}
	for index := 0; index < sshCompletionMaxConcurrent+1; index++ {
		select {
		case err := <-results:
			require.ErrorIs(t, err, context.DeadlineExceeded)
		case <-time.After(time.Second):
			t.Fatal("timed-out completion caller did not return")
		}
	}

	go func() {
		_, err := runtime.Complete(context.Background(), request)
		results <- err
	}()
	select {
	case <-started:
		t.Fatal("timed-out workers released their concurrency slots before NewSession returned")
	case err := <-results:
		require.ErrorIs(t, err, context.DeadlineExceeded)
	case <-time.After(time.Second):
		t.Fatal("queued completion did not observe its timeout")
	}

	close(release)
	for index := 0; index < sshCompletionMaxConcurrent; index++ {
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("blocked NewSession worker did not finish after release")
		}
	}
}

func TestOpenCompletionSessionClosesSessionReturnedWithError(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	_, client, _ := connectedCompletionClient(t, server)
	sentinel := errors.New("injected NewSession error")
	runtime := &Runtime{
		client: client,
		closed: make(chan struct{}),
		newSession: func() (*ssh.Session, error) {
			session, err := client.NewSession()
			if err != nil {
				return nil, err
			}
			return session, sentinel
		},
	}
	_, err := runtime.openCompletionSession(context.Background())
	require.ErrorIs(t, err, sentinel)
	select {
	case <-server.sessionOpened:
	case <-time.After(time.Second):
		t.Fatal("injected SSH session was not opened")
	}
	select {
	case <-server.sessionClosed:
	case <-time.After(time.Second):
		t.Fatal("session returned with an error was not closed")
	}
}

func TestRuntimeCompletionUsesInjectedTimeout(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	started := make(chan struct{})
	release := make(chan struct{})
	server.setExecHandler(func(_ string, channel ssh.Channel) {
		close(started)
		<-release
		_ = channel.Close()
	})
	service, runtime, profile := createConnectedTestRuntime(t, server, ".")
	runtime.completionTimeout = 30 * time.Millisecond

	startedAt := time.Now()
	_, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
		Cwd: ".", Prefix: "blocked", Kind: terminal.CompletionKindFile,
	})
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Less(t, time.Since(startedAt), time.Second)
	close(release)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed completion exec did not start")
	}
	require.True(t, service.IsConnected(profile.ID))
	_, err = runtime.Write([]byte("after-timeout\n"))
	require.NoError(t, err)
	require.True(t, strings.Contains(readRuntimeUntil(t, runtime, "remote:after-timeout"), "remote:after-timeout"))
}

func TestRuntimeCompletionTimeoutInterruptsBlockedStart(t *testing.T) {
	server := newTestSSHServer(t, "correct-password")
	server.setExecHandler(runTestSSHExec)
	service, runtime, profile := createConnectedTestRuntime(t, server, ".")
	replyGate := make(chan struct{})
	server.setExecReplyGate(replyGate)
	runtime.completionTimeout = 30 * time.Millisecond

	startedAt := time.Now()
	_, err := runtime.Complete(context.Background(), terminal.CompletionRequest{
		Cwd: ".", Prefix: "blocked-start", Kind: terminal.CompletionKindFile,
	})
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Less(t, time.Since(startedAt), time.Second)
	select {
	case <-server.execCommands:
	case <-time.After(time.Second):
		t.Fatal("SSH server did not receive the blocked exec request")
	}
	close(replyGate)
	require.Eventually(t, func() bool { return service.IsConnected(profile.ID) }, time.Second, time.Millisecond)
	_, err = runtime.Write([]byte("after-start-timeout\n"))
	require.NoError(t, err)
	require.Contains(t, readRuntimeUntil(t, runtime, "remote:after-start-timeout"), "remote:after-start-timeout")
}
