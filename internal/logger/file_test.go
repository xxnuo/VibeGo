package logger

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog/log"
	"github.com/stretchr/testify/assert"
)

func TestSetLogFile(t *testing.T) {
	tmpDir := t.TempDir()

	originalLogger := log.Logger
	defer func() { log.Logger = originalLogger }()

	t.Run("Enable File Logging", func(t *testing.T) {
		Setup("info")
		SetLogFile(tmpDir, false)
		log.Info().Msg("test message to file")

		files, err := filepath.Glob(filepath.Join(tmpDir, "vibego-*.log"))
		assert.NoError(t, err)
		assert.NotEmpty(t, files, "Log file should be created")

		logPath := files[0]
		content, err := os.ReadFile(logPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content), "\"message\":\"test message to file\"")
	})

	t.Run("Disable File Logging", func(t *testing.T) {
		files, _ := filepath.Glob(filepath.Join(tmpDir, "vibego-*.log"))
		for _, f := range files {
			os.Remove(f)
		}

		SetLogFile(tmpDir, true)
		log.Info().Msg("should not be in file")

		files, err := filepath.Glob(filepath.Join(tmpDir, "vibego-*.log"))
		assert.NoError(t, err)
		assert.Empty(t, files, "No log file should be created when disabled")
	})

	t.Run("Empty LogDir Uses Default", func(t *testing.T) {
		defer os.RemoveAll("./logs")
		SetLogFile("", false)
		log.Info().Msg("test default dir")

		files, err := filepath.Glob("./logs/vibego-*.log")
		assert.NoError(t, err)
		assert.NotEmpty(t, files)
	})
}
