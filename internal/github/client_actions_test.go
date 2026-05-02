package github

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestActionsClientListsRunsJobsStepsSuitesAndOrganizations(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer actions-token" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/acme/widget/actions/runs":
			query := r.URL.Query()
			for key, want := range map[string]string{
				"actor":                 "octocat",
				"branch":                "feature/retry",
				"event":                 "pull_request",
				"status":                "completed",
				"created":               ">2026-01-01",
				"head_sha":              "abc123",
				"exclude_pull_requests": "false",
				"check_suite_id":        "99",
				"page":                  "2",
				"per_page":              "17",
			} {
				if got := query.Get(key); got != want {
					t.Fatalf("query %s = %q, want %q", key, got, want)
				}
			}
			_, _ = w.Write([]byte(`{"total_count":1,"workflow_runs":[{"id":42,"workflow_id":7,"name":"CI","status":"completed","conclusion":"success","check_suite_id":99}]}`))
		case "/repos/acme/widget/actions/runs/42":
			_, _ = w.Write([]byte(`{"id":42,"name":"CI","head_branch":"main"}`))
		case "/repos/acme/widget/actions/runs/42/jobs":
			query := r.URL.Query()
			if query.Get("filter") != "latest" || query.Get("page") != "3" || query.Get("per_page") != "11" {
				t.Fatalf("unexpected jobs query: %s", query.Encode())
			}
			_, _ = w.Write([]byte(`{"total_count":1,"jobs":[{"id":51,"run_id":42,"name":"build","steps":[{"name":"checkout","number":1,"status":"completed","conclusion":"success","log":"ok"}]}]}`))
		case "/repos/acme/widget/actions/jobs/51":
			_, _ = w.Write([]byte(`{"id":51,"name":"build","steps":[{"name":"test","number":2,"status":"completed"}]}`))
		case "/repos/acme/widget/commits/feature/retry/check-suites":
			_, _ = w.Write([]byte(`{"total_count":1,"check_suites":[{"id":99,"status":"completed","rerequestable":true}]}`))
		case "/repos/acme/widget/check-suites/99":
			_, _ = w.Write([]byte(`{"id":99,"status":"completed","runs_rerequestable":true}`))
		case "/user/orgs":
			if got := r.URL.Query().Get("page"); got != "4" {
				t.Fatalf("org page = %q", got)
			}
			_, _ = w.Write([]byte(`[{"id":1,"login":"acme","name":"Acme"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	ctx := context.Background()
	exclude := false
	runs, err := client.ListWorkflowRuns(ctx, "acme", "widget", WorkflowRunsFilter{
		Actor: "octocat", Branch: "feature/retry", Event: "pull_request", Status: "completed",
		Created: ">2026-01-01", HeadSHA: "abc123", ExcludePullRequests: &exclude,
		CheckSuiteID: 99, Page: 2, PerPage: 17,
	}, "actions-token")
	if err != nil || runs.TotalCount != 1 || len(runs.WorkflowRuns) != 1 || runs.WorkflowRuns[0].ID != 42 {
		t.Fatalf("workflow runs: %#v %v", runs, err)
	}
	run, err := client.GetWorkflowRun(ctx, "acme", "widget", 42, "actions-token")
	if err != nil || run.HeadBranch != "main" {
		t.Fatalf("workflow run: %#v %v", run, err)
	}
	jobs, err := client.ListWorkflowRunJobs(ctx, "acme", "widget", 42, "latest", 3, 11, "actions-token")
	if err != nil || len(jobs.Jobs) != 1 || len(jobs.Jobs[0].Steps) != 1 || jobs.Jobs[0].Steps[0].Log != "ok" {
		t.Fatalf("workflow jobs: %#v %v", jobs, err)
	}
	job, err := client.GetWorkflowJob(ctx, "acme", "widget", 51, "actions-token")
	if err != nil || job.ID != 51 || len(job.Steps) != 1 {
		t.Fatalf("workflow job: %#v %v", job, err)
	}
	suites, err := client.ListCheckSuites(ctx, "acme", "widget", "feature/retry", 1, 30, "actions-token")
	if err != nil || suites.TotalCount != 1 || suites.CheckSuites[0].ID != 99 {
		t.Fatalf("check suites: %#v %v", suites, err)
	}
	suite, err := client.GetCheckSuite(ctx, "acme", "widget", 99, "actions-token")
	if err != nil || !suite.RunsRerequestable {
		t.Fatalf("check suite: %#v %v", suite, err)
	}
	orgs, err := client.ListOrganizations(ctx, 4, 30, "actions-token")
	if err != nil || len(orgs) != 1 || orgs[0].Login != "acme" {
		t.Fatalf("organizations: %#v %v", orgs, err)
	}
}

func TestActionsClientRerunEndpointsAndIDValidation(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		if r.ContentLength != 0 {
			t.Fatalf("rerun request body length = %d, want 0", r.ContentLength)
		}
		paths = append(paths, r.URL.Path)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	ctx := context.Background()
	if err := client.RerunCheckSuite(ctx, "o", "r", 9, "t"); err != nil {
		t.Fatalf("RerunCheckSuite: %v", err)
	}
	if err := client.RerunWorkflowRun(ctx, "o", "r", 10, "t"); err != nil {
		t.Fatalf("RerunWorkflowRun: %v", err)
	}
	if err := client.RerunFailedJobs(ctx, "o", "r", 11, "t"); err != nil {
		t.Fatalf("RerunFailedJobs: %v", err)
	}
	if err := client.RerunWorkflowJob(ctx, "o", "r", 12, "t"); err != nil {
		t.Fatalf("RerunWorkflowJob: %v", err)
	}
	want := []string{
		"/repos/o/r/check-suites/9/rerequest",
		"/repos/o/r/actions/runs/10/rerun",
		"/repos/o/r/actions/runs/11/rerun-failed-jobs",
		"/repos/o/r/actions/jobs/12/rerun",
	}
	if len(paths) != len(want) {
		t.Fatalf("paths = %#v, want %#v", paths, want)
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("path[%d] = %q, want %q", i, paths[i], want[i])
		}
	}
	for _, check := range []struct {
		name string
		call func() error
	}{
		{"suite", func() error { return client.RerunCheckSuite(ctx, "o", "r", 0, "t") }},
		{"run", func() error { return client.RerunWorkflowRun(ctx, "o", "r", -1, "t") }},
		{"job", func() error { return client.RerunWorkflowJob(ctx, "o", "r", 0, "t") }},
		{"jobs", func() error { _, err := client.ListWorkflowRunJobs(ctx, "o", "r", 0, "", 1, 30, "t"); return err }},
	} {
		t.Run(check.name, func(t *testing.T) {
			err := check.call()
			apiErr, ok := err.(*APIError)
			if !ok || apiErr.Code != "invalid_request" {
				t.Fatalf("error = %#v, want invalid_request", err)
			}
		})
	}
}
