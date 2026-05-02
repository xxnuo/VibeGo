package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/github"
	"github.com/xxnuo/vibego/internal/service/settings"
	"gorm.io/gorm"
)

const (
	githubTokenSettingKey = "github.access_token"
	maxGitHubOAuthStates  = 1024
	defaultGitHubScope    = "repo user workflow"
)

var allowedGitHubScopes = map[string]struct{}{
	"repo": {}, "user": {}, "workflow": {}, "read:user": {},
	"user:email": {}, "read:org": {},
}

// GitHubHandler exposes the provider-facing contract for the Git workbench.
// Tokens are intentionally kept outside all response types.
type GitHubHandler struct {
	client      *github.Client
	settings    *settings.Store
	staticToken string

	mu           sync.Mutex
	runtimeToken string
	oauthStates  map[string]oauthState
}

type oauthState struct {
	createdAt time.Time
	expiresAt time.Time
}

func NewGitHubHandler(db *gorm.DB) *GitHubHandler {
	cfg := github.ConfigFromEnv()
	return newGitHubHandler(db, github.NewClient(cfg), cfg.Token)
}

func NewGitHubHandlerWithConfig(db *gorm.DB, cfg github.Config) *GitHubHandler {
	return newGitHubHandler(db, github.NewClient(cfg), cfg.Token)
}

func NewGitHubHandlerWithClient(db *gorm.DB, client *github.Client) *GitHubHandler {
	return newGitHubHandler(db, client, "")
}

func newGitHubHandler(db *gorm.DB, client *github.Client, staticToken string) *GitHubHandler {
	h := &GitHubHandler{
		client:      client,
		staticToken: strings.TrimSpace(staticToken),
		oauthStates: make(map[string]oauthState),
	}
	if db != nil {
		h.settings = settings.New(db)
	}
	return h
}

// SetStaticToken is useful for embedding VibeGo with an injected secret
// provider. The value is never emitted in a response.
func (h *GitHubHandler) SetStaticToken(token string) {
	h.mu.Lock()
	h.staticToken = strings.TrimSpace(token)
	h.mu.Unlock()
}

func (h *GitHubHandler) Register(r *gin.RouterGroup) {
	h.RegisterPublicAuthRoutes(r)
	h.RegisterProtectedRoutes(r)
}

// RegisterPublicAuthRoutes registers OAuth provider callbacks that must be
// reachable without the VibeGo API key. The callback is protected by its
// short-lived state value instead of the API-key middleware.
func (h *GitHubHandler) RegisterPublicAuthRoutes(r *gin.RouterGroup) {
	g := r.Group("/github")
	g.GET("/auth/callback", h.AuthCallback)
}

