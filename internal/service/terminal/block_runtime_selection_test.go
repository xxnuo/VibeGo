package terminal

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

type blockRuntimeSSHSelectionTestRuntime struct {
	blockRuntimeLifecycleTestRuntime
}

func (*blockRuntimeSSHSelectionTestRuntime) Type() string { return RuntimeTypeSSH }

func TestCreateBlockRuntimeDefaultsToDurableBlockSelection(t *testing.T) {
	db := setupBlockRuntimeDurableDB(t)
	block := seedBlockRuntimeDurableRows(
		t,
		db,
		"selection-default-terminal",
		"selection-default-block",
		model.StatusRunning,
	)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Updates(map[string]any{
		"runtime_type":   RuntimeTypeSSH,
		"ssh_profile_id": "child-profile",
		"cwd":            "/child/cwd",
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	var request RuntimeCreateRequest
	var requestMu sync.Mutex
	manager.runtimeFactory = runtimeFactoryFunc(func(value RuntimeCreateRequest) (TerminalRuntime, error) {
		requestMu.Lock()
		request = value
		requestMu.Unlock()
		return &blockRuntimeSSHSelectionTestRuntime{}, nil
	})

	info, err := manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
		TerminalID: block.TerminalID,
		BlockID:    block.ID,
		BlockToken: blockRuntimeDurableTestToken,
	})
	require.NoError(t, err)
	require.Equal(t, RuntimeTypeSSH, info.RuntimeType)
	require.Equal(t, "child-profile", info.SSHProfileID)
	require.Equal(t, "/child/cwd", info.Cwd)

	requestMu.Lock()
	captured := request
	requestMu.Unlock()
	require.Equal(t, RuntimeTypeSSH, captured.Type)
	require.Equal(t, "child-profile", captured.ProfileID)
	require.Equal(t, "/child/cwd", captured.Cwd)
}

func TestCreateBlockRuntimeRejectsExplicitDurableSelectionMismatch(t *testing.T) {
	tests := []struct {
		name          string
		runtimeType   string
		sshProfileID  string
		wantErrorText string
	}{
		{
			name:          "runtime",
			runtimeType:   RuntimeTypeLocal,
			wantErrorText: "runtime type conflicts with durable block selection",
		},
		{
			name:          "profile",
			runtimeType:   RuntimeTypeSSH,
			sshProfileID:  "other-profile",
			wantErrorText: "ssh profile conflicts with durable block selection",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := setupBlockRuntimeDurableDB(t)
			block := seedBlockRuntimeDurableRows(
				t,
				db,
				"selection-mismatch-"+test.name+"-terminal",
				"selection-mismatch-"+test.name+"-block",
				model.StatusRunning,
			)
			require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Updates(map[string]any{
				"runtime_type":   RuntimeTypeSSH,
				"ssh_profile_id": "durable-profile",
			}).Error)

			manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
			var factoryCalls atomic.Int32
			manager.runtimeFactory = runtimeFactoryFunc(func(RuntimeCreateRequest) (TerminalRuntime, error) {
				factoryCalls.Add(1)
				return &blockRuntimeSSHSelectionTestRuntime{}, nil
			})

			_, err := manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
				TerminalID: block.TerminalID, BlockID: block.ID, BlockToken: blockRuntimeDurableTestToken,
				RuntimeType: test.runtimeType, SSHProfileID: test.sshProfileID,
			})
			require.ErrorIs(t, err, ErrBlockRuntimeInvalid)
			require.ErrorContains(t, err, test.wantErrorText)
			require.Zero(t, factoryCalls.Load())
		})
	}
}

func TestCreateBlockRuntimeKeepsLegacyBlankSelectionCompatible(t *testing.T) {
	db := setupBlockRuntimeDurableDB(t)
	block := seedBlockRuntimeDurableRows(
		t,
		db,
		"selection-legacy-terminal",
		"selection-legacy-block",
		model.StatusRunning,
	)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	var request RuntimeCreateRequest
	manager.runtimeFactory = runtimeFactoryFunc(func(value RuntimeCreateRequest) (TerminalRuntime, error) {
		request = value
		return &blockRuntimeSSHSelectionTestRuntime{}, nil
	})

	info, err := manager.CreateBlockRuntime(BlockRuntimeCreateOptions{
		TerminalID: block.TerminalID, BlockID: block.ID, BlockToken: blockRuntimeDurableTestToken,
		RuntimeType: RuntimeTypeSSH, SSHProfileID: "legacy-profile",
	})
	require.NoError(t, err)
	require.Equal(t, RuntimeTypeSSH, info.RuntimeType)
	require.Equal(t, "legacy-profile", info.SSHProfileID)
	require.Equal(t, RuntimeTypeSSH, request.Type)
	require.Equal(t, "legacy-profile", request.ProfileID)
}

func TestCreateBlockRuntimeLocalDurableSelectionDoesNotInheritParentSSHProfile(t *testing.T) {
	db := setupBlockRuntimeDurableDB(t)
	block := seedBlockRuntimeDurableRows(
		t,
		db,
		"selection-local-child-terminal",
		"selection-local-child-block",
		model.StatusRunning,
	)
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", block.TerminalID).Updates(map[string]any{
		"runtime_type": RuntimeTypeSSH, "ssh_profile_id": "parent-profile",
	}).Error)
	require.NoError(t, db.Model(&model.BlockTermBlock{}).Where("id = ?", block.ID).Updates(map[string]any{
		"runtime_type": RuntimeTypeLocal, "ssh_profile_id": "",
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	resolved, err := manager.blockRuntimeDefaults(BlockRuntimeCreateOptions{
		TerminalID: block.TerminalID, BlockID: block.ID, BlockToken: blockRuntimeDurableTestToken,
	})
	require.NoError(t, err)
	require.Equal(t, RuntimeTypeLocal, resolved.RuntimeType)
	require.Empty(t, resolved.SSHProfileID)
}

func TestRestartBlockTermPreservesDurableRuntimeSelection(t *testing.T) {
	fixture := newBlockTermRestartFixture(t, "success", false)
	require.NoError(t, fixture.db.Model(&model.BlockTermBlock{}).Where("id = ?", fixture.blockID).
		Updates(map[string]any{
			"runtime_type":   RuntimeTypeSSH,
			"ssh_profile_id": "restart-profile",
		}).Error)

	restarted, err := fixture.manager.RestartBlockTermBlock(
		fixture.blockID,
		blockTermRestartRequest(blockTermRestartTestToken),
	)
	require.NoError(t, err)
	require.Equal(t, RuntimeTypeSSH, restarted.RuntimeType)
	require.Equal(t, "restart-profile", restarted.SSHProfileID)

	var persisted model.BlockTermBlock
	require.NoError(t, fixture.db.First(&persisted, "id = ?", fixture.blockID).Error)
	require.Equal(t, RuntimeTypeSSH, persisted.RuntimeType)
	require.Equal(t, "restart-profile", persisted.SSHProfileID)
}
