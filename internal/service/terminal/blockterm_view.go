package terminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

// BlockTerm sidebar state is scoped to a terminal session. Keep the defaults
// here (rather than in the HTTP handler) so websocket/desktop callers and the
// cleanup path share exactly the same canonical representation.
const (
	BlockTermSidebarDefaultWidth    = "50%"
	BlockTermSidebarFixedWidth      = "500px"
	BlockTermSidebarMinPaneWidth    = 200
	BlockTermSidebarMaxPixelWidth   = 4000
	BlockTermSidebarMaxBlockIDBytes = 256
)

var blockTermSidebarWidthPattern = regexp.MustCompile(`^([1-9][0-9]{0,3})(px|%)$`)

var (
	ErrBlockTermViewInvalid       = errors.New("invalid BlockTerm view state")
	ErrBlockTermViewBlockNotFound = errors.New("BlockTerm sidebar block not found")
	ErrBlockTermViewBlockScope    = errors.New("BlockTerm sidebar block belongs to another terminal")
	ErrBlockTermViewBlockArchived = errors.New("BlockTerm sidebar block is archived")
	ErrBlockTermViewStateCorrupt  = errors.New("stored BlockTerm view state is invalid")
	ErrBlockTermViewSSHProfile    = errors.New("BlockTerm next connection SSH profile not found")
)

// BlockTermSidebarState is the canonical wire/storage representation. A nil
// BlockID is encoded as JSON null and is deliberately different from an
// omitted PATCH field.
type BlockTermSidebarState struct {
	Open    bool    `json:"open"`
	Width   string  `json:"width"`
	BlockID *string `json:"block_id"`
}

// BlockTermConnectionState is the durable selection used by the next command
// block. An explicitly supplied cwd belongs to the selected connection; an
// empty cwd is filled from the owning terminal session by the service.
type BlockTermConnectionState struct {
	RuntimeType  string  `json:"runtime_type"`
	SSHProfileID *string `json:"ssh_profile_id,omitempty"`
	Cwd          string  `json:"cwd,omitempty"`
}

type BlockTermViewState struct {
	Sidebar        BlockTermSidebarState     `json:"sidebar"`
	NextConnection *BlockTermConnectionState `json:"next_connection,omitempty"`
}

// BlockTermSidebarPatch carries presence information for nullable block_id.
// Open and Width use nil to mean "leave unchanged".
type BlockTermSidebarPatch struct {
	Open       *bool
	Width      *string
	BlockIDSet bool
	BlockID    *string
	// NextConnectionSet distinguishes an omitted field from an explicit null.
	// A non-nil value is normalized against the owning terminal session.
	NextConnectionSet bool
	NextConnection    *BlockTermConnectionState
}

func DefaultBlockTermViewState() BlockTermViewState {
	return BlockTermViewState{Sidebar: BlockTermSidebarState{Width: BlockTermSidebarDefaultWidth}}
}

func canonicalBlockTermViewJSON(state BlockTermViewState) (string, error) {
	if err := validateBlockTermViewState(state); err != nil {
		return "", err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return "", fmt.Errorf("marshal BlockTerm view state: %w", err)
	}
	return string(data), nil
}

func validateBlockTermViewState(state BlockTermViewState) error {
	if err := validateBlockTermSidebarWidth(state.Sidebar.Width); err != nil {
		return err
	}
	if state.Sidebar.BlockID != nil {
		if err := validateBlockTermSidebarBlockID(*state.Sidebar.BlockID); err != nil {
			return err
		}
	}
	if state.NextConnection != nil {
		if err := validateBlockTermConnectionState(*state.NextConnection); err != nil {
			return err
		}
	}
	return nil
}