// RegisterProtectedRoutes registers all GitHub endpoints that are initiated by
// the VibeGo client and therefore remain behind the normal API middleware.
func (h *GitHubHandler) RegisterProtectedRoutes(r *gin.RouterGroup) {
	g := r.Group("/github")
	g.GET("/auth/status", h.AuthStatus)
	g.GET("/status", h.AuthStatus)
	g.POST("/auth/token", h.SetToken)
	g.POST("/auth/logout", h.Logout)
	g.GET("/auth/start", h.AuthStart)
	g.POST("/auth/device/start", h.DeviceStart)
	g.POST("/auth/device/poll", h.DevicePoll)
	g.POST("/auth/device/cancel", h.DeviceCancel)

	g.GET("/remote", h.ParseRemote)
	g.POST("/remote/parse", h.ParseRemote)
	g.GET("/account", h.Account)
	g.GET("/repository", h.Repository)
	g.POST("/repository", h.CreateRepository)
	g.POST("/publish", h.Publish)
	g.GET("/pull-requests", h.PullRequests)
	g.GET("/pull-requests/:number", h.PullRequest)
	g.POST("/pull-requests", h.CreatePullRequest)
	g.GET("/issues", h.Issues)
	g.POST("/issues", h.CreateIssue)
	// Actions/checks endpoints. The canonical names are workflow-runs,
	// workflow-jobs and check-suites; the /actions/runs aliases mirror GitHub's
	// REST vocabulary for integrations that already use those paths. Static
	// action names are registered before the parameterized variants so Gin does
	// not route "rerun" as an ID.
	g.GET("/workflow-runs", h.WorkflowRuns)
	g.GET("/actions/runs", h.WorkflowRuns)
	g.POST("/check-suites/rerun", h.RerunCheckSuite)
	g.POST("/check-suites/:id/rerun", h.RerunCheckSuite)
	g.POST("/check-suites/:id/rerequest", h.RerunCheckSuite)
	g.POST("/actions/check-suites/:id/rerequest", h.RerunCheckSuite)
	g.POST("/workflow-runs/rerun", h.RerunWorkflowRun)
	g.POST("/workflow-runs/rerun-failed", h.RerunFailedJobs)
	g.POST("/workflow-runs/rerun-failed-jobs", h.RerunFailedJobs)
	g.POST("/workflow-runs/:id/rerun", h.RerunWorkflowRun)
	g.POST("/workflow-runs/:id/rerun-failed", h.RerunFailedJobs)
	g.POST("/workflow-runs/:id/rerun-failed-jobs", h.RerunFailedJobs)
	g.POST("/workflow-jobs/rerun", h.RerunWorkflowJob)
	g.POST("/workflow-jobs/:id/rerun", h.RerunWorkflowJob)
	g.POST("/actions/runs/:id/rerun", h.RerunWorkflowRun)
	g.POST("/actions/runs/:id/rerun-failed-jobs", h.RerunFailedJobs)
	g.POST("/actions/jobs/:id/rerun", h.RerunWorkflowJob)
	g.GET("/workflow-runs/:id/jobs", h.WorkflowRunJobs)
	g.GET("/actions/runs/:id/jobs", h.WorkflowRunJobs)
	g.GET("/workflow-jobs/:id/steps", h.WorkflowJobSteps)
	g.GET("/actions/jobs/:id/steps", h.WorkflowJobSteps)
	g.GET("/workflow-runs/:id", h.WorkflowRun)
	g.GET("/actions/runs/:id", h.WorkflowRun)
	g.GET("/workflow-jobs/:id", h.WorkflowJob)
	g.GET("/actions/jobs/:id", h.WorkflowJob)
	g.GET("/check-suites", h.CheckSuites)
	g.GET("/check-suites/:id", h.CheckSuite)
	g.GET("/organizations", h.Organizations)
	g.GET("/orgs", h.Organizations)
	g.GET("/checks", h.Checks)
	g.POST("/checks/:id/rerun", h.RerunCheck)
	g.POST("/checks/rerun", h.RerunCheck)
}

type githubErrorResponse struct {
	Success   bool              `json:"success"`
	Error     string            `json:"error"`
	Code      string            `json:"code"`
	Status    int               `json:"status,omitempty"`
	RequestID string            `json:"request_id,omitempty"`
	Details   map[string]string `json:"details,omitempty"`
}

func githubError(c *gin.Context, status int, code, message string) {
	if status < 400 {
		status = http.StatusInternalServerError
	}
	c.JSON(status, githubErrorResponse{Success: false, Error: sanitizeGitHubMessage(message), Code: code, Status: status})
}

func githubClientError(c *gin.Context, err error) {
	var apiErr *github.APIError
	if errors.As(err, &apiErr) {
		status := apiErr.StatusCode
		if status < 400 {
			status = http.StatusBadGateway
		}
		if status == http.StatusUnauthorized {
			status = http.StatusUnauthorized
		}
		if status == http.StatusForbidden {
			status = http.StatusForbidden
		}
		resp := githubErrorResponse{
			Success:   false,
			Error:     sanitizeGitHubMessage(apiErr.Message),
			Code:      apiErr.Code,
			Status:    status,
			RequestID: apiErr.RequestID,
		}
		if apiErr.DocumentationURL != "" {
			resp.Details = map[string]string{"documentation_url": sanitizeGitHubMessage(apiErr.DocumentationURL)}
		}
		c.JSON(status, resp)
		return
	}
	githubError(c, http.StatusBadGateway, "github_request_failed", sanitizeGitHubError(err))
}

func sanitizeGitHubError(err error) string {
	if err == nil {
		return "GitHub request failed"
	}
	return sanitizeGitHubMessage(err.Error())
}

func sanitizeGitHubMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "GitHub request failed"
	}
	var builder strings.Builder
	for _, r := range message {
		if unicode.IsControl(r) {
			if r == '\t' || r == ' ' {
				builder.WriteRune(r)
			}
			continue
		}
		builder.WriteRune(r)
		if builder.Len() >= 512 {
			break
		}
	}
	result := strings.TrimSpace(builder.String())
	if result == "" {
		return "GitHub request failed"
	}
	if len([]rune(result)) > 512 {
		runes := []rune(result)
		result = string(runes[:509]) + "..."
	}
	return result
}

