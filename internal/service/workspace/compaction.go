package workspace

import (
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const KeepRecentRevisions int64 = 500

// CompactExistingMutations bounds logs left by earlier versions before serving
// requests, including workspaces that may never receive another mutation.
func (s *Service) CompactExistingMutations() error {
	var ids []string
	if err := s.readerDB.Model(&model.WorkspaceMutation{}).Distinct("workspace_id").Pluck("workspace_id", &ids).Error; err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.CompactWorkspaceMutations(id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) EarliestRevision(workspaceID string) (int64, error) {
	var revision int64
	err := s.readerDB.Model(&model.WorkspaceMutation{}).Where("workspace_id = ?", workspaceID).
		Select("COALESCE(MIN(revision), 0)").Scan(&revision).Error
	return revision, err
}

// Keep the bound inside the commit transaction: background scheduling alone
// cannot guarantee that the log never exceeds 500 entries.
func compactMutations(tx *gorm.DB, id string, revision, keep int64) (int64, error) {
	if revision <= keep {
		return 0, nil
	}
	result := tx.Where("workspace_id = ? AND revision <= ?", id, revision-keep).Delete(&model.WorkspaceMutation{})
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected > 0 {
		if err := tx.Model(&model.Workspace{}).Where("id = ?", id).
			UpdateColumn("compacted_revision", gorm.Expr("MAX(compacted_revision, ?)", revision-keep)).Error; err != nil {
			return 0, err
		}
	}
	return result.RowsAffected, nil
}

func (s *Service) CompactWorkspaceMutations(workspaceID string, keepCount ...int64) (int64, error) {
	keep := KeepRecentRevisions
	if len(keepCount) > 0 {
		keep = keepCount[0]
	}
	if keep < 1 {
		return 0, invalid("keep count must be positive")
	}
	var removed int64
	err := s.writerDB.Transaction(func(tx *gorm.DB) error {
		var revision int64
		if err := tx.Model(&model.WorkspaceMutation{}).Where("workspace_id = ?", workspaceID).
			Select("COALESCE(MAX(revision), 0)").Scan(&revision).Error; err != nil {
			return err
		}
		var err error
		removed, err = compactMutations(tx, workspaceID, revision, keep)
		return err
	})
	return removed, err
}
