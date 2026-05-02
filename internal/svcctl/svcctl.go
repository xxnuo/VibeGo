package svcctl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	kservice "github.com/kardianos/service"
	"github.com/xxnuo/vibego/internal/config"
	"github.com/xxnuo/vibego/internal/service/remotedesktop"
	"github.com/xxnuo/vibego/internal/version"
)

var osStderr io.Writer = os.Stderr
var osStdout io.Writer = os.Stdout
var installBinaryFunc = installBinary
var newServiceFunc = newService
var serviceConfigExistsFunc = serviceConfigExists

const ServiceName = "vibego"
const ServiceDescription = "VibeGo - Vibe Anywhere"
const InputHelperServiceName = "vibego-input-helper"
const InputHelperServiceDescription = "VibeGo Remote Desktop Input Helper"

type Runner func(context.Context) error

type serviceScope int

const (
	scopeAuto serviceScope = iota
	scopeUser
	scopeSystem
)

type serviceProgram struct {
	runner Runner
	ctx    context.Context
	cancel context.CancelFunc
	done   chan error
}

func Run(args []string, runner Runner) bool {
	if len(args) < 2 {
		return false
	}

	switch args[1] {
	case "help", "-h", "--help":
		handleHelp(args)
		return true
	case "install":
		handleInstall()
		return true
	case "uninstall":
		handleUninstall()
		return true
	case "service":
		handleService(args, runner)
		return true
	default:
		return false
	}
}

func (p *serviceProgram) Start(kservice.Service) error {
	if p.runner == nil {
		return nil
	}
	p.ctx, p.cancel = context.WithCancel(context.Background())
	p.done = make(chan error, 1)
	go func() {
		p.done <- p.runner(p.ctx)
	}()
	return nil
}

func (p *serviceProgram) Stop(kservice.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	if p.done == nil {
		return nil
	}
	select {
	case err := <-p.done:
		return err
	case <-time.After(10 * time.Second):
		return fmt.Errorf("service stop timed out")
	}
}

func handleHelp(args []string) {
	if len(args) >= 3 && args[2] == "service" {
		printServiceUsage()
		return
	}
	printUsage()
}