func sanitizeGitHubOAuthError(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "access_denied":
		return "GitHub OAuth authorization was denied"
	case "login_required":
		return "GitHub OAuth login is required"
	case "unauthorized_client":
		return "GitHub OAuth client is not authorized"
	case "invalid_request":
		return "GitHub OAuth request was invalid"
	case "unsupported_response_type":
		return "GitHub OAuth response type is unsupported"
	case "server_error", "temporarily_unavailable":
		return "GitHub OAuth service is temporarily unavailable"
	default:
		return "GitHub OAuth authorization was denied"
	}
}

func githubOK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, Response{Success: true, Data: data})
}

func githubCreated(c *gin.Context, data any) {
	c.JSON(http.StatusCreated, Response{Success: true, Data: data})
}

func (h *GitHubHandler) token() (token, source string) {
	h.mu.Lock()
	staticToken := h.staticToken
	runtimeToken := h.runtimeToken
	h.mu.Unlock()
	if staticToken != "" {
		return staticToken, "environment"
	}
	if runtimeToken != "" {
		return runtimeToken, "session"
	}
	if h.settings != nil {
		if value, err := h.settings.Get(githubTokenSettingKey); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value), "stored"
		}
		// Read the legacy spellings once so existing installations can migrate
		// without exposing either key through the generic settings API.
		for _, key := range []string{"github_token", "githubToken"} {
			if value, err := h.settings.Get(key); err == nil && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value), "stored"
			}
		}
	}
	return "", ""
}

func (h *GitHubHandler) requireToken(c *gin.Context) string {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return ""
	}
	token, _ := h.token()
	if token == "" {
		githubError(c, http.StatusUnauthorized, "github_auth_required", "GitHub authentication is required")
		return ""
	}
	return token
}

type githubAuthStatus struct {
	Authenticated    bool   `json:"authenticated"`
	Source           string `json:"source,omitempty"`
	OAuthConfigured  bool   `json:"oauth_configured"`
	DeviceConfigured bool   `json:"device_configured"`
}

func (h *GitHubHandler) AuthStatus(c *gin.Context) {
	token, source := h.token()
	githubOK(c, githubAuthStatus{
		Authenticated:    token != "",
		Source:           source,
		OAuthConfigured:  h.oauthConfigured(),
		DeviceConfigured: h.deviceConfigured(),
	})
}

type githubTokenRequest struct {
	Token string `json:"token" binding:"required"`
}

func (h *GitHubHandler) SetToken(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	var req githubTokenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "token is required")
		return
	}
	token := strings.TrimSpace(req.Token)
	if token == "" || len(token) > 4096 || strings.ContainsAny(token, "\r\n\x00") {
		githubError(c, http.StatusBadRequest, "invalid_token", "token is invalid")
		return
	}
	if h.client != nil {
		if _, err := h.client.GetUser(c.Request.Context(), token); err != nil {
			githubClientError(c, err)
			return
		}
	}
	if h.settings == nil {
		h.mu.Lock()
		h.runtimeToken = token
		h.mu.Unlock()
		githubOK(c, gin.H{"authenticated": true, "source": "session"})
		return
	}
	if err := h.settings.Set(githubTokenSettingKey, token); err != nil {
		githubError(c, http.StatusInternalServerError, "github_credential_store_failed", "failed to store GitHub credential")
		return
	}
	h.mu.Lock()
	h.runtimeToken = ""
	h.mu.Unlock()
	githubOK(c, gin.H{"authenticated": true, "source": "stored"})
}

func (h *GitHubHandler) Logout(c *gin.Context) {
	if h.settings != nil {
		if err := h.settings.Delete(githubTokenSettingKey); err != nil {
			githubError(c, http.StatusInternalServerError, "github_credential_store_failed", "failed to remove GitHub credential")
			return
		}
		for _, key := range []string{"github_token", "githubToken"} {
			_ = h.settings.Delete(key)
		}
	}
	h.mu.Lock()
	h.runtimeToken = ""
	h.mu.Unlock()
	// A process-configured token cannot be revoked by a request; report the
	// resulting state without exposing whether or where it is stored.
	token, source := h.token()
	githubOK(c, githubAuthStatus{Authenticated: token != "", Source: source, OAuthConfigured: h.oauthConfigured(), DeviceConfigured: h.deviceConfigured()})
}

