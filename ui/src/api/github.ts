import { request } from "@/api/request";

export interface GitHubEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  status?: number;
}

export interface GitHubAuthStatus {
  authenticated: boolean;
  source?: string;
  oauth_configured: boolean;
  device_configured: boolean;
}

export interface GitHubUser {
  login: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  html_url?: string;
}

export interface GitHubRemote {
  url: string;
  host: string;
  owner: string;
  repository: string;
  repo: string;
  html_url: string;
  api_url: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description?: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  owner?: GitHubUser;
  archived?: boolean;
  visibility?: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string;
  state: string;
  draft?: boolean;
  html_url: string;
  user?: GitHubUser;
  head?: { label?: string; ref?: string; sha?: string };
  base?: { label?: string; ref?: string; sha?: string };
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  html_url: string;
  user?: GitHubUser;
  labels?: { name: string; color?: string }[];
  comments?: number;
  created_at?: string;
  updated_at?: string;
  pull_request?: { html_url?: string };
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  head_sha?: string;
  check_suite?: { id: number };
  status: string;
  conclusion?: string;
  html_url?: string;
  details_url?: string;
  output?: { title?: string; summary?: string; text?: string };
}

export interface GitHubWorkflowRun {
  id: number;
  node_id?: string;
  name: string;
  display_title?: string;
  workflow_id?: number;
  workflow_url?: string;
  run_number?: number;
  event?: string;
  status: string;
  conclusion?: string | null;
  head_branch?: string;
  head_sha?: string;
  html_url?: string;
  jobs_url?: string;
  logs_url?: string;
  rerun_url?: string;
  cancel_url?: string;
  check_suite_id?: number;
  check_suite_url?: string;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string;
  run_attempt?: number;
  previous_attempt_url?: string;
}

export interface GitHubWorkflowRunsSnapshot {
  repository: GitHubRemote;
  workflow_runs: GitHubWorkflowRun[];
  total_count: number;
  page: number;
  per_page: number;
}

export type GitHubWorkflowRuns = GitHubWorkflowRunsSnapshot;

export interface GitHubWorkflowJobStep {
  name: string;
  number: number;
  status: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string;
  log?: string;
}

export type GitHubWorkflowStep = GitHubWorkflowJobStep;

export interface GitHubWorkflowJob {
  id: number;
  run_id?: number;
  run_url?: string;
  node_id?: string;
  head_sha?: string;
  url?: string;
  html_url?: string;
  check_run_url?: string;
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string;
  run_attempt?: number;
  runner_name?: string;
  runner_group_id?: number;
  runner_group_name?: string;
  labels?: string[];
  // GitHub may omit steps for queued jobs, and older Enterprise responses can
  // serialize an empty step list as null.
  steps?: GitHubWorkflowJobStep[] | null;
}

export interface GitHubWorkflowJobsSnapshot {
  repository: GitHubRemote;
  run_id: number;
  jobs: GitHubWorkflowJob[];
  total_count: number;
  page: number;
  per_page: number;
}

export type GitHubWorkflowJobs = GitHubWorkflowJobsSnapshot;

export interface GitHubCheckSuite {
  id: number;
  node_id?: string;
  head_branch?: string;
  head_sha?: string;
  url?: string;
  latest_check_runs_url?: string;
  rerequest_url?: string;
  status?: string;
  conclusion?: string | null;
  app?: unknown;
  repository?: GitHubRepository;
  created_at?: string;
  updated_at?: string;
  rerequestable?: boolean;
  runs_rerequestable?: boolean;
}

export interface GitHubCheckSuitesSnapshot {
  repository: GitHubRemote;
  ref: string;
  check_suites: GitHubCheckSuite[];
  total_count: number;
  page: number;
  per_page: number;
}

export interface GitHubOrganization {
  id: number;
  login: string;
  node_id?: string;
  url?: string;
  repos_url?: string;
  events_url?: string;
  hooks_url?: string;
  issues_url?: string;
  members_url?: string;
  avatar_url?: string;
  html_url?: string;
  name?: string;
  description?: string;
  type?: string;
  public_repos?: number;
}

export interface GitHubOrganizationsSnapshot {
  items: GitHubOrganization[];
  organizations: GitHubOrganization[];
  page: number;
  per_page: number;
}

export interface GitHubWorkflowRunsQuery {
  actor?: string;
  branch?: string;
  event?: string;
  status?: string;
  created?: string;
  head_sha?: string;
  exclude_pull_requests?: boolean;
  check_suite_id?: number;
  page?: number;
  per_page?: number;
}

export interface GitHubChecksSnapshot {
  repository: GitHubRemote;
  ref: string;
  status: {
    state: string;
    total_count: number;
    statuses?: { context: string; description?: string; target_url?: string }[];
  };
  check_runs: { total_count: number; check_runs: GitHubCheckRun[] };
}

export interface GitHubDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type GitHubDevicePollResult = GitHubUser | null;

async function githubRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await request<GitHubEnvelope<T>>(endpoint, options);
  if (!response.success) {
    throw new Error(response.error || "GitHub request failed");
  }
  return response.data as T;
}

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") values.set(key, String(value));
  }
  return values.toString();
};

