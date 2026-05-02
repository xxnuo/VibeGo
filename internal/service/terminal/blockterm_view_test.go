package terminal

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func blockTermViewString(value string) *string { return &value }

func blockTermViewBool(value bool) *bool { return &value }

func seedBlockTermViewSession(t *testing.T, db *gorm.DB, id string) {
	t.Helper()
	require.NoError(t, db.Create(&model.TerminalSession{
		ID:     id,
		Name:   id,
		Status: model.StatusClosed,
	}).Error)
}

func seedBlockTermViewSSHProfile(t *testing.T, db *gorm.DB, id string) {
	t.Helper()
	require.NoError(t, db.Create(&model.SSHConnectionProfile{
		ID:             id,
		Name:           id,
		Host:           "127.0.0.1",
		Port:           22,
		User:           "test",
		AuthMethod:     "password",
		ConnectTimeout: 10,
		CreatedAt:      1,
		UpdatedAt:      1,
	}).Error)
}

func TestBlockTermViewDefaultsAndPatch(t *testing.T) {
	db := setupTestDB(t)
	seedBlockTermViewSession(t, db, "terminal-view")
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-view",
		TerminalID: "terminal-view",
		LineNum:    0,
		Status:     "success",
	}).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	state, err := manager.GetBlockTermView("terminal-view")
	require.NoError(t, err)
	require.False(t, state.Sidebar.Open)
	require.Equal(t, BlockTermSidebarDefaultWidth, state.Sidebar.Width)
	require.Nil(t, state.Sidebar.BlockID)

	state, err = manager.PatchBlockTermView("terminal-view", BlockTermSidebarPatch{
		Open:       blockTermViewBool(true),
		Width:      blockTermViewString(BlockTermSidebarFixedWidth),
		BlockIDSet: true,
		BlockID:    blockTermViewString("block-view"),
	})
	require.NoError(t, err)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, BlockTermSidebarFixedWidth, state.Sidebar.Width)
	require.Equal(t, "block-view", *state.Sidebar.BlockID)

	var persisted model.TerminalSession
	require.NoError(t, db.First(&persisted, "id = ?", "terminal-view").Error)
	var raw map[string]any
	require.NoError(t, json.Unmarshal([]byte(persisted.BlockTermViewJSON), &raw))
	require.Equal(t, true, raw["sidebar"].(map[string]any)["open"])
	require.Equal(t, "500px", raw["sidebar"].(map[string]any)["width"])
	require.Equal(t, "block-view", raw["sidebar"].(map[string]any)["block_id"])

	// An explicit nil owner is different from an omitted field and preserves
	// the selected width/open state.
	state, err = manager.PatchBlockTermView("terminal-view", BlockTermSidebarPatch{
		BlockIDSet: true,
		BlockID:    nil,
	})
	require.NoError(t, err)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, BlockTermSidebarFixedWidth, state.Sidebar.Width)
	require.Nil(t, state.Sidebar.BlockID)
}