func (h *GitHubHandler) oauthConfigured() bool {
	if h.client == nil || h.client.ClientID() == "" || !h.client.HasClientSecret() {
		return false
	}
	return isHTTPConfigurationURL(h.client.OAuthAuthorizeURL()) && isHTTPConfigurationURL(h.client.OAuthTokenURL())
}

func (h *GitHubHandler) deviceConfigured() bool {
	return h.client != nil && h.client.ClientID() != "" && isHTTPConfigurationURL(h.client.DeviceURL()) && isHTTPConfigurationURL(h.client.OAuthTokenURL())
}

func isHTTPConfigurationURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && parsed.Host != "" && parsed.User == nil && (strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https"))
}

func randomState() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func normalizeGitHubScope(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultGitHubScope, nil
	}
	seen := make(map[string]struct{})
	result := make([]string, 0, 6)
	for _, scope := range strings.FieldsFunc(raw, func(r rune) bool { return r == ' ' || r == ',' }) {
		scope = strings.TrimSpace(scope)
		if _, ok := allowedGitHubScopes[scope]; !ok {
			return "", fmt.Errorf("GitHub OAuth scope %q is not allowed", scope)
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		result = append(result, scope)
	}
	if len(result) == 0 {
		return defaultGitHubScope, nil
	}
	return strings.Join(result, " "), nil
}

func (h *GitHubHandler) rememberOAuthState(state string, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, value := range h.oauthStates {
		if !now.Before(value.expiresAt) {
			delete(h.oauthStates, key)
		}
	}
	if len(h.oauthStates) >= maxGitHubOAuthStates {
		var oldestKey string
		var oldest time.Time
		for key, value := range h.oauthStates {
			if oldestKey == "" || value.createdAt.Before(oldest) {
				oldestKey, oldest = key, value.createdAt
			}
		}
		delete(h.oauthStates, oldestKey)
	}
	h.oauthStates[state] = oauthState{createdAt: now, expiresAt: now.Add(10 * time.Minute)}
}

func (h *GitHubHandler) AuthStart(c *gin.Context) {
	if !h.oauthConfigured() {
		githubError(c, http.StatusServiceUnavailable, "github_oauth_not_configured", "GitHub OAuth client is not configured")
		return
	}
	state, err := randomState()
	if err != nil {
		githubError(c, http.StatusInternalServerError, "github_oauth_state_failed", "failed to create OAuth state")
		return
	}
	scope, err := normalizeGitHubScope(c.Query("scope"))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_oauth_scope", err.Error())
		return
	}
	h.rememberOAuthState(state, time.Now())
	values := url.Values{}
	values.Set("client_id", h.client.ClientID())
	values.Set("state", state)
	values.Set("scope", scope)
	if redirect := h.client.RedirectURL(); redirect != "" {
		values.Set("redirect_uri", redirect)
	}
	authorizeURL, parseErr := url.Parse(h.client.OAuthAuthorizeURL())
	if parseErr != nil || !isHTTPConfigurationURL(h.client.OAuthAuthorizeURL()) {
		githubError(c, http.StatusServiceUnavailable, "github_oauth_not_configured", "GitHub OAuth authorize URL is invalid")
		return
	}
	query := authorizeURL.Query()
	for key, list := range values {
		if len(list) > 0 {
			query.Set(key, list[0])
		}
	}
	authorizeURL.RawQuery = query.Encode()
	githubOK(c, gin.H{"url": authorizeURL.String(), "state": state})
}

func (h *GitHubHandler) AuthCallback(c *gin.Context) {
	state := strings.TrimSpace(c.Query("state"))
	if state == "" {
		githubError(c, http.StatusBadRequest, "invalid_oauth_state", "OAuth state is required")
		return
	}
	h.mu.Lock()
	value, ok := h.oauthStates[state]
	if ok {
		delete(h.oauthStates, state)
	}
	h.mu.Unlock()
	if !ok || time.Now().After(value.expiresAt) {
		githubError(c, http.StatusBadRequest, "invalid_oauth_state", "OAuth state is invalid or expired")
		return
	}
	if oauthErr := strings.TrimSpace(c.Query("error")); oauthErr != "" {
		githubError(c, http.StatusBadRequest, "github_oauth_denied", sanitizeGitHubOAuthError(oauthErr))
		return
	}
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	code := strings.TrimSpace(c.Query("code"))
	if code == "" || len(code) > 4096 || strings.ContainsAny(code, "\r\n\x00") {
		githubError(c, http.StatusBadRequest, "invalid_request", "OAuth code is required")
		return
	}
	token, err := h.client.ExchangeOAuthCode(c.Request.Context(), code, h.client.RedirectURL())
	if err != nil {
		githubClientError(c, err)
		return
	}
	account, err := h.client.GetUser(c.Request.Context(), token.AccessToken)
	if err != nil {
		githubClientError(c, err)
		return
	}
	if err := h.saveToken(token.AccessToken); err != nil {
		githubError(c, http.StatusInternalServerError, "github_credential_store_failed", "failed to store GitHub credential")
		return
	}
	githubOK(c, account)
}

