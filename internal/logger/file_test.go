package logger

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog/log"
	"github.com/stretchr/testify/assert"
)

func TestSetLogFile(t *testing.T) {
	// Setup temp dir
	tmpDir := t.TempDir()

	// Save original logger state
	originalLogger := log.Logger
	defer func() { log.Logger = originalLogger }()

	t.Run("Enable File Logging", func(t *testing.T) {
		// Initialize global logger first
		Setup("info")

		SetLogFile(tmpDir, false)

		log.Info().Msg("test message to file")

		// Find generated log file
		files, err := filepath.Glob(filepath.Join(tmpDir, "vibego-*.log"))
		assert.NoError(t, err)
		assert.NotEmpty(t, files, "Log file should be created")

		logPath := files[0]
		content, err := os.ReadFile(logPath)
		assert.NoError(t, err)
		assert.Contains(t, string(content), "\"message\":\"test message to file\"")
	})

	t.Run("Disable File Logging", func(t *testing.T) {
		// Clean up
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
}
