package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

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
