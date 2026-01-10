package logger

import (
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
)

func TestInit(t *testing.T) {
	Setup("debug")
	assert.Equal(t, zerolog.DebugLevel, zerolog.GlobalLevel())

	Setup("info")
	assert.Equal(t, zerolog.InfoLevel, zerolog.GlobalLevel())
}