func validateBlockTermConnectionState(state BlockTermConnectionState) error {
	switch strings.TrimSpace(state.RuntimeType) {
	case RuntimeTypeLocal:
		if state.SSHProfileID != nil && strings.TrimSpace(*state.SSHProfileID) != "" {
			return fmt.Errorf("next_connection ssh_profile_id is only valid for ssh runtime")
		}
	case RuntimeTypeSSH:
		if state.SSHProfileID == nil || strings.TrimSpace(*state.SSHProfileID) == "" {
			return fmt.Errorf("next_connection ssh_profile_id is required for ssh runtime")
		}
	default:
		return fmt.Errorf("next_connection runtime_type must be local or ssh")
	}
	if len([]byte(state.Cwd)) > 4096 || strings.IndexByte(state.Cwd, 0) >= 0 {
		return fmt.Errorf("next_connection cwd is invalid")
	}
	return nil
}

func normalizeBlockTermConnectionState(tx *gorm.DB, state *BlockTermConnectionState, session model.TerminalSession) error {
	if state == nil {
		return nil
	}
	state.RuntimeType = strings.TrimSpace(state.RuntimeType)
	state.Cwd = strings.TrimSpace(state.Cwd)
	if state.Cwd == "" {
		state.Cwd = strings.TrimSpace(session.CurrentCwd)
		if state.Cwd == "" {
			state.Cwd = strings.TrimSpace(session.Cwd)
		}
		if state.Cwd == "" {
			state.Cwd = "."
		}
	}
	if state.RuntimeType == RuntimeTypeLocal {
		state.SSHProfileID = nil
	} else if state.RuntimeType == RuntimeTypeSSH {
		if state.SSHProfileID == nil {
			return fmt.Errorf("%w: ssh_profile_id is required", ErrBlockTermViewInvalid)
		}
		profileID := strings.TrimSpace(*state.SSHProfileID)
		if profileID == "" {
			return fmt.Errorf("%w: ssh_profile_id is required", ErrBlockTermViewInvalid)
		}
		state.SSHProfileID = &profileID
		if tx == nil || !tx.Migrator().HasTable(&model.SSHConnectionProfile{}) {
			return ErrBlockTermViewSSHProfile
		}
		var count int64
		if err := tx.Model(&model.SSHConnectionProfile{}).Where("id = ?", profileID).Count(&count).Error; err != nil {
			return err
		}
		if count != 1 {
			return ErrBlockTermViewSSHProfile
		}
	}
	if err := validateBlockTermConnectionState(*state); err != nil {
		return fmt.Errorf("%w: %v", ErrBlockTermViewInvalid, err)
	}
	return nil
}

func blockTermConnectionStateEqual(left, right BlockTermConnectionState) bool {
	if left.RuntimeType != right.RuntimeType || left.Cwd != right.Cwd {
		return false
	}
	if left.SSHProfileID == nil || right.SSHProfileID == nil {
		return left.SSHProfileID == nil && right.SSHProfileID == nil
	}
	return *left.SSHProfileID == *right.SSHProfileID
}

func validateBlockTermSidebarWidth(width string) error {
	if width == "" {
		return fmt.Errorf("width is required")
	}
	matches := blockTermSidebarWidthPattern.FindStringSubmatch(width)
	if len(matches) != 3 {
		return fmt.Errorf("width must be a bounded px or percent value")
	}
	n, err := strconv.Atoi(matches[1])
	if err != nil {
		return fmt.Errorf("width must be a bounded px or percent value")
	}
	if matches[2] == "%" {
		if n < 10 || n > 90 {
			return fmt.Errorf("width percentage must be between 10%% and 90%%")
		}
		return nil
	}
	if n < BlockTermSidebarMinPaneWidth || n > BlockTermSidebarMaxPixelWidth {
		return fmt.Errorf("width in pixels must be between %dpx and %dpx", BlockTermSidebarMinPaneWidth, BlockTermSidebarMaxPixelWidth)
	}
	return nil
}

func validateBlockTermSidebarBlockID(blockID string) error {
	if blockID == "" {
		return fmt.Errorf("block_id must be null or a non-empty string")
	}
	if strings.IndexByte(blockID, 0) >= 0 {
		return fmt.Errorf("block_id contains an invalid NUL byte")
	}
	if len([]byte(blockID)) > BlockTermSidebarMaxBlockIDBytes {
		return fmt.Errorf("block_id is too long")
	}
	return nil
}