func (h *GitHubHandler) saveToken(token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("empty token")
	}
	if h.settings != nil {
		if err := h.settings.Set(githubTokenSettingKey, token); err != nil {
			return err
		}
		h.mu.Lock()
		h.runtimeToken = ""
		h.mu.Unlock()
		return nil
	}
	h.mu.Lock()
	h.runtimeToken = token
	h.mu.Unlock()
	return nil
}

type githubDeviceStartResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete,omitempty"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

func (h *GitHubHandler) DeviceStart(c *gin.Context) {
	if !h.deviceConfigured() {
		githubError(c, http.StatusServiceUnavailable, "github_oauth_not_configured", "GitHub OAuth client is not configured")
		return
	}
	scope, scopeErr := normalizeGitHubScope(c.Query("scope"))
	if scopeErr != nil {
		githubError(c, http.StatusBadRequest, "invalid_oauth_scope", scopeErr.Error())
		return
	}
	result, err := h.client.StartDeviceFlow(c.Request.Context(), scope)
	if err != nil {
		githubClientError(c, err)
		return
	}
	// The endpoint is protected by the VibeGo API middleware; the device code is
	// returned only to the caller that initiated the short-lived flow.
	githubOK(c, result)
}

type githubDevicePollRequest struct {
	DeviceCode string `json:"device_code" binding:"required"`
}

func (h *GitHubHandler) DevicePoll(c *gin.Context) {
	if !h.deviceConfigured() {
		githubError(c, http.StatusServiceUnavailable, "github_oauth_not_configured", "GitHub OAuth client is not configured")
		return
	}
	var req githubDevicePollRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_device_code", "device_code is required")
		return
	}
	deviceCode := strings.TrimSpace(req.DeviceCode)
	if deviceCode == "" || len(deviceCode) > 4096 || strings.ContainsAny(deviceCode, "\r\n\x00") {
		githubError(c, http.StatusBadRequest, "invalid_device_code", "device_code is required")
		return
	}
	token, err := h.client.PollDeviceFlow(c.Request.Context(), deviceCode)
	if err != nil {
		var apiErr *github.APIError
		if errors.As(err, &apiErr) && (apiErr.Code == "github_authorization_pending" || apiErr.Code == "github_slow_down") {
			c.JSON(http.StatusAccepted, githubErrorResponse{Success: false, Error: apiErr.Message, Code: apiErr.Code, Status: http.StatusAccepted})
			return
		}
		githubClientError(c, err)
		return
	}
	account, err := h.client.GetUser(c.Request.Context(), token.AccessToken)
	if err != nil {
		githubClientError(c, err)
		return
	}
	if err := h.saveToken(token.AccessToken); err != nil {
		githubError(c, http.StatusInternalServerError, "github_credential_store_failed", "failed to store GitHub credential")
		return
	}
	githubOK(c, account)
}

func (h *GitHubHandler) DeviceCancel(c *gin.Context) {
	// GitHub device codes expire server-side. The endpoint exists so clients can
	// cancel their local polling loop without needing a token-bearing request.
	githubOK(c, gin.H{"cancelled": true})
}

func (h *GitHubHandler) Account(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	account, err := h.client.GetUser(c.Request.Context(), token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, account)
}

type githubRepoRequest struct {
	Remote     string `json:"remote" form:"remote"`
	URL        string `json:"url" form:"url"`
	Owner      string `json:"owner" form:"owner"`
	Repo       string `json:"repo" form:"repo"`
	Repository string `json:"repository" form:"repository"`
}