func TestBlockTermViewNextConnectionPatchAndCwdFallback(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.SSHConnectionProfile{}))
	require.NoError(t, db.Create(&model.TerminalSession{
		ID:          "terminal-view-next",
		Name:        "terminal-view-next",
		Cwd:         " /terminal/cwd ",
		CurrentCwd:  " /terminal/current ",
		RuntimeType: RuntimeTypeLocal,
		Status:      model.StatusClosed,
	}).Error)
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-view-next",
		TerminalID: "terminal-view-next",
		LineNum:    0,
	}).Error)
	seedBlockTermViewSSHProfile(t, db, "profile-view-next")

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	state, err := manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		Open:       blockTermViewBool(true),
		Width:      blockTermViewString(BlockTermSidebarFixedWidth),
		BlockIDSet: true,
		BlockID:    blockTermViewString("block-view-next"),
	})
	require.NoError(t, err)
	require.Nil(t, state.NextConnection)

	state, err = manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		NextConnectionSet: true,
		NextConnection: &BlockTermConnectionState{
			RuntimeType: RuntimeTypeLocal,
			Cwd:         " /selected/local ",
		},
	})
	require.NoError(t, err)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, BlockTermSidebarFixedWidth, state.Sidebar.Width)
	require.Equal(t, "block-view-next", *state.Sidebar.BlockID)
	require.NotNil(t, state.NextConnection)
	require.Equal(t, RuntimeTypeLocal, state.NextConnection.RuntimeType)
	require.Nil(t, state.NextConnection.SSHProfileID)
	require.Equal(t, "/selected/local", state.NextConnection.Cwd)

	state, err = manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		Width: blockTermViewString("60%"),
	})
	require.NoError(t, err)
	require.Equal(t, "60%", state.Sidebar.Width)
	require.NotNil(t, state.NextConnection)
	require.Equal(t, "/selected/local", state.NextConnection.Cwd)

	profileID := " profile-view-next "
	state, err = manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		NextConnectionSet: true,
		NextConnection: &BlockTermConnectionState{
			RuntimeType:  " ssh ",
			SSHProfileID: &profileID,
			Cwd:          " ",
		},
	})
	require.NoError(t, err)
	require.NotNil(t, state.NextConnection)
	require.Equal(t, RuntimeTypeSSH, state.NextConnection.RuntimeType)
	require.Equal(t, "profile-view-next", *state.NextConnection.SSHProfileID)
	require.Equal(t, "/terminal/current", state.NextConnection.Cwd)

	require.NoError(t, db.Model(&model.TerminalSession{}).
		Where("id = ?", "terminal-view-next").
		Updates(map[string]any{"current_cwd": "", "cwd": " /terminal/fallback "}).Error)
	state, err = manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		NextConnectionSet: true,
		NextConnection: &BlockTermConnectionState{
			RuntimeType: RuntimeTypeLocal,
			Cwd:         "",
		},
	})
	require.NoError(t, err)
	require.Equal(t, "/terminal/fallback", state.NextConnection.Cwd)

	require.NoError(t, db.Model(&model.TerminalSession{}).
		Where("id = ?", "terminal-view-next").
		Updates(map[string]any{"current_cwd": "", "cwd": ""}).Error)
	leftoverProfileID := "profile-view-next"
	state, err = manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		NextConnectionSet: true,
		NextConnection: &BlockTermConnectionState{
			RuntimeType:  RuntimeTypeLocal,
			SSHProfileID: &leftoverProfileID,
		},
	})
	require.NoError(t, err)
	require.Nil(t, state.NextConnection.SSHProfileID)
	require.Equal(t, ".", state.NextConnection.Cwd)

	state, err = manager.PatchBlockTermView("terminal-view-next", BlockTermSidebarPatch{
		NextConnectionSet: true,
		NextConnection:    nil,
	})
	require.NoError(t, err)
	require.Nil(t, state.NextConnection)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, "60%", state.Sidebar.Width)
	require.Equal(t, "block-view-next", *state.Sidebar.BlockID)
}

func TestBlockTermViewRejectsInvalidNextConnectionWithoutMutation(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.SSHConnectionProfile{}))
	seedBlockTermViewSession(t, db, "terminal-view-next-invalid")
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	_, err := manager.PatchBlockTermView("terminal-view-next-invalid", BlockTermSidebarPatch{
		NextConnectionSet: true,
		NextConnection: &BlockTermConnectionState{
			RuntimeType: RuntimeTypeLocal,
			Cwd:         "/saved/cwd",
		},
	})
	require.NoError(t, err)

	var persisted model.TerminalSession
	require.NoError(t, db.First(&persisted, "id = ?", "terminal-view-next-invalid").Error)
	expectedJSON := persisted.BlockTermViewJSON
	missingProfileID := "missing-profile"
	tests := []struct {
		name       string
		connection BlockTermConnectionState
		target     error
	}{
		{name: "invalid runtime", connection: BlockTermConnectionState{RuntimeType: "container"}, target: ErrBlockTermViewInvalid},
		{name: "ssh missing profile", connection: BlockTermConnectionState{RuntimeType: RuntimeTypeSSH}, target: ErrBlockTermViewInvalid},
		{name: "ssh unknown profile", connection: BlockTermConnectionState{RuntimeType: RuntimeTypeSSH, SSHProfileID: &missingProfileID}, target: ErrBlockTermViewSSHProfile},
		{name: "nul cwd", connection: BlockTermConnectionState{RuntimeType: RuntimeTypeLocal, Cwd: "/bad\x00cwd"}, target: ErrBlockTermViewInvalid},
		{name: "oversized cwd", connection: BlockTermConnectionState{RuntimeType: RuntimeTypeLocal, Cwd: strings.Repeat("x", 4097)}, target: ErrBlockTermViewInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := manager.PatchBlockTermView("terminal-view-next-invalid", BlockTermSidebarPatch{
				NextConnectionSet: true,
				NextConnection:    &test.connection,
			})
			require.ErrorIs(t, err, test.target)
			require.NoError(t, db.First(&persisted, "id = ?", "terminal-view-next-invalid").Error)
			require.Equal(t, expectedJSON, persisted.BlockTermViewJSON)
		})
	}
}

