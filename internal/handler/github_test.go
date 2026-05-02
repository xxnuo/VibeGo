package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	gh "github.com/xxnuo/vibego/internal/github"
	"github.com/xxnuo/vibego/internal/middleware"
)

func setupGitHubHandlerTest(t *testing.T, serverURL string) (*GitHubHandler, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewGitHubHandlerWithConfig(nil, gh.Config{
		BaseURL:           serverURL,
		DeviceURL:         serverURL + "/device",
		OAuthTokenURL:     serverURL + "/token",
		OAuthAuthorizeURL: serverURL + "/authorize",
		ClientID:          "client",
		ClientSecret:      "secret",
	})
	r := gin.New()
	h.Register(r.Group("/api"))
	return h, r
}

func TestGitHubOAuthCallbackIsPublicButOtherRoutesAreProtected(t *testing.T) {
	h := NewGitHubHandlerWithConfig(nil, gh.Config{BaseURL: "http://127.0.0.1:1"})
	r := gin.New()
	public := r.Group("/api")
	h.RegisterPublicAuthRoutes(public)
	protected := r.Group("/api")
	protected.Use(middleware.Auth("vibego-key"))
	h.RegisterProtectedRoutes(protected)

	callback := httptest.NewRecorder()
	request, _ := http.NewRequest(http.MethodGet, "/api/github/auth/callback?state=invalid", nil)
	r.ServeHTTP(callback, request)
	if callback.Code != http.StatusBadRequest {
		t.Fatalf("callback should reach handler without API key, got %d %s", callback.Code, callback.Body.String())
	}

	status := httptest.NewRecorder()
	request, _ = http.NewRequest(http.MethodGet, "/api/github/auth/status", nil)
	r.ServeHTTP(status, request)
	if status.Code != http.StatusUnauthorized {
		t.Fatalf("protected route should require API key, got %d %s", status.Code, status.Body.String())
	}
}

func TestGitHubHandlerRemoteAndTokenBoundaries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing authorization header: %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/user":
			_, _ = w.Write([]byte(`{"login":"vibego"}`))
		case "/repos/owner/repo":
			_, _ = w.Write([]byte(`{"name":"repo","full_name":"owner/repo","html_url":"https://github.com/owner/repo"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)
	h.SetStaticToken("test-token")

	w := postJSON(r, "/api/github/remote/parse", map[string]string{"remote": "git@github.com:owner/repo.git"})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"owner":"owner"`) {
		t.Fatalf("remote parse: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/github/account", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"login":"vibego"`) || strings.Contains(w.Body.String(), "test-token") {
		t.Fatalf("account response: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req, _ = http.NewRequest(http.MethodGet, "/api/github/repository?owner=owner&repo=repo", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "owner/repo") {
		t.Fatalf("repository response: %d %s", w.Code, w.Body.String())
	}
}

func TestGitHubHandlerRejectsRemoteHostThatDoesNotMatchAPI(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		http.Error(w, "unexpected upstream request", http.StatusInternalServerError)
	}))
	defer server.Close()

	_, r := setupGitHubHandlerTest(t, server.URL)
	w := postJSON(r, "/api/github/remote/parse", map[string]string{
		"remote": "https://evil.example/owner/repo.git",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("mismatched remote host: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"invalid_remote"`) {
		t.Fatalf("unexpected error response: %s", w.Body.String())
	}
	if called {
		t.Fatal("remote parse unexpectedly contacted upstream API")
	}
}

func TestGitHubHandlerDerivesEnterpriseHostForOwnerRepoRequests(t *testing.T) {
	var gotHost string
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotHost = req.URL.Host
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       http.NoBody,
				Request:    req,
			}, nil
		}),
	}
	h := NewGitHubHandlerWithConfig(nil, gh.Config{
		BaseURL:    "https://api.ghe.example",
		HTTPClient: client,
	})
	h.SetStaticToken("enterprise-token")
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h.Register(r.Group("/api"))

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/github/repository?owner=acme&repo=widget", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("enterprise repository request: %d %s", w.Code, w.Body.String())
	}
	if gotHost != "api.ghe.example" {
		t.Fatalf("upstream host = %q, want api.ghe.example", gotHost)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestGitHubHandlerRequiresTokenForWrites(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()
	_, r := setupGitHubHandlerTest(t, server.URL)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/api/github/pull-requests", strings.NewReader(`{"owner":"o","repo":"r","title":"t","head":"h","base":"main"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d %s", w.Code, w.Body.String())
	}
}