func handleInstall() {
	dst := InstalledBinPath()
	if err := installBinary(dst); err != nil {
		fmt.Fprintf(os.Stderr, "Error: install binary: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Installed to %s\n", dst)
	fmt.Printf("Make sure %s is in your PATH\n", filepath.Dir(dst))
}

func handleUninstall() {
	dst := InstalledBinPath()
	if err := os.Remove(dst); err != nil {
		if os.IsNotExist(err) {
			fmt.Println("Not installed")
			return
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed %s\n", dst)
}

func handleService(args []string, runner Runner) {
	if len(args) < 3 {
		printServiceUsage()
		os.Exit(1)
	}

	cmd := args[2]
	if cmd == "help" || cmd == "-h" || cmd == "--help" {
		printServiceUsage()
		return
	}

	if cmd == "run" {
		if err := runService(args[3:], runner); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if cmd == "input-helper" {
		if err := remotedesktop.RunInputHelper(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if cmd == "install-input-helper" {
		if err := runInputHelperInstall(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Input helper installed")
		return
	}

	scope, extraArgs, err := parseServiceFlags(args[3:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	userService, err := resolveUserService(runtime.GOOS, currentUID(), scope)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if cmd != "install" && len(extraArgs) > 0 {
		fmt.Fprintf(os.Stderr, "Error: %s does not accept server flags\n", cmd)
		os.Exit(1)
	}

	err = runServiceCommand(cmd, userService, extraArgs)
	if err != nil {
		if cmd != "status" {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		}
		os.Exit(1)
	}
}

func runServiceCommand(cmd string, userService bool, extraArgs []string) error {
	binPath := targetBinPath(userService)
	args := append([]string{"service", "run"}, extraArgs...)
	svc, err := newServiceFunc(userService, binPath, args, nil)
	if err != nil {
		return err
	}

	switch cmd {
	case "install":
		if err := reinstallService(svc, binPath); err != nil {
			return serviceError(cmd, err)
		}
		fmt.Printf("Service installed (%s): %s\n", scopeName(userService), binPath)
		fmt.Printf("Run: %s service start %s\n", os.Args[0], scopeFlag(userService))
	case "uninstall":
		_ = svc.Stop()
		if err := svc.Uninstall(); err != nil {
			return serviceError(cmd, err)
		}
		fmt.Println("Service uninstalled")
	case "start":
		if err := svc.Start(); err != nil {
			return serviceError(cmd, err)
		}
		fmt.Println("Service started")
	case "stop":
		if err := svc.Stop(); err != nil {
			return serviceError(cmd, err)
		}
		fmt.Println("Service stopped")
	case "restart":
		if err := svc.Restart(); err != nil {
			return serviceError(cmd, err)
		}
		fmt.Println("Service restarted")
	case "status":
		return printServiceStatus(svc)
	default:
		return fmt.Errorf("unknown service command: %s", cmd)
	}
	return nil
}

func runInputHelperInstall() error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("input helper is only supported on linux")
	}
	if currentUID() != 0 {
		return fmt.Errorf("input helper install requires root")
	}
	binPath := systemBinPath(runtime.GOOS, os.Getenv("ProgramFiles"))
	if err := installBinaryFunc(binPath); err != nil {
		return fmt.Errorf("install binary: %w", err)
	}
	cfg := newServiceConfig(false, binPath, []string{"service", "input-helper"})
	cfg.Name = InputHelperServiceName
	cfg.DisplayName = InputHelperServiceDescription
	cfg.Description = InputHelperServiceDescription
	svc, err := kservice.New(&serviceProgram{runner: func(context.Context) error {
		return remotedesktop.RunInputHelper()
	}}, cfg)
	if err != nil {
		return err
	}
	status, installed, err := serviceInstallState(svc)
	if err != nil {
		return err
	}
	if installed {
		if err := stopInstalledService(svc, status); err != nil {
			return err
		}
		if err := uninstallInstalledService(svc); err != nil {
			return err
		}
	}
	if err := svc.Install(); err != nil {
		return err
	}
	return svc.Start()
}

func reinstallService(svc kservice.Service, binPath string) error {
	status, installed, err := serviceInstallState(svc)
	if err != nil {
		return err
	}

	wasRunning := installed && status == kservice.StatusRunning
	if !installed || runtime.GOOS == "windows" {
		if installed {
			if err := stopInstalledService(svc, status); err != nil {
				return err
			}
			if err := uninstallInstalledService(svc); err != nil {
				return err
			}
		}
		if err := installBinaryFunc(binPath); err != nil {
			return fmt.Errorf("install binary: %w", err)
		}
		if err := svc.Install(); err != nil {
			return err
		}
		if wasRunning {
			if err := svc.Start(); err != nil {
				return err
			}
			fmt.Println("Service restarted")
		}
		return nil
	}

	if err := installBinaryFunc(binPath); err != nil {
		return fmt.Errorf("install binary: %w", err)
	}
	if installed {
		if err := stopInstalledService(svc, status); err != nil {
			return err
		}
		if err := uninstallInstalledService(svc); err != nil {
			return err
		}
	}
	if err := svc.Install(); err != nil {
		return err
	}
	if wasRunning {
		if err := svc.Start(); err != nil {
			return err
		}
		fmt.Println("Service restarted")
	}
	return nil
}

func serviceInstallState(svc kservice.Service) (kservice.Status, bool, error) {
	status, err := svc.Status()
	if err == nil {
		switch status {
		case kservice.StatusRunning, kservice.StatusStopped:
			return status, true, nil
		default:
			return status, false, nil
		}
	}
	if errors.Is(err, kservice.ErrNotInstalled) || isServiceMissingError(err) {
		return kservice.StatusUnknown, false, nil
	}
	if status == kservice.StatusUnknown && serviceConfigExistsFunc() {
		return kservice.StatusStopped, true, nil
	}
	return status, false, err
}

func stopInstalledService(svc kservice.Service, status kservice.Status) error {
	if status != kservice.StatusRunning {
		return nil
	}
	if err := svc.Stop(); err != nil && !errors.Is(err, kservice.ErrNotInstalled) && !isServiceMissingError(err) {
		return err
	}
	return nil
}

func uninstallInstalledService(svc kservice.Service) error {
	if err := svc.Uninstall(); err != nil && !errors.Is(err, kservice.ErrNotInstalled) && !isServiceMissingError(err) {
		return err
	}
	return nil
}

func isServiceMissingError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not installed") ||
		strings.Contains(msg, "does not exist") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "failed to open service")
}

func serviceConfigExists() bool {
	switch runtime.GOOS {
	case "linux":
		path := filepath.Join("/etc/systemd/system", ServiceName+".service")
		if _, err := os.Stat(path); err == nil {
			return true
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return false
		}
		_, err = os.Stat(filepath.Join(home, ".config", "systemd", "user", ServiceName+".service"))
		return err == nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err == nil {
			if _, err := os.Stat(filepath.Join(home, "Library", "LaunchAgents", ServiceName+".plist")); err == nil {
				return true
			}
		}
		_, err = os.Stat(filepath.Join("/Library/LaunchDaemons", ServiceName+".plist"))
		return err == nil
	default:
		return false
	}
}

func serviceError(cmd string, err error) error {
	if runtime.GOOS == "windows" {
		return fmt.Errorf("%s service: %w; run this command as administrator", cmd, err)
	}
	return err
}

func runService(args []string, runner Runner) error {
	if runner == nil {
		return fmt.Errorf("service runner is not configured")
	}
	os.Args = append([]string{os.Args[0]}, args...)
	svc, err := newService(false, currentBinPath(), nil, runner)
	if err != nil {
		return err
	}
	return svc.Run()
}

func newService(userService bool, binPath string, args []string, runner Runner) (kservice.Service, error) {
	cfg := newServiceConfig(userService, binPath, args)
	return kservice.New(&serviceProgram{runner: runner}, cfg)
}

func newServiceConfig(userService bool, binPath string, args []string) *kservice.Config {
	home, _ := os.UserHomeDir()
	cfg := &kservice.Config{
		Name:             ServiceName,
		DisplayName:      ServiceDescription,
		Description:      ServiceDescription,
		Executable:       binPath,
		Arguments:        args,
		WorkingDirectory: home,
		Option:           kservice.KeyValue{},
	}

	if userService {
		cfg.Option["UserService"] = true
	}

	switch runtime.GOOS {
	case "linux":
		cfg.Dependencies = []string{"After=network.target"}
		cfg.Option["Restart"] = "on-failure"
		cfg.Option["LimitNOFILE"] = 65536
		cfg.Option["SystemdScript"] = systemdScript(userService)
	case "darwin":
		cfg.Option["RunAtLoad"] = true
		cfg.Option["KeepAlive"] = true
	case "windows":
		cfg.Option["StartType"] = "automatic"
		cfg.Option["OnFailure"] = "restart"
	}

	return cfg
}

func printServiceStatus(svc kservice.Service) error {
	status, err := svc.Status()
	if errors.Is(err, kservice.ErrNotInstalled) {
		fmt.Fprintln(osStdout, "not-installed")
		return err
	}
	if err != nil {
		fmt.Fprintln(osStdout, "not-installed")
		return err
	}

	switch status {
	case kservice.StatusRunning:
		fmt.Fprintln(osStdout, "running")
	case kservice.StatusStopped:
		fmt.Fprintln(osStdout, "stopped")
	default:
		fmt.Fprintln(osStdout, "not-installed")
		return kservice.ErrNotInstalled
	}
	return nil
}

func parseServiceFlags(args []string) (serviceScope, []string, error) {
	scope := scopeAuto
	rest := make([]string, 0, len(args))
	for _, arg := range args {
		switch arg {
		case "--user":
			if scope == scopeSystem {
				return scopeAuto, nil, fmt.Errorf("--user and --system cannot be used together")
			}
			scope = scopeUser
		case "--system":
			if scope == scopeUser {
				return scopeAuto, nil, fmt.Errorf("--user and --system cannot be used together")
			}
			scope = scopeSystem
		default:
			rest = append(rest, arg)
		}
	}
	return scope, rest, nil
}

func resolveUserService(goos string, uid int, scope serviceScope) (bool, error) {
	switch scope {
	case scopeUser:
		if goos == "windows" {
			return false, fmt.Errorf("Windows user service is not supported; run as administrator and use --system")
		}
		return true, nil
	case scopeSystem:
		return false, nil
	case scopeAuto:
		if goos == "windows" {
			return false, nil
		}
		return uid != 0, nil
	default:
		return false, fmt.Errorf("invalid service scope")
	}
}

func currentUID() int {
	u, err := user.Current()
	if err != nil {
		return -1
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return -1
	}
	return uid
}

func targetBinPath(userService bool) string {
	if userService {
		return InstalledBinPath()
	}
	return systemBinPath(runtime.GOOS, os.Getenv("ProgramFiles"))
}

func InstalledBinPath() string {
	home, _ := os.UserHomeDir()
	return userBinPath(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"))
}

func userBinPath(goos, home, localAppData string) string {
	name := ServiceName
	if goos == "windows" {
		name += ".exe"
		if localAppData != "" {
			return filepath.Join(localAppData, "Programs", ServiceName, name)
		}
		return filepath.Join(home, "AppData", "Local", "Programs", ServiceName, name)
	}
	return filepath.Join(home, ".local", "bin", name)
}

func systemBinPath(goos, programFiles string) string {
	name := ServiceName
	if goos == "windows" {
		name += ".exe"
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		return filepath.Join(programFiles, "VibeGo", name)
	}
	return filepath.Join("/usr/local/bin", name)
}

func currentBinPath() string {
	p, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to get executable path: %v\n", err)
		os.Exit(1)
	}
	p, err = filepath.EvalSymlinks(p)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to resolve executable path: %v\n", err)
		os.Exit(1)
	}
	return p
}

func installBinary(dst string) error {
	src := currentBinPath()
	if src == dst {
		return nil
	}

	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create directory %s: %w", dir, err)
	}

	if err := copyFile(src, dst); err != nil {
		return fmt.Errorf("copy binary: %w", err)
	}
	return os.Chmod(dst, 0755)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}

	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}

	return os.Rename(tmp, dst)
}

func systemdScript(userService bool) string {
	target := "multi-user.target"
	if userService {
		target = "default.target"
	}
	return strings.ReplaceAll(`[Unit]
Description={{Description}}
ConditionFileIsExecutable={{Path | cmdEscape}}
{{range Dependencies}}{{.}}
{{end}}

[Service]
Type=simple
ExecStart={{Path | cmdEscape}}{{range Arguments}} {{. | cmd}}{{end}}
{{if WorkingDirectory}}WorkingDirectory={{WorkingDirectory | cmdEscape}}{{end}}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy={{.Target}}
`, "{{.Target}}", target)
}

func scopeName(userService bool) string {
	if userService {
		return "user"
	}
	return "system"
}

func scopeFlag(userService bool) string {
	if userService {
		return "--user"
	}
	return "--system"
}

func printUsage() {
	config.WriteHelp(osStderr, os.Args[0])
	fmt.Fprintf(osStderr, "\n")
	printServiceUsage()
}

func printServiceUsage() {
	fmt.Fprintf(osStderr, "VibeGo %s\n\n", version.Version)
	fmt.Fprintf(osStderr, "Usage:\n")
	fmt.Fprintf(osStderr, "  %s service <command> [--user|--system] [server flags]\n\n", os.Args[0])
	fmt.Fprintf(osStderr, "Service commands:\n")
	fmt.Fprintf(osStderr, "  help        Show service help\n")
	fmt.Fprintf(osStderr, "  install     Install service (auto-copies binary)\n")
	fmt.Fprintf(osStderr, "  uninstall   Uninstall service\n")
	fmt.Fprintf(osStderr, "  start       Start service\n")
	fmt.Fprintf(osStderr, "  stop        Stop service\n")
	fmt.Fprintf(osStderr, "  restart     Restart service\n")
	fmt.Fprintf(osStderr, "  status      Show service status\n")
	fmt.Fprintf(osStderr, "  install-input-helper  Install remote desktop input helper (internal)\n")
	fmt.Fprintf(osStderr, "\nScope:\n")
	fmt.Fprintf(osStderr, "  --user      Install/control current user service on Linux/macOS\n")
	fmt.Fprintf(osStderr, "  --system    Install/control system service\n")
	fmt.Fprintf(osStderr, "\nExamples:\n")
	fmt.Fprintf(osStderr, "  %s service install --user -port 8080\n", os.Args[0])
	fmt.Fprintf(osStderr, "  sudo %s service install --system -port 8080\n", os.Args[0])
	fmt.Fprintf(osStderr, "  %s service install --system -port 8080\n", os.Args[0])
}
