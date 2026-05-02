package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIBaseURL     = "https://api.github.com/"
	defaultDeviceURL      = "https://github.com/login/device/code"
	maxResponseBytes      = 8 << 20
	maxProviderErrorRunes = 1024
	maxVerificationURLLen = 4096
)

// Config controls the GitHub API and OAuth endpoints. Every URL is
// injectable, which keeps the client usable with an httptest server and with
// GitHub Enterprise installations.
type Config struct {
	BaseURL           string
	OAuthAuthorizeURL string
	OAuthTokenURL     string
	DeviceURL         string
	RedirectURL       string
	ClientID          string
	ClientSecret      string
	Token             string
	HTTPClient        *http.Client
	UserAgent         string
}

// ConfigFromEnv returns the supported environment-based configuration. The
// token is read by the server only and is never included in response structs.
func ConfigFromEnv() Config {
	baseURL := firstEnv("VG_GITHUB_API_BASE_URL", "GITHUB_API_BASE_URL")
	if baseURL == "" {
		baseURL = defaultAPIBaseURL
	}
	authorizeURL := firstEnv("VG_GITHUB_AUTHORIZE_URL", "GITHUB_AUTHORIZE_URL")
	if authorizeURL == "" {
		authorizeURL = "https://github.com/login/oauth/authorize"
	}
	tokenURL := firstEnv("VG_GITHUB_TOKEN_URL", "GITHUB_TOKEN_URL")
	if tokenURL == "" {
		tokenURL = "https://github.com/login/oauth/access_token"
	}
	deviceURL := firstEnv("VG_GITHUB_DEVICE_URL", "GITHUB_DEVICE_URL")
	if deviceURL == "" {
		deviceURL = defaultDeviceURL
	}
	return Config{
		BaseURL:           baseURL,
		OAuthAuthorizeURL: authorizeURL,
		OAuthTokenURL:     tokenURL,
		DeviceURL:         deviceURL,
		RedirectURL:       firstEnv("VG_GITHUB_REDIRECT_URL", "GITHUB_REDIRECT_URL"),
		ClientID:          firstEnv("VG_GITHUB_CLIENT_ID", "GITHUB_CLIENT_ID"),
		ClientSecret:      firstEnv("VG_GITHUB_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"),
		Token:             firstEnv("VG_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"),
		UserAgent:         firstEnv("VG_GITHUB_USER_AGENT", "GITHUB_USER_AGENT"),
	}
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

// Client is a small, dependency-free GitHub REST client. It does not retain
// request tokens unless Config.Token is explicitly provided by the caller.
type Client struct {
	baseURL      *url.URL
	authorizeURL string
	tokenURL     string
	deviceURL    string
	redirectURL  string
	clientID     string
	clientSecret string
	token        string
	httpClient   *http.Client
	userAgent    string
}

// NewClient constructs a client. Invalid endpoint URLs are retained as a
// deferred request error so callers can safely build a handler from process
// configuration and report a structured error through HTTP.
func NewClient(cfg Config) *Client {
	base := strings.TrimSpace(cfg.BaseURL)
	if base == "" {
		base = defaultAPIBaseURL
	}
	parsed, err := url.Parse(base)
	if err != nil || !validHTTPURL(parsed) {
		parsed = nil
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	ua := strings.TrimSpace(cfg.UserAgent)
	if ua == "" {
		ua = "VibeGo-GitHub/1"
	}
	return &Client{
		baseURL:      parsed,
		authorizeURL: normalizeHTTPURL(cfg.OAuthAuthorizeURL),
		tokenURL:     normalizeHTTPURL(cfg.OAuthTokenURL),
		deviceURL:    normalizeHTTPURL(cfg.DeviceURL),
		redirectURL:  normalizeHTTPURL(cfg.RedirectURL),
		clientID:     strings.TrimSpace(cfg.ClientID),
		clientSecret: strings.TrimSpace(cfg.ClientSecret),
		token:        strings.TrimSpace(cfg.Token),
		httpClient:   hc,
		userAgent:    ua,
	}
}

func validHTTPURL(parsed *url.URL) bool {
	if parsed == nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https")
}

func normalizeHTTPURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || !validHTTPURL(parsed) {
		return ""
	}
	return parsed.String()
}

// SetToken updates the optional static token used when a request does not
// provide one. The value is never serialized or logged by this package.
func (c *Client) SetToken(token string) {
	if c != nil {
		c.token = strings.TrimSpace(token)
	}
}

func (c *Client) OAuthAuthorizeURL() string {
	if c == nil {
		return ""
	}
	return c.authorizeURL
}
func (c *Client) OAuthTokenURL() string {
	if c == nil {
		return ""
	}
	return c.tokenURL
}
func (c *Client) DeviceURL() string {
	if c == nil {
		return ""
	}
	return c.deviceURL
}
func (c *Client) RedirectURL() string {
	if c == nil {
		return ""
	}
	return c.redirectURL
}
func (c *Client) ClientID() string {
	if c == nil {
		return ""
	}
	return c.clientID
}
func (c *Client) HasClientSecret() bool {
	return c != nil && strings.TrimSpace(c.clientSecret) != ""
}

// RemoteHost returns the host normally used by GitHub remotes for this API
// endpoint. Public GitHub uses github.com while Enterprise installations
// conventionally expose the API below api.<host>.
func (c *Client) RemoteHost() string {
	if c == nil || c.baseURL == nil {
		return ""
	}
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(c.baseURL.Hostname()), "."))
	if host == "api.github.com" {
		return "github.com"
	}
	return strings.TrimPrefix(host, "api.")
}

