import {
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  KeyRound,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { gitApi } from "@/api/git";
import {
  type GitHubAuthStatus,
  type GitHubCheckRun,
  type GitHubCheckSuite,
  type GitHubIssue,
  type GitHubOrganization,
  type GitHubPullRequest,
  type GitHubRemote,
  type GitHubRepository,
  type GitHubUser,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
  githubApi,
} from "@/api/github";
import { getTranslation, type Locale } from "@/lib/i18n";
import "@/components/git/github-panel.css";

interface GitHubPanelProps {
  path: string;
  locale: Locale;
  remoteUrls: string[];
  currentBranch: string;
  headHash?: string;
  onClose: () => void;
  onChanged?: () => void;
}

type GitHubTab = "repository" | "pulls" | "issues" | "checks";

const checkSuiteRerunWindowMs = 30 * 24 * 60 * 60 * 1000;

/** Match GitHub Desktop's check-suite rerun eligibility rules. */
export const isCheckSuiteRerunnable = (suite: GitHubCheckSuite, now = Date.now()): boolean => {
  if (suite.rerequestable !== true || suite.status?.toLowerCase() !== "completed") return false;
  const createdAt = Date.parse(suite.created_at || "");
  return Number.isFinite(createdAt) && createdAt > now - checkSuiteRerunWindowMs && createdAt <= now;
};

/** Resolve Actions runs by immutable commit identity to avoid branch-name mismatches. */
export const workflowRunsQueryForCommit = (headHash: string) => ({
  head_sha: headHash,
  per_page: 30,
});

const GitHubPanel: React.FC<GitHubPanelProps> = ({
  path,
  locale,
  remoteUrls,
  currentBranch,
  headHash,
  onClose,
  onChanged,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const [auth, setAuth] = useState<GitHubAuthStatus | null>(null);
  const [account, setAccount] = useState<GitHubUser | null>(null);
  const [remote, setRemote] = useState<GitHubRemote | null>(null);
  const [repository, setRepository] = useState<GitHubRepository | null>(null);
  const [tab, setTab] = useState<GitHubTab>("repository");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [device, setDevice] = useState<{ code: string; userCode: string; uri: string; interval: number } | null>(null);
  const [pulls, setPulls] = useState<GitHubPullRequest[]>([]);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [checks, setChecks] = useState<GitHubCheckRun[]>([]);
  const [checkState, setCheckState] = useState("");
  const [workflowRuns, setWorkflowRuns] = useState<GitHubWorkflowRun[]>([]);
  const [workflowJobs, setWorkflowJobs] = useState<Record<number, GitHubWorkflowJob[]>>({});
  const [expandedWorkflowRun, setExpandedWorkflowRun] = useState<number | null>(null);
  const [expandedWorkflowJob, setExpandedWorkflowJob] = useState<number | null>(null);
  const [checkSuites, setCheckSuites] = useState<GitHubCheckSuite[]>([]);
  const [organizations, setOrganizations] = useState<GitHubOrganization[]>([]);
  const [selectedOrganization, setSelectedOrganization] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDescription, setNewRepoDescription] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newHead, setNewHead] = useState(currentBranch);
  const [newBase, setNewBase] = useState("main");
  const oauthTimerRef = useRef<number | null>(null);

  const stopOAuthPolling = useCallback(() => {
    if (oauthTimerRef.current !== null) {
      window.clearTimeout(oauthTimerRef.current);
      oauthTimerRef.current = null;
    }
  }, []);

  const run = useCallback(
    async <T,>(key: string, action: () => Promise<T>): Promise<T | null> => {
      setBusy(key);
      setError(null);
      try {
        return await action();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : t("git.github.operationFailed");
        setError(message);
        toast.error(message);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [t]
  );

  const loadAuth = useCallback(async (): Promise<GitHubAuthStatus | null> => {
    const next = await run("auth", () => githubApi.authStatus());
    if (!next) {
      setAccount(null);
      return null;
    }
    setAuth(next);
    if (next.authenticated) {
      const user = await run("account", () => githubApi.account());
      if (user) setAccount(user);
    } else {
      setAccount(null);
    }
    return next;
  }, [run]);

  const loadOrganizations = useCallback(
    async (authenticated: boolean) => {
      if (!authenticated) {
        setOrganizations([]);
        setSelectedOrganization("");
        return;
      }
      const result = await run("organizations", () => githubApi.organizations());
      if (result) {
        const items = result.organizations?.length ? result.organizations : result.items || [];
        setOrganizations(items);
      }
    },
    [run]
  );

  const loadRemote = useCallback(
    async (authenticated: boolean) => {
      const raw = remoteUrls.find((value) => value.trim() !== "");
      setRemote(null);
      setRepository(null);
      if (!raw) {
        return;
      }
      const next = await run("remote", () => githubApi.parseRemote(raw));
      if (!next) return;
      setRemote(next);
      if (!authenticated) return;
      const repo = await run("repository", () => githubApi.repository(next.owner, next.repository));
      if (repo) {
        setRepository(repo);
        setNewBase(repo.default_branch || "main");
      }
    },
    [remoteUrls, run]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    const nextAuth = await loadAuth();
    await loadOrganizations(Boolean(nextAuth?.authenticated));
    await loadRemote(Boolean(nextAuth?.authenticated));
    setLoading(false);
  }, [loadAuth, loadOrganizations, loadRemote]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => stopOAuthPolling, [stopOAuthPolling]);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let timer: number | null = null;
    const delay = Math.max(3, device.interval) * 1000;
    const schedule = (poll: () => Promise<void>) => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, delay);
    };
    const poll = async () => {
      if (cancelled) return;
      setBusy("device-poll");
      setError(null);
      try {
        const result = await githubApi.devicePoll(device.code);
        if (cancelled) return;
        if (result) {
          setDevice(null);
          const nextAuth = await loadAuth();
          if (nextAuth?.authenticated) {
            await loadOrganizations(true);
            await loadRemote(true);
          }
          toast.success(t("git.github.signedIn"));
          return;
        }
        schedule(poll);
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : t("git.github.operationFailed");
        setError(message);
        toast.error(message);
        setDevice(null);
      } finally {
        if (!cancelled) setBusy(null);
      }
    };
    schedule(poll);
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
  }, [device, loadAuth, loadOrganizations, loadRemote, run, t]);

  const refreshRepositoryData = useCallback(async () => {
    if (!remote) return;
    if (tab === "pulls") {
      const result = await run("pulls", () => githubApi.pullRequests(remote.owner, remote.repository));
      if (result) setPulls(result.items || []);
    } else if (tab === "issues") {
      const result = await run("issues", () => githubApi.issues(remote.owner, remote.repository));
      if (result) setIssues(result.items || []);
    } else if (tab === "checks" && headHash) {
      // Clear snapshots before fetching so a failed endpoint cannot leave
      // stale status beside freshly loaded data from another endpoint.
      setChecks([]);
      setCheckState("");
      setWorkflowRuns([]);
      setCheckSuites([]);
      setWorkflowJobs({});
      setExpandedWorkflowRun(null);
      setExpandedWorkflowJob(null);
      await run("checks", async () => {
        const results = await Promise.allSettled([
          githubApi.checks(remote.owner, remote.repository, headHash),
          githubApi.workflowRuns(remote.owner, remote.repository, workflowRunsQueryForCommit(headHash)),
          githubApi.checkSuites(remote.owner, remote.repository, headHash, 1, 30),
        ]);
        const [checksResult, runsResult, suitesResult] = results;
        const failures: unknown[] = [];
        if (checksResult.status === "fulfilled") {
          setChecks(checksResult.value.check_runs.check_runs || []);
          setCheckState(checksResult.value.status.state || "");
        } else {
          failures.push(checksResult.reason);
        }
        if (runsResult.status === "fulfilled") {
          setWorkflowRuns(runsResult.value.workflow_runs || []);
        } else {
          failures.push(runsResult.reason);
        }
        if (suitesResult.status === "fulfilled") {
          setCheckSuites(suitesResult.value.check_suites || []);
        } else {
          failures.push(suitesResult.reason);
        }
        if (failures.length > 0) {
          const firstFailure = failures[0];
          throw firstFailure instanceof Error ? firstFailure : new Error(t("git.github.operationFailed"));
        }
      });
    }
  }, [headHash, remote, run, t, tab]);

  useEffect(() => {
    if (!loading && auth?.authenticated) void refreshRepositoryData();
  }, [auth?.authenticated, loading, refreshRepositoryData]);

  const signInWithToken = async () => {
    const value = token.trim();
    if (!value) return;
    const result = await run("token", () => githubApi.setToken(value));
    if (result) {
      setToken("");
      const nextAuth = await loadAuth();
      if (nextAuth?.authenticated) {
        await loadOrganizations(true);
        await loadRemote(true);
      }
      toast.success(t("git.github.signedIn"));
    }
  };

  const startDeviceFlow = async () => {
    const result = await run("device-start", () => githubApi.deviceStart());
    if (!result) return;
    setDevice({
      code: result.device_code,
      userCode: result.user_code,
      uri: result.verification_uri,
      interval: result.interval,
    });
    window.open(result.verification_uri_complete || result.verification_uri, "_blank", "noopener,noreferrer");
  };

  const startOAuth = async () => {
    const result = await run("oauth", () => githubApi.authStart());
    if (!result) return;
    window.open(result.url, "_blank", "noopener,noreferrer");
    stopOAuthPolling();
    const deadline = Date.now() + 10 * 60 * 1000;
    const poll = async () => {
      if (Date.now() >= deadline) {
        oauthTimerRef.current = null;
        return;
      }
      try {
        const next = await githubApi.authStatus();
        if (next.authenticated) {
          oauthTimerRef.current = null;
          try {
            const nextAuth = await loadAuth();
            if (nextAuth?.authenticated) {
              await loadOrganizations(true);
              await loadRemote(true);
            }
            toast.success(t("git.github.signedIn"));
          } catch {
            // loadAuth already reports request failures through the panel.
          }
          return;
        }
      } catch {
        // The callback window may be closed or the server may be briefly
        // unavailable; keep polling until the OAuth state expires.
      }
      oauthTimerRef.current = window.setTimeout(() => void poll(), 2000);
    };
    oauthTimerRef.current = window.setTimeout(() => void poll(), 1000);
  };

  const signOut = async () => {
    const result = await run("logout", () => githubApi.logout());
    if (result) {
      setAuth(result);
      setAccount(null);
      setOrganizations([]);
      setSelectedOrganization("");
    }
  };

  const cancelDeviceFlow = async () => {
    setDevice(null);
    await run("device-cancel", () => githubApi.deviceCancel());
  };

  const toggleWorkflowRun = async (workflowRun: GitHubWorkflowRun) => {
    if (expandedWorkflowRun === workflowRun.id) {
      setExpandedWorkflowRun(null);
      setExpandedWorkflowJob(null);
      return;
    }
    const result = await run(`jobs:${workflowRun.id}`, () =>
      githubApi.workflowRunJobs(remote?.owner || "", remote?.repository || "", workflowRun.id, "latest")
    );
    if (!result) return;
    setWorkflowJobs((current) => ({ ...current, [workflowRun.id]: result.jobs || [] }));
    setExpandedWorkflowRun(workflowRun.id);
    setExpandedWorkflowJob(null);
  };

  const toggleWorkflowJob = (job: GitHubWorkflowJob) => {
    setExpandedWorkflowJob((current) => (current === job.id ? null : job.id));
  };

  const rerunWorkflow = async (id: number, failedOnly = false) => {
    if (!remote) return;
    const result = await run(failedOnly ? `rerun-failed:${id}` : `rerun-workflow:${id}`, () =>
      failedOnly
        ? githubApi.rerunFailedJobs({ owner: remote.owner, repo: remote.repository, id })
        : githubApi.rerunWorkflowRun({ owner: remote.owner, repo: remote.repository, id })
    );
    if (result) {
      toast.success(t("git.github.rerunRequested"));
      await refreshRepositoryData();
    }
  };

  const rerunSuite = async (id: number) => {
    if (!remote) return;
    const result = await run(`rerun-suite:${id}`, () =>
      githubApi.rerunCheckSuite({ owner: remote.owner, repo: remote.repository, id })
    );
    if (result) {
      toast.success(t("git.github.rerunRequested"));
      await refreshRepositoryData();
    }
  };

  const rerunJob = async (id: number) => {
    if (!remote) return;
    const result = await run(`rerun-job:${id}`, () =>
      githubApi.rerunWorkflowJob({ owner: remote.owner, repo: remote.repository, id })
    );
    if (result) {
      toast.success(t("git.github.rerunRequested"));
      await refreshRepositoryData();
    }
  };

  const publishRepository = async () => {
    const name = newRepoName.trim() || path.split(/[\\/]/).filter(Boolean).pop() || "repository";
    const result = await run("publish", () =>
      githubApi.publish(name, newRepoDescription.trim(), newRepoPrivate, selectedOrganization || undefined)
    );
    if (!result) return;
    const cloneURL = result.clone_url || result.repository.clone_url;
    const added = await run("remote-add", () => gitApi.addRemote(path, "origin", cloneURL));
    if (!added) return;
    const pushed = await run("push", () => gitApi.push(path, "origin", false));
    if (pushed) {
      const parsed = await run("remote", () => githubApi.parseRemote(cloneURL));
      if (parsed) setRemote(parsed);
      setRepository(result.repository);
      onChanged?.();
      toast.success(t("git.github.published"));
    }
  };

  const createPullRequest = async () => {
    if (!remote || !newTitle.trim() || !newHead.trim() || !newBase.trim()) return;
    const result = await run("create-pull", () =>
      githubApi.createPullRequest({
        owner: remote.owner,
        repo: remote.repository,
        title: newTitle.trim(),
        body: newBody,
        head: newHead.trim(),
        base: newBase.trim(),
        draft: false,
      })
    );
    if (result) {
      setNewTitle("");
      setNewBody("");
      await refreshRepositoryData();
      toast.success(t("git.github.created"));
    }
  };

  const createIssue = async () => {
    if (!remote || !newTitle.trim()) return;
    const result = await run("create-issue", () =>
      githubApi.createIssue({ owner: remote.owner, repo: remote.repository, title: newTitle.trim(), body: newBody })
    );
    if (result) {
      setNewTitle("");
      setNewBody("");
      await refreshRepositoryData();
      toast.success(t("git.github.created"));
    }
  };

  const tabItems = useMemo(
    () => [
      { id: "repository" as const, label: t("git.github.repository") },
      { id: "pulls" as const, label: t("git.github.pullRequests") },
      { id: "issues" as const, label: t("git.github.issues") },
      { id: "checks" as const, label: t("git.github.checks") },
    ],
    [t]
  );

  return (
    <div className="github-panel-overlay" role="presentation">
      <section className="github-panel" role="dialog" aria-modal="true" aria-label={t("git.github.title")}>
        <header className="github-panel-header">
          <div className="github-panel-title">
            <GitBranch size={16} />
            <span>{t("git.github.title")}</span>
          </div>
          <div className="github-panel-header-actions">
            <button
              type="button"
              className="github-panel-icon-button"
              onClick={() => void loadData()}
              title={t("git.github.refresh")}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            <button type="button" className="github-panel-icon-button" onClick={onClose} title={t("common.close")}>
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="github-panel-content">
          {error && <div className="github-panel-error">{error}</div>}
          <section className="github-panel-section github-panel-auth">
            <div className="github-panel-section-heading">
              <span>{t("git.github.account")}</span>
              {auth?.authenticated && (
                <span className="github-panel-status">{account?.login || t("git.github.connected")}</span>
              )}
            </div>
            {auth?.authenticated ? (
              <div className="github-panel-authenticated">
                <span className="github-panel-muted">{account?.name || account?.login}</span>
                <button
                  type="button"
                  className="github-panel-button"
                  onClick={() => void signOut()}
                  disabled={busy === "logout"}
                >
                  <LogOut size={12} />
                  {t("git.github.signOut")}
                </button>
              </div>
            ) : (
              <div className="github-panel-auth-controls">
                <div className="github-panel-inline">
                  <KeyRound size={13} />
                  <input
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder={t("git.github.tokenPlaceholder")}
                    type="password"
                    aria-label={t("git.github.tokenPlaceholder")}
                  />
                  <button
                    type="button"
                    className="github-panel-button github-panel-button-primary"
                    onClick={() => void signInWithToken()}
                    disabled={busy === "token" || !token.trim()}
                  >
                    <LogIn size={12} />
                    {t("git.github.signIn")}
                  </button>
                </div>
                <div className="github-panel-inline github-panel-muted">
                  <button
                    type="button"
                    className="github-panel-button"
                    onClick={() => void startOAuth()}
                    disabled={!auth?.oauth_configured || busy === "oauth"}
                  >
                    {t("git.github.oauth")}
                  </button>
                  <button
                    type="button"
                    className="github-panel-button"
                    onClick={() => void startDeviceFlow()}
                    disabled={!auth?.device_configured || busy === "device-start"}
                  >
                    {t("git.github.deviceFlow")}
                  </button>
                </div>
                {device && (
                  <div className="github-panel-device">
                    <span>
                      {t("git.github.deviceCode")}: <strong>{device.userCode}</strong>
                    </span>
                    <span className="github-panel-device-actions">
                      <a href={device.uri} target="_blank" rel="noreferrer">
                        {t("git.github.openVerification")}
                        <ExternalLink size={11} />
                      </a>
                      <button
                        type="button"
                        className="github-panel-icon-button"
                        onClick={() => void cancelDeviceFlow()}
                        disabled={busy !== null}
                        title={t("git.github.cancel")}
                        aria-label={t("git.github.cancel")}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                )}
              </div>
            )}
          </section>

          {auth?.authenticated && (
            <>
              <div className="github-panel-tabs" role="tablist">
                {tabItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    role="tab"
                    aria-selected={tab === item.id}
                    className={tab === item.id ? "github-panel-tab github-panel-tab-active" : "github-panel-tab"}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {tab === "repository" && (
                <section className="github-panel-section">
                  <div className="github-panel-section-heading">
                    <span>{t("git.github.repository")}</span>
                    {remote && (
                      <a href={remote.html_url} target="_blank" rel="noreferrer" className="github-panel-link">
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  {remote ? (
                    <>
                      <div className="github-panel-repository-name">
                        {repository?.full_name || `${remote.owner}/${remote.repository}`}
                      </div>
                      <div className="github-panel-muted">
                        {repository?.description || t("git.github.noDescription")}
                      </div>
                      <div className="github-panel-meta-row">
                        <span>{repository?.private ? t("git.github.private") : t("git.github.public")}</span>
                        <span>{repository?.default_branch || "main"}</span>
                      </div>
                    </>
                  ) : (
                    <div className="github-panel-publish">
                      <input
                        value={newRepoName}
                        onChange={(event) => setNewRepoName(event.target.value)}
                        placeholder={t("git.github.repositoryName")}
                        aria-label={t("git.github.repositoryName")}
                      />
                      <input
                        value={newRepoDescription}
                        onChange={(event) => setNewRepoDescription(event.target.value)}
                        placeholder={t("git.github.description")}
                        aria-label={t("git.github.description")}
                      />
                      <label className="github-panel-check">
                        <input
                          type="checkbox"
                          checked={newRepoPrivate}
                          onChange={(event) => setNewRepoPrivate(event.target.checked)}
                        />
                        {t("git.github.private")}
                      </label>
                      {organizations.length > 0 && (
                        <label className="github-panel-field-label">
                          <span>{t("git.github.organization")}</span>
                          <select
                            value={selectedOrganization}
                            onChange={(event) => setSelectedOrganization(event.target.value)}
                            aria-label={t("git.github.organization")}
                          >
                            <option value="">{t("git.github.personalAccount")}</option>
                            {organizations.map((organization) => (
                              <option key={organization.id} value={organization.login}>
                                {organization.login}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <button
                        type="button"
                        className="github-panel-button github-panel-button-primary"
                        onClick={() => void publishRepository()}
                        disabled={busy !== null}
                      >
                        <Upload size={12} />
                        {t("git.github.publish")}
                      </button>
                    </div>
                  )}
                </section>
              )}
              {tab === "pulls" && remote && (
                <section className="github-panel-section">
                  <div className="github-panel-section-heading">
                    <span>{t("git.github.pullRequests")}</span>
                    <button
                      type="button"
                      className="github-panel-icon-button"
                      onClick={() => void refreshRepositoryData()}
                      title={t("git.github.refresh")}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <div className="github-panel-form">
                    <input
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      placeholder={t("git.github.titlePlaceholder")}
                      aria-label={t("git.github.titlePlaceholder")}
                    />
                    <textarea
                      value={newBody}
                      onChange={(event) => setNewBody(event.target.value)}
                      placeholder={t("git.github.bodyPlaceholder")}
                      aria-label={t("git.github.bodyPlaceholder")}
                    />
                    <div className="github-panel-inline">
                      <input
                        value={newHead}
                        onChange={(event) => setNewHead(event.target.value)}
                        placeholder={t("git.github.headBranch")}
                        aria-label={t("git.github.headBranch")}
                      />
                      <input
                        value={newBase}
                        onChange={(event) => setNewBase(event.target.value)}
                        placeholder={t("git.github.baseBranch")}
                        aria-label={t("git.github.baseBranch")}
                      />
                      <button
                        type="button"
                        className="github-panel-button github-panel-button-primary"
                        onClick={() => void createPullRequest()}
                        disabled={busy !== null || !newTitle.trim()}
                      >
                        <GitPullRequest size={12} />
                        {t("git.github.create")}
                      </button>
                    </div>
                  </div>
                  <div className="github-panel-list">
                    {pulls.length === 0 ? (
                      <div className="github-panel-muted">{t("git.github.empty")}</div>
                    ) : (
                      pulls.map((item) => (
                        <a
                          className="github-panel-list-row"
                          href={item.html_url}
                          target="_blank"
                          rel="noreferrer"
                          key={item.number}
                        >
                          <GitPullRequest size={13} />
                          <span>
                            <strong>
                              #{item.number} {item.title}
                            </strong>
                            <small>
                              {item.user?.login || ""} · {item.state}
                            </small>
                          </span>
                          <ExternalLink size={11} />
                        </a>
                      ))
                    )}
                  </div>
                </section>
              )}
              {tab === "issues" && remote && (
                <section className="github-panel-section">
                  <div className="github-panel-section-heading">
                    <span>{t("git.github.issues")}</span>
                    <button
                      type="button"
                      className="github-panel-icon-button"
                      onClick={() => void refreshRepositoryData()}
                      title={t("git.github.refresh")}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <div className="github-panel-form">
                    <input
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      placeholder={t("git.github.titlePlaceholder")}
                      aria-label={t("git.github.titlePlaceholder")}
                    />
                    <textarea
                      value={newBody}
                      onChange={(event) => setNewBody(event.target.value)}
                      placeholder={t("git.github.bodyPlaceholder")}
                      aria-label={t("git.github.bodyPlaceholder")}
                    />
                    <button
                      type="button"
                      className="github-panel-button github-panel-button-primary"
                      onClick={() => void createIssue()}
                      disabled={busy !== null || !newTitle.trim()}
                    >
                      <CircleDot size={12} />
                      {t("git.github.create")}
                    </button>
                  </div>
                  <div className="github-panel-list">
                    {issues.filter((item) => !item.pull_request).length === 0 ? (
                      <div className="github-panel-muted">{t("git.github.empty")}</div>
                    ) : (
                      issues
                        .filter((item) => !item.pull_request)
                        .map((item) => (
                          <a
                            className="github-panel-list-row"
                            href={item.html_url}
                            target="_blank"
                            rel="noreferrer"
                            key={item.number}
                          >
                            <CircleDot size={13} />
                            <span>
                              <strong>
                                #{item.number} {item.title}
                              </strong>
                              <small>
                                {item.user?.login || ""} · {item.state}
                              </small>
                            </span>
                            <ExternalLink size={11} />
                          </a>
                        ))
                    )}
                  </div>
                </section>
              )}
              {tab === "checks" && remote && (
                <section className="github-panel-section">
                  <div className="github-panel-section-heading">
                    <span>{t("git.github.checks")}</span>
                    <button
                      type="button"
                      className="github-panel-icon-button"
                      onClick={() => void refreshRepositoryData()}
                      title={t("git.github.refresh")}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <div className="github-panel-meta-row">
                    <span>{headHash?.slice(0, 8) || currentBranch}</span>
                    <span className="github-panel-status">
                      <ShieldCheck size={12} />
                      {checkState || t("git.github.unknown")}
                    </span>
                  </div>

                  <div className="github-panel-subheading-row">
                    <span>{t("git.github.workflowRuns")}</span>
                    <span className="github-panel-muted">{workflowRuns.length}</span>
                  </div>
                  <div className="github-panel-list">
                    {workflowRuns.length === 0 ? (
                      <div className="github-panel-muted">{t("git.github.noWorkflowRuns")}</div>
                    ) : (
                      workflowRuns.map((workflowRun) => {
                        const jobs = workflowJobs[workflowRun.id] || [];
                        const expanded = expandedWorkflowRun === workflowRun.id;
                        return (
                          <React.Fragment key={workflowRun.id}>
                            <div className="github-panel-list-row github-panel-action-row">
                              <button
                                type="button"
                                className="github-panel-action-toggle"
                                onClick={() => void toggleWorkflowRun(workflowRun)}
                                aria-expanded={expanded}
                                title={expanded ? t("git.github.hideDetails") : t("git.github.showDetails")}
                              >
                                <Play size={12} />
                                <span>
                                  <strong>
                                    {workflowRun.name} #{workflowRun.run_number || workflowRun.id}
                                  </strong>
                                  <small>
                                    {workflowRun.status}
                                    {workflowRun.conclusion ? ` · ${workflowRun.conclusion}` : ""}
                                    {workflowRun.head_branch ? ` · ${workflowRun.head_branch}` : ""}
                                  </small>
                                </span>
                              </button>
                              <span className="github-panel-action-buttons">
                                <button
                                  type="button"
                                  className="github-panel-icon-button"
                                  onClick={() => void rerunWorkflow(workflowRun.id)}
                                  disabled={busy !== null}
                                  title={t("git.github.rerunWorkflow")}
                                  aria-label={t("git.github.rerunWorkflow")}
                                >
                                  <Play size={11} />
                                </button>
                                <button
                                  type="button"
                                  className="github-panel-icon-button"
                                  onClick={() => void rerunWorkflow(workflowRun.id, true)}
                                  disabled={busy !== null || workflowRun.conclusion !== "failure"}
                                  title={t("git.github.rerunFailedJobs")}
                                  aria-label={t("git.github.rerunFailedJobs")}
                                >
                                  <RefreshCw size={11} />
                                </button>
                              </span>
                            </div>
                            {expanded && (
                              <div className="github-panel-nested-list">
                                {jobs.length === 0 ? (
                                  <div className="github-panel-muted">{t("git.github.empty")}</div>
                                ) : (
                                  jobs.map((job) => {
                                    const jobExpanded = expandedWorkflowJob === job.id;
                                    const steps = job.steps ?? [];
                                    return (
                                      <React.Fragment key={job.id}>
                                        <div className="github-panel-list-row github-panel-job-row">
                                          <button
                                            type="button"
                                            className="github-panel-action-toggle"
                                            onClick={() => toggleWorkflowJob(job)}
                                            aria-expanded={jobExpanded}
                                            title={
                                              jobExpanded ? t("git.github.hideDetails") : t("git.github.showDetails")
                                            }
                                          >
                                            <ShieldCheck size={12} />
                                            <span>
                                              <strong>{job.name}</strong>
                                              <small>
                                                {job.status}
                                                {job.conclusion ? ` · ${job.conclusion}` : ""}
                                              </small>
                                            </span>
                                          </button>
                                          <button
                                            type="button"
                                            className="github-panel-icon-button"
                                            onClick={() => void rerunJob(job.id)}
                                            disabled={busy !== null || job.conclusion !== "failure"}
                                            title={t("git.github.rerun")}
                                            aria-label={t("git.github.rerun")}
                                          >
                                            <Play size={10} />
                                          </button>
                                        </div>
                                        {jobExpanded && (
                                          <div className="github-panel-steps">
                                            <div className="github-panel-step-heading">
                                              {t("git.github.workflowSteps")}
                                            </div>
                                            {steps.length === 0 ? (
                                              <div className="github-panel-muted">{t("git.github.empty")}</div>
                                            ) : (
                                              steps.map((step) => (
                                                <div className="github-panel-step" key={`${job.id}-${step.number}`}>
                                                  <span>
                                                    {step.number}. {step.name}
                                                  </span>
                                                  <small>
                                                    {step.status}
                                                    {step.conclusion ? ` · ${step.conclusion}` : ""}
                                                  </small>
                                                  {step.log && <pre>{step.log}</pre>}
                                                </div>
                                              ))
                                            )}
                                          </div>
                                        )}
                                      </React.Fragment>
                                    );
                                  })
                                )}
                              </div>
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </div>

                  <div className="github-panel-subheading-row">
                    <span>{t("git.github.checkSuites")}</span>
                    <span className="github-panel-muted">{checkSuites.length}</span>
                  </div>
                  <div className="github-panel-list">
                    {checkSuites.length === 0 ? (
                      <div className="github-panel-muted">{t("git.github.noCheckSuites")}</div>
                    ) : (
                      checkSuites.map((suite) => (
                        <div className="github-panel-list-row" key={suite.id}>
                          <ShieldCheck size={13} />
                          <span>
                            <strong>
                              {suite.app && typeof suite.app === "object" && "name" in suite.app
                                ? String(suite.app.name)
                                : `#${suite.id}`}
                            </strong>
                            <small>
                              {suite.status || t("git.github.unknown")}
                              {suite.conclusion ? ` · ${suite.conclusion}` : ""}
                            </small>
                          </span>
                          <button
                            type="button"
                            className="github-panel-icon-button"
                            onClick={() => void rerunSuite(suite.id)}
                            // `/check-suites/:id/rerequest` is authorized by
                            // rerequestable; runs_rerequestable describes the
                            // individual runs and does not grant this action.
                            disabled={busy !== null || !isCheckSuiteRerunnable(suite)}
                            title={t("git.github.rerun")}
                            aria-label={t("git.github.rerun")}
                          >
                            <Play size={11} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="github-panel-subheading-row">
                    <span>{t("git.github.checks")}</span>
                    <span className="github-panel-muted">{checks.length}</span>
                  </div>
                  <div className="github-panel-list">
                    {checks.length === 0 ? (
                      <div className="github-panel-muted">{t("git.github.empty")}</div>
                    ) : (
                      checks.map((item) => (
                        <div className="github-panel-list-row" key={item.id}>
                          <ShieldCheck size={13} />
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {item.status}
                              {item.conclusion ? ` · ${item.conclusion}` : ""}
                            </small>
                          </span>
                          <button
                            type="button"
                            className="github-panel-icon-button"
                            onClick={() =>
                              remote &&
                              void run(`rerun:${item.id}`, () =>
                                githubApi.rerunCheck({ owner: remote.owner, repo: remote.repository, id: item.id })
                              )
                            }
                            disabled={busy !== null}
                            title={t("git.github.rerun")}
                          >
                            <Play size={11} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
};

export default GitHubPanel;
