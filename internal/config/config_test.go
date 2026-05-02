package config

import (
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDataDirectoriesByEnvironment(t *testing.T) {
	home, err := os.UserHomeDir()
	assert.NoError(t, err)
	for _, tc := range []struct {
		name    string
		dev     string
		devUI   string
		wantDir string
	}{
		{name: "default", wantDir: "vibego"},
		{name: "development", dev: "true", wantDir: "vibego-dev"},
		{name: "desktop development", devUI: "http://127.0.0.1:15173", wantDir: "vibego-dev"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("VG_DEV", tc.dev)
			t.Setenv("VG_DESKTOP_DEV_UI", tc.devUI)
			wantDir := tc.wantDir
			if debugBuild {
				wantDir = "vibego-dev"
			}
			root := filepath.Join(home, ".config", wantDir)
			cfg := defaultConfig()
			assert.Equal(t, root, cfg.HomeDir)
			assert.Equal(t, filepath.Join(root, "server"), cfg.ConfigDir)
			assert.Equal(t, cfg.ConfigDir, cfg.TlsDir)
			assert.Equal(t, filepath.Join(root, "logs"), cfg.LogDir)
		})
	}
}

func TestTLSDirectoryFollowsConfigOverride(t *testing.T) {
	for _, useFlag := range []bool{false, true} {
		t.Run(map[bool]string{false: "environment", true: "flag"}[useFlag], func(t *testing.T) {
			oldFlags, oldArgs, oldConfig, oldUsage := flag.CommandLine, os.Args, GlobalConfig, flag.Usage
			t.Cleanup(func() {
				flag.CommandLine, os.Args, GlobalConfig, flag.Usage = oldFlags, oldArgs, oldConfig, oldUsage
			})
			flag.CommandLine = flag.NewFlagSet("config-test", flag.ContinueOnError)
			GlobalConfig = nil
			os.Args = []string{"config-test"}
			dir := t.TempDir()
			t.Setenv("VG_CONFIG_DIR", dir)
			if useFlag {
				t.Setenv("VG_CONFIG_DIR", filepath.Join(dir, "unused"))
				os.Args = append(os.Args, "--config-dir", dir)
			}
			cfg := GetConfig()
			assert.Equal(t, dir, cfg.ConfigDir)
			assert.Equal(t, dir, cfg.TlsDir)
		})
	}
}

func TestGetConfig(t *testing.T) {
	GlobalConfig = nil
	cfg := GetConfig()
	assert.Equal(t, cfg.Host, "0.0.0.0")
	assert.Equal(t, cfg.Port, "1984")
}

func TestGetConfigCached(t *testing.T) {
	GlobalConfig = &Config{Host: "cached", Port: "9999"}
	cfg := GetConfig()
	assert.Equal(t, "cached", cfg.Host)
	assert.Equal(t, "9999", cfg.Port)
	GlobalConfig = nil
}

func TestGetConfigWithEnv(t *testing.T) {
	GlobalConfig = nil
	os.Setenv("VG_HOST", "127.0.0.1")
	os.Setenv("VG_PORT", "8080")
	defer os.Unsetenv("VG_HOST")
	defer os.Unsetenv("VG_PORT")
	GlobalConfig = nil
}