// ValidateRemoteHost ensures a parsed git remote is addressed by the API
// endpoint configured for this client. The public github.com host remains
// valid for the default provider (and for reverse-proxy based deployments),
// while Enterprise remotes must match the configured API host. Accepting an
// exact host or its conventional api.<host> form keeps GitHub Enterprise
// configurations compatible without allowing arbitrary remote hosts.
func (c *Client) ValidateRemoteHost(host string) error {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if !validHost(host) {
		return fmt.Errorf("remote host is invalid")
	}
	if c == nil || c.baseURL == nil {
		return fmt.Errorf("remote host does not match the configured GitHub API host")
	}
	configured := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(c.baseURL.Hostname()), "."))
	// The public provider maps github.com remotes to api.github.com. A
	// loopback endpoint is also accepted as an explicitly local development
	// proxy, but an Enterprise API must never silently receive a public-host
	// remote.
	if host == "github.com" {
		if configured == "github.com" || configured == "api.github.com" || isLoopbackHost(configured) {
			return nil
		}
		return fmt.Errorf("remote host %q does not match the configured GitHub API host", host)
	}
	if host == configured || configured == "api."+host || host == "api."+configured {
		return nil
	}
	return fmt.Errorf("remote host %q does not match the configured GitHub API host", host)
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// APIError is returned for non-2xx GitHub responses and transport/protocol
// failures. StatusCode is zero for local failures.
type APIError struct {
	StatusCode       int
	Code             string
	Message          string
	DocumentationURL string
	RequestID        string
	Err              error
}

func (e *APIError) Error() string {
	if e == nil {
		return "github request failed"
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	if e.StatusCode > 0 {
		return "github request failed with status " + strconv.Itoa(e.StatusCode)
	}
	return "github request failed"
}

func (e *APIError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type User struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
	HTMLURL   string `json:"html_url"`
	Type      string `json:"type"`
}

type Repository struct {
	ID            int64           `json:"id"`
	Name          string          `json:"name"`
	FullName      string          `json:"full_name"`
	Private       bool            `json:"private"`
	Description   string          `json:"description"`
	HTMLURL       string          `json:"html_url"`
	CloneURL      string          `json:"clone_url"`
	SSHURL        string          `json:"ssh_url"`
	DefaultBranch string          `json:"default_branch"`
	Owner         User            `json:"owner"`
	Permissions   map[string]bool `json:"permissions,omitempty"`
	Archived      bool            `json:"archived"`
	Visibility    string          `json:"visibility,omitempty"`
}

type BranchRef struct {
	Label string      `json:"label,omitempty"`
	Ref   string      `json:"ref,omitempty"`
	SHA   string      `json:"sha,omitempty"`
	Repo  *Repository `json:"repo,omitempty"`
}

type PullRequest struct {
	Number    int       `json:"number"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	State     string    `json:"state"`
	Draft     bool      `json:"draft"`
	HTMLURL   string    `json:"html_url"`
	APIURL    string    `json:"url"`
	User      User      `json:"user"`
	Head      BranchRef `json:"head"`
	Base      BranchRef `json:"base"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	MergedAt  *string   `json:"merged_at"`
	Mergeable *bool     `json:"mergeable"`
}

type IssueLabel struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	URL   string `json:"url"`
}

type Issue struct {
	Number      int          `json:"number"`
	Title       string       `json:"title"`
	Body        string       `json:"body"`
	State       string       `json:"state"`
	HTMLURL     string       `json:"html_url"`
	APIURL      string       `json:"url"`
	User        User         `json:"user"`
	Labels      []IssueLabel `json:"labels"`
	Comments    int          `json:"comments"`
	CreatedAt   string       `json:"created_at"`
	UpdatedAt   string       `json:"updated_at"`
	PullRequest *struct {
		URL     string `json:"url"`
		HTMLURL string `json:"html_url"`
	} `json:"pull_request,omitempty"`
}

type StatusContext struct {
	Context     string `json:"context"`
	State       string `json:"state"`
	TargetURL   string `json:"target_url"`
	URL         string `json:"url"`
	Description string `json:"description"`
}

type CommitStatus struct {
	State      string          `json:"state"`
	TotalCount int             `json:"total_count"`
	Statuses   []StatusContext `json:"statuses"`
	Repository *Repository     `json:"repository,omitempty"`
	SHA        string          `json:"sha,omitempty"`
}

type CheckRun struct {
	ID         int64          `json:"id"`
	Name       string         `json:"name"`
	NodeID     string         `json:"node_id"`
	HeadSHA    string         `json:"head_sha"`
	CheckSuite *CheckSuiteRef `json:"check_suite,omitempty"`
	Status     string         `json:"status"`
	Conclusion string         `json:"conclusion"`
	HTMLURL    string         `json:"html_url"`
	DetailsURL string         `json:"details_url"`
	Output     struct {
		Title   string `json:"title"`
		Summary string `json:"summary"`
		Text    string `json:"text"`
	} `json:"output"`
	StartedAt   string  `json:"started_at"`
	CompletedAt *string `json:"completed_at"`
}