func (h *GitHubHandler) ParseRemote(c *gin.Context) {
	req, err := parseGitHubRepoRequest(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	remote, err := h.resolveRemote(c, req)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_remote", err.Error())
		return
	}
	githubOK(c, remote)
}

func parseGitHubRepoRequest(c *gin.Context) (githubRepoRequest, error) {
	req := githubRepoRequest{
		Remote:     c.Query("remote"),
		URL:        c.Query("url"),
		Owner:      c.Query("owner"),
		Repo:       c.Query("repo"),
		Repository: c.Query("repository"),
	}
	if c.Request.Method != http.MethodPost || c.Request.Body == nil {
		return req, nil
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.SplitN(c.GetHeader("Content-Type"), ";", 2)[0]))
	if contentType != "" && contentType != "application/json" {
		return req, nil
	}
	var body githubRepoRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return req, nil
		}
		return githubRepoRequest{}, errors.New("request body must be valid JSON")
	}
	if body.Remote != "" {
		req.Remote = body.Remote
	}
	if body.URL != "" {
		req.URL = body.URL
	}
	if body.Owner != "" {
		req.Owner = body.Owner
	}
	if body.Repo != "" {
		req.Repo = body.Repo
	}
	if body.Repository != "" {
		req.Repository = body.Repository
	}
	return req, nil
}

func (h *GitHubHandler) resolveRemote(c *gin.Context, req githubRepoRequest) (github.Remote, error) {
	if req.Remote == "" {
		req.Remote = req.URL
	}
	if req.Remote != "" {
		remote, err := github.ParseGitHubRemote(req.Remote)
		if err != nil {
			return github.Remote{}, err
		}
		if h.client != nil {
			if err := h.client.ValidateRemoteHost(remote.Host); err != nil {
				return github.Remote{}, err
			}
		}
		return remote, nil
	}
	if req.Owner == "" || req.Repo == "" {
		req.Repo = req.Repository
	}
	if req.Owner == "" || req.Repo == "" {
		return github.Remote{}, errors.New("remote or owner/repository is required")
	}
	host := "github.com"
	if h.client != nil {
		if configuredHost := h.client.RemoteHost(); configuredHost != "" {
			host = configuredHost
		}
	}
	remote, err := github.ParseGitHubRemote("https://" + host + "/" + req.Owner + "/" + req.Repo)
	if err != nil {
		return github.Remote{}, err
	}
	if h.client != nil {
		if err := h.client.ValidateRemoteHost(remote.Host); err != nil {
			return github.Remote{}, err
		}
	}
	return remote, nil
}

func queryRepoRequest(c *gin.Context) githubRepoRequest {
	return githubRepoRequest{Remote: c.Query("remote"), URL: c.Query("url"), Owner: c.Query("owner"), Repo: c.Query("repo"), Repository: c.Query("repository")}
}

func (h *GitHubHandler) Repository(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	token, _ := h.token()
	repo, err := h.client.GetRepository(c.Request.Context(), remote.Owner, remote.Repository, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, repo)
}

type createRepositoryRequest struct {
	Name         string `json:"name" binding:"required"`
	Description  string `json:"description"`
	Private      bool   `json:"private"`
	Organization string `json:"organization"`
}

func (h *GitHubHandler) CreateRepository(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req createRepositoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	repo, err := h.createRepository(c.Request.Context(), req, token)
	if err != nil {
		if apiErr, ok := err.(*github.APIError); ok && (apiErr.Code == "invalid_repository_name" || apiErr.Code == "invalid_organization") {
			githubError(c, http.StatusBadRequest, apiErr.Code, apiErr.Message)
		} else {
			githubClientError(c, err)
		}
		return
	}
	githubCreated(c, repo)
}

func (h *GitHubHandler) createRepository(ctx context.Context, req createRepositoryRequest, token string) (github.Repository, error) {
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 || strings.ContainsAny(req.Name, "/\\\r\n\x00") {
		return github.Repository{}, &github.APIError{Code: "invalid_repository_name", Message: "repository name is invalid"}
	}
	path := "/user/repos"
	if req.Organization != "" {
		if _, err := github.ParseGitHubRemote("https://github.com/" + req.Organization + "/placeholder"); err != nil {
			return github.Repository{}, &github.APIError{Code: "invalid_organization", Message: "organization is invalid"}
		}
		path = "/orgs/" + url.PathEscape(req.Organization) + "/repos"
	}
	var repo github.Repository
	if err := h.client.DoJSON(ctx, http.MethodPost, path, token, req, &repo); err != nil {
		return github.Repository{}, err
	}
	return repo, nil
}