export const githubApi = {
  authStatus: () => githubRequest<GitHubAuthStatus>("/github/auth/status"),
  setToken: (token: string) =>
    githubRequest<{ authenticated: boolean; source?: string }>("/github/auth/token", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  logout: () => githubRequest<GitHubAuthStatus>("/github/auth/logout", { method: "POST" }),
  authStart: () => githubRequest<{ url: string; state: string }>("/github/auth/start"),
  deviceStart: () =>
    githubRequest<GitHubDeviceCode>("/github/auth/device/start", {
      method: "POST",
    }),
  devicePoll: async (deviceCode: string): Promise<GitHubDevicePollResult> => {
    const response = await request<GitHubEnvelope<GitHubUser>>("/github/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (!response.success) {
      if (
        response.status === 202 &&
        (response.code === "github_authorization_pending" || response.code === "github_slow_down")
      ) {
        return null;
      }
      throw new Error(response.error || "GitHub request failed");
    }
    return response.data as GitHubUser;
  },
  deviceCancel: () => githubRequest<{ cancelled: boolean }>("/github/auth/device/cancel", { method: "POST" }),
  parseRemote: (remote: string) =>
    githubRequest<GitHubRemote>("/github/remote/parse", {
      method: "POST",
      body: JSON.stringify({ remote }),
    }),
  account: () => githubRequest<GitHubUser>("/github/account"),
  repository: (owner: string, repo: string) =>
    githubRequest<GitHubRepository>(`/github/repository?${query({ owner, repo })}`),
  createRepository: (name: string, description: string, isPrivate: boolean, organization?: string) =>
    githubRequest<GitHubRepository>("/github/repository", {
      method: "POST",
      body: JSON.stringify({ name, description, private: isPrivate, organization }),
    }),
  publish: (name: string, description: string, isPrivate: boolean, organization?: string) =>
    githubRequest<{ repository: GitHubRepository; clone_url: string; ssh_url: string; html_url: string }>(
      "/github/publish",
      {
        method: "POST",
        body: JSON.stringify({ name, description, private: isPrivate, organization }),
      }
    ),
  pullRequests: (owner: string, repo: string, state = "open") =>
    githubRequest<{ repository: GitHubRemote; items: GitHubPullRequest[] }>(
      `/github/pull-requests?${query({ owner, repo, state })}`
    ),
  pullRequest: (owner: string, repo: string, number: number) =>
    githubRequest<GitHubPullRequest>(`/github/pull-requests/${number}?${query({ owner, repo })}`),
  createPullRequest: (input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  }) => githubRequest<GitHubPullRequest>("/github/pull-requests", { method: "POST", body: JSON.stringify(input) }),
  issues: (owner: string, repo: string, state = "open") =>
    githubRequest<{ repository: GitHubRemote; items: GitHubIssue[] }>(
      `/github/issues?${query({ owner, repo, state })}`
    ),
  createIssue: (input: { owner: string; repo: string; title: string; body: string; labels?: string[] }) =>
    githubRequest<GitHubIssue>("/github/issues", { method: "POST", body: JSON.stringify(input) }),
  checks: (owner: string, repo: string, ref: string) =>
    githubRequest<GitHubChecksSnapshot>(`/github/checks?${query({ owner, repo, ref })}`),
  rerunCheck: (input: { owner: string; repo: string; id: number }) =>
    githubRequest<{ rerun: boolean; id: number }>("/github/checks/rerun", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  workflowRuns: (owner: string, repo: string, filters: GitHubWorkflowRunsQuery = {}) =>
    githubRequest<GitHubWorkflowRunsSnapshot>(`/github/workflow-runs?${query({ owner, repo, ...filters })}`),
  workflowRun: (owner: string, repo: string, id: number) =>
    githubRequest<GitHubWorkflowRun>(`/github/workflow-runs/${id}?${query({ owner, repo })}`),
  workflowRunJobs: (
    owner: string,
    repo: string,
    runId: number,
    filter?: "latest" | "all",
    page?: number,
    perPage?: number
  ) =>
    githubRequest<GitHubWorkflowJobsSnapshot>(
      `/github/workflow-runs/${runId}/jobs?${query({ owner, repo, filter, page, per_page: perPage })}`
    ),
  workflowJob: (owner: string, repo: string, id: number) =>
    githubRequest<GitHubWorkflowJob>(`/github/workflow-jobs/${id}?${query({ owner, repo })}`),
  workflowJobSteps: (owner: string, repo: string, jobId: number) =>
    githubRequest<{ repository: GitHubRemote; job_id: number; steps?: GitHubWorkflowJobStep[] | null }>(
      `/github/workflow-jobs/${jobId}/steps?${query({ owner, repo })}`
    ),
  checkSuites: (owner: string, repo: string, ref: string, page?: number, perPage?: number) =>
    githubRequest<GitHubCheckSuitesSnapshot>(
      `/github/check-suites?${query({ owner, repo, ref, page, per_page: perPage })}`
    ),
  checkSuite: (owner: string, repo: string, id: number) =>
    githubRequest<GitHubCheckSuite>(`/github/check-suites/${id}?${query({ owner, repo })}`),
  organizations: (page?: number, perPage?: number) =>
    githubRequest<GitHubOrganizationsSnapshot>(`/github/organizations?${query({ page, per_page: perPage })}`),
  rerunCheckSuite: (input: { owner: string; repo: string; id: number }) =>
    githubRequest<{ rerun: boolean; id: number }>("/github/check-suites/rerun", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rerunWorkflowRun: (input: { owner: string; repo: string; id: number }) =>
    githubRequest<{ rerun: boolean; id: number }>("/github/workflow-runs/rerun", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rerunFailedJobs: (input: { owner: string; repo: string; id: number }) =>
    githubRequest<{ rerun: boolean; id: number }>("/github/workflow-runs/rerun-failed", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rerunWorkflowJob: (input: { owner: string; repo: string; id: number }) =>
    githubRequest<{ rerun: boolean; id: number }>("/github/workflow-jobs/rerun", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
