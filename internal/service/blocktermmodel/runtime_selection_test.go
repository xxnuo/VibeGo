package blocktermmodel

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func modelRuntimeSelectionUpstream(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = w.Write([]byte("data: [DONE]\n\n"))
}

func TestCreateRunPersistsExplicitRuntimeSelection(t *testing.T) {
	service, db, _ := newModelTestService(t, modelRuntimeSelectionUpstream, 16)

	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "explicit-runtime-model", TerminalID: "terminal-1", Command: "/chat runtime",
		Prompt: "runtime", RuntimeType: "ssh", SSHProfileID: "child-profile",
	})
	require.NoError(t, err)
	require.Equal(t, "ssh", block.RuntimeType)
	require.Equal(t, "child-profile", block.SSHProfileID)

	var persisted model.BlockTermBlock
	require.NoError(t, db.First(&persisted, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", persisted.RuntimeType)
	require.Equal(t, "child-profile", persisted.SSHProfileID)
	var history model.BlockTermCommandHistory
	require.NoError(t, db.First(&history, "id = ?", block.ID).Error)
	require.Equal(t, "ssh", history.RuntimeType)
	require.Equal(t, "child-profile", history.SSHProfileID)

	_, err = service.CreateRun(context.Background(), RunInput{
		ID: "explicit-runtime-model", TerminalID: "terminal-1", Command: "/chat runtime",
		Prompt: "runtime", RuntimeType: "local",
	})
	require.ErrorIs(t, err, ErrRunConflict)
}

func TestCreateRunRuntimeSelectionFallsBackToSourceThenTerminal(t *testing.T) {
	service, db, _ := newModelTestService(t, modelRuntimeSelectionUpstream, 16)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "runtime-source", TerminalID: "terminal-1", LineNum: 1,
		Kind: "command", Command: "echo source", Status: "success", RuntimeType: "ssh",
		SSHProfileID: "source-profile", CreatedAt: 10, UpdatedAt: 10,
	}).Error)

	sourceBlock, err := service.CreateRun(context.Background(), RunInput{
		ID: "source-runtime-model", TerminalID: "terminal-1", Command: "/chat source",
		Prompt: "source", SourceBlockID: "runtime-source",
	})
	require.NoError(t, err)
	require.Equal(t, "ssh", sourceBlock.RuntimeType)
	require.Equal(t, "source-profile", sourceBlock.SSHProfileID)

	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").
		Updates(map[string]any{"runtime_type": "ssh", "ssh_profile_id": "terminal-profile"}).Error)
	terminalBlock, err := service.CreateRun(context.Background(), RunInput{
		ID: "terminal-runtime-model", TerminalID: "terminal-1", Command: "/chat terminal", Prompt: "terminal",
	})
	require.NoError(t, err)
	require.Equal(t, "ssh", terminalBlock.RuntimeType)
	require.Equal(t, "terminal-profile", terminalBlock.SSHProfileID)

	localBlock, err := service.CreateRun(context.Background(), RunInput{
		ID: "local-runtime-model", TerminalID: "terminal-1", Command: "/chat local",
		Prompt: "local", RuntimeType: "local",
	})
	require.NoError(t, err)
	require.Equal(t, "local", localBlock.RuntimeType)
	require.Empty(t, localBlock.SSHProfileID)
}

func TestCreateRunExplicitSSHDoesNotInheritProfileFromLocalSource(t *testing.T) {
	service, db, _ := newModelTestService(t, modelRuntimeSelectionUpstream, 16)
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-1").
		Updates(map[string]any{"runtime_type": "ssh", "ssh_profile_id": "terminal-profile"}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID: "local-runtime-source", TerminalID: "terminal-1", LineNum: 1,
		Kind: "command", Command: "echo local", Status: "success", RuntimeType: "local",
		SSHProfileID: "stale-local-profile", CreatedAt: 10, UpdatedAt: 10,
	}).Error)

	block, err := service.CreateRun(context.Background(), RunInput{
		ID: "explicit-ssh-local-source-model", TerminalID: "terminal-1", Command: "/chat source",
		Prompt: "source", SourceBlockID: "local-runtime-source", RuntimeType: "ssh",
	})
	require.NoError(t, err)
	require.Equal(t, "ssh", block.RuntimeType)
	require.Equal(t, "terminal-profile", block.SSHProfileID)
}

func TestCreateRunRejectsInvalidRuntimeSelection(t *testing.T) {
	service, _, _ := newModelTestService(t, modelRuntimeSelectionUpstream, 16)

	tests := []struct {
		name          string
		runtimeType   string
		sshProfileID  string
		wantErrorText string
	}{
		{name: "unknown runtime", runtimeType: "container", wantErrorText: "runtime_type must be local or ssh"},
		{name: "local profile", runtimeType: "local", sshProfileID: "profile", wantErrorText: "ssh_profile_id is only valid for ssh runtime"},
		{name: "ssh profile required", runtimeType: "ssh", wantErrorText: "ssh_profile_id is required for ssh runtime"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.CreateRun(context.Background(), RunInput{
				ID: "invalid-runtime-" + test.name, TerminalID: "terminal-1", Prompt: "invalid",
				RuntimeType: test.runtimeType, SSHProfileID: test.sshProfileID,
			})
			require.ErrorIs(t, err, ErrInvalidRunInput)
			require.ErrorContains(t, err, test.wantErrorText)
		})
	}
}