// Publish creates the provider-side repository and returns its clone URL.
// Local remote setup/push remains the responsibility of the existing Git API;
// keeping those side effects separate makes retries idempotent and auditable.
func (h *GitHubHandler) Publish(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req createRepositoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	repo, err := h.createRepository(c.Request.Context(), req, token)
	if err != nil {
		if apiErr, ok := err.(*github.APIError); ok && (apiErr.Code == "invalid_repository_name" || apiErr.Code == "invalid_organization") {
			githubError(c, http.StatusBadRequest, apiErr.Code, apiErr.Message)
		} else {
			githubClientError(c, err)
		}
		return
	}
	githubCreated(c, gin.H{"repository": repo, "clone_url": repo.CloneURL, "ssh_url": repo.SSHURL, "html_url": repo.HTMLURL})
}

func parsePage(c *gin.Context) (int, int, error) {
	page, perPage := 1, 30
	if raw := c.Query("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 10000 {
			return 0, 0, errors.New("page must be between 1 and 10000")
		}
		page = parsed
	}
	if raw := c.Query("per_page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			return 0, 0, errors.New("per_page must be between 1 and 100")
		}
		perPage = parsed
	}
	return page, perPage, nil
}

func (h *GitHubHandler) PullRequests(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	page, perPage, err := parsePage(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	state := strings.TrimSpace(c.Query("state"))
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "closed" && state != "all" {
		githubError(c, http.StatusBadRequest, "invalid_state", "state must be open, closed, or all")
		return
	}
	token, _ := h.token()
	items, err := h.client.ListPullRequests(c.Request.Context(), remote.Owner, remote.Repository, state, page, perPage, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"repository": remote, "items": items, "page": page, "per_page": perPage})
}

func (h *GitHubHandler) PullRequest(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	number, err := strconv.Atoi(c.Param("number"))
	if err != nil || number < 1 {
		githubError(c, http.StatusBadRequest, "invalid_pull_request", "pull request number is invalid")
		return
	}
	token, _ := h.token()
	item, err := h.client.GetPullRequest(c.Request.Context(), remote.Owner, remote.Repository, number, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, item)
}

type createPullRequestRequest struct {
	githubRepoRequest
	Title string `json:"title" binding:"required"`
	Body  string `json:"body"`
	Head  string `json:"head" binding:"required"`
	Base  string `json:"base" binding:"required"`
	Draft bool   `json:"draft"`
}

func (h *GitHubHandler) CreatePullRequest(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req createPullRequestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "title, head, base, and repository are required")
		return
	}
	remote, err := h.resolveRemote(c, req.githubRepoRequest)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	if err := validateGitHubText(req.Title, 256, "title"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pull_request", err.Error())
		return
	}
	if err := validateGitHubRef(req.Head, "head"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pull_request", err.Error())
		return
	}
	if err := validateGitHubRef(req.Base, "base"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pull_request", err.Error())
		return
	}
	item, err := h.client.CreatePullRequest(c.Request.Context(), remote.Owner, remote.Repository, github.PullRequestInput{Title: strings.TrimSpace(req.Title), Body: req.Body, Head: strings.TrimSpace(req.Head), Base: strings.TrimSpace(req.Base), Draft: req.Draft}, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubCreated(c, item)
}

func (h *GitHubHandler) Issues(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	page, perPage, err := parsePage(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	state := strings.TrimSpace(c.Query("state"))
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "closed" && state != "all" {
		githubError(c, http.StatusBadRequest, "invalid_state", "state must be open, closed, or all")
		return
	}
	token, _ := h.token()
	items, err := h.client.ListIssues(c.Request.Context(), remote.Owner, remote.Repository, state, page, perPage, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"repository": remote, "items": items, "page": page, "per_page": perPage})
}

type createIssueRequest struct {
	githubRepoRequest
	Title     string   `json:"title" binding:"required"`
	Body      string   `json:"body"`
	Labels    []string `json:"labels"`
	Assignees []string `json:"assignees"`
}

