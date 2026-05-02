package github

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDeviceFlow(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/device" {
			if err := r.ParseForm(); err != nil || r.Form.Get("client_id") != "client" || r.Form.Get("scope") != "repo user" {
				t.Fatalf("unexpected device form: %v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(DeviceCode{DeviceCode: "device", UserCode: "ABCD", VerificationURI: "https://github.test/device", Interval: 1})
			return
		}
		if r.URL.Path == "/token" {
			if err := r.ParseForm(); err != nil || r.Form.Get("client_id") != "client" || r.Form.Get("device_code") != "device" {
				t.Fatalf("unexpected token form: %v", r.Form)
			}
			if requests == 2 {
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending", "error_description": "waiting"})
				return
			}
			_ = json.NewEncoder(w).Encode(OAuthToken{AccessToken: "secret-token", TokenType: "bearer", Scope: "repo"})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		DeviceURL:     server.URL + "/device",
		OAuthTokenURL: server.URL + "/token",
		ClientID:      "client",
		HTTPClient:    server.Client(),
	})
	device, err := client.StartDeviceFlow(context.Background(), "repo user")
	if err != nil || device.DeviceCode != "device" {
		t.Fatalf("start device flow: %#v %v", device, err)
	}
	_, err = client.PollDeviceFlow(context.Background(), device.DeviceCode)
	if apiErr, ok := err.(*APIError); !ok || apiErr.Code != "github_authorization_pending" {
		t.Fatalf("expected pending error, got %#v", err)
	}
	token, err := client.PollDeviceFlow(context.Background(), device.DeviceCode)
	if err != nil || token.AccessToken != "secret-token" {
		t.Fatalf("poll device flow: %#v %v", token, err)
	}
}

func TestDeviceFlowRejectsUnsafeVerificationURLs(t *testing.T) {
	for _, test := range []struct {
		name string
		uri  string
	}{
		{name: "javascript", uri: "javascript:alert(1)"},
		{name: "data", uri: "data:text/html,pwned"},
		{name: "relative", uri: "//evil.example/device"},
		{name: "credentials", uri: "https://user:secret@github.example/device"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(DeviceCode{
					DeviceCode:      "device",
					UserCode:        "ABCD",
					VerificationURI: test.uri,
					Interval:        1,
				})
			}))
			defer server.Close()

			client := NewClient(Config{
				BaseURL:    server.URL,
				DeviceURL:  server.URL + "/device",
				ClientID:   "client",
				HTTPClient: server.Client(),
			})
			_, err := client.StartDeviceFlow(context.Background(), "repo")
			apiErr, ok := err.(*APIError)
			if !ok || apiErr.Code != "github_auth_error" {
				t.Fatalf("expected unsafe verification URL error, got %#v", err)
			}
		})
	}
}

func TestDeviceFlowRejectsUnsafeVerificationURLComplete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(DeviceCode{
			DeviceCode:              "device",
			UserCode:                "ABCD",
			VerificationURI:         "https://github.example/device",
			VerificationURIComplete: "javascript:alert(1)",
			Interval:                1,
		})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:    server.URL,
		DeviceURL:  server.URL + "/device",
		ClientID:   "client",
		HTTPClient: server.Client(),
	})
	_, err := client.StartDeviceFlow(context.Background(), "repo")
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "github_auth_error" {
		t.Fatalf("expected unsafe complete URL error, got %#v", err)
	}
}

func TestParseRemote(t *testing.T) {
	tests := []struct {
		input string
		owner string
		repo  string
	}{
		{"https://github.com/owner/repo.git", "owner", "repo"},
		{"git@github.com:owner/repo.git", "owner", "repo"},
		{"ssh://git@github.example.com/owner/repo", "owner", "repo"},
	}
	for _, test := range tests {
		remote, err := ParseRemote(test.input)
		if err != nil || remote.Owner != test.owner || remote.Repository != test.repo {
			t.Fatalf("parse %q: %#v %v", test.input, remote, err)
		}
	}
	for _, input := range []string{"/tmp/repo", "https://github.com/owner/a/b", "https://github.com/owner/../repo"} {
		if _, err := ParseRemote(input); err == nil {
			t.Fatalf("expected invalid remote %q", input)
		}
	}
}

func TestOAuthTokenFormFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/token" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/x-www-form-urlencoded")
		_, _ = w.Write([]byte(url.Values{"access_token": {"token"}, "scope": {"repo"}}.Encode()))
	}))
	defer server.Close()
	client := NewClient(Config{BaseURL: server.URL, OAuthTokenURL: server.URL + "/token", ClientID: "client", ClientSecret: "secret", HTTPClient: server.Client()})
	token, err := client.ExchangeOAuthCode(context.Background(), "code", "")
	if err != nil || token.AccessToken != "token" || !strings.Contains(token.Scope, "repo") {
		t.Fatalf("exchange token: %#v %v", token, err)
	}
}

