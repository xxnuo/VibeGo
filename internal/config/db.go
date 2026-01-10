package config

import (
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
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
	GlobalDB, err = gorm.Open(sqlite.Open(dbPath), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		panic(err)
	}
	if len(models) > 0 {
		if err := GlobalDB.AutoMigrate(models...); err != nil {
			panic(err)
		}
	}

	return GlobalDB
}