func (h *GitHubHandler) CreateIssue(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req createIssueRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "title and repository are required")
		return
	}
	remote, err := h.resolveRemote(c, req.githubRepoRequest)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	if err := validateGitHubText(req.Title, 256, "title"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_issue", err.Error())
		return
	}
	if err := validateStringList(req.Labels, 50, 100, "labels"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_issue", err.Error())
		return
	}
	if err := validateStringList(req.Assignees, 50, 100, "assignees"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_issue", err.Error())
		return
	}
	item, err := h.client.CreateIssue(c.Request.Context(), remote.Owner, remote.Repository, github.IssueInput{Title: strings.TrimSpace(req.Title), Body: req.Body, Labels: req.Labels, Assignees: req.Assignees}, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubCreated(c, item)
}

func (h *GitHubHandler) Checks(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	ref := strings.TrimSpace(c.Query("ref"))
	if ref == "" {
		ref = strings.TrimSpace(c.Query("sha"))
	}
	if err := validateGitHubRef(ref, "ref"); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_ref", err.Error())
		return
	}
	page, perPage, err := parsePage(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	token, _ := h.token()
	status, err := h.client.GetCommitStatus(c.Request.Context(), remote.Owner, remote.Repository, ref, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	runs, err := h.client.GetCheckRuns(c.Request.Context(), remote.Owner, remote.Repository, ref, page, perPage, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"repository": remote, "ref": ref, "status": status, "check_runs": runs})
}

type rerunCheckRequest struct {
	githubRepoRequest
	ID int64 `json:"id"`
}

func (h *GitHubHandler) RerunCheck(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req rerunCheckRequest
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		githubError(c, http.StatusBadRequest, "invalid_request", "check run id and repository are required")
		return
	}
	pathOwner, pathRepo := strings.TrimSpace(c.Param("owner")), strings.TrimSpace(c.Param("repo"))
	queryOwner, queryRepo := strings.TrimSpace(c.Query("owner")), strings.TrimSpace(c.Query("repo"))
	queryRepository := strings.TrimSpace(c.Query("repository"))
	queryRemote, queryURL := strings.TrimSpace(c.Query("remote")), strings.TrimSpace(c.Query("url"))
	if queryOwner != "" {
		req.Owner = queryOwner
	}
	if queryRepo != "" {
		req.Repo = queryRepo
	}
	if queryRepository != "" {
		req.Repository = queryRepository
	}
	if queryRemote != "" {
		req.Remote = queryRemote
	}
	if queryURL != "" {
		req.URL = queryURL
	}
	if pathOwner != "" || pathRepo != "" {
		// Explicit route parameters identify the target repository and must not
		// be replaced by a conflicting body or query value.
		req.githubRepoRequest = githubRepoRequest{Owner: pathOwner, Repo: pathRepo}
	} else if queryOwner != "" || queryRepo != "" || queryRepository != "" {
		// Explicit owner/repository query parameters take precedence over a
		// body remote URL, while still allowing the owner and repo aliases to
		// be combined across sources.
		req.Remote = ""
		req.URL = ""
	}
	pathID := strings.TrimSpace(c.Param("id"))
	if pathID != "" {
		parsed, parseErr := strconv.ParseInt(pathID, 10, 64)
		if parseErr != nil {
			req.ID = 0
		} else {
			req.ID = parsed
		}
	} else if rawID := strings.TrimSpace(c.Query("id")); rawID != "" {
		parsed, parseErr := strconv.ParseInt(rawID, 10, 64)
		if parseErr != nil {
			req.ID = 0
		} else {
			req.ID = parsed
		}
	}
	if req.ID <= 0 {
		githubError(c, http.StatusBadRequest, "invalid_check_run", "check run id is invalid")
		return
	}
	remote, err := h.resolveRemote(c, req.githubRepoRequest)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	if err := h.client.RerunCheck(c.Request.Context(), remote.Owner, remote.Repository, req.ID, token); err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"rerun": true, "id": req.ID})
}

func validateGitHubText(value string, max int, name string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("%s is required", name)
	}
	if len(value) > max {
		return fmt.Errorf("%s is too long", name)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s contains invalid characters", name)
	}
	return nil
}

func validateGitHubRef(value, name string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("%s is required", name)
	}
	if len(value) > 256 || strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s is invalid", name)
	}
	if strings.HasPrefix(value, "-") || strings.Contains(value, "..") {
		return fmt.Errorf("%s is invalid", name)
	}
	return nil
}

func validateStringList(values []string, maxItems, maxLength int, name string) error {
	if len(values) > maxItems {
		return fmt.Errorf("%s has too many items", name)
	}
	for _, value := range values {
		if err := validateGitHubText(value, maxLength, name); err != nil {
			return err
		}
	}
	return nil
}
