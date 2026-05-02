package svcctl

import (
	"bytes"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"

	kservice "github.com/kardianos/service"
)

func TestRunHelp(t *testing.T) {
	stderr := osStderr
	defer func() {
		osStderr = stderr
	}()

	var buf bytes.Buffer
	osStderr = &buf

	if !Run([]string{"vibego", "help"}, nil) {
		t.Fatalf("expected help command to be handled")
	}

	output := buf.String()
	if !strings.Contains(output, "Usage:") {
		t.Fatalf("expected usage output, got %q", output)
	}
	if !strings.Contains(output, "service <command> [service flags]") {
		t.Fatalf("expected service usage in output, got %q", output)
	}
}

func TestRunServiceHelp(t *testing.T) {
	stderr := osStderr
	defer func() {
		osStderr = stderr
	}()

	var buf bytes.Buffer
	osStderr = &buf

	if !Run([]string{"vibego", "service", "help"}, nil) {
		t.Fatalf("expected service help command to be handled")
	}

	output := buf.String()
	if !strings.Contains(output, "Service commands:") {
		t.Fatalf("expected service commands output, got %q", output)
	}
	if !strings.Contains(output, "--user      Install/control current user service") {
		t.Fatalf("expected service scope entry, got %q", output)
	}
}

func TestParseServiceFlags(t *testing.T) {
	scope, rest, err := parseServiceFlags([]string{"--user", "-port", "8080"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if scope != scopeUser {
		t.Fatalf("expected user scope, got %v", scope)
	}
	if strings.Join(rest, " ") != "-port 8080" {
		t.Fatalf("unexpected rest args: %#v", rest)
	}

	scope, rest, err = parseServiceFlags([]string{"--system", "-no-tls"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if scope != scopeSystem {
		t.Fatalf("expected system scope, got %v", scope)
	}
	if strings.Join(rest, " ") != "-no-tls" {
		t.Fatalf("unexpected rest args: %#v", rest)
	}
}

func TestParseServiceFlagsRejectsMixedScope(t *testing.T) {
	_, _, err := parseServiceFlags([]string{"--user", "--system"})
	if err == nil {
		t.Fatalf("expected mixed scope error")
	}
}

func TestResolveUserService(t *testing.T) {
	tests := []struct {
		name      string
		goos      string
		uid       int
		scope     serviceScope
		want      bool
		wantError bool
	}{
		{name: "linux root auto system", goos: "linux", uid: 0, scope: scopeAuto},
		{name: "linux user auto user", goos: "linux", uid: 1000, scope: scopeAuto, want: true},
		{name: "darwin explicit user", goos: "darwin", uid: 0, scope: scopeUser, want: true},
		{name: "windows auto system", goos: "windows", uid: 1000, scope: scopeAuto},
		{name: "windows explicit user error", goos: "windows", uid: 1000, scope: scopeUser, wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveUserService(tt.goos, tt.uid, tt.scope)
			if tt.wantError {
				if err == nil {
					t.Fatalf("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("expected %v, got %v", tt.want, got)
			}
		})
	}
}

func TestBinPaths(t *testing.T) {
	if got := userBinPath("linux", "/home/me", ""); got != "/home/me/.local/bin/vibego" {
		t.Fatalf("unexpected linux user path: %s", got)
	}
	if got := systemBinPath("linux", ""); got != "/usr/local/bin/vibego" {
		t.Fatalf("unexpected linux system path: %s", got)
	}
	if got := userBinPath("windows", `C:\Users\me`, `C:\Users\me\AppData\Local`); !strings.Contains(got, `AppData\Local`) || !strings.HasSuffix(got, "vibego.exe") {
		t.Fatalf("unexpected windows user path: %s", got)
	}
	if got := systemBinPath("windows", `C:\Program Files`); !strings.Contains(got, `Program Files`) || !strings.HasSuffix(got, "vibego.exe") {
		t.Fatalf("unexpected windows system path: %s", got)
	}
}

func TestServiceConfig(t *testing.T) {
	cfg := newServiceConfig(true, "/tmp/vibego", []string{"service", "run", "-port", "8080"})
	if cfg.Executable != "/tmp/vibego" {
		t.Fatalf("unexpected executable: %s", cfg.Executable)
	}
	if strings.Join(cfg.Arguments, " ") != "service run -port 8080" {
		t.Fatalf("unexpected arguments: %#v", cfg.Arguments)
	}
	if cfg.Option["UserService"] != true {
		t.Fatalf("expected user service option")
	}

	if runtime.GOOS == "linux" {
		script, ok := cfg.Option["SystemdScript"].(string)
		if !ok {
			t.Fatalf("expected systemd script")
		}
		if !strings.Contains(script, "WantedBy=default.target") {
			t.Fatalf("expected user target in script: %s", script)
		}
		if !strings.Contains(script, "LimitNOFILE=65536") {
			t.Fatalf("expected nofile limit in script: %s", script)
		}
	}
}

func TestSystemdScriptUsesKardianosTemplateKeys(t *testing.T) {
	script := systemdScript(true)

	for _, bad := range []string{".Description", ".Path", ".Arguments", ".WorkingDirectory", ".Dependencies"} {
		if strings.Contains(script, bad) {
			t.Fatalf("systemd script contains unsupported template key %q:\n%s", bad, script)
		}
	}

	for _, want := range []string{
		"Description={{Description}}",
		"ConditionFileIsExecutable={{Path | cmdEscape}}",
		"{{range Dependencies}}{{.}}",
		"ExecStart={{Path | cmdEscape}}{{range Arguments}} {{. | cmd}}{{end}}",
		"{{if WorkingDirectory}}WorkingDirectory={{WorkingDirectory | cmdEscape}}{{end}}",
		"WantedBy=default.target",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("systemd script missing %q:\n%s", want, script)
		}
	}
}

func TestPrintServiceStatus(t *testing.T) {
	tests := []struct {
		name      string
		status    kservice.Status
		err       error
		wantOut   string
		wantError bool
	}{
		{name: "running", status: kservice.StatusRunning, wantOut: "running\n"},
		{name: "stopped", status: kservice.StatusStopped, wantOut: "stopped\n"},
		{name: "not installed", err: kservice.ErrNotInstalled, wantOut: "not-installed\n", wantError: true},
		{name: "unknown error", err: errors.New("boom"), wantOut: "not-installed\n", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout := osStdout
			defer func() {
				osStdout = stdout
			}()

			var buf bytes.Buffer
			osStdout = &buf

			err := printServiceStatus(&fakeService{status: tt.status, err: tt.err})
			if tt.wantError && err == nil {
				t.Fatalf("expected error")
			}
			if !tt.wantError && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if buf.String() != tt.wantOut {
				t.Fatalf("expected %q, got %q", tt.wantOut, buf.String())
			}
		})
	}
}

func TestRunServiceCommandInstallFresh(t *testing.T) {
	restore := stubServiceLifecycle(t, []fakeServiceStatusResult{{status: kservice.StatusUnknown, err: kservice.ErrNotInstalled}})
	defer restore()

	var installBinaryCalls []string
	installBinaryFunc = func(dst string) error {
		installBinaryCalls = append(installBinaryCalls, dst)
		return nil
	}

	if err := runServiceCommand("install", true, []string{"-port", "8080"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(installBinaryCalls) != 1 {
		t.Fatalf("expected install binary once, got %d", len(installBinaryCalls))
	}
	svc := lastFakeService(t)
	if svc.installCalls != 1 {
		t.Fatalf("expected install once, got %d", svc.installCalls)
	}
	if svc.uninstallCalls != 0 {
		t.Fatalf("expected no uninstall, got %d", svc.uninstallCalls)
	}
	if svc.startCalls != 0 {
		t.Fatalf("expected no start, got %d", svc.startCalls)
	}
	if svc.stopCalls != 0 {
		t.Fatalf("expected no stop, got %d", svc.stopCalls)
	}
}

func TestRunServiceCommandInstallReinstallsRunningService(t *testing.T) {
	restore := stubServiceLifecycle(t, []fakeServiceStatusResult{{status: kservice.StatusRunning}})
	defer restore()

	var installBinaryCalls []string
	installBinaryFunc = func(dst string) error {
		installBinaryCalls = append(installBinaryCalls, dst)
		return nil
	}

	if err := runServiceCommand("install", false, []string{"-port", "8080"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(installBinaryCalls) != 1 {
		t.Fatalf("expected install binary once, got %d", len(installBinaryCalls))
	}
	svc := lastFakeService(t)
	if svc.stopCalls != 1 {
		t.Fatalf("expected stop once, got %d", svc.stopCalls)
	}
	if svc.uninstallCalls != 1 {
		t.Fatalf("expected uninstall once, got %d", svc.uninstallCalls)
	}
	if svc.installCalls != 1 {
		t.Fatalf("expected install once, got %d", svc.installCalls)
	}
	if svc.startCalls != 1 {
		t.Fatalf("expected start once, got %d", svc.startCalls)
	}
}

func TestRunServiceCommandInstallReinstallsStoppedService(t *testing.T) {
	restore := stubServiceLifecycle(t, []fakeServiceStatusResult{{status: kservice.StatusStopped}})
	defer restore()

	installBinaryFunc = func(string) error { return nil }

	if err := runServiceCommand("install", false, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	svc := lastFakeService(t)
	if svc.stopCalls != 0 {
		t.Fatalf("expected no stop, got %d", svc.stopCalls)
	}
	if svc.uninstallCalls != 1 {
		t.Fatalf("expected uninstall once, got %d", svc.uninstallCalls)
	}
	if svc.installCalls != 1 {
		t.Fatalf("expected install once, got %d", svc.installCalls)
	}
	if svc.startCalls != 0 {
		t.Fatalf("expected no start, got %d", svc.startCalls)
	}
}

func TestRunServiceCommandInstallStatusUnknownWithConfigReinstalls(t *testing.T) {
	restore := stubServiceLifecycle(t, []fakeServiceStatusResult{{status: kservice.StatusUnknown, err: errors.New("service in failed state")}})
	defer restore()

	serviceConfigExistsFunc = func() bool { return true }
	installBinaryFunc = func(string) error { return nil }

	if err := runServiceCommand("install", false, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	svc := lastFakeService(t)
	if svc.uninstallCalls != 1 {
		t.Fatalf("expected uninstall once, got %d", svc.uninstallCalls)
	}
	if svc.installCalls != 1 {
		t.Fatalf("expected install once, got %d", svc.installCalls)
	}
}

func TestRunServiceCommandInstallStatusUnknownWithoutConfigFails(t *testing.T) {
	restore := stubServiceLifecycle(t, []fakeServiceStatusResult{{status: kservice.StatusUnknown, err: errors.New("boom")}})
	defer restore()

	serviceConfigExistsFunc = func() bool { return false }
	installBinaryFunc = func(string) error { return nil }

	err := runServiceCommand("install", false, nil)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected boom error, got %v", err)
	}
}

type fakeService struct {
	kservice.Service
	statuses       []fakeServiceStatusResult
	status         kservice.Status
	err            error
	installCalls   int
	uninstallCalls int
	startCalls     int
	stopCalls      int
}

func (s fakeService) Status() (kservice.Status, error) {
	if len(s.statuses) == 0 {
		return s.status, s.err
	}
	result := s.statuses[0]
	s.statuses = s.statuses[1:]
	s.status = result.status
	s.err = result.err
	return result.status, result.err
}

func (s *fakeService) Install() error {
	s.installCalls++
	return nil
}

func (s *fakeService) Uninstall() error {
	s.uninstallCalls++
	return nil
}

func (s *fakeService) Start() error {
	s.startCalls++
	return nil
}

func (s *fakeService) Stop() error {
	s.stopCalls++
	return nil
}

type fakeServiceStatusResult struct {
	status kservice.Status
	err    error
}

var fakeServices []*fakeService

func stubServiceLifecycle(t *testing.T, statuses []fakeServiceStatusResult) func() {
	t.Helper()

	prevInstallBinary := installBinaryFunc
	prevNewService := newServiceFunc
	prevConfigExists := serviceConfigExistsFunc
	fakeServices = nil

	newServiceFunc = func(bool, string, []string, Runner) (kservice.Service, error) {
		svc := &fakeService{statuses: append([]fakeServiceStatusResult(nil), statuses...)}
		fakeServices = append(fakeServices, svc)
		return svc, nil
	}

	return func() {
		installBinaryFunc = prevInstallBinary
		newServiceFunc = prevNewService
		serviceConfigExistsFunc = prevConfigExists
		fakeServices = nil
	}
}

func lastFakeService(t *testing.T) *fakeService {
	t.Helper()
	if len(fakeServices) == 0 {
		t.Fatal("expected fake service")
	}
	return fakeServices[len(fakeServices)-1]
}

func (s *fakeService) Logger(chan<- error) (kservice.Logger, error) {
	return nil, fmt.Errorf("not implemented")
}

func (s *fakeService) SystemLogger(chan<- error) (kservice.Logger, error) {
	return nil, fmt.Errorf("not implemented")
}

func (s *fakeService) String() string {
	return ServiceName
}

func (s *fakeService) Platform() string {
	return runtime.GOOS
}
