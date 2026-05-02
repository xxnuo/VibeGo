//go:build desktop_server

package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/xxnuo/vibego/internal/config"
)

func configureDesktopServer(cfg *config.Config) {
	desktopDir := filepath.Join(cfg.HomeDir, "desktop")
	desktopPort := strings.TrimSpace(os.Getenv("VG_DESKTOP_PORT"))
	if desktopPort == "" {
		desktopPort = "0"
	}
	cfg.ConfigDir = desktopDir
	cfg.TlsDir = desktopDir
	cfg.LogDir = filepath.Join(desktopDir, "logs")
	cfg.Host = "127.0.0.1"
	cfg.Port = desktopPort
	cfg.AllowWAN = desktopPort != "0"
	cfg.NeedKey = false
	cfg.Key = ""
	cfg.NoTLS = true
	cfg.DevUI = strings.TrimSpace(os.Getenv("VG_DESKTOP_DEV_UI"))
	cfg.CORSOrigins = "*"
}