func TestBlockTermViewGetClearsDeletedSSHProfile(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.SSHConnectionProfile{}))
	seedBlockTermViewSession(t, db, "terminal-view-next-stale")
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-view-next-stale",
		TerminalID: "terminal-view-next-stale",
		LineNum:    0,
	}).Error)
	seedBlockTermViewSSHProfile(t, db, "profile-view-next-stale")
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	profileID := "profile-view-next-stale"
	state, err := manager.PatchBlockTermView("terminal-view-next-stale", BlockTermSidebarPatch{
		Open:              blockTermViewBool(true),
		Width:             blockTermViewString(BlockTermSidebarFixedWidth),
		BlockIDSet:        true,
		BlockID:           blockTermViewString("block-view-next-stale"),
		NextConnectionSet: true,
		NextConnection: &BlockTermConnectionState{
			RuntimeType:  RuntimeTypeSSH,
			SSHProfileID: &profileID,
			Cwd:          "/remote/cwd",
		},
	})
	require.NoError(t, err)
	require.NotNil(t, state.NextConnection)
	require.NoError(t, db.Delete(&model.SSHConnectionProfile{}, "id = ?", profileID).Error)

	state, err = manager.GetBlockTermView("terminal-view-next-stale")
	require.NoError(t, err)
	require.Nil(t, state.NextConnection)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, BlockTermSidebarFixedWidth, state.Sidebar.Width)
	require.Equal(t, "block-view-next-stale", *state.Sidebar.BlockID)

	var persisted model.TerminalSession
	require.NoError(t, db.First(&persisted, "id = ?", "terminal-view-next-stale").Error)
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(persisted.BlockTermViewJSON), &raw))
	_, exists := raw["next_connection"]
	require.False(t, exists)
}

func TestBlockTermViewGetPreservesUnknownPersistedFields(t *testing.T) {
	db := setupTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.SSHConnectionProfile{}))
	seedBlockTermViewSession(t, db, "terminal-view-forward-compatible")
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-view-forward-compatible",
		TerminalID: "terminal-view-forward-compatible",
		LineNum:    0,
	}).Error)
	seedBlockTermViewSSHProfile(t, db, "profile-view-forward-compatible")

	const storedView = `{"sidebar":{"open":true,"width":"500px","block_id":"block-view-forward-compatible","future_sidebar":{"mode":"wide"}},"next_connection":{"runtime_type":"ssh","ssh_profile_id":"profile-view-forward-compatible","cwd":"/remote/cwd","future_connection":true},"future_root":{"version":2}}`
	require.NoError(t, db.Model(&model.TerminalSession{}).
		Where("id = ?", "terminal-view-forward-compatible").
		Update("blockterm_view_json", storedView).Error)

	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	state, err := manager.GetBlockTermView("terminal-view-forward-compatible")
	require.NoError(t, err)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, BlockTermSidebarFixedWidth, state.Sidebar.Width)
	require.Equal(t, "block-view-forward-compatible", *state.Sidebar.BlockID)
	require.NotNil(t, state.NextConnection)
	require.Equal(t, RuntimeTypeSSH, state.NextConnection.RuntimeType)
	require.Equal(t, "profile-view-forward-compatible", *state.NextConnection.SSHProfileID)
	require.Equal(t, "/remote/cwd", state.NextConnection.Cwd)
	responseJSON, err := json.Marshal(state)
	require.NoError(t, err)
	require.NotContains(t, string(responseJSON), "future_")

	var persisted model.TerminalSession
	require.NoError(t, db.First(&persisted, "id = ?", "terminal-view-forward-compatible").Error)
	require.Equal(t, storedView, persisted.BlockTermViewJSON)
}