// parseBlockTermViewJSON accepts an empty column as the initial/default state,
// but rejects malformed persisted JSON instead of silently discarding user
// state. Unknown fields are ignored for forward compatibility and the result
// is always returned in canonical form.
func parseBlockTermViewJSON(raw string) (BlockTermViewState, error) {
	state := DefaultBlockTermViewState()
	if strings.TrimSpace(raw) == "" {
		return state, nil
	}

	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &root); err != nil || root == nil {
		return state, fmt.Errorf("%w: expected a JSON object", ErrBlockTermViewStateCorrupt)
	}
	sidebarRaw, ok := root["sidebar"]
	if ok {
		if bytes.Equal(bytes.TrimSpace(sidebarRaw), []byte("null")) {
			return state, fmt.Errorf("%w: sidebar must be an object", ErrBlockTermViewStateCorrupt)
		}
		var sidebar map[string]json.RawMessage
		if err := json.Unmarshal(sidebarRaw, &sidebar); err != nil || sidebar == nil {
			return state, fmt.Errorf("%w: sidebar must be an object", ErrBlockTermViewStateCorrupt)
		}
		for key, value := range sidebar {
			switch key {
			case "open":
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return state, fmt.Errorf("%w: sidebar.open must be a boolean", ErrBlockTermViewStateCorrupt)
				}
				if err := json.Unmarshal(value, &state.Sidebar.Open); err != nil {
					return state, fmt.Errorf("%w: sidebar.open must be a boolean", ErrBlockTermViewStateCorrupt)
				}
			case "width":
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return state, fmt.Errorf("%w: sidebar.width must be a string", ErrBlockTermViewStateCorrupt)
				}
				if err := json.Unmarshal(value, &state.Sidebar.Width); err != nil {
					return state, fmt.Errorf("%w: sidebar.width must be a string", ErrBlockTermViewStateCorrupt)
				}
			case "block_id", "blockId", "sidebarlineid":
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					state.Sidebar.BlockID = nil
					continue
				}
				var blockID string
				if err := json.Unmarshal(value, &blockID); err != nil {
					return state, fmt.Errorf("%w: sidebar.block_id must be a string or null", ErrBlockTermViewStateCorrupt)
				}
				state.Sidebar.BlockID = &blockID
			}
		}
	}
	if nextRaw, ok := root["next_connection"]; ok {
		if bytes.Equal(bytes.TrimSpace(nextRaw), []byte("null")) {
			state.NextConnection = nil
		} else {
			var next map[string]json.RawMessage
			if err := json.Unmarshal(nextRaw, &next); err != nil || next == nil {
				return state, fmt.Errorf("%w: next_connection must be an object or null", ErrBlockTermViewStateCorrupt)
			}
			var connection BlockTermConnectionState
			if rawValue, exists := next["runtime_type"]; exists {
				if err := json.Unmarshal(rawValue, &connection.RuntimeType); err != nil {
					return state, fmt.Errorf("%w: next_connection.runtime_type must be a string", ErrBlockTermViewStateCorrupt)
				}
			}
			if rawValue, exists := next["ssh_profile_id"]; exists {
				if bytes.Equal(bytes.TrimSpace(rawValue), []byte("null")) {
					connection.SSHProfileID = nil
				} else {
					var profileID string
					if err := json.Unmarshal(rawValue, &profileID); err != nil {
						return state, fmt.Errorf("%w: next_connection.ssh_profile_id must be a string or null", ErrBlockTermViewStateCorrupt)
					}
					connection.SSHProfileID = &profileID
				}
			}
			if rawValue, exists := next["cwd"]; exists {
				if err := json.Unmarshal(rawValue, &connection.Cwd); err != nil {
					return state, fmt.Errorf("%w: next_connection.cwd must be a string", ErrBlockTermViewStateCorrupt)
				}
			}
			state.NextConnection = &connection
		}
	}
	if err := validateBlockTermViewState(state); err != nil {
		return DefaultBlockTermViewState(), fmt.Errorf("%w: %v", ErrBlockTermViewStateCorrupt, err)
	}
	return state, nil
}

