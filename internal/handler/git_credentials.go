package handler

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/xxnuo/vibego/internal/github"
)

// githubTokenForGit reads the same server-side token used by the GitHub API
// handler. It is deliberately never copied into a command argument or remote
// URL. Environment fallback keeps the no-database server mode useful.
func (h *GitHandler) githubTokenForGit() string {
	if h != nil && h.settings != nil {
		if value, err := h.settings.Get("github.access_token"); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		for _, key := range []string{"github_token", "githubToken"} {
			if value, err := h.settings.Get(key); err == nil && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	for _, key := range []string{"VG_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func githubRemoteURL(repoRoot, remoteName string) string {
	if strings.TrimSpace(remoteName) == "" {
		return ""
	}
	cmd := newGitCommand("remote", "get-url", "--", remoteName)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func isGitHubHTTPSRemote(raw string) bool {
	_, ok := githubHTTPSRemoteHost(raw, github.ConfigFromEnv())
	return ok
}

func githubHTTPSRemoteHost(raw string, cfg github.Config) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil {
		return "", false
	}
	remote, err := github.ParseRemote(raw)
	if err != nil {
		return "", false
	}
	client := github.NewClient(cfg)
	if err := client.ValidateRemoteHost(remote.Host); err != nil {
		return "", false
	}
	// A non-standard port is eligible only when it is explicitly configured for
	// the API endpoint as well.
	if port := parsed.Port(); port != "" && port != "443" {
		base, baseErr := url.Parse(strings.TrimSpace(cfg.BaseURL))
		if baseErr != nil || base.Port() == "" || base.Port() != port {
			return "", false
		}
	}
	return remote.Host, true
}

func githubAskPassScript(host string, windows bool) string {
	if windows {
		return "@echo off\r\n" +
			"setlocal\r\n" +
			"set \"prompt=%~1\"\r\n" +
			"echo(%prompt%|%SystemRoot%\\System32\\findstr.exe /I /C:\"https://" + host + "'\" /C:\"https://" + host + ":\" /C:\"https://" + host + "/\" >nul || exit /b 1\r\n" +
			"echo(%prompt%|%SystemRoot%\\System32\\findstr.exe /I /C:\"Username for\" >nul && (echo x-access-token & exit /b 0)\r\n" +
			"echo(%prompt%|%SystemRoot%\\System32\\findstr.exe /I /C:\"Password for\" >nul && (echo %VG_GITHUB_TOKEN% & exit /b 0)\r\n" +
			"exit /b 1\r\n"
	}
	return "#!/bin/sh\n" +
		"prompt=${1-}\n" +
		"case \"$prompt\" in\n" +
		"  *\"https://" + host + "'\"*|*\"https://" + host + ":\"*|*\"https://" + host + "/\"*) ;;\n" +
		"  *) exit 1 ;;\n" +
		"esac\n" +
		"case \"$prompt\" in\n" +
		"  *Username*) printf '%s\\n' 'x-access-token' ;;\n" +
		"  *Password*) printf '%s\\n' \"$VG_GITHUB_TOKEN\" ;;\n" +
		"  *) exit 1 ;;\n" +
		"esac\n"
}

// configureGitHubAskPass installs a short-lived askpass helper for a Git
// network command. The token is supplied through the child environment only;
// the helper path and command arguments contain no credential material.
func (h *GitHandler) configureGitHubAskPass(cmd *exec.Cmd, remoteURL string) (cleanup func()) {
	cleanup = func() {}
	token := h.githubTokenForGit()
	host, validRemote := githubHTTPSRemoteHost(remoteURL, github.ConfigFromEnv())
	if token == "" || !validRemote || cmd == nil {
		return cleanup
	}

	dir, err := os.MkdirTemp("", "vibego-git-askpass-")
	if err != nil {
		return cleanup
	}
	cleanup = func() { _ = os.RemoveAll(dir) }

	name := "askpass.sh"
	contents := githubAskPassScript(host, false)
	mode := os.FileMode(0700)
	if runtime.GOOS == "windows" {
		name = "askpass.cmd"
		contents = githubAskPassScript(host, true)
		mode = 0600
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(contents), mode); err != nil {
		cleanup()
		return func() {}
	}
	// A repository or global credential.helper may be an executable shell
	// command. Clear the helper list for this process so it cannot read or
	// exfiltrate the token-bearing environment.
	if len(cmd.Args) > 0 {
		cmd.Args = append([]string{cmd.Args[0], "-c", "credential.helper="}, cmd.Args[1:]...)
	}
	cmd.Env = setGitEnv(cmd.Env, "GIT_ASKPASS", path)
	cmd.Env = setGitEnv(cmd.Env, "GIT_TERMINAL_PROMPT", "0")
	cmd.Env = setGitEnv(cmd.Env, "VG_GITHUB_TOKEN", token)
	return cleanup
}

func setGitEnv(env []string, key, value string) []string {
	prefix := key + "="
	filtered := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, prefix) {
			filtered = append(filtered, item)
		}
	}
	return append(filtered, fmt.Sprintf("%s=%s", key, value))
}

// updateGitSubmodules refreshes gitlinks after an operation that may have
// changed the checked-out commit. It is intentionally best-effort at call
// sites: a repository without credentials or with an unavailable submodule
// remote should not hide the successful parent checkout/pull.
func (h *GitHandler) autoUpdateGitSubmodules(repoRoot string) error {
	if strings.TrimSpace(repoRoot) == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(repoRoot, ".gitmodules")); err != nil {
		return nil
	}
	// Automatic post-operation refreshes must never opt into local file URLs.
	// The explicit submodule settings action carries the user confirmation and
	// is the only path that can request protocol.file.allow=always.
	args := []string{"-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive"}
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	remoteURL := githubRemoteURL(repoRoot, "origin")
	if !isGitHubHTTPSRemote(remoteURL) {
		remoteURL = githubSubmoduleURLForCredentials(repoRoot)
	}
	cleanup := h.configureGitHubAskPass(cmd, remoteURL)
	defer cleanup()
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("submodule update failed: %s", message)
	}
	return nil
}

func hasLocalSubmoduleURL(repoRoot string) bool {
	cmd := newGitCommand("config", "--file", ".gitmodules", "--get-regexp", `\.url$`)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(output), "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), " ", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		if strings.HasPrefix(value, "file://") || filepath.IsAbs(value) || strings.HasPrefix(value, "./") || strings.HasPrefix(value, "../") {
			return true
		}
	}
	return false
}

func githubSubmoduleURLForCredentials(repoRoot string) string {
	cmd := newGitCommand("config", "--file", ".gitmodules", "--get-regexp", `\.url$`)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(output), "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), " ", 2)
		if len(parts) == 2 && isGitHubHTTPSRemote(strings.TrimSpace(parts[1])) {
			return strings.TrimSpace(parts[1])
		}
	}
	return ""
}