func TestBlockTermViewRejectsInvalidWidthAndOwnerScope(t *testing.T) {
	db := setupTestDB(t)
	seedBlockTermViewSession(t, db, "terminal-view-a")
	seedBlockTermViewSession(t, db, "terminal-view-b")
	require.NoError(t, db.Create([]model.BlockTermBlock{
		{ID: "block-view-a", TerminalID: "terminal-view-a", LineNum: 0},
		{ID: "block-view-b", TerminalID: "terminal-view-b", LineNum: 0},
		{ID: "block-view-archived", TerminalID: "terminal-view-a", LineNum: 1, Archived: true},
	}).Error)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})

	for _, width := range []string{"9%", "91%", "199px", "4001px", "100%", "bad"} {
		_, err := manager.PatchBlockTermView("terminal-view-a", BlockTermSidebarPatch{
			Width: blockTermViewString(width),
		})
		require.Error(t, err, width)
		require.True(t, errors.Is(err, ErrBlockTermViewInvalid), width)
	}
	for _, width := range []string{"10%", "90%", "200px", "4000px"} {
		_, err := manager.PatchBlockTermView("terminal-view-a", BlockTermSidebarPatch{
			Width: blockTermViewString(width),
		})
		require.NoError(t, err, width)
	}

	_, err := manager.PatchBlockTermView("terminal-view-a", BlockTermSidebarPatch{
		BlockIDSet: true,
		BlockID:    blockTermViewString("block-view-b"),
	})
	require.ErrorIs(t, err, ErrBlockTermViewBlockScope)

	_, err = manager.PatchBlockTermView("terminal-view-a", BlockTermSidebarPatch{
		BlockIDSet: true,
		BlockID:    blockTermViewString("block-view-archived"),
	})
	require.ErrorIs(t, err, ErrBlockTermViewBlockArchived)

	_, err = manager.PatchBlockTermView("terminal-view-a", BlockTermSidebarPatch{
		BlockIDSet: true,
		BlockID:    blockTermViewString("missing-block"),
	})
	require.ErrorIs(t, err, ErrBlockTermViewBlockNotFound)
}

func TestBlockTermViewGetLegalizesStaleOwner(t *testing.T) {
	db := setupTestDB(t)
	seedBlockTermViewSession(t, db, "terminal-view-stale")
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	_, err := manager.PatchBlockTermView("terminal-view-stale", BlockTermSidebarPatch{
		Open:       blockTermViewBool(true),
		BlockIDSet: true,
		BlockID:    nil,
	})
	require.NoError(t, err)
	// Install a stale owner directly to model a block deleted by an older
	// client. GET should close and clear it instead of returning a dangling id.
	state := BlockTermViewState{Sidebar: BlockTermSidebarState{
		Open:    true,
		Width:   BlockTermSidebarFixedWidth,
		BlockID: blockTermViewString("deleted-block"),
	}}
	encoded, err := canonicalBlockTermViewJSON(state)
	require.NoError(t, err)
	require.NoError(t, db.Model(&model.TerminalSession{}).Where("id = ?", "terminal-view-stale").Update("blockterm_view_json", encoded).Error)

	got, err := manager.GetBlockTermView("terminal-view-stale")
	require.NoError(t, err)
	require.False(t, got.Sidebar.Open)
	require.Equal(t, BlockTermSidebarFixedWidth, got.Sidebar.Width)
	require.Nil(t, got.Sidebar.BlockID)

	var persisted model.TerminalSession
	require.NoError(t, db.First(&persisted, "id = ?", "terminal-view-stale").Error)
	require.NotContains(t, persisted.BlockTermViewJSON, "deleted-block")
}

func TestClearBlockTermViewForBlockIsTransactional(t *testing.T) {
	db := setupTestDB(t)
	seedBlockTermViewSession(t, db, "terminal-view-cleanup")
	require.NoError(t, db.Create(&model.BlockTermBlock{
		ID:         "block-cleanup",
		TerminalID: "terminal-view-cleanup",
		LineNum:    0,
	}).Error)
	manager := NewManager(db, &ManagerConfig{Shell: "/bin/sh"})
	_, err := manager.PatchBlockTermView("terminal-view-cleanup", BlockTermSidebarPatch{
		Open:       blockTermViewBool(true),
		Width:      blockTermViewString(BlockTermSidebarFixedWidth),
		BlockIDSet: true,
		BlockID:    blockTermViewString("block-cleanup"),
	})
	require.NoError(t, err)

	// A rolled-back archive/delete transaction must leave the owner intact.
	require.Error(t, db.Transaction(func(tx *gorm.DB) error {
		if err := ClearBlockTermViewForBlock(tx, "terminal-view-cleanup", "block-cleanup"); err != nil {
			return err
		}
		return errors.New("rollback cleanup")
	}))
	state, err := manager.GetBlockTermView("terminal-view-cleanup")
	require.NoError(t, err)
	require.True(t, state.Sidebar.Open)
	require.Equal(t, "block-cleanup", *state.Sidebar.BlockID)

	require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.BlockTermBlock{}).Where("id = ?", "block-cleanup").Update("archived", true).Error; err != nil {
			return err
		}
		return ClearBlockTermViewForBlock(tx, "terminal-view-cleanup", "block-cleanup")
	}))
	state, err = manager.GetBlockTermView("terminal-view-cleanup")
	require.NoError(t, err)
	require.False(t, state.Sidebar.Open)
	require.Nil(t, state.Sidebar.BlockID)
}
