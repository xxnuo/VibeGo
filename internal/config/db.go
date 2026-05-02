package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var GlobalDB *gorm.DB = nil

func GetDB(models ...any) *gorm.DB {
	if GlobalDB != nil {
		return GlobalDB
	}

	cfg := GetConfig()
	dbPath := filepath.Join(cfg.ConfigDir, "vibego.sqlite")
	if err := os.MkdirAll(cfg.ConfigDir, 0755); err != nil {
		panic(err)
	}

	var err error
	GlobalDB, err = gorm.Open(sqlite.Open(dbPath+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		panic(err)
	}

	sqlDB, err := GlobalDB.DB()
	if err != nil {
		panic(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	if len(models) > 0 {
		if err := GlobalDB.AutoMigrate(models...); err != nil {
			panic(err)
		}
	}

	return GlobalDB
}

func ensureWorkspaceSettingsColumns(tx *gorm.DB) error {
	if tx.Migrator().HasTable(&model.UserSession{}) && !tx.Migrator().HasColumn(&model.UserSession{}, "position") {
		if err := tx.Migrator().AddColumn(&model.UserSession{}, "Position"); err != nil {
			return fmt.Errorf("add user_sessions.position: %w", err)
		}
	}
	if !tx.Migrator().HasTable(&model.TerminalSession{}) {
		return nil
	}
	if !tx.Migrator().HasColumn(&model.TerminalSession{}, "tab_color") {
		if err := tx.Migrator().AddColumn(&model.TerminalSession{}, "TabColor"); err != nil {
			return fmt.Errorf("add terminal_sessions.tab_color: %w", err)
		}
	}
	if !tx.Migrator().HasColumn(&model.TerminalSession{}, "tab_icon") {
		if err := tx.Migrator().AddColumn(&model.TerminalSession{}, "TabIcon"); err != nil {
			return fmt.Errorf("add terminal_sessions.tab_icon: %w", err)
		}
	}
	return nil
}

func normalizeUserSessionPositions(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.UserSession{}) || !tx.Migrator().HasColumn(&model.UserSession{}, "position") {
		return nil
	}

	type sessionPosition struct {
		ID       string `gorm:"column:id"`
		Position int64  `gorm:"column:position"`
	}
	var sessions []sessionPosition
	if err := tx.Table((model.UserSession{}).TableName()).
		Select("id", "position").
		Order("CASE WHEN position > 0 THEN 0 ELSE 1 END ASC").
		Order("CASE WHEN position > 0 THEN position ELSE 0 END ASC").
		Order("updated_at DESC").
		Order("id ASC").
		Find(&sessions).Error; err != nil {
		return fmt.Errorf("load user session positions: %w", err)
	}
	for i, session := range sessions {
		position := int64(i + 1)
		if session.Position == position {
			continue
		}
		if err := tx.Table((model.UserSession{}).TableName()).
			Where("id = ?", session.ID).
			UpdateColumn("position", position).Error; err != nil {
			return fmt.Errorf("update user session %s position: %w", session.ID, err)
		}
	}
	return nil
}

// MigrateWorkspaceSettings upgrades workspace and terminal presentation columns
// without creating those tables as a side effect.
func MigrateWorkspaceSettings(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := ensureWorkspaceSettingsColumns(tx); err != nil {
			return err
		}
		return normalizeUserSessionPositions(tx)
	})
}
