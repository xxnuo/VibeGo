package logger

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"gopkg.in/natefinch/lumberjack.v2"
)

func SetLogFile(logDir string, disable bool) {
	consoleWriter := zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}

	if disable {
		log.Logger = zerolog.New(consoleWriter).With().Timestamp().Logger()
		return
	}

	if logDir == "" {
		logDir = "./logs"
	}

	if err := os.MkdirAll(logDir, 0755); err != nil {
		os.Stderr.WriteString("Failed to create log directory: " + err.Error() + "\n")
		log.Logger = zerolog.New(consoleWriter).With().Timestamp().Logger()
		return
	}

	timestamp := time.Now().Format("2006-01-02-15-04-05")
	filename := filepath.Join(logDir, fmt.Sprintf("vibego-%s.log", timestamp))

	logFile := &lumberjack.Logger{
		Filename:   filename,
		MaxSize:    10,
		MaxBackups: 0,
		MaxAge:     0,
	}

	multi := zerolog.MultiLevelWriter(consoleWriter, logFile)
	log.Logger = zerolog.New(multi).With().Timestamp().Logger()
}
