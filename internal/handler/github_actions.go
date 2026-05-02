package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/github"
)

// githubActionsRequest is shared by action mutation endpoints. GitHub IDs are
// represented as int64 because the provider documents them as integer IDs and
// they can exceed a 32-bit signed range.
type githubActionsRequest struct {
	githubRepoRequest
	ID            int64 `json:"id"`
	WorkflowRunID int64 `json:"workflow_run_id"`
	CheckSuiteID  int64 `json:"check_suite_id"`
	JobID         int64 `json:"job_id"`
}

func bindGitHubActionsJSON(c *gin.Context, req any) error {
	if c.Request == nil || c.Request.Body == nil {
		return nil
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.SplitN(c.GetHeader("Content-Type"), ";", 2)[0]))
	if contentType != "" && contentType != "application/json" {
		return nil
	}
	if err := c.ShouldBindJSON(req); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	return nil
}

func mergeGitHubRepoRequest(base, override githubRepoRequest) githubRepoRequest {
	if strings.TrimSpace(override.Remote) != "" {
		base.Remote = override.Remote
	}
	if strings.TrimSpace(override.URL) != "" {
		base.URL = override.URL
	}
	if strings.TrimSpace(override.Owner) != "" {
		base.Owner = override.Owner
	}
	if strings.TrimSpace(override.Repo) != "" {
		base.Repo = override.Repo
	}
	if strings.TrimSpace(override.Repository) != "" {
		base.Repository = override.Repository
	}
	return base
}

func actionRepoRequest(c *gin.Context, body githubRepoRequest) githubRepoRequest {
	query := queryRepoRequest(c)
	result := mergeGitHubRepoRequest(body, query)
	if query.Owner != "" || query.Repo != "" || query.Repository != "" {
		// An explicit owner/repository query identifies the target more
		// precisely than a body remote URL. Clear the latter so resolveRemote
		// cannot accidentally select a different repository.
		result.Remote = ""
		result.URL = ""
	}
	pathOwner := strings.TrimSpace(c.Param("owner"))
	pathRepo := strings.TrimSpace(c.Param("repo"))
	if pathOwner != "" || pathRepo != "" {
		// Explicit path parameters are authoritative. This also prevents a body
		// remote URL from silently changing the target of a path-based request.
		result = githubRepoRequest{Owner: pathOwner, Repo: pathRepo}
	}
	return result
}

func optionalGitHubValue(value, name string, max int) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) > max || strings.ContainsAny(value, "\x00\r\n") {
		return "", fmt.Errorf("%s is invalid", name)
	}
	return value, nil
}

func workflowRunsFilterFromQuery(c *gin.Context) (github.WorkflowRunsFilter, int, int, error) {
	page, perPage, err := parsePage(c)
	if err != nil {
		return github.WorkflowRunsFilter{}, 0, 0, err
	}
	filter := github.WorkflowRunsFilter{Page: page, PerPage: perPage}
	for _, item := range []struct {
		value *string
		name  string
		max   int
	}{
		{&filter.Actor, "actor", 128},
		{&filter.Branch, "branch", 256},
		{&filter.Event, "event", 128},
		{&filter.Status, "status", 64},
		{&filter.Created, "created", 256},
		{&filter.HeadSHA, "head_sha", 256},
	} {
		value, valueErr := optionalGitHubValue(c.Query(item.name), item.name, item.max)
		if valueErr != nil {
			return github.WorkflowRunsFilter{}, 0, 0, valueErr
		}
		*item.value = value
	}
	if raw := strings.TrimSpace(c.Query("check_suite_id")); raw != "" {
		id, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || id <= 0 {
			return github.WorkflowRunsFilter{}, 0, 0, errors.New("check_suite_id is invalid")
		}
		filter.CheckSuiteID = id
	} else if raw := strings.TrimSpace(c.Query("check_suite")); raw != "" {
		id, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || id <= 0 {
			return github.WorkflowRunsFilter{}, 0, 0, errors.New("check_suite_id is invalid")
		}
		filter.CheckSuiteID = id
	}
	if raw := strings.TrimSpace(c.Query("exclude_pull_requests")); raw != "" {
		exclude, parseErr := strconv.ParseBool(raw)
		if parseErr != nil {
			return github.WorkflowRunsFilter{}, 0, 0, errors.New("exclude_pull_requests must be true or false")
		}
		filter.ExcludePullRequests = &exclude
	}
	return filter, page, perPage, nil
}