func applyBlockTermSidebarPatch(state BlockTermViewState, patch BlockTermSidebarPatch) (BlockTermViewState, error) {
	if patch.Open != nil {
		state.Sidebar.Open = *patch.Open
	}
	if patch.Width != nil {
		state.Sidebar.Width = *patch.Width
	}
	if patch.BlockIDSet {
		state.Sidebar.BlockID = patch.BlockID
	}
	if patch.NextConnectionSet {
		state.NextConnection = patch.NextConnection
	}
	if err := validateBlockTermViewState(state); err != nil {
		return state, fmt.Errorf("%w: %v", ErrBlockTermViewInvalid, err)
	}
	return state, nil
}

func (m *Manager) loadBlockTermView(tx *gorm.DB, terminalID string) (BlockTermViewState, model.TerminalSession, error) {
	var session model.TerminalSession
	if err := tx.Where("id = ?", terminalID).First(&session).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return BlockTermViewState{}, session, ErrTerminalNotFound
		}
		return BlockTermViewState{}, session, err
	}
	state, err := parseBlockTermViewJSON(session.BlockTermViewJSON)
	if err != nil {
		if errors.Is(err, ErrBlockTermViewStateCorrupt) {
			return DefaultBlockTermViewState(), session, nil
		}
		return BlockTermViewState{}, session, err
	}
	return state, session, nil
}

func validateBlockTermSidebarOwner(tx *gorm.DB, terminalID string, blockID *string) error {
	if blockID == nil {
		return nil
	}
	if !tx.Migrator().HasTable(&model.BlockTermBlock{}) {
		return ErrBlockTermViewBlockNotFound
	}
	var block model.BlockTermBlock
	if err := tx.Where("id = ?", *blockID).First(&block).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrBlockTermViewBlockNotFound
		}
		return err
	}
	if block.TerminalID != terminalID {
		return ErrBlockTermViewBlockScope
	}
	if block.Archived {
		return ErrBlockTermViewBlockArchived
	}
	return nil
}

// GetBlockTermView returns the terminal-scoped view state. A stale owner (for
// example, a block removed by an older client) is legalized to a closed,
// ownerless sidebar in the same transaction before it is returned.
func (m *Manager) GetBlockTermView(terminalID string) (BlockTermViewState, error) {
	terminalID = strings.TrimSpace(terminalID)
	if terminalID == "" {
		return BlockTermViewState{}, fmt.Errorf("%w: terminal_id is required", ErrBlockTermViewInvalid)
	}
	var state BlockTermViewState
	err := m.WithTerminalLifecycle(func() error {
		return m.withWorkspaceMutation(func() error {
			return m.db.Transaction(func(tx *gorm.DB) error {
				loaded, session, err := m.loadBlockTermView(tx, terminalID)
				if err != nil {
					return err
				}
				viewChanged := false
				if loaded.NextConnection != nil {
					originalConnection := *loaded.NextConnection
					if normalizeErr := normalizeBlockTermConnectionState(tx, loaded.NextConnection, session); normalizeErr != nil {
						if errors.Is(normalizeErr, ErrBlockTermViewSSHProfile) ||
							errors.Is(normalizeErr, ErrBlockTermViewInvalid) {
							loaded.NextConnection = nil
							viewChanged = true
						} else {
							return normalizeErr
						}
					} else if !blockTermConnectionStateEqual(originalConnection, *loaded.NextConnection) {
						viewChanged = true
					}
				}
				if loaded.Sidebar.BlockID != nil {
					ownerErr := validateBlockTermSidebarOwner(tx, terminalID, loaded.Sidebar.BlockID)
					if errors.Is(ownerErr, ErrBlockTermViewBlockNotFound) ||
						errors.Is(ownerErr, ErrBlockTermViewBlockScope) ||
						errors.Is(ownerErr, ErrBlockTermViewBlockArchived) {
						loaded.Sidebar.Open = false
						loaded.Sidebar.BlockID = nil
						viewChanged = true
					} else if ownerErr != nil {
						return ownerErr
					}
				}
				if viewChanged {
					encoded, encodeErr := canonicalBlockTermViewJSON(loaded)
					if encodeErr != nil {
						return encodeErr
					}
					if err := tx.Model(&model.TerminalSession{}).
						Where("id = ?", terminalID).
						Update("blockterm_view_json", encoded).Error; err != nil {
						return err
					}
				}
				state = loaded
				return nil
			})
		})
	})
	return state, err
}

