package logger

import (
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
)

func TestSetup(t *testing.T) {
	tests := []struct {
		level    string
		expected zerolog.Level
	}{
		{"debug", zerolog.DebugLevel},
		{"info", zerolog.InfoLevel},
		{"warn", zerolog.WarnLevel},
		{"warning", zerolog.WarnLevel},
		{"error", zerolog.ErrorLevel},
		{"unknown", zerolog.InfoLevel},
		{"", zerolog.InfoLevel},
		{"DEBUG", zerolog.DebugLevel},
		{"INFO", zerolog.InfoLevel},
		{"WARN", zerolog.WarnLevel},
		{"ERROR", zerolog.ErrorLevel},
	}

	for _, tt := range tests {
		t.Run(tt.level, func(t *testing.T) {
			Setup(tt.level)
			assert.Equal(t, tt.expected, zerolog.GlobalLevel())
		})
	}
}
