package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/glebarez/sqlite"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type DBPair struct {
	Writer *gorm.DB
	Reader *gorm.DB
}

var GlobalDB *gorm.DB
var GlobalDBPair *DBPair
var dbMu sync.Mutex

// OpenDBPair configures every connection, including connections opened later by
// database/sql. This driver uses _pragma, not mattn/go-sqlite3 DSN options.
func OpenDBPair(path string) (*DBPair, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
	options := "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	open := func(extra string, maxOpen, maxIdle int) (*gorm.DB, error) {
		db, err := gorm.Open(sqlite.Open(uri+options+extra), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if err != nil {
			return nil, err
		}
		pool, err := db.DB()
		if err != nil {
			return nil, err
		}
		pool.SetMaxOpenConns(maxOpen)
		pool.SetMaxIdleConns(maxIdle)
		return db, nil
	}
	writer, err := open("&_txlock=immediate", 1, 1)
	if err != nil {
		return nil, err
	}
	reader, err := open("&_pragma=query_only(1)", max(4, runtime.NumCPU()*2), max(2, runtime.NumCPU()))
	if err != nil {
		pool, _ := writer.DB()
		_ = pool.Close()
		return nil, err
	}
	return &DBPair{Writer: writer, Reader: reader}, nil
}

func GetDBPair(models ...any) *DBPair {
	dbMu.Lock()
	defer dbMu.Unlock()
	if GlobalDBPair == nil {
		cfg := GetConfig()
		if err := os.MkdirAll(cfg.ConfigDir, 0755); err != nil {
			panic(err)
		}
		pair, err := OpenDBPair(filepath.Join(cfg.ConfigDir, "vibego.sqlite"))
		if err != nil {
			panic(err)
		}
		GlobalDBPair, GlobalDB = pair, pair.Writer
	}
	if len(models) > 0 {
		if err := GlobalDBPair.Writer.AutoMigrate(models...); err != nil {
			panic(err)
		}
	}
	return GlobalDBPair
}

func GetDB(models ...any) *gorm.DB { return GetDBPair(models...).Writer }

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

func MigrateLegacySessionsToWorkspaces(db *gorm.DB) error {
	if err := db.AutoMigrate(&model.Workspace{}, &model.WorkspaceFolder{}, &model.WorkspaceTool{}, &model.WorkspaceTab{}, &model.WorkspaceMutation{}, &model.WorkspacePluginStorage{}); err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		var sessions []model.UserSession
		if err := tx.Find(&sessions).Error; err != nil {
			return err
		}
		for _, session := range sessions {
			var count int64
			if err := tx.Model(&model.Workspace{}).Where("id = ?", session.ID).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				continue
			}
			if err := migrateSession(tx, session); err != nil {
				return fmt.Errorf("migrate workspace %s: %w", session.ID, err)
			}
		}
		return migratePageTasks(tx)
	})
}
