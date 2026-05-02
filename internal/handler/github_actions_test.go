package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubActionsHandlerListsRunsJobsStepsSuitesAndOrganizations(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer actions-token" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/acme/widget/actions/runs":
			if got := r.URL.Query().Get("branch"); got != "feature/retry" {
				t.Fatalf("workflow branch = %q", got)
			}
			if got := r.URL.Query().Get("event"); got != "pull_request" {
				t.Fatalf("workflow event = %q", got)
			}
			_, _ = w.Write([]byte(`{"total_count":1,"workflow_runs":[{"id":42,"name":"CI","status":"completed"}]}`))
		case "/repos/acme/widget/actions/runs/42/jobs":
			if got := r.URL.Query().Get("filter"); got != "latest" {
				t.Fatalf("job filter = %q", got)
			}
			_, _ = w.Write([]byte(`{"total_count":1,"jobs":[{"id":51,"name":"build","steps":[{"name":"test","number":1,"status":"completed","conclusion":"success"}]}]}`))
		case "/repos/acme/widget/actions/jobs/51":
			_, _ = w.Write([]byte(`{"id":51,"name":"build","steps":[{"name":"test","number":1,"status":"completed","conclusion":"success"}]}`))
		case "/repos/acme/widget/commits/main/check-suites":
			_, _ = w.Write([]byte(`{"total_count":1,"check_suites":[{"id":99,"status":"completed"}]}`))
		case "/user/orgs":
			_, _ = w.Write([]byte(`[{"id":1,"login":"acme"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)
	h.SetStaticToken("actions-token")

	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodGet, path, nil)
		r.ServeHTTP(w, req)
		return w
	}
	decodeData := func(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		var envelope struct {
			Success bool           `json:"success"`
			Data    map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if !envelope.Success {
			t.Fatalf("unsuccessful response: %s", w.Body.String())
		}
		return envelope.Data
	}

	data := decodeData(t, get("/api/github/workflow-runs?owner=acme&repo=widget&branch=feature%2Fretry&event=pull_request"))
	runs, ok := data["workflow_runs"].([]any)
	if !ok || len(runs) != 1 || runs[0].(map[string]any)["id"] != float64(42) {
		t.Fatalf("workflow runs data = %#v", data)
	}
	data = decodeData(t, get("/api/github/workflow-runs/42/jobs?owner=acme&repo=widget&filter=latest"))
	jobs, ok := data["jobs"].([]any)
	if !ok || len(jobs) != 1 {
		t.Fatalf("jobs data = %#v", data)
	}
	job := jobs[0].(map[string]any)
	steps, ok := job["steps"].([]any)
	if !ok || len(steps) != 1 || steps[0].(map[string]any)["name"] != "test" {
		t.Fatalf("steps data = %#v", job)
	}
	data = decodeData(t, get("/api/github/check-suites?owner=acme&repo=widget&ref=main"))
	if suites, ok := data["check_suites"].([]any); !ok || len(suites) != 1 {
		t.Fatalf("check suites data = %#v", data)
	}
	data = decodeData(t, get("/api/github/organizations?page=2&per_page=10"))
	if orgs, ok := data["items"].([]any); !ok || len(orgs) != 1 || orgs[0].(map[string]any)["login"] != "acme" {
		t.Fatalf("organizations data = %#v", data)
	}
	data = decodeData(t, get("/api/github/workflow-jobs/51/steps?owner=acme&repo=widget"))
	if steps, ok := data["steps"].([]any); !ok || len(steps) != 1 || steps[0].(map[string]any)["name"] != "test" {
		t.Fatalf("job steps data = %#v", data)
	}
}

func TestGitHubActionsHandlerRerunOperationsAndValidation(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer actions-token" {
			t.Fatalf("missing authorization")
		}
		paths = append(paths, r.URL.Path)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)
	h.SetStaticToken("actions-token")

	for _, item := range []struct {
		path string
		body any
	}{
		{path: "/api/github/check-suites/99/rerun?owner=acme&repo=widget", body: map[string]any{}},
		{path: "/api/github/workflow-runs/42/rerun?owner=acme&repo=widget", body: map[string]any{}},
		{path: "/api/github/workflow-runs/43/rerun-failed-jobs?owner=acme&repo=widget", body: map[string]any{}},
		{path: "/api/github/workflow-jobs/51/rerun?owner=acme&repo=widget", body: map[string]any{}},
	} {
		w := postJSON(r, item.path, item.body)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"rerun":true`) {
			t.Fatalf("rerun %s: %d %s", item.path, w.Code, w.Body.String())
		}
	}
	want := []string{
		"/repos/acme/widget/check-suites/99/rerequest",
		"/repos/acme/widget/actions/runs/42/rerun",
		"/repos/acme/widget/actions/runs/43/rerun-failed-jobs",
		"/repos/acme/widget/actions/jobs/51/rerun",
	}
	if len(paths) != len(want) {
		t.Fatalf("upstream paths = %#v, want %#v", paths, want)
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("path[%d] = %q, want %q", i, paths[i], want[i])
		}
	}

	for _, item := range []struct {
		path string
		code string
	}{
		{path: "/api/github/workflow-runs/not-an-id/rerun?owner=acme&repo=widget", code: "invalid_workflow_run"},
		{path: "/api/github/workflow-runs/0/rerun?owner=acme&repo=widget", code: "invalid_workflow_run"},
		{path: "/api/github/check-suites/99/rerun?owner=acme&repo=widget", code: ""},
	} {
		if item.code == "" {
			continue
		}
		w := postJSON(r, item.path, map[string]any{})
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"`+item.code+`"`) {
			t.Fatalf("invalid rerun %s: %d %s", item.path, w.Code, w.Body.String())
		}
	}
}

func TestGitHubActionsHandlerQueryRepositoryOverridesBodyRemote(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":42,"name":"CI"}`))
	}))
	defer server.Close()
	h, r := setupGitHubHandlerTest(t, server.URL)
	h.SetStaticToken("actions-token")
	w := postJSON(r, "/api/github/workflow-runs/42/rerun?owner=query-owner&repo=query-repo", map[string]any{
		"remote": "https://github.com/body-owner/body-repo.git",
	})
	// The mocked upstream returns an object for any method; this request should
	// still fail at the upstream method/path boundary only if the wrong target
	// is selected. A successful response proves query owner/repo won.
	if w.Code == http.StatusBadRequest || gotPath != "/repos/query-owner/query-repo/actions/runs/42/rerun" {
		t.Fatalf("query repository precedence: %d %s path=%q", w.Code, w.Body.String(), gotPath)
	}
}

func TestGitHubOrganizationsRequiresToken(t *testing.T) {
	_, r := setupGitHubHandlerTest(t, "http://127.0.0.1:1")
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/github/organizations", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), `"code":"github_auth_required"`) {
		t.Fatalf("organizations without token: %d %s", w.Code, w.Body.String())
	}
}
