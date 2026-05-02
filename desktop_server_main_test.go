//go:build desktop_server

package main

import (
	"path/filepath"
	"testing"

	"github.com/xxnuo/vibego/internal/config"
)

func TestConfigureDesktopServerIsIsolatedAndLoopbackOnly(t *testing.T) {
	t.Setenv("VG_DESKTOP_PORT", "")
	t.Setenv("VG_DESKTOP_DEV_UI", "")
	cfg := &config.Config{HomeDir: t.TempDir()}
	configureDesktopServer(cfg)
	desktopDir := filepath.Join(cfg.HomeDir, "desktop")
	if cfg.ConfigDir != desktopDir || cfg.TlsDir != desktopDir || cfg.LogDir != filepath.Join(desktopDir, "logs") {
		t.Fatalf("unexpected desktop paths: %#v", cfg)
	}
	if cfg.Host != "127.0.0.1" || cfg.Port != "0" || !cfg.NoTLS || cfg.AllowWAN || cfg.NeedKey || cfg.Key != "" {
		t.Fatalf("unexpected desktop network config: %#v", cfg)
	}
}

func TestConfigureDesktopServerUsesDevelopmentPort(t *testing.T) {
	t.Setenv("VG_DESKTOP_PORT", "11984")
	t.Setenv("VG_DESKTOP_DEV_UI", "http://127.0.0.1:15173")
	cfg := &config.Config{HomeDir: t.TempDir()}
	configureDesktopServer(cfg)
	if cfg.Port != "11984" || !cfg.AllowWAN || cfg.DevUI != "http://127.0.0.1:15173" {
		t.Fatalf("unexpected development config: %#v", cfg)
	}
}