func parseActionID(c *gin.Context, bodyID int64, kind string, queryNames ...string) (int64, error) {
	if raw := strings.TrimSpace(c.Param("id")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			return 0, fmt.Errorf("%s id is invalid", kind)
		}
		return id, nil
	}
	for _, name := range append([]string{"id"}, queryNames...) {
		if raw := strings.TrimSpace(c.Query(name)); raw != "" {
			id, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || id <= 0 {
				return 0, fmt.Errorf("%s id is invalid", kind)
			}
			return id, nil
		}
	}
	if bodyID > 0 {
		return bodyID, nil
	}
	return 0, fmt.Errorf("%s id is required", kind)
}

func parseWorkflowRunID(c *gin.Context, req githubActionsRequest) (int64, error) {
	return parseActionID(c, firstPositive(req.ID, req.WorkflowRunID), "workflow run", "run_id", "workflow_run_id")
}

func parseCheckSuiteID(c *gin.Context, req githubActionsRequest) (int64, error) {
	return parseActionID(c, firstPositive(req.ID, req.CheckSuiteID), "check suite", "suite_id", "check_suite_id")
}

func parseWorkflowJobID(c *gin.Context, req githubActionsRequest) (int64, error) {
	return parseActionID(c, firstPositive(req.ID, req.JobID), "workflow job", "job_id")
}

func firstPositive(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func (h *GitHubHandler) WorkflowRuns(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	filter, page, perPage, err := workflowRunsFilterFromQuery(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_filter", err.Error())
		return
	}
	token, _ := h.token()
	runs, err := h.client.ListWorkflowRuns(c.Request.Context(), remote.Owner, remote.Repository, filter, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{
		"repository":    remote,
		"workflow_runs": runs.WorkflowRuns,
		"total_count":   runs.TotalCount,
		"page":          page,
		"per_page":      perPage,
	})
}

func (h *GitHubHandler) WorkflowRun(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	runID, err := parseActionID(c, 0, "workflow run")
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_run", err.Error())
		return
	}
	token, _ := h.token()
	run, err := h.client.GetWorkflowRun(c.Request.Context(), remote.Owner, remote.Repository, runID, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, run)
}

func (h *GitHubHandler) WorkflowRunJobs(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	runID, err := parseActionID(c, 0, "workflow run", "run_id", "workflow_run_id")
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_run", err.Error())
		return
	}
	page, perPage, err := parsePage(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	filter, filterErr := optionalGitHubValue(c.Query("filter"), "filter", 16)
	if filterErr != nil || (filter != "" && filter != "latest" && filter != "all") {
		if filterErr == nil {
			filterErr = errors.New("filter must be latest or all")
		}
		githubError(c, http.StatusBadRequest, "invalid_workflow_filter", filterErr.Error())
		return
	}
	token, _ := h.token()
	jobs, err := h.client.ListWorkflowRunJobs(c.Request.Context(), remote.Owner, remote.Repository, runID, filter, page, perPage, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{
		"repository":  remote,
		"run_id":      runID,
		"jobs":        jobs.Jobs,
		"total_count": jobs.TotalCount,
		"page":        page,
		"per_page":    perPage,
	})
}

func (h *GitHubHandler) WorkflowJob(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	jobID, err := parseActionID(c, 0, "workflow job")
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_job", err.Error())
		return
	}
	token, _ := h.token()
	job, err := h.client.GetWorkflowJob(c.Request.Context(), remote.Owner, remote.Repository, jobID, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, job)
}

func (h *GitHubHandler) WorkflowJobSteps(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	jobID, err := parseActionID(c, 0, "workflow job")
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_job", err.Error())
		return
	}
	token, _ := h.token()
	steps, err := h.client.ListWorkflowJobSteps(c.Request.Context(), remote.Owner, remote.Repository, jobID, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"repository": remote, "job_id": jobID, "steps": steps})
}

