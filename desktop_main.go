//go:build desktop

package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/pkg/browser"
)

func main() {
	server, appURL, err := startDesktopServer()
	if err != nil {
		log.Fatal(err)
	}
	defer stopDesktopProcess(server)

	window := &desktopWindowProcess{}
	systray.Run(func() {
		systray.SetIcon(desktopIcon)
		systray.SetTitle("VibeGo")
		systray.SetTooltip("VibeGo")

		showItem := systray.AddMenuItem("显示 VibeGo", "打开 VibeGo 窗口")
		closeItem := systray.AddMenuItem("关闭窗口", "销毁 VibeGo WebView")
		systray.AddSeparator()
		browserItem := systray.AddMenuItem("浏览器打开", "在默认浏览器中打开 VibeGo")
		systray.AddSeparator()
		quitItem := systray.AddMenuItem("退出 VibeGo", "退出 VibeGo")

		go func() {
			for {
				select {
				case <-showItem.ClickedCh:
					window.Show(appURL)
				case <-closeItem.ClickedCh:
					window.Close()
				case <-browserItem.ClickedCh:
					if err := browser.OpenURL(appURL); err != nil {
						log.Printf("打开浏览器失败: %v", err)
					}
				case <-quitItem.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()
		window.Show(appURL)
	}, func() {
		window.Close()
	})
}

type desktopWindowProcess struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan error
}

func (p *desktopWindowProcess) Show(appURL string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd != nil {
		return
	}

	windowPath := filepath.Join(filepath.Dir(os.Args[0]), "vibego-window")
	if runtime.GOOS == "windows" {
		windowPath += ".exe"
	}
	args := []string{appURL}
	if _, err := os.Stat(windowPath); err != nil {
		windowPath = "go"
		args = []string{"run", "-tags", "desktop_window,gtk3", ".", appURL}
	}
	cmd := exec.Command(windowPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "VIBEGO_WINDOW_URL="+appURL)
	if err := cmd.Start(); err != nil {
		log.Printf("启动窗口失败: %v", err)
		return
	}
	p.cmd = cmd
	p.done = make(chan error, 1)
	done := p.done
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		if p.cmd == cmd {
			p.cmd = nil
			p.done = nil
		}
		p.mu.Unlock()
		done <- err
	}()
}

func (p *desktopWindowProcess) Close() {
	p.mu.Lock()
	cmd, done := p.cmd, p.done
	p.mu.Unlock()
	if cmd == nil {
		return
	}
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		_ = cmd.Process.Kill()
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}

func startDesktopServer() (*exec.Cmd, string, error) {
	serverPath := filepath.Join(filepath.Dir(os.Args[0]), "vibego-server")
	if runtime.GOOS == "windows" {
		serverPath += ".exe"
	}
	args := []string{}
	if _, err := os.Stat(serverPath); err != nil {
		serverPath = "go"
		args = []string{"run", "-tags", "desktop_server", "."}
	}
	cmd := exec.Command(serverPath, args...)
	desktopServerPort := strings.TrimSpace(os.Getenv("VG_DESKTOP_PORT"))
	if desktopServerPort == "" {
		desktopServerPort = "0"
	}
	cmd.Env = append(os.Environ(), "VG_DESKTOP_PORT="+desktopServerPort)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, "", err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, "", err
	}
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "VIBEGO_DESKTOP_READY=") {
				select {
				case ready <- strings.TrimPrefix(line, "VIBEGO_DESKTOP_READY="):
				default:
				}
				continue
			}
			fmt.Fprintln(os.Stdout, line)
		}
		select {
		case ready <- "":
		default:
		}
	}()
	select {
	case url := <-ready:
		if url == "" {
			_ = cmd.Process.Kill()
			return nil, "", fmt.Errorf("desktop server exited before readiness")
		}
		return cmd, url, nil
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		return nil, "", fmt.Errorf("timed out waiting for desktop server")
	}
}

func stopDesktopProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		_ = cmd.Process.Kill()
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			log.Printf("桌面后端退出: %v", err)
		}
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}
