package terminal

import (
	"errors"
	"fmt"

	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermhistory"
	"gorm.io/gorm"
)

func (m *Manager) WithTerminalLifecycle(fn func() error) error {
	m.workspaceLifecycleMu.RLock()
	defer m.workspaceLifecycleMu.RUnlock()
	return fn()
}

func (m *Manager) withWorkspaceMutation(fn func() error) error {
	m.workspaceMutationMu.Lock()
	defer m.workspaceMutationMu.Unlock()
	return fn()
}

func (m *Manager) mutateWorkspace(
	workspaceSessionID string,
	mutation func(*gorm.DB) error,
	afterCommit func(),
) error {
	if workspaceSessionID == "" {
		return ErrWorkspaceNotFound
	}

	return m.withWorkspaceMutation(func() error {
		if err := m.db.Transaction(func(tx *gorm.DB) error {
			if err := m.validateWorkspaceSession(tx, workspaceSessionID); err != nil {
				return err
			}
			if mutation != nil {
				return mutation(tx)
			}
			return nil
		}); err != nil {
			return err
		}
		if afterCommit != nil {
			afterCommit()
		}
		return nil
	})
}

// MutateWorkspace serializes a transactional workspace update with terminal
// create/sync/delete operations that share the manager.
func (m *Manager) MutateWorkspace(workspaceSessionID string, mutation func(*gorm.DB) error) error {
	return m.mutateWorkspace(workspaceSessionID, mutation, nil)
}

func (m *Manager) WithWorkspaceSession(workspaceSessionID string, fn func() error) error {
	return m.WithTerminalLifecycle(func() error {
		if err := m.validateWorkspaceSession(m.db, workspaceSessionID); err != nil {
			return err
		}
		return fn()
	})
}

func (m *Manager) validateWorkspaceSession(db *gorm.DB, workspaceSessionID string) error {
	if workspaceSessionID == "" {
		return nil
	}

	var session model.UserSession
	if err := db.Select("id").First(&session, "id = ?", workspaceSessionID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrWorkspaceNotFound
		}
		return err
	}
	return nil
}

func (m *Manager) resolveTerminalParentScope(
	db *gorm.DB,
	opts *CreateOptions,
) error {
	if opts.ParentID == "" {
		return nil
	}

	var parent model.TerminalSession
	if err := db.Select("id", "workspace_session_id", "group_id").First(&parent, "id = ?", opts.ParentID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return fmt.Errorf("%w: parent terminal %s", ErrTerminalNotFound, opts.ParentID)
		}
		return err
	}
	if opts.WorkspaceSessionID == "" {
		opts.WorkspaceSessionID = parent.WorkspaceSessionID
	}
	if opts.GroupID == "" {
		opts.GroupID = parent.GroupID
	}
	if parent.WorkspaceSessionID != opts.WorkspaceSessionID || parent.GroupID != opts.GroupID {
		return fmt.Errorf(
			"%w: parent %s belongs to workspace %q group %q",
			ErrTerminalScopeMismatch,
			opts.ParentID,
			parent.WorkspaceSessionID,
			parent.GroupID,
		)
	}
	return nil
}

func (m *Manager) collectWorkspaceDeleteIDs(workspaceSessionID string) ([]string, error) {
	var workspaceIDs []string
	if err := m.db.Model(&model.TerminalSession{}).
		Where("workspace_session_id = ?", workspaceSessionID).
		Pluck("id", &workspaceIDs).Error; err != nil {
		return nil, err
	}

	ids := make([]string, 0, len(workspaceIDs))
	seen := make(map[string]struct{}, len(workspaceIDs))
	parents := make([]string, 0, len(workspaceIDs))
	for _, id := range workspaceIDs {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
		parents = append(parents, id)
	}

	for len(parents) > 0 {
		var childIDs []string
		if err := m.db.Model(&model.TerminalSession{}).
			Where("parent_id IN ? AND workspace_session_id = ?", parents, workspaceSessionID).
			Pluck("id", &childIDs).Error; err != nil {
			return nil, err
		}

		nextParents := make([]string, 0, len(childIDs))
		for _, childID := range childIDs {
			if _, ok := seen[childID]; ok {
				continue
			}
			seen[childID] = struct{}{}
			ids = append(ids, childID)
			nextParents = append(nextParents, childID)
		}
		parents = nextParents
	}

	return ids, nil
}

func (m *Manager) DeleteWorkspace(workspaceSessionID string) error {
	if workspaceSessionID == "" {
		return ErrWorkspaceNotFound
	}

	m.workspaceLifecycleMu.Lock()
	defer m.workspaceLifecycleMu.Unlock()
	m.workspaceMutationMu.Lock()
	defer m.workspaceMutationMu.Unlock()

	if err := m.validateWorkspaceSession(m.db, workspaceSessionID); err != nil {
		return err
	}

	ids, err := m.collectWorkspaceDeleteIDs(workspaceSessionID)
	if err != nil {
		return err
	}

	for _, id := range ids {
		unlock := m.lockTerminalLifecycle(id)
		err := m.closeForDelete(id)
		unlock()
		if err != nil {
			return fmt.Errorf("close terminal %s: %w", id, err)
		}
	}

	m.blockTermMutationMu.Lock()
	defer m.blockTermMutationMu.Unlock()
	err = m.db.Transaction(func(tx *gorm.DB) error {
		if len(ids) > 0 {
			if err := blocktermhistory.SyncTerminals(tx, ids); err != nil {
				return err
			}
			if err := tx.Where("session_id IN ?", ids).Delete(&model.TerminalHistory{}).Error; err != nil {
				return err
			}
			if tx.Migrator().HasTable(&model.BlockTermOutputSegment{}) {
				if err := tx.Where("terminal_id IN ?", ids).Delete(&model.BlockTermOutputSegment{}).Error; err != nil {
					return err
				}
			}
			if tx.Migrator().HasTable(&model.BlockTermBlock{}) {
				if err := tx.Where("terminal_id IN ?", ids).Delete(&model.BlockTermBlock{}).Error; err != nil {
					return err
				}
			}
			if err := tx.Where("id IN ?", ids).Delete(&model.TerminalSession{}).Error; err != nil {
				return err
			}
		}

		result := tx.Delete(&model.UserSession{}, "id = ?", workspaceSessionID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrWorkspaceNotFound
		}
		return nil
	})
	if err == nil {
		// Durable blocks and their history have been removed by the transaction;
		// drop only the in-memory independent-runtime lifecycle markers here.
		for _, id := range ids {
			m.clearBlockRuntimePreparationStateForTerminal(id)
		}
	}
	return err
}