// CheckSuiteRef is the compact check-suite reference embedded in a check-run
// response. It is separate from CheckSuite, which models the full resource.
type CheckSuiteRef struct {
	ID int64 `json:"id"`
}

type CheckRuns struct {
	TotalCount int        `json:"total_count"`
	CheckRuns  []CheckRun `json:"check_runs"`
}

// WorkflowRuns is the envelope returned by GitHub's Actions workflow-runs
// endpoints. The fields intentionally mirror GitHub's wire format so callers
// can use the response without a lossy translation layer.
type WorkflowRuns struct {
	TotalCount   int           `json:"total_count"`
	WorkflowRuns []WorkflowRun `json:"workflow_runs"`
}

// WorkflowRun is the commonly useful subset of an Actions workflow run.
// GitHub adds fields over time; unknown fields are ignored by encoding/json.
type WorkflowRun struct {
	ID                 int64  `json:"id"`
	NodeID             string `json:"node_id"`
	Name               string `json:"name"`
	DisplayTitle       string `json:"display_title,omitempty"`
	WorkflowID         int64  `json:"workflow_id"`
	WorkflowURL        string `json:"workflow_url"`
	RunNumber          int    `json:"run_number"`
	Event              string `json:"event"`
	Status             string `json:"status"`
	Conclusion         string `json:"conclusion"`
	HeadBranch         string `json:"head_branch"`
	HeadSHA            string `json:"head_sha"`
	HTMLURL            string `json:"html_url"`
	JobsURL            string `json:"jobs_url"`
	LogsURL            string `json:"logs_url"`
	RerunURL           string `json:"rerun_url"`
	CancelURL          string `json:"cancel_url"`
	CheckSuiteID       int64  `json:"check_suite_id"`
	CheckSuiteURL      string `json:"check_suite_url"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
	RunStartedAt       string `json:"run_started_at"`
	RunAttempt         int    `json:"run_attempt"`
	PreviousAttemptURL string `json:"previous_attempt_url,omitempty"`
}

type WorkflowJobs struct {
	TotalCount int           `json:"total_count"`
	Jobs       []WorkflowJob `json:"jobs"`
}

// Compatibility aliases for callers that name the collection after the
// provider resource rather than the workflow run that owns it.
type WorkflowRunJobs = WorkflowJobs
type WorkflowStep = WorkflowJobStep

// WorkflowJob contains the step list returned by the workflow-jobs endpoint.
// Steps are part of GitHub's job response; there is no separate REST endpoint
// for listing steps.
type WorkflowJob struct {
	ID            int64             `json:"id"`
	RunID         int64             `json:"run_id"`
	RunURL        string            `json:"run_url"`
	NodeID        string            `json:"node_id"`
	HeadSHA       string            `json:"head_sha"`
	URL           string            `json:"url"`
	HTMLURL       string            `json:"html_url"`
	CheckRunURL   string            `json:"check_run_url"`
	Name          string            `json:"name"`
	Status        string            `json:"status"`
	Conclusion    string            `json:"conclusion"`
	StartedAt     string            `json:"started_at"`
	CompletedAt   string            `json:"completed_at"`
	RunAttempt    int               `json:"run_attempt"`
	RunnerName    string            `json:"runner_name"`
	RunnerGroupID int64             `json:"runner_group_id"`
	RunnerGroup   string            `json:"runner_group_name"`
	Labels        []string          `json:"labels,omitempty"`
	Steps         []WorkflowJobStep `json:"steps"`
}

type WorkflowJobStep struct {
	Name        string `json:"name"`
	Number      int    `json:"number"`
	Status      string `json:"status"`
	Conclusion  string `json:"conclusion"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
	Log         string `json:"log,omitempty"`
}

type CheckSuite struct {
	ID                 int64       `json:"id"`
	NodeID             string      `json:"node_id"`
	HeadBranch         string      `json:"head_branch"`
	HeadSHA            string      `json:"head_sha"`
	URL                string      `json:"url"`
	LatestCheckRunsURL string      `json:"latest_check_runs_url"`
	RerequestURL       string      `json:"rerequest_url"`
	Status             string      `json:"status"`
	Conclusion         string      `json:"conclusion"`
	App                any         `json:"app,omitempty"`
	Repository         *Repository `json:"repository,omitempty"`
	CreatedAt          string      `json:"created_at"`
	UpdatedAt          string      `json:"updated_at"`
	Rerequestable      bool        `json:"rerequestable"`
	RunsRerequestable  bool        `json:"runs_rerequestable"`
}

type CheckSuites struct {
	TotalCount  int          `json:"total_count"`
	CheckSuites []CheckSuite `json:"check_suites"`
}

// WorkflowRunsFilter maps the filters accepted by GET /actions/runs.
// Page and PerPage use the same defaults and bounds as the other client list
// methods. CheckSuiteID <= 0 means that filter is omitted.
type WorkflowRunsFilter struct {
	Actor               string
	Branch              string
	Event               string
	Status              string
	Created             string
	HeadSHA             string
	ExcludePullRequests *bool
	CheckSuiteID        int64
	Page                int
	PerPage             int
}

