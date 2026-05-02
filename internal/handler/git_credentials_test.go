package handler

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestIsGitHubHTTPSRemoteOnlyAllowsGitHubDotComOverTLS(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		{name: "github https", url: "https://github.com/owner/repo.git", want: true},
		{name: "github https case", url: "HTTPS://github.com/owner/repo.git", want: true},
		{name: "github host case", url: "https://GITHUB.COM/owner/repo.git", want: true},
		{name: "nonstandard port", url: "https://github.com:8443/owner/repo.git"},
		{name: "embedded credentials", url: "https://user:secret@github.com/owner/repo.git"},
		{name: "plain http", url: "http://github.com/owner/repo.git"},
		{name: "lookalike subdomain", url: "https://evil.github.com/owner/repo.git"},
		{name: "lookalike suffix", url: "https://github.com.example/owner/repo.git"},
		{name: "enterprise requires allowlist", url: "https://github.example.com/owner/repo.git"},
		{name: "ssh", url: "git@github.com:owner/repo.git"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isGitHubHTTPSRemote(tt.url); got != tt.want {
				t.Fatalf("isGitHubHTTPSRemote(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}

func TestIsGitHubHTTPSRemoteUsesConfiguredEnterpriseHost(t *testing.T) {
	t.Setenv("VG_GITHUB_API_BASE_URL", "https://api.ghe.example/api/v3")
	if !isGitHubHTTPSRemote("https://ghe.example/owner/repo.git") {
		t.Fatal("configured Enterprise host was rejected")
	}
	if isGitHubHTTPSRemote("https://github.com/owner/repo.git") {
		t.Fatal("public GitHub host was accepted by Enterprise configuration")
	}
}

func TestSanitizeGitRemoteURLRemovesCredentials(t *testing.T) {
	for _, test := range []struct {
		input string
		want  string
	}{
		{input: "https://user:secret@example.com/owner/repo.git", want: "https://example.com/owner/repo.git"},
		{input: "user:secret@example.com:owner/repo.git", want: "example.com:owner/repo.git"},
		{input: "git@example.com:owner/repo.git", want: "git@example.com:owner/repo.git"},
	} {
		if got := sanitizeGitRemoteURL(test.input); got != test.want {
			t.Fatalf("sanitizeGitRemoteURL(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

func TestConfigureGitHubAskPassRestrictsPromptAndCredentialHelpers(t *testing.T) {
	t.Setenv("VG_GITHUB_TOKEN", "test-token")
	cmd := exec.Command("git", "version")
	h := &GitHandler{}
	cleanup := h.configureGitHubAskPass(cmd, "https://github.com/owner/repo.git")
	defer cleanup()
	if len(cmd.Args) < 4 || cmd.Args[1] != "-c" || cmd.Args[2] != "credential.helper=" {
		t.Fatalf("credential helper was not cleared: %#v", cmd.Args)
	}
	var askpass string
	for _, value := range cmd.Env {
		if strings.HasPrefix(value, "GIT_ASKPASS=") {
			askpass = strings.TrimPrefix(value, "GIT_ASKPASS=")
		}
	}
	if askpass == "" {
		t.Fatal("GIT_ASKPASS was not configured")
	}
	contents, err := os.ReadFile(askpass)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(contents), "https://github.com/") {
		t.Fatalf("askpass helper does not restrict host: %s", contents)
	}
}

func TestGitHubAskPassScriptsUseConfiguredHostAndPortablePromptMatching(t *testing.T) {
	shell := githubAskPassScript("ghe.example", false)
	if !strings.Contains(shell, "https://ghe.example") || strings.Contains(shell, "github.com") {
		t.Fatalf("unexpected shell askpass host: %s", shell)
	}
	windows := githubAskPassScript("ghe.example", true)
	if !strings.Contains(windows, "https://ghe.example") || strings.Contains(windows, "EQU") {
		t.Fatalf("Windows askpass prompt matching is unsafe or stale: %s", windows)
	}
}