func (h *GitHubHandler) CheckSuites(c *gin.Context) {
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
	suites, err := h.client.ListCheckSuites(c.Request.Context(), remote.Owner, remote.Repository, ref, page, perPage, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{
		"repository":   remote,
		"ref":          ref,
		"check_suites": suites.CheckSuites,
		"total_count":  suites.TotalCount,
		"page":         page,
		"per_page":     perPage,
	})
}

func (h *GitHubHandler) CheckSuite(c *gin.Context) {
	if h.client == nil {
		githubError(c, http.StatusServiceUnavailable, "github_not_configured", "GitHub client is not configured")
		return
	}
	remote, err := h.resolveRemote(c, queryRepoRequest(c))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	suiteID, err := parseActionID(c, 0, "check suite")
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_check_suite", err.Error())
		return
	}
	token, _ := h.token()
	suite, err := h.client.GetCheckSuite(c.Request.Context(), remote.Owner, remote.Repository, suiteID, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, suite)
}

func (h *GitHubHandler) Organizations(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	page, perPage, err := parsePage(c)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	items, err := h.client.ListOrganizations(c.Request.Context(), page, perPage, token)
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"items": items, "organizations": items, "page": page, "per_page": perPage})
}

func (h *GitHubHandler) RerunCheckSuite(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req githubActionsRequest
	if err := bindGitHubActionsJSON(c, &req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "request body must be valid JSON")
		return
	}
	suiteID, err := parseCheckSuiteID(c, req)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_check_suite", err.Error())
		return
	}
	remote, err := h.resolveRemote(c, actionRepoRequest(c, req.githubRepoRequest))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	if err := h.client.RerunCheckSuite(c.Request.Context(), remote.Owner, remote.Repository, suiteID, token); err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"rerun": true, "id": suiteID})
}

func (h *GitHubHandler) RerunWorkflowRun(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req githubActionsRequest
	if err := bindGitHubActionsJSON(c, &req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "request body must be valid JSON")
		return
	}
	runID, err := parseWorkflowRunID(c, req)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_run", err.Error())
		return
	}
	h.rerunWorkflowOperation(c, actionRepoRequest(c, req.githubRepoRequest), runID, false, token)
}

func (h *GitHubHandler) RerunFailedJobs(c *gin.Context) {
	token := h.requireToken(c)
	if token == "" {
		return
	}
	var req githubActionsRequest
	if err := bindGitHubActionsJSON(c, &req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "request body must be valid JSON")
		return
	}
	runID, err := parseWorkflowRunID(c, req)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_run", err.Error())
		return
	}
	h.rerunWorkflowOperation(c, actionRepoRequest(c, req.githubRepoRequest), runID, true, token)
}

func (h *GitHubHandler) rerunWorkflowOperation(c *gin.Context, repoReq githubRepoRequest, runID int64, failedOnly bool, token string) {
	remote, err := h.resolveRemote(c, repoReq)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	if failedOnly {
		err = h.client.RerunFailedJobs(c.Request.Context(), remote.Owner, remote.Repository, runID, token)
	} else {
		err = h.client.RerunWorkflowRun(c.Request.Context(), remote.Owner, remote.Repository, runID, token)
	}
	if err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"rerun": true, "id": runID})
}

func (h *GitHubHandler) RerunWorkflowJob(c *gin.Context) {
	if h.requireToken(c) == "" {
		return
	}
	var req githubActionsRequest
	if err := bindGitHubActionsJSON(c, &req); err != nil {
		githubError(c, http.StatusBadRequest, "invalid_request", "request body must be valid JSON")
		return
	}
	jobID, err := parseWorkflowJobID(c, req)
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_workflow_job", err.Error())
		return
	}
	token, _ := h.token()
	remote, err := h.resolveRemote(c, actionRepoRequest(c, req.githubRepoRequest))
	if err != nil {
		githubError(c, http.StatusBadRequest, "invalid_repository", err.Error())
		return
	}
	if err := h.client.RerunWorkflowJob(c.Request.Context(), remote.Owner, remote.Repository, jobID, token); err != nil {
		githubClientError(c, err)
		return
	}
	githubOK(c, gin.H{"rerun": true, "id": jobID})
}