type Organization struct {
	ID          int64  `json:"id"`
	Login       string `json:"login"`
	NodeID      string `json:"node_id"`
	URL         string `json:"url"`
	ReposURL    string `json:"repos_url"`
	EventsURL   string `json:"events_url"`
	HooksURL    string `json:"hooks_url"`
	IssuesURL   string `json:"issues_url"`
	MembersURL  string `json:"members_url"`
	AvatarURL   string `json:"avatar_url"`
	HTMLURL     string `json:"html_url"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	PublicRepos int    `json:"public_repos"`
}

type PullRequestInput struct {
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
	Head  string `json:"head"`
	Base  string `json:"base"`
	Draft bool   `json:"draft,omitempty"`
}

type IssueInput struct {
	Title     string   `json:"title"`
	Body      string   `json:"body,omitempty"`
	Labels    []string `json:"labels,omitempty"`
	Assignees []string `json:"assignees,omitempty"`
}

func invalidIDError(kind string) error {
	return &APIError{Code: "invalid_request", Message: kind + " id is invalid"}
}

func (c *Client) GetUser(ctx context.Context, token string) (User, error) {
	var out User
	err := c.doJSON(ctx, http.MethodGet, "/user", token, nil, &out)
	return out, err
}

func (c *Client) GetRepository(ctx context.Context, owner, repo, token string) (Repository, error) {
	var out Repository
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo), token, nil, &out)
	return out, err
}

func (c *Client) ListPullRequests(ctx context.Context, owner, repo, state string, page, perPage int, token string) ([]PullRequest, error) {
	if state == "" {
		state = "open"
	}
	values := listQuery(state, page, perPage)
	var out []PullRequest
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/pulls?"+values.Encode(), token, nil, &out)
	return out, err
}

func (c *Client) GetPullRequest(ctx context.Context, owner, repo string, number int, token string) (PullRequest, error) {
	var out PullRequest
	err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("%s/pulls/%d", repoPath(owner, repo), number), token, nil, &out)
	return out, err
}

func (c *Client) ListIssues(ctx context.Context, owner, repo, state string, page, perPage int, token string) ([]Issue, error) {
	if state == "" {
		state = "open"
	}
	values := listQuery(state, page, perPage)
	var out []Issue
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/issues?"+values.Encode(), token, nil, &out)
	return out, err
}

func (c *Client) GetCommitStatus(ctx context.Context, owner, repo, ref, token string) (CommitStatus, error) {
	var out CommitStatus
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/commits/"+url.PathEscape(ref)+"/status", token, nil, &out)
	return out, err
}

func (c *Client) GetCheckRuns(ctx context.Context, owner, repo, ref string, page, perPage int, token string) (CheckRuns, error) {
	values := listQuery("", page, perPage)
	var out CheckRuns
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/commits/"+url.PathEscape(ref)+"/check-runs?"+values.Encode(), token, nil, &out)
	return out, err
}

// ListWorkflowRuns lists Actions runs for a repository. Filter fields map
// directly to GitHub's query parameters; empty values are omitted. The
// method deliberately returns GitHub's envelope (rather than only the slice)
// so callers retain total_count for pagination.
func (c *Client) ListWorkflowRuns(ctx context.Context, owner, repo string, filter WorkflowRunsFilter, token string) (WorkflowRuns, error) {
	values := listQuery("", filter.Page, filter.PerPage)
	if value := strings.TrimSpace(filter.Actor); value != "" {
		values.Set("actor", value)
	}
	if value := strings.TrimSpace(filter.Branch); value != "" {
		values.Set("branch", value)
	}
	if value := strings.TrimSpace(filter.Event); value != "" {
		values.Set("event", value)
	}
	if value := strings.TrimSpace(filter.Status); value != "" {
		values.Set("status", value)
	}
	if value := strings.TrimSpace(filter.Created); value != "" {
		values.Set("created", value)
	}
	if value := strings.TrimSpace(filter.HeadSHA); value != "" {
		values.Set("head_sha", value)
	}
	if filter.ExcludePullRequests != nil {
		values.Set("exclude_pull_requests", strconv.FormatBool(*filter.ExcludePullRequests))
	}
	if filter.CheckSuiteID > 0 {
		values.Set("check_suite_id", strconv.FormatInt(filter.CheckSuiteID, 10))
	}
	var out WorkflowRuns
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/actions/runs?"+values.Encode(), token, nil, &out)
	return out, err
}

// GetWorkflowRuns is kept as a descriptive alias for callers that use the
// same naming convention as GetCheckRuns.
func (c *Client) GetWorkflowRuns(ctx context.Context, owner, repo string, filter WorkflowRunsFilter, token string) (WorkflowRuns, error) {
	return c.ListWorkflowRuns(ctx, owner, repo, filter, token)
}

// ListWorkflowRunsByBranch is a convenience wrapper for the common pull
// request workflow lookup used by GitHub Desktop.
func (c *Client) ListWorkflowRunsByBranch(ctx context.Context, owner, repo, branch, event string, page, perPage int, token string) (WorkflowRuns, error) {
	return c.ListWorkflowRuns(ctx, owner, repo, WorkflowRunsFilter{
		Branch:  branch,
		Event:   event,
		Page:    page,
		PerPage: perPage,
	}, token)
}

func (c *Client) GetWorkflowRun(ctx context.Context, owner, repo string, runID int64, token string) (WorkflowRun, error) {
	if runID <= 0 {
		return WorkflowRun{}, invalidIDError("workflow run")
	}
	var out WorkflowRun
	err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("%s/actions/runs/%d", repoPath(owner, repo), runID), token, nil, &out)
	return out, err
}

// ListWorkflowRunJobs returns jobs and their embedded steps for a workflow
// run. GitHub exposes steps as part of each job; no extra per-step request is
// necessary or available in the REST API.
func (c *Client) ListWorkflowRunJobs(ctx context.Context, owner, repo string, runID int64, filter string, page, perPage int, token string) (WorkflowJobs, error) {
	if runID <= 0 {
		return WorkflowJobs{}, invalidIDError("workflow run")
	}
	values := listQuery("", page, perPage)
	if filter = strings.TrimSpace(filter); filter != "" {
		values.Set("filter", filter)
	}
	var out WorkflowJobs
	err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("%s/actions/runs/%d/jobs?%s", repoPath(owner, repo), runID, values.Encode()), token, nil, &out)
	return out, err
}

// GetWorkflowRunJobs is an alias retained for callers that prefer Get* names
// for collection endpoints.
func (c *Client) GetWorkflowRunJobs(ctx context.Context, owner, repo string, runID int64, page, perPage int, token string) (WorkflowJobs, error) {
	return c.ListWorkflowRunJobs(ctx, owner, repo, runID, "", page, perPage, token)
}

// ListWorkflowJobs is an alias for ListWorkflowRunJobs that reads naturally
// at call sites which already have a run identifier.
func (c *Client) ListWorkflowJobs(ctx context.Context, owner, repo string, runID int64, page, perPage int, token string) (WorkflowJobs, error) {
	return c.ListWorkflowRunJobs(ctx, owner, repo, runID, "", page, perPage, token)
}

func (c *Client) GetWorkflowJobs(ctx context.Context, owner, repo string, runID int64, page, perPage int, token string) (WorkflowJobs, error) {
	return c.ListWorkflowRunJobs(ctx, owner, repo, runID, "", page, perPage, token)
}

func (c *Client) GetWorkflowJob(ctx context.Context, owner, repo string, jobID int64, token string) (WorkflowJob, error) {
	if jobID <= 0 {
		return WorkflowJob{}, invalidIDError("workflow job")
	}
	var out WorkflowJob
	err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("%s/actions/jobs/%d", repoPath(owner, repo), jobID), token, nil, &out)
	return out, err
}

// ListWorkflowJobSteps returns the steps embedded in a workflow job response.
// GitHub does not expose a separate REST resource for steps, so this helper
// performs one job lookup and preserves the provider's ordering.
func (c *Client) ListWorkflowJobSteps(ctx context.Context, owner, repo string, jobID int64, token string) ([]WorkflowJobStep, error) {
	job, err := c.GetWorkflowJob(ctx, owner, repo, jobID, token)
	if err != nil {
		return nil, err
	}
	return job.Steps, nil
}

func (c *Client) ListCheckSuites(ctx context.Context, owner, repo, ref string, page, perPage int, token string) (CheckSuites, error) {
	values := listQuery("", page, perPage)
	ref = strings.TrimSpace(ref)
	if ref == "" || len(ref) > 256 || strings.ContainsAny(ref, "\x00\r\n") {
		return CheckSuites{}, &APIError{Code: "invalid_request", Message: "check suite ref is invalid"}
	}
	var out CheckSuites
	err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/commits/"+url.PathEscape(ref)+"/check-suites?"+values.Encode(), token, nil, &out)
	return out, err
}

func (c *Client) GetCheckSuite(ctx context.Context, owner, repo string, suiteID int64, token string) (CheckSuite, error) {
	if suiteID <= 0 {
		return CheckSuite{}, invalidIDError("check suite")
	}
	var out CheckSuite
	err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("%s/check-suites/%d", repoPath(owner, repo), suiteID), token, nil, &out)
	return out, err
}

func (c *Client) ListOrganizations(ctx context.Context, page, perPage int, token string) ([]Organization, error) {
	values := listQuery("", page, perPage)
	var out []Organization
	err := c.doJSON(ctx, http.MethodGet, "/user/orgs?"+values.Encode(), token, nil, &out)
	return out, err
}

// RerunCheckSuite requests a new check-suite evaluation without pushing code.
func (c *Client) RerunCheckSuite(ctx context.Context, owner, repo string, suiteID int64, token string) error {
	if suiteID <= 0 {
		return invalidIDError("check suite")
	}
	return c.doJSON(ctx, http.MethodPost, fmt.Sprintf("%s/check-suites/%d/rerequest", repoPath(owner, repo), suiteID), token, nil, nil)
}

// RerunWorkflowRun reruns all jobs in a workflow run.
func (c *Client) RerunWorkflowRun(ctx context.Context, owner, repo string, runID int64, token string) error {
	if runID <= 0 {
		return invalidIDError("workflow run")
	}
	return c.doJSON(ctx, http.MethodPost, fmt.Sprintf("%s/actions/runs/%d/rerun", repoPath(owner, repo), runID), token, nil, nil)
}

func (c *Client) RerunWorkflow(ctx context.Context, owner, repo string, runID int64, token string) error {
	return c.RerunWorkflowRun(ctx, owner, repo, runID, token)
}

// RerunFailedJobs reruns failed jobs and their dependent jobs in a workflow
// run. This is the operation exposed by GitHub Desktop's failed-only action.
func (c *Client) RerunFailedJobs(ctx context.Context, owner, repo string, runID int64, token string) error {
	if runID <= 0 {
		return invalidIDError("workflow run")
	}
	return c.doJSON(ctx, http.MethodPost, fmt.Sprintf("%s/actions/runs/%d/rerun-failed-jobs", repoPath(owner, repo), runID), token, nil, nil)
}

func (c *Client) RerunWorkflowJob(ctx context.Context, owner, repo string, jobID int64, token string) error {
	if jobID <= 0 {
		return invalidIDError("workflow job")
	}
	return c.doJSON(ctx, http.MethodPost, fmt.Sprintf("%s/actions/jobs/%d/rerun", repoPath(owner, repo), jobID), token, nil, nil)
}

// RerunJob is a short alias matching GitHub's endpoint terminology.
func (c *Client) RerunJob(ctx context.Context, owner, repo string, jobID int64, token string) error {
	return c.RerunWorkflowJob(ctx, owner, repo, jobID, token)
}

func (c *Client) CreatePullRequest(ctx context.Context, owner, repo string, input PullRequestInput, token string) (PullRequest, error) {
	var out PullRequest
	err := c.doJSON(ctx, http.MethodPost, repoPath(owner, repo)+"/pulls", token, input, &out)
	return out, err
}

func (c *Client) CreateIssue(ctx context.Context, owner, repo string, input IssueInput, token string) (Issue, error) {
	var out Issue
	err := c.doJSON(ctx, http.MethodPost, repoPath(owner, repo)+"/issues", token, input, &out)
	return out, err
}

func (c *Client) RerunCheck(ctx context.Context, owner, repo string, checkRunID int64, token string) error {
	return c.doJSON(ctx, http.MethodPost, fmt.Sprintf("%s/check-runs/%d/rerequest", repoPath(owner, repo), checkRunID), token, struct{}{}, nil)
}

// DoJSON is an escape hatch for a small future endpoint without exposing the
// underlying token or transport details to handlers.
func (c *Client) DoJSON(ctx context.Context, method, path, token string, body, out any) error {
	return c.doJSON(ctx, method, path, token, body, out)
}

func repoPath(owner, repo string) string {
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
}

func listQuery(state string, page, perPage int) url.Values {
	values := url.Values{}
	if state != "" {
		values.Set("state", state)
	}
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 || perPage > 100 {
		perPage = 30
	}
	values.Set("page", strconv.Itoa(page))
	values.Set("per_page", strconv.Itoa(perPage))
	return values
}

func (c *Client) endpoint(path string) (*url.URL, error) {
	if c == nil || c.baseURL == nil {
		return nil, &APIError{Code: "github_configuration_error", Message: "GitHub API base URL is invalid"}
	}
	if path == "" || !strings.HasPrefix(path, "/") {
		return nil, &APIError{Code: "github_request_error", Message: "GitHub API path is invalid"}
	}
	relative, err := url.Parse(path)
	if err != nil || relative.IsAbs() || relative.Host != "" || relative.User != nil {
		return nil, &APIError{Code: "github_request_error", Message: "GitHub API path is invalid"}
	}
	base := *c.baseURL
	base.Path = strings.TrimRight(base.Path, "/") + relative.Path
	base.RawPath = strings.TrimRight(c.baseURL.EscapedPath(), "/") + relative.EscapedPath()
	base.RawQuery = relative.RawQuery
	base.Fragment = ""
	return &base, nil
}

func (c *Client) doJSON(ctx context.Context, method, path, token string, body, out any) error {
	endpoint, err := c.endpoint(path)
	if err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var payload io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return &APIError{Code: "github_request_error", Message: "failed to encode GitHub request", Err: marshalErr}
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), payload)
	if err != nil {
		return &APIError{Code: "github_request_error", Message: "failed to create GitHub request", Err: err}
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", c.userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token = strings.TrimSpace(token); token == "" {
		token = c.token
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	hc := c.httpClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return &APIError{Code: "github_network_error", Message: "GitHub request failed", Err: err}
	}
	defer resp.Body.Close()
	bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if readErr != nil {
		return &APIError{StatusCode: resp.StatusCode, Code: "github_network_error", Message: "failed to read GitHub response", Err: readErr, RequestID: resp.Header.Get("X-GitHub-Request-Id")}
	}
	if len(bodyBytes) > maxResponseBytes {
		return &APIError{StatusCode: resp.StatusCode, Code: "github_response_too_large", Message: "GitHub response is too large", RequestID: resp.Header.Get("X-GitHub-Request-Id")}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseAPIError(resp.StatusCode, resp.Header.Get("X-GitHub-Request-Id"), bodyBytes, token, c.clientSecret)
	}
	if out == nil || len(bytes.TrimSpace(bodyBytes)) == 0 {
		return nil
	}
	if err := json.Unmarshal(bodyBytes, out); err != nil {
		return &APIError{StatusCode: resp.StatusCode, Code: "github_decode_error", Message: "invalid GitHub response", Err: err, RequestID: resp.Header.Get("X-GitHub-Request-Id")}
	}
	return nil
}

func parseAPIError(status int, requestID string, body []byte, secrets ...string) *APIError {
	var payload struct {
		Message          string `json:"message"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
		DocumentationURL string `json:"documentation_url"`
		ErrorURI         string `json:"error_uri"`
		Errors           any    `json:"errors"`
	}
	_ = json.Unmarshal(body, &payload)
	message := payload.Message
	if strings.TrimSpace(message) == "" {
		message = payload.ErrorDescription
	}
	if strings.TrimSpace(message) == "" {
		message = payload.Error
	}
	message = sanitizeProviderText(message, secrets...)
	if message == "" {
		message = http.StatusText(status)
	}
	documentationURL := payload.DocumentationURL
	if strings.TrimSpace(documentationURL) == "" {
		documentationURL = payload.ErrorURI
	}
	documentationURL = sanitizeProviderText(documentationURL, secrets...)
	code := "github_api_error"
	if status == http.StatusUnauthorized {
		code = "github_auth_required"
	}
	if status == http.StatusForbidden {
		code = "github_forbidden"
	}
	if status == http.StatusNotFound {
		code = "github_not_found"
	}
	return &APIError{StatusCode: status, Code: code, Message: message, DocumentationURL: documentationURL, RequestID: requestID}
}

