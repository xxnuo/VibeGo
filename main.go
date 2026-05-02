//go:build !desktop && !desktop_server && !desktop_window

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/rs/zerolog/log"
	"github.com/xxnuo/vibego/internal/svcctl"
)

// @title VibeGo API
// @version 0.3.5
// @description VibeGo 后端服务 API
// @host localhost:1984
// @BasePath /api
func main() {
	if svcctl.Run(os.Args, runServer) {
		return
	}

	if err := runServerWithSignals(); err != nil {
		log.Fatal().Err(err).Msg("Server stopped")
	}
}

func runServerWithSignals() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return runServer(ctx)
}