func TestGitHubAuthStatusDoesNotExposeToken(t *testing.T) {
	_, r := setupGitHubHandlerTest(t, "http://127.0.0.1:1")
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/github/auth/status", nil)
	r.ServeHTTP(w, req)
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("auth status leaked secret: %s", w.Body.String())
	}
}

func TestGitHubOAuthCallbackValidatesAccountBeforeSavingToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"oauth-token","token_type":"bearer"}`))
		case "/user":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"token rejected"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/github/auth/start", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("auth start: %d %s", w.Code, w.Body.String())
	}
	var start struct {
		Data struct {
			State string `json:"state"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &start); err != nil {
		t.Fatal(err)
	}
	if start.Data.State == "" {
		t.Fatal("auth start did not return state")
	}

	w = httptest.NewRecorder()
	callbackURL := "/api/github/auth/callback?state=" + start.Data.State + "&code=oauth-code"
	req, _ = http.NewRequest(http.MethodGet, callbackURL, nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("auth callback: %d %s", w.Code, w.Body.String())
	}
	if token, source := h.token(); token != "" || source != "" {
		t.Fatalf("invalid OAuth token was saved: token=%q source=%q", token, source)
	}
}

func TestGitHubOAuthCallbackRequiresCode(t *testing.T) {
	_, r := setupGitHubHandlerTest(t, "http://127.0.0.1:1")
	w := httptest.NewRecorder()
	startReq, _ := http.NewRequest(http.MethodGet, "/api/github/auth/start", nil)
	r.ServeHTTP(w, startReq)
	if w.Code != http.StatusOK {
		t.Fatalf("auth start: %d %s", w.Code, w.Body.String())
	}
	var start struct {
		Data struct {
			State string `json:"state"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &start); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	callback := "/api/github/auth/callback?state=" + start.Data.State
	request, _ := http.NewRequest(http.MethodGet, callback, nil)
	r.ServeHTTP(w, request)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("missing OAuth code response: %d %s", w.Code, w.Body.String())
	}
}

func TestGitHubDevicePollValidatesAccountBeforeSavingToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"device-token","token_type":"bearer"}`))
		case "/user":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"token rejected"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)

	w := postJSON(r, "/api/github/auth/device/poll", map[string]string{"device_code": "device-code"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("device poll: %d %s", w.Code, w.Body.String())
	}
	if token, source := h.token(); token != "" || source != "" {
		t.Fatalf("invalid device token was saved: token=%q source=%q", token, source)
	}
}

func TestGitHubOAuthCallbackDoesNotEchoProviderError(t *testing.T) {
	_, r := setupGitHubHandlerTest(t, "http://127.0.0.1:1")
	w := httptest.NewRecorder()
	startReq, _ := http.NewRequest(http.MethodGet, "/api/github/auth/start", nil)
	r.ServeHTTP(w, startReq)
	if w.Code != http.StatusOK {
		t.Fatalf("auth start: %d %s", w.Code, w.Body.String())
	}
	var start struct {
		Data struct {
			State string `json:"state"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &start); err != nil {
		t.Fatal(err)
	}
	secret := strings.Repeat("provider-secret-", 100)
	callback := "/api/github/auth/callback?state=" + start.Data.State + "&error=" + url.QueryEscape(secret)
	w = httptest.NewRecorder()
	request, _ := http.NewRequest(http.MethodGet, callback, nil)
	r.ServeHTTP(w, request)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("auth callback: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "provider-secret") || len(w.Body.Bytes()) > 2048 {
		t.Fatalf("provider error was echoed or unbounded: %s", w.Body.String())
	}
}

func TestGitHubRerunPathParametersTakePrecedence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Fatalf("authorization = %q", got)
		}
		wantPath := "/repos/query-owner/query-repo/check-runs/42/rerequest"
		if r.URL.Path != wantPath {
			t.Fatalf("rerun path = %q, want %q", r.URL.Path, wantPath)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("rerun method = %q", r.Method)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)
	h.SetStaticToken("test-token")

	w := postJSON(r, "/api/github/checks/42/rerun?owner=query-owner&repo=query-repo&id=100", map[string]any{
		"owner": "body-owner",
		"repo":  "body-repo",
		"id":    99,
	})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"id":42`) {
		t.Fatalf("rerun response: %d %s", w.Code, w.Body.String())
	}
}
