//go:build desktop_server

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/rs/zerolog/log"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	err := runServerWithOptions(ctx, serverOptions{
		Configure: configureDesktopServer,
		Ready: func(url string) {
			fmt.Fprintf(os.Stdout, "VIBEGO_DESKTOP_READY=%s\n", url)
		},
	})
	if err != nil && err != context.Canceled {
		log.Error().Err(err).Msg("桌面后端退出异常")
		os.Exit(1)
	}
}
