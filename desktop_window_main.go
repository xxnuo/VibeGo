//go:build desktop_window

package main

import (
	"log"
	"os"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const desktopWindowName = "vibego-main"

func main() {
	configureDesktopEnvironment()
	appURL := os.Getenv("VIBEGO_WINDOW_URL")
	if appURL == "" && len(os.Args) > 1 {
		appURL = os.Args[1]
	}
	if appURL == "" {
		log.Fatal("VIBEGO_WINDOW_URL is required")
	}

	app := application.New(application.Options{
		Name:        "VibeGo",
		Description: "VibeGo desktop client",
		Icon:        desktopIcon,
		Assets:      application.AlphaAssets,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	window := app.Window.NewWithOptions(desktopWindowOptions(appURL))
	var closeScheduled atomic.Bool
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if !closeScheduled.CompareAndSwap(false, true) {
			event.Cancel()
			return
		}
		event.Cancel()
		window.ExecJS(`window.dispatchEvent(new Event("vibego:desktop-park"))`)
		go func() {
			time.Sleep(500 * time.Millisecond)
			os.Exit(0)
		}()
	})
	go exitWhenWindowCloses(window)

	if err := app.Run(); err != nil {
		log.Printf("桌面窗口退出: %v", err)
	}
}

func exitWhenWindowCloses(window *application.WebviewWindow) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	wasVisible := false
	for range ticker.C {
		if window.IsVisible() {
			wasVisible = true
			continue
		}
		if wasVisible {
			time.Sleep(500 * time.Millisecond)
			if !window.IsVisible() {
				os.Exit(0)
			}
		}
	}
}

func configureDesktopEnvironment() {
	if _, exists := os.LookupEnv("WEBKIT_DISABLE_DMABUF_RENDERER"); !exists {
		_ = os.Setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
	}
}

func desktopWindowOptions(appURL string) application.WebviewWindowOptions {
	return application.WebviewWindowOptions{
		Name:      desktopWindowName,
		Title:     "VibeGo",
		URL:       appURL,
		Width:     1440,
		Height:    900,
		MinWidth:  900,
		MinHeight: 600,
		Linux: application.LinuxWindow{
			Icon:             desktopIcon,
			WebviewGpuPolicy: application.WebviewGpuPolicyNever,
		},
	}
}