// PatchBlockTermView atomically validates terminal ownership, block ownership,
// and the new JSON value before replacing the canonical terminal view.
func (m *Manager) PatchBlockTermView(terminalID string, patch BlockTermSidebarPatch) (BlockTermViewState, error) {
	terminalID = strings.TrimSpace(terminalID)
	if terminalID == "" {
		return BlockTermViewState{}, fmt.Errorf("%w: terminal_id is required", ErrBlockTermViewInvalid)
	}
	var state BlockTermViewState
	err := m.WithTerminalLifecycle(func() error {
		return m.withWorkspaceMutation(func() error {
			return m.db.Transaction(func(tx *gorm.DB) error {
				current, session, err := m.loadBlockTermView(tx, terminalID)
				if err != nil {
					return err
				}
				if patch.NextConnectionSet && patch.NextConnection != nil {
					if err := normalizeBlockTermConnectionState(tx, patch.NextConnection, session); err != nil {
						return err
					}
				}
				next, err := applyBlockTermSidebarPatch(current, patch)
				if err != nil {
					return err
				}
				if !patch.NextConnectionSet && next.NextConnection != nil {
					if err := normalizeBlockTermConnectionState(tx, next.NextConnection, session); err != nil {
						return err
					}
				}
				if err := validateBlockTermSidebarOwner(tx, terminalID, next.Sidebar.BlockID); err != nil {
					return err
				}
				encoded, err := canonicalBlockTermViewJSON(next)
				if err != nil {
					return err
				}
				result := tx.Model(&model.TerminalSession{}).
					Where("id = ?", terminalID).
					Update("blockterm_view_json", encoded)
				if result.Error != nil {
					return result.Error
				}
				if result.RowsAffected == 0 {
					return ErrTerminalNotFound
				}
				state = next
				return nil
			})
		})
	})
	return state, err
}

// ClearBlockTermViewForBlock is intended to be called with the same GORM
// transaction that archives/deletes a block. It makes the sidebar ownerless
// and closed while preserving the user's selected width.
func ClearBlockTermViewForBlock(tx *gorm.DB, terminalID string, blockID string) error {
	terminalID = strings.TrimSpace(terminalID)
	blockID = strings.TrimSpace(blockID)
	if tx == nil || terminalID == "" || blockID == "" {
		return nil
	}
	if !tx.Migrator().HasColumn(&model.TerminalSession{}, "blockterm_view_json") {
		// Older databases are upgraded by the application migration. Keeping this
		// helper a no-op before that migration preserves backwards compatibility.
		return nil
	}
	var session model.TerminalSession
	if err := tx.Model(&model.TerminalSession{}).
		Select("id", "blockterm_view_json").
		Where("id = ?", terminalID).
		First(&session).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	state, err := parseBlockTermViewJSON(session.BlockTermViewJSON)
	if err != nil || state.Sidebar.BlockID == nil || *state.Sidebar.BlockID != blockID {
		return nil
	}
	state.Sidebar.Open = false
	state.Sidebar.BlockID = nil
	encoded, err := canonicalBlockTermViewJSON(state)
	if err != nil {
		return err
	}
	return tx.Model(&model.TerminalSession{}).
		Where("id = ?", session.ID).
		Update("blockterm_view_json", encoded).Error
}