func sanitizeProviderText(value string, secrets ...string) string {
	value = strings.TrimSpace(value)
	for _, secret := range secrets {
		secret = strings.TrimSpace(secret)
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	runes := []rune(value)
	if len(runes) > maxProviderErrorRunes {
		value = string(runes[:maxProviderErrorRunes-len("...")]) + "..."
	}
	return value
}

// OAuthToken is the subset returned by GitHub's access-token endpoint.
type OAuthToken struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
}

// DeviceCode is the short-lived response from GitHub's device authorization
// endpoint. The code is only returned to the caller that started the flow.
type DeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete,omitempty"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

func (c *Client) StartDeviceFlow(ctx context.Context, scope string) (DeviceCode, error) {
	if c == nil || strings.TrimSpace(c.deviceURL) == "" {
		return DeviceCode{}, &APIError{Code: "github_configuration_error", Message: "GitHub device URL is not configured"}
	}
	if strings.TrimSpace(c.clientID) == "" {
		return DeviceCode{}, &APIError{Code: "github_configuration_error", Message: "GitHub OAuth client is not configured"}
	}
	values := url.Values{"client_id": []string{c.clientID}}
	if strings.TrimSpace(scope) != "" {
		values.Set("scope", strings.TrimSpace(scope))
	}
	req, err := http.NewRequestWithContext(nonNilContext(ctx), http.MethodPost, c.deviceURL, strings.NewReader(values.Encode()))
	if err != nil {
		return DeviceCode{}, &APIError{Code: "github_request_error", Message: "failed to create device authorization request", Err: err}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", c.userAgent)
	hc := c.httpClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return DeviceCode{}, &APIError{Code: "github_network_error", Message: "GitHub device authorization request failed", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return DeviceCode{}, &APIError{StatusCode: resp.StatusCode, Code: "github_network_error", Message: "failed to read device authorization response", Err: err}
	}
	if len(body) > maxResponseBytes {
		return DeviceCode{}, &APIError{StatusCode: resp.StatusCode, Code: "github_response_too_large", Message: "GitHub response is too large"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return DeviceCode{}, parseAPIError(resp.StatusCode, resp.Header.Get("X-GitHub-Request-Id"), body, c.clientID, c.clientSecret)
	}
	var result DeviceCode
	if err := json.Unmarshal(body, &result); err != nil {
		return DeviceCode{}, &APIError{StatusCode: resp.StatusCode, Code: "github_decode_error", Message: "invalid device authorization response", Err: err}
	}
	if result.DeviceCode == "" || result.UserCode == "" || result.VerificationURI == "" {
		return DeviceCode{}, &APIError{StatusCode: resp.StatusCode, Code: "github_auth_error", Message: "device authorization response is incomplete"}
	}
	verificationURI, valid := normalizeVerificationURL(result.VerificationURI)
	if !valid {
		return DeviceCode{}, &APIError{StatusCode: resp.StatusCode, Code: "github_auth_error", Message: "device verification URL is invalid"}
	}
	result.VerificationURI = verificationURI
	if result.VerificationURIComplete != "" {
		verificationURIComplete, completeValid := normalizeVerificationURL(result.VerificationURIComplete)
		if !completeValid {
			return DeviceCode{}, &APIError{StatusCode: resp.StatusCode, Code: "github_auth_error", Message: "device verification URL is invalid"}
		}
		result.VerificationURIComplete = verificationURIComplete
	}
	if result.Interval < 1 {
		result.Interval = 5
	}
	return result, nil
}

func normalizeVerificationURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxVerificationURLLen {
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil || !validHTTPURL(parsed) {
		return "", false
	}
	if port := parsed.Port(); port != "" {
		parsedPort, portErr := strconv.Atoi(port)
		if portErr != nil || parsedPort < 1 || parsedPort > 65535 {
			return "", false
		}
	}
	return parsed.String(), true
}

func (c *Client) PollDeviceFlow(ctx context.Context, deviceCode string) (OAuthToken, error) {
	if c == nil || strings.TrimSpace(c.tokenURL) == "" {
		return OAuthToken{}, &APIError{Code: "github_configuration_error", Message: "GitHub OAuth token URL is not configured"}
	}
	if strings.TrimSpace(c.clientID) == "" {
		return OAuthToken{}, &APIError{Code: "github_configuration_error", Message: "GitHub OAuth client is not configured"}
	}
	deviceCode = strings.TrimSpace(deviceCode)
	if deviceCode == "" || len(deviceCode) > 4096 || strings.ContainsAny(deviceCode, "\r\n\x00") {
		return OAuthToken{}, &APIError{Code: "invalid_request", Message: "device code is required"}
	}
	values := url.Values{
		"client_id":   []string{c.clientID},
		"device_code": []string{deviceCode},
		"grant_type":  []string{"urn:ietf:params:oauth:grant-type:device_code"},
	}
	req, err := http.NewRequestWithContext(nonNilContext(ctx), http.MethodPost, c.tokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return OAuthToken{}, &APIError{Code: "github_request_error", Message: "failed to create device token request", Err: err}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", c.userAgent)
	hc := c.httpClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return OAuthToken{}, &APIError{Code: "github_network_error", Message: "GitHub device token request failed", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_network_error", Message: "failed to read device token response", Err: err}
	}
	if len(body) > maxResponseBytes {
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_response_too_large", Message: "GitHub response is too large"}
	}
	var wire struct {
		OAuthToken
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return OAuthToken{}, parseAPIError(resp.StatusCode, resp.Header.Get("X-GitHub-Request-Id"), body, deviceCode, c.clientID, c.clientSecret)
		}
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_decode_error", Message: "invalid device token response", Err: err}
	}
	if wire.Error != "" {
		code := "github_device_error"
		message := sanitizeProviderText(wire.ErrorDescription, deviceCode, c.clientID, c.clientSecret)
		if message == "" {
			message = sanitizeProviderText(wire.Error, deviceCode, c.clientID, c.clientSecret)
		}
		switch wire.Error {
		case "authorization_pending":
			code = "github_authorization_pending"
		case "slow_down":
			code = "github_slow_down"
		case "expired_token":
			code = "github_device_expired"
		case "access_denied":
			code = "github_oauth_denied"
		}
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: code, Message: message}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return OAuthToken{}, parseAPIError(resp.StatusCode, resp.Header.Get("X-GitHub-Request-Id"), body, deviceCode, c.clientID, c.clientSecret)
	}
	if strings.TrimSpace(wire.AccessToken) == "" {
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_auth_error", Message: "device token response did not include an access token"}
	}
	return wire.OAuthToken, nil
}

func nonNilContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

// ExchangeOAuthCode exchanges a short-lived OAuth code. It intentionally
// returns only the token to the caller; HTTP handlers must keep it server-side.
func (c *Client) ExchangeOAuthCode(ctx context.Context, code, redirectURI string) (OAuthToken, error) {
	if c == nil || strings.TrimSpace(c.tokenURL) == "" {
		return OAuthToken{}, &APIError{Code: "github_configuration_error", Message: "GitHub OAuth token URL is not configured"}
	}
	clientSecret := strings.TrimSpace(c.clientSecret)
	if strings.TrimSpace(c.clientID) == "" || clientSecret == "" {
		return OAuthToken{}, &APIError{Code: "github_configuration_error", Message: "GitHub OAuth client is not configured"}
	}
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 4096 || strings.ContainsAny(code, "\r\n\x00") {
		return OAuthToken{}, &APIError{Code: "invalid_request", Message: "OAuth code is required"}
	}
	values := url.Values{}
	values.Set("client_id", c.clientID)
	values.Set("client_secret", clientSecret)
	values.Set("code", code)
	if redirectURI != "" {
		values.Set("redirect_uri", redirectURI)
	}
	req, err := http.NewRequestWithContext(nonNilContext(ctx), http.MethodPost, c.tokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return OAuthToken{}, &APIError{Code: "github_request_error", Message: "failed to create OAuth request", Err: err}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", c.userAgent)
	hc := c.httpClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return OAuthToken{}, &APIError{Code: "github_network_error", Message: "GitHub OAuth request failed", Err: err}
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if readErr != nil {
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_network_error", Message: "failed to read OAuth response", Err: readErr}
	}
	if len(body) > maxResponseBytes {
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_response_too_large", Message: "GitHub response is too large"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return OAuthToken{}, parseAPIError(resp.StatusCode, resp.Header.Get("X-GitHub-Request-Id"), body, clientSecret, code, c.clientID)
	}
	var wire struct {
		OAuthToken
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
		ErrorURI         string `json:"error_uri"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		// GitHub historically allowed form-encoded responses. Supporting it is
		// useful for Enterprise proxies while keeping the token server-side.
		parsed, parseErr := url.ParseQuery(string(body))
		if parseErr != nil {
			return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_decode_error", Message: "invalid OAuth response", Err: err}
		}
		wire.AccessToken = parsed.Get("access_token")
		wire.TokenType = parsed.Get("token_type")
		wire.Scope = parsed.Get("scope")
		wire.Error = parsed.Get("error")
		wire.ErrorDescription = parsed.Get("error_description")
		wire.ErrorURI = parsed.Get("error_uri")
	}
	if strings.TrimSpace(wire.Error) != "" {
		message := sanitizeProviderText(wire.ErrorDescription, clientSecret, code, c.clientID)
		if message == "" {
			message = sanitizeProviderText(wire.Error, clientSecret, code, c.clientID)
		}
		return OAuthToken{}, &APIError{
			StatusCode:       resp.StatusCode,
			Code:             "github_oauth_error",
			Message:          message,
			DocumentationURL: sanitizeProviderText(wire.ErrorURI, clientSecret, code, c.clientID),
		}
	}
	if strings.TrimSpace(wire.AccessToken) == "" {
		return OAuthToken{}, &APIError{StatusCode: resp.StatusCode, Code: "github_auth_error", Message: "OAuth response did not include an access token"}
	}
	return wire.OAuthToken, nil
}