func TestExchangeOAuthCodeTrimsSecretAndAcceptsNilContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if got := r.Form.Get("client_secret"); got != "secret" {
			t.Fatalf("client_secret = %q, want trimmed secret", got)
		}
		if got := r.Form.Get("code"); got != "code" {
			t.Fatalf("code = %q, want trimmed code", got)
		}
		_, _ = w.Write([]byte(`{"access_token":"token","token_type":"bearer"}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		OAuthTokenURL: server.URL,
		ClientID:      "client",
		ClientSecret:  "  secret  ",
		HTTPClient:    server.Client(),
	})
	token, err := client.ExchangeOAuthCode(nil, "  code  ", "")
	if err != nil || token.AccessToken != "token" {
		t.Fatalf("exchange token: %#v %v", token, err)
	}
}

func TestOAuthProviderErrorsRedactSecretsAndAreBounded(t *testing.T) {
	const (
		clientID = "client-id"
		secret   = "client-secret"
		code     = "oauth-code"
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"` + code + ` ` + secret + ` ` + clientID + ` ` + strings.Repeat("x", 2000) + `","error_uri":"https://example.test/` + secret + `"}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		OAuthTokenURL: server.URL,
		ClientID:      clientID,
		ClientSecret:  secret,
		HTTPClient:    server.Client(),
	})
	_, err := client.ExchangeOAuthCode(nil, code, "")
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T (%v)", err, err)
	}
	for _, value := range []string{secret, code, clientID} {
		if strings.Contains(apiErr.Message, value) || strings.Contains(apiErr.DocumentationURL, value) {
			t.Fatalf("provider error leaked %q: message=%q docs=%q", value, apiErr.Message, apiErr.DocumentationURL)
		}
	}
	if got := len([]rune(apiErr.Message)); got > maxProviderErrorRunes {
		t.Fatalf("provider error message has %d runes, want <= %d", got, maxProviderErrorRunes)
	}
}

func TestPollDeviceFlowTrimsCodeAndRedactsProviderError(t *testing.T) {
	const (
		clientID = "client-id"
		secret   = "client-secret"
		code     = "device-code"
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if got := r.Form.Get("device_code"); got != code {
			t.Fatalf("device_code = %q, want trimmed code", got)
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_device_code","error_description":"` + code + ` ` + secret + ` ` + clientID + `"}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		OAuthTokenURL: server.URL,
		ClientID:      clientID,
		ClientSecret:  secret,
		HTTPClient:    server.Client(),
	})
	_, err := client.PollDeviceFlow(nil, "  "+code+"  ")
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T (%v)", err, err)
	}
	for _, value := range []string{secret, code, clientID} {
		if strings.Contains(apiErr.Message, value) {
			t.Fatalf("device error leaked %q: %q", value, apiErr.Message)
		}
	}
}

func TestExchangeOAuthCodeRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxResponseBytes+1)))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		OAuthTokenURL: server.URL,
		ClientID:      "client",
		ClientSecret:  "secret",
		HTTPClient:    server.Client(),
	})
	_, err := client.ExchangeOAuthCode(nil, "code", "")
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "github_response_too_large" {
		t.Fatalf("expected oversized response error, got %#v", err)
	}
}

func TestDeviceAndJSONRequestsRejectOversizedResponses(t *testing.T) {
	oversized := strings.Repeat("x", maxResponseBytes+1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(oversized))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		DeviceURL:     server.URL + "/device",
		OAuthTokenURL: server.URL + "/token",
		ClientID:      "client",
		ClientSecret:  "secret",
		HTTPClient:    server.Client(),
	})
	checks := []struct {
		name string
		call func() error
	}{
		{name: "device start", call: func() error { _, err := client.StartDeviceFlow(nil, "repo"); return err }},
		{name: "device poll", call: func() error { _, err := client.PollDeviceFlow(nil, "device"); return err }},
		{name: "json request", call: func() error { return client.DoJSON(nil, http.MethodGet, "/user", "", nil, &User{}) }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			err := check.call()
			apiErr, ok := err.(*APIError)
			if !ok || apiErr.Code != "github_response_too_large" {
				t.Fatalf("expected oversized response error, got %#v", err)
			}
		})
	}
}

func TestExchangeOAuthCodeHandlesProviderErrorPayload(t *testing.T) {
	const (
		clientID = "client-id"
		secret   = "client-secret"
		code     = "oauth-code"
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"` + code + ` ` + secret + ` ` + clientID + `","error_uri":"https://example.test/` + code + `"}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:       server.URL,
		OAuthTokenURL: server.URL,
		ClientID:      clientID,
		ClientSecret:  secret,
		HTTPClient:    server.Client(),
	})
	_, err := client.ExchangeOAuthCode(nil, code, "")
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "github_oauth_error" {
		t.Fatalf("expected provider OAuth error, got %#v", err)
	}
	for _, value := range []string{secret, code, clientID} {
		if strings.Contains(apiErr.Message, value) || strings.Contains(apiErr.DocumentationURL, value) {
			t.Fatalf("provider error leaked %q: message=%q docs=%q", value, apiErr.Message, apiErr.DocumentationURL)
		}
	}
}
