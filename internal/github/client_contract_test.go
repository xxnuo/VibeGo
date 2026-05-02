package github

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientPreservesQueryAndEscapesRef(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/repos/owner/repo/commits/feature/foo/check-runs" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("page"); got != "2" {
			t.Fatalf("page = %q", got)
		}
		if got := r.URL.Query().Get("per_page"); got != "17" {
			t.Fatalf("per_page = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"total_count":0,"check_runs":[]}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL + "/api", HTTPClient: server.Client()})
	if _, err := client.GetCheckRuns(context.Background(), "owner", "repo", "feature/foo", 2, 17, ""); err != nil {
		t.Fatalf("GetCheckRuns: %v", err)
	}
}

func TestClientErrorRedactsBearerToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Bearer secret-token is invalid"}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	_, err := client.GetUser(context.Background(), "secret-token")
	if err == nil {
		t.Fatal("expected API error")
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("token leaked in error: %v", err)
	}
}

func TestClientRejectsNonHTTPEndpoints(t *testing.T) {
	client := NewClient(Config{
		BaseURL:           "file:///tmp/github-api",
		OAuthAuthorizeURL: "javascript:alert(1)",
		OAuthTokenURL:     "ftp://example.test/token",
		DeviceURL:         "//example.test/device",
		RedirectURL:       "file:///tmp/callback",
	})
	if _, err := client.GetUser(nil, ""); err == nil {
		t.Fatal("expected invalid API base URL error")
	}
	if client.OAuthAuthorizeURL() != "" || client.OAuthTokenURL() != "" || client.DeviceURL() != "" || client.RedirectURL() != "" {
		t.Fatalf("non-HTTP endpoints were retained")
	}
}

func TestPollDeviceFlowMapsPlainTextHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("unauthorized"))
	}))
	defer server.Close()
	client := NewClient(Config{BaseURL: server.URL, OAuthTokenURL: server.URL, ClientID: "client", HTTPClient: server.Client()})
	_, err := client.PollDeviceFlow(nil, "device")
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.StatusCode != http.StatusUnauthorized || apiErr.Code != "github_auth_required" {
		t.Fatalf("unexpected error: %#v", err)
	}
}

func TestParseRemoteRedactsEmbeddedCredentials(t *testing.T) {
	remote, err := ParseRemote("https://user:secret@example.com/owner/repo.git")
	if err != nil {
		t.Fatalf("ParseRemote: %v", err)
	}
	if strings.Contains(remote.URL, "secret") || strings.Contains(remote.URL, "user@") {
		t.Fatalf("credentials leaked in URL: %q", remote.URL)
	}
}

func TestValidateRemoteHostMatchesConfiguredAPI(t *testing.T) {
	client := NewClient(Config{BaseURL: "https://api.github.com/"})
	for _, host := range []string{"github.com", "GITHUB.COM."} {
		if err := client.ValidateRemoteHost(host); err != nil {
			t.Fatalf("ValidateRemoteHost(%q): %v", host, err)
		}
	}
	if err := client.ValidateRemoteHost("evil.example"); err == nil {
		t.Fatal("mismatched public host was accepted")
	}

	enterprise := NewClient(Config{BaseURL: "https://api.ghe.example/api/v3"})
	for _, host := range []string{"ghe.example", "api.ghe.example"} {
		if err := enterprise.ValidateRemoteHost(host); err != nil {
			t.Fatalf("enterprise ValidateRemoteHost(%q): %v", host, err)
		}
	}
	if err := enterprise.ValidateRemoteHost("other.ghe.example"); err == nil {
		t.Fatal("mismatched enterprise host was accepted")
	}
	if err := enterprise.ValidateRemoteHost("github.com"); err == nil {
		t.Fatal("public GitHub host was accepted by Enterprise configuration")
	}

	loopback := NewClient(Config{BaseURL: "http://127.0.0.1:9876/api"})
	if err := loopback.ValidateRemoteHost("github.com"); err != nil {
		t.Fatalf("loopback development proxy should accept public host: %v", err)
	}
}
