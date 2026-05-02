import {
  Check,
  Download,
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitFork,
  HardDrive,
  Loader2,
  Move,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type GitLFSStatus,
  type GitRepositoryConfig,
  type GitRepositoryRemote,
  type GitRepositorySettings as GitRepositorySettingsSnapshot,
  type GitSubmoduleEntry,
  type GitWorktreeEntry,
  gitApi,
} from "@/api/git";
import { useDialog } from "@/components/common";
import { getTranslation, type Locale } from "@/lib/i18n";
import "@/components/git/git-repository-settings.css";

interface GitRepositorySettingsProps {
  path: string;
  locale: Locale;
  onClose: () => void;
  onChanged?: () => void;
  onOpenWorktree?: (path: string) => void;
}

type IdentityScope = "local" | "global";

interface RemoteDraft {
  url: string;
  pushUrl: string;
}

interface WorktreeDraft {
  path: string;
  branch: string;
  commit: string;
  createBranch: boolean;
}

const emptyWorktreeDraft = (): WorktreeDraft => ({
  path: "",
  branch: "",
  commit: "",
  createBranch: false,
});

const configValue = (config: GitRepositoryConfig, scope: IdentityScope) => ({
  name: scope === "local" ? config.localUserName : config.globalUserName,
  email: scope === "local" ? config.localUserEmail : config.globalUserEmail,
});

const remoteDraftsFrom = (remotes: GitRepositoryRemote[]) => {
  const drafts: Record<string, RemoteDraft> = {};
  for (const remote of remotes) {
    drafts[remote.name] = { url: remote.fetchUrl, pushUrl: remote.pushUrls[0] || "" };
  }
  return drafts;
};

const worktreeLabel = (worktree: GitWorktreeEntry, t: (key: string) => string) => {
  if (worktree.main) return t("git.repositorySettings.main");
  if (worktree.detached) return t("git.repositorySettings.detached");
  return worktree.branch || worktree.head.slice(0, 8);
};

const GitRepositorySettings: React.FC<GitRepositorySettingsProps> = ({
  path,
  locale,
  onClose,
  onChanged,
  onOpenWorktree,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const dialog = useDialog();
  const [snapshot, setSnapshot] = useState<GitRepositorySettingsSnapshot | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<IdentityScope>("local");
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [remoteDrafts, setRemoteDrafts] = useState<Record<string, RemoteDraft>>({});
  const [newRemoteName, setNewRemoteName] = useState("");
  const [newRemoteUrl, setNewRemoteUrl] = useState("");
  const [gitignore, setGitignore] = useState("");
  const [lfs, setLfs] = useState<GitLFSStatus | null>(null);
  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDraft>(emptyWorktreeDraft);
  const [movePaths, setMovePaths] = useState<Record<string, string>>({});
  const [submodules, setSubmodules] = useState<GitSubmoduleEntry[]>([]);
  const [submoduleRecursive, setSubmoduleRecursive] = useState(true);
  const [allowFileProtocol, setAllowFileProtocol] = useState(false);
  const scopeRef = useRef<IdentityScope>(scope);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const applySnapshot = useCallback((next: GitRepositorySettingsSnapshot) => {
    setSnapshot(next);
    setGitignore(next.gitignore);
    setLfs(next.lfs);
    const selected = configValue(next.config, scopeRef.current);
    setIdentityName(selected.name);
    setIdentityEmail(selected.email);
    setRemoteDrafts(remoteDraftsFrom(next.remotes));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSnapshot, worktreeResponse] = await Promise.all([
        gitApi.repositorySettings(path),
        gitApi.worktrees(path),
      ]);
      applySnapshot(nextSnapshot);
      setWorktrees(worktreeResponse.worktrees || []);
      try {
        const submoduleResponse = await gitApi.submodules(path);
        setSubmodules(submoduleResponse.submodules || []);
      } catch {
        // Older servers may not expose the optional submodule endpoint.
        setSubmodules([]);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("git.repositorySettings.loadFailed");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, path, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const refreshWorktrees = useCallback(async () => {
    try {
      const response = await gitApi.worktrees(path);
      setWorktrees(response.worktrees || []);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("git.repositorySettings.operationFailed");
      setError(message);
      toast.error(message);
    }
  }, [path, t]);

  const refreshSubmodules = useCallback(async () => {
    try {
      const response = await gitApi.submodules(path);
      setSubmodules(response.submodules || []);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("git.repositorySettings.operationFailed");
      setError(message);
      toast.error(message);
    }
  }, [path, t]);

  const run = useCallback(
    async <T,>(key: string, action: () => Promise<T>, successMessage?: string): Promise<T | null> => {
      setBusy(key);
      setError(null);
      try {
        const result = await action();
        if (successMessage) toast.success(successMessage);
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : t("git.repositorySettings.operationFailed");
        setError(message);
        toast.error(message);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [t]
  );

  const handleScopeChange = (nextScope: IdentityScope) => {
    setScope(nextScope);
    if (!snapshot) return;
    const selected = configValue(snapshot.config, nextScope);
    setIdentityName(selected.name);
    setIdentityEmail(selected.email);
  };

  const saveIdentity = async () => {
    const next = await run(
      "identity",
      () => gitApi.updateConfig(path, scope, identityName.trim(), identityEmail.trim()),
      t("git.repositorySettings.saved")
    );
    if (next) applySnapshot(next);
  };

  const saveRemote = async (remote: GitRepositoryRemote) => {
    const draft = remoteDrafts[remote.name] || { url: remote.fetchUrl, pushUrl: remote.pushUrls[0] || "" };
    const next = await run(
      `remote:${remote.name}`,
      () => gitApi.setRemote(path, remote.name, draft.url.trim(), draft.pushUrl.trim()),
      t("git.repositorySettings.saved")
    );
    if (next && snapshot) setSnapshot({ ...snapshot, remotes: next.remotes });
    if (next) setRemoteDrafts(remoteDraftsFrom(next.remotes));
  };

  const addRemote = async () => {
    const name = newRemoteName.trim();
    const url = newRemoteUrl.trim();
    if (!name || !url) {
      setError(t("git.repositorySettings.remoteRequired"));
      return;
    }
    const next = await run("remote:add", () => gitApi.addRemote(path, name, url), t("git.repositorySettings.saved"));
    if (next && snapshot) setSnapshot({ ...snapshot, remotes: next.remotes });
    if (next) {
      setRemoteDrafts(remoteDraftsFrom(next.remotes));
      setNewRemoteName("");
      setNewRemoteUrl("");
    }
  };

  const deleteRemote = async (remote: GitRepositoryRemote) => {
    const confirmed = await dialog.confirm(
      t("git.repositorySettings.deleteRemoteTitle"),
      `${remote.name}: ${remote.fetchUrl}`,
      { confirmText: t("common.delete"), confirmVariant: "danger" }
    );
    if (!confirmed) return;
    const next = await run(
      `remote:delete:${remote.name}`,
      () => gitApi.deleteRemote(path, remote.name),
      t("git.repositorySettings.saved")
    );
    if (next && snapshot) setSnapshot({ ...snapshot, remotes: next.remotes });
    if (next) setRemoteDrafts(remoteDraftsFrom(next.remotes));
  };

  const saveGitignore = async () => {
    const next = await run(
      "gitignore",
      () => gitApi.updateGitIgnore(path, gitignore),
      t("git.repositorySettings.saved")
    );
    if (next) {
      setGitignore(next.gitignore);
      if (snapshot) setSnapshot({ ...snapshot, gitignore: next.gitignore });
    }
  };

  const initializeLfs = async () => {
    const next = await run("lfs", () => gitApi.gitLFS(path, "init"), t("git.repositorySettings.saved"));
    if (next) {
      setLfs(next);
      if (snapshot) setSnapshot({ ...snapshot, lfs: next });
    }
  };

  const addWorktree = async () => {
    const draft = worktreeDraft;
    if (!draft.path.trim()) {
      setError(t("git.repositorySettings.worktreeRequired"));
      return;
    }
    if (draft.createBranch && !draft.branch.trim()) {
      setError(t("git.repositorySettings.branchRequired"));
      return;
    }
    const next = await run(
      "worktree:add",
      () =>
        gitApi.addWorktree(path, draft.path.trim(), {
          branch: draft.branch.trim() || undefined,
          commit: draft.commit.trim() || undefined,
          createBranch: draft.createBranch,
        }),
      t("git.repositorySettings.saved")
    );
    if (next) {
      setWorktreeDraft(emptyWorktreeDraft());
      await refreshWorktrees();
    }
  };

  const removeWorktree = async (worktree: GitWorktreeEntry) => {
    const confirmed = await dialog.confirm(t("git.repositorySettings.removeWorktreeTitle"), worktree.path, {
      confirmText: t("common.remove"),
      confirmVariant: "danger",
    });
    if (!confirmed) return;
    const next = await run(
      `worktree:remove:${worktree.path}`,
      () => gitApi.removeWorktree(path, worktree.path),
      t("git.repositorySettings.saved")
    );
    if (next) await refreshWorktrees();
  };

  const moveWorktree = async (worktree: GitWorktreeEntry) => {
    const newPath = (movePaths[worktree.path] || "").trim();
    if (!newPath || newPath === worktree.path) return;
    const next = await run(
      `worktree:move:${worktree.path}`,
      () => gitApi.moveWorktree(path, worktree.path, newPath),
      t("git.repositorySettings.saved")
    );
    if (next) {
      setMovePaths((current) => {
        const copy = { ...current };
        delete copy[worktree.path];
        return copy;
      });
      await refreshWorktrees();
    }
  };

  const updateSubmodules = async (paths: string[] = []) => {
    const key = paths.length === 1 ? `submodule:update:${paths[0]}` : "submodule:update";
    const next = await run(
      key,
      () =>
        gitApi.updateSubmodules(path, paths, {
          recursive: submoduleRecursive,
          allowFileProtocol,
        }),
      t("git.repositorySettings.submodulesUpdated")
    );
    if (next) {
      setSubmodules(next.submodules || []);
      onChanged?.();
    }
  };

  const resetSubmodules = async (paths: string[] = []) => {
    const confirmed = await dialog.confirm(
      t("git.repositorySettings.resetSubmodulesTitle"),
      t("git.repositorySettings.resetSubmodulesMessage"),
      { confirmText: t("git.repositorySettings.forceReset"), confirmVariant: "danger" }
    );
    if (!confirmed) return;
    const key = paths.length === 1 ? `submodule:reset:${paths[0]}` : "submodule:reset";
    const next = await run(
      key,
      () =>
        gitApi.resetSubmodules(path, paths, {
          recursive: submoduleRecursive,
          allowFileProtocol,
        }),
      t("git.repositorySettings.submodulesReset")
    );
    if (next) {
      setSubmodules(next.submodules || []);
      onChanged?.();
    }
  };

  const remoteRows = useMemo(() => snapshot?.remotes || [], [snapshot?.remotes]);
  const currentLfs = lfs || snapshot?.lfs;
  const submodulesBusy = busy === "submodule:update" || busy === "submodule:reset";

  return (
    <div className="git-repository-settings-overlay" role="presentation">
      <section
        className="git-repository-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("git.repositorySettings.title")}
      >
        <header className="git-repository-settings-header">
          <div className="git-repository-settings-heading">
            <Settings2 size={16} />
            <div className="git-repository-settings-title-wrap">
              <h2>{t("git.repositorySettings.title")}</h2>
              <span title={path}>{path}</span>
            </div>
          </div>
          <div className="git-repository-settings-header-actions">
            <button
              type="button"
              className="git-repository-settings-icon-button"
              onClick={() => void load()}
              disabled={loading}
              title={t("git.repositorySettings.reload")}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
              <span className="sr-only">{t("git.repositorySettings.reload")}</span>
            </button>
            <button
              type="button"
              className="git-repository-settings-icon-button"
              onClick={onClose}
              title={t("common.close")}
            >
              <X size={15} />
              <span className="sr-only">{t("common.close")}</span>
            </button>
          </div>
        </header>

        {loading && !snapshot ? (
          <div className="git-repository-settings-loading">
            <Loader2 size={18} className="animate-spin" />
            <span>{t("git.repositorySettings.loading")}</span>
          </div>
        ) : !snapshot ? (
          <div className="git-repository-settings-loading git-repository-settings-load-error">
            <div className="git-repository-settings-error">{error || t("git.repositorySettings.loadFailed")}</div>
            <button type="button" className="git-repository-settings-button" onClick={() => void load()}>
              <RefreshCw size={13} />
              {t("git.repositorySettings.reload")}
            </button>
          </div>
        ) : (
          <div className="git-repository-settings-scroll">
            {error && <div className="git-repository-settings-error">{error}</div>}

            <section className="git-repository-settings-section">
              <div className="git-repository-settings-section-heading">
                <UserRound size={14} />
                <h3>{t("git.repositorySettings.identity")}</h3>
              </div>
              <div className="git-repository-settings-form-grid">
                <label>
                  <span>{t("git.repositorySettings.scope")}</span>
                  <select
                    value={scope}
                    onChange={(event) => handleScopeChange(event.target.value as IdentityScope)}
                    disabled={busy === "identity"}
                  >
                    <option value="local">{t("git.repositorySettings.local")}</option>
                    <option value="global">{t("git.repositorySettings.global")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("git.repositorySettings.name")}</span>
                  <input
                    value={identityName}
                    onChange={(event) => setIdentityName(event.target.value)}
                    autoComplete="name"
                  />
                </label>
                <label className="git-repository-settings-field-wide">
                  <span>{t("git.repositorySettings.email")}</span>
                  <input
                    value={identityEmail}
                    onChange={(event) => setIdentityEmail(event.target.value)}
                    type="email"
                    autoComplete="email"
                  />
                </label>
              </div>
              <div className="git-repository-settings-effective">
                <span>{t("git.repositorySettings.effective")}</span>
                <code>
                  {snapshot?.config.effectiveName || "-"} &lt;{snapshot?.config.effectiveEmail || "-"}&gt;
                </code>
              </div>
              <button
                type="button"
                className="git-repository-settings-button git-repository-settings-button--primary"
                onClick={() => void saveIdentity()}
                disabled={busy === "identity"}
              >
                {busy === "identity" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {t("git.repositorySettings.saveIdentity")}
              </button>
            </section>

            <section className="git-repository-settings-section">
              <div className="git-repository-settings-section-heading">
                <GitBranch size={14} />
                <h3>{t("git.repositorySettings.remotes")}</h3>
              </div>
              {remoteRows.length === 0 && (
                <div className="git-repository-settings-empty">{t("git.repositorySettings.noRemotes")}</div>
              )}
              <div className="git-repository-settings-list">
                {remoteRows.map((remote) => {
                  const draft = remoteDrafts[remote.name] || {
                    url: remote.fetchUrl,
                    pushUrl: remote.pushUrls[0] || "",
                  };
                  const remoteBusy = busy === `remote:${remote.name}` || busy === `remote:delete:${remote.name}`;
                  return (
                    <div className="git-repository-settings-list-row" key={remote.name}>
                      <div className="git-repository-settings-list-row-heading">
                        <strong>{remote.name}</strong>
                        <button
                          type="button"
                          className="git-repository-settings-icon-button git-repository-settings-icon-button--danger"
                          onClick={() => void deleteRemote(remote)}
                          disabled={remoteBusy}
                          title={t("common.delete")}
                        >
                          <Trash2 size={13} />
                          <span className="sr-only">{t("common.delete")}</span>
                        </button>
                      </div>
                      <div className="git-repository-settings-form-grid">
                        <label>
                          <span>{t("git.repositorySettings.fetchUrl")}</span>
                          <input
                            value={draft.url}
                            onChange={(event) =>
                              setRemoteDrafts((current) => ({
                                ...current,
                                [remote.name]: { ...draft, url: event.target.value },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>{t("git.repositorySettings.pushUrl")}</span>
                          <input
                            value={draft.pushUrl}
                            onChange={(event) =>
                              setRemoteDrafts((current) => ({
                                ...current,
                                [remote.name]: { ...draft, pushUrl: event.target.value },
                              }))
                            }
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className="git-repository-settings-button"
                        onClick={() => void saveRemote(remote)}
                        disabled={remoteBusy}
                      >
                        {remoteBusy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                        {t("common.save")}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="git-repository-settings-add-row">
                <input
                  value={newRemoteName}
                  onChange={(event) => setNewRemoteName(event.target.value)}
                  placeholder={t("git.repositorySettings.remoteName")}
                  aria-label={t("git.repositorySettings.remoteName")}
                />
                <input
                  value={newRemoteUrl}
                  onChange={(event) => setNewRemoteUrl(event.target.value)}
                  placeholder={t("git.repositorySettings.remoteUrl")}
                  aria-label={t("git.repositorySettings.remoteUrl")}
                />
                <button
                  type="button"
                  className="git-repository-settings-button git-repository-settings-button--primary"
                  onClick={() => void addRemote()}
                  disabled={busy === "remote:add"}
                >
                  {busy === "remote:add" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  {t("git.repositorySettings.addRemote")}
                </button>
              </div>
            </section>

            <section className="git-repository-settings-section">
              <div className="git-repository-settings-section-heading">
                <FileCode2 size={14} />
                <h3>.gitignore</h3>
              </div>
              <textarea
                value={gitignore}
                onChange={(event) => setGitignore(event.target.value)}
                placeholder={t("git.repositorySettings.gitignorePlaceholder")}
                spellCheck={false}
              />
              <div className="git-repository-settings-section-actions">
                <span className="git-repository-settings-hint">{gitignore.length.toLocaleString()} / 1 MB</span>
                <button
                  type="button"
                  className="git-repository-settings-button git-repository-settings-button--primary"
                  onClick={() => void saveGitignore()}
                  disabled={busy === "gitignore"}
                >
                  {busy === "gitignore" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  {t("git.repositorySettings.saveGitignore")}
                </button>
              </div>
            </section>

            <section className="git-repository-settings-section">
              <div className="git-repository-settings-section-heading">
                <HardDrive size={14} />
                <h3>Git LFS</h3>
              </div>
              <div className="git-repository-settings-status-grid">
                <span>{t("git.repositorySettings.status")}</span>
                <strong
                  className={
                    currentLfs?.installed
                      ? "git-repository-settings-status--ok"
                      : "git-repository-settings-status--warning"
                  }
                >
                  {currentLfs?.installed
                    ? t("git.repositorySettings.installed")
                    : t("git.repositorySettings.notInstalled")}
                </strong>
                <span>{t("git.repositorySettings.initialized")}</span>
                <strong>
                  {currentLfs?.initialized ? t("git.repositorySettings.yes") : t("git.repositorySettings.no")}
                </strong>
                <span>{t("git.repositorySettings.trackedFiles")}</span>
                <strong>{currentLfs?.trackedFiles.length || 0}</strong>
              </div>
              {currentLfs?.version && <code className="git-repository-settings-muted-code">{currentLfs.version}</code>}
              {currentLfs?.error && <div className="git-repository-settings-hint">{currentLfs.error}</div>}
              <button
                type="button"
                className="git-repository-settings-button"
                onClick={() => void initializeLfs()}
                disabled={busy === "lfs" || !currentLfs?.installed || currentLfs.initialized}
              >
                {busy === "lfs" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {t("git.repositorySettings.initialize")}
              </button>
            </section>

            <section className="git-repository-settings-section">
              <div className="git-repository-settings-section-heading">
                <GitFork size={14} />
                <h3>{t("git.repositorySettings.submodules")}</h3>
                <span className="git-repository-settings-count">{submodules.length}</span>
              </div>
              {submodules.length === 0 ? (
                <div className="git-repository-settings-empty">{t("git.repositorySettings.noSubmodules")}</div>
              ) : (
                <div className="git-repository-settings-list">
                  {submodules.map((submodule) => {
                    const updateBusy = busy === `submodule:update:${submodule.path}`;
                    const resetBusy = busy === `submodule:reset:${submodule.path}`;
                    const status = submodule.status;
                    return (
                      <div className="git-repository-settings-list-row" key={submodule.path}>
                        <div className="git-repository-settings-submodule-heading">
                          <div className="git-repository-settings-worktree-title">
                            <strong>{submodule.path}</strong>
                            {!status.initialized && (
                              <span className="git-repository-settings-badge git-repository-settings-badge--warning">
                                {t("git.repositorySettings.uninitialized")}
                              </span>
                            )}
                            {status.commitChanged && (
                              <span className="git-repository-settings-badge git-repository-settings-badge--warning">
                                {t("git.repositorySettings.pointerChanged")}
                              </span>
                            )}
                            {(status.modifiedChanges || status.untrackedChanges) && (
                              <span className="git-repository-settings-badge git-repository-settings-badge--dirty">
                                {t("git.repositorySettings.dirty")}
                              </span>
                            )}
                            {status.conflict && (
                              <span className="git-repository-settings-badge git-repository-settings-badge--danger">
                                {t("git.repositorySettings.conflict")}
                              </span>
                            )}
                          </div>
                          {submodule.url && <code title={submodule.url}>{submodule.url}</code>}
                        </div>
                        <div className="git-repository-settings-submodule-commits">
                          <span>
                            {t("git.repositorySettings.indexCommit")}: <code>{submodule.indexSHA || "-"}</code>
                          </span>
                          <span>
                            {t("git.repositorySettings.checkedOutCommit")}: <code>{submodule.sha || "-"}</code>
                          </span>
                        </div>
                        <div className="git-repository-settings-submodule-actions">
                          <button
                            type="button"
                            className="git-repository-settings-button"
                            onClick={() => void updateSubmodules([submodule.path])}
                            disabled={submodulesBusy || updateBusy || resetBusy}
                          >
                            {updateBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                            {status.initialized
                              ? t("git.repositorySettings.update")
                              : t("git.repositorySettings.initialize")}
                          </button>
                          <button
                            type="button"
                            className="git-repository-settings-button git-repository-settings-button--danger"
                            onClick={() => void resetSubmodules([submodule.path])}
                            disabled={submodulesBusy || updateBusy || resetBusy}
                          >
                            {resetBusy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                            {t("git.repositorySettings.forceReset")}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="git-repository-settings-submodule-options">
                <label className="git-repository-settings-checkbox">
                  <input
                    type="checkbox"
                    checked={submoduleRecursive}
                    onChange={(event) => setSubmoduleRecursive(event.target.checked)}
                  />
                  <span>{t("git.repositorySettings.recursive")}</span>
                </label>
                <label className="git-repository-settings-checkbox">
                  <input
                    type="checkbox"
                    checked={allowFileProtocol}
                    onChange={(event) => setAllowFileProtocol(event.target.checked)}
                  />
                  <span>{t("git.repositorySettings.allowFileProtocol")}</span>
                </label>
                <div className="git-repository-settings-submodule-toolbar">
                  <button
                    type="button"
                    className="git-repository-settings-button"
                    onClick={() => void updateSubmodules()}
                    disabled={submodulesBusy || submodules.length === 0}
                  >
                    {busy === "submodule:update" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    {t("git.repositorySettings.updateAll")}
                  </button>
                  <button
                    type="button"
                    className="git-repository-settings-button git-repository-settings-button--danger"
                    onClick={() => void resetSubmodules()}
                    disabled={submodulesBusy || submodules.length === 0}
                  >
                    {busy === "submodule:reset" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RotateCcw size={13} />
                    )}
                    {t("git.repositorySettings.resetAll")}
                  </button>
                  <button
                    type="button"
                    className="git-repository-settings-icon-button"
                    onClick={() => void refreshSubmodules()}
                    disabled={submodulesBusy}
                    title={t("git.repositorySettings.reload")}
                  >
                    <RefreshCw size={13} />
                    <span className="sr-only">{t("git.repositorySettings.reload")}</span>
                  </button>
                </div>
              </div>
            </section>

            <section className="git-repository-settings-section">
              <div className="git-repository-settings-section-heading">
                <FolderGit2 size={14} />
                <h3>{t("git.repositorySettings.worktrees")}</h3>
                <span className="git-repository-settings-count">{worktrees.length}</span>
              </div>
              {worktrees.length === 0 && (
                <div className="git-repository-settings-empty">{t("git.repositorySettings.noWorktrees")}</div>
              )}
              <div className="git-repository-settings-list">
                {worktrees.map((worktree) => {
                  const moveBusy = busy === `worktree:move:${worktree.path}`;
                  const removeBusy = busy === `worktree:remove:${worktree.path}`;
                  return (
                    <div className="git-repository-settings-list-row" key={worktree.path}>
                      <div className="git-repository-settings-worktree-heading">
                        <div className="git-repository-settings-worktree-title">
                          <strong>{worktreeLabel(worktree, t)}</strong>
                          {worktree.locked && (
                            <span className="git-repository-settings-badge">{t("git.repositorySettings.locked")}</span>
                          )}
                          {worktree.prunable && (
                            <span className="git-repository-settings-badge git-repository-settings-badge--warning">
                              {t("git.repositorySettings.prunable")}
                            </span>
                          )}
                        </div>
                        <code title={worktree.path}>{worktree.path}</code>
                      </div>
                      <div className="git-repository-settings-worktree-actions">
                        {onOpenWorktree && (
                          <button
                            type="button"
                            className="git-repository-settings-icon-button"
                            onClick={() => onOpenWorktree(worktree.path)}
                            disabled={moveBusy || removeBusy}
                            title={t("git.repositorySettings.openWorktree")}
                          >
                            <FolderOpen size={13} />
                            <span className="sr-only">{t("git.repositorySettings.openWorktree")}</span>
                          </button>
                        )}
                        <input
                          value={movePaths[worktree.path] || ""}
                          onChange={(event) =>
                            setMovePaths((current) => ({ ...current, [worktree.path]: event.target.value }))
                          }
                          placeholder={t("git.repositorySettings.newPath")}
                          disabled={worktree.main || moveBusy || removeBusy}
                        />
                        <button
                          type="button"
                          className="git-repository-settings-icon-button"
                          onClick={() => void moveWorktree(worktree)}
                          disabled={worktree.main || !movePaths[worktree.path]?.trim() || moveBusy || removeBusy}
                          title={t("git.repositorySettings.move")}
                        >
                          {moveBusy ? <Loader2 size={13} className="animate-spin" /> : <Move size={13} />}
                          <span className="sr-only">{t("git.repositorySettings.move")}</span>
                        </button>
                        <button
                          type="button"
                          className="git-repository-settings-icon-button git-repository-settings-icon-button--danger"
                          onClick={() => void removeWorktree(worktree)}
                          disabled={worktree.main || moveBusy || removeBusy}
                          title={t("common.remove")}
                        >
                          {removeBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                          <span className="sr-only">{t("common.remove")}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="git-repository-settings-worktree-add">
                <div className="git-repository-settings-form-grid">
                  <label className="git-repository-settings-field-wide">
                    <span>{t("git.repositorySettings.worktreePath")}</span>
                    <input
                      value={worktreeDraft.path}
                      onChange={(event) => setWorktreeDraft((current) => ({ ...current, path: event.target.value }))}
                      placeholder="/path/to/worktree"
                    />
                  </label>
                  <label>
                    <span>{t("git.repositorySettings.branch")}</span>
                    <input
                      value={worktreeDraft.branch}
                      onChange={(event) => setWorktreeDraft((current) => ({ ...current, branch: event.target.value }))}
                      placeholder="feature/name"
                    />
                  </label>
                  <label>
                    <span>{t("git.repositorySettings.commit")}</span>
                    <input
                      value={worktreeDraft.commit}
                      onChange={(event) => setWorktreeDraft((current) => ({ ...current, commit: event.target.value }))}
                      placeholder="HEAD"
                    />
                  </label>
                </div>
                <label className="git-repository-settings-checkbox">
                  <input
                    type="checkbox"
                    checked={worktreeDraft.createBranch}
                    onChange={(event) =>
                      setWorktreeDraft((current) => ({ ...current, createBranch: event.target.checked }))
                    }
                  />
                  <span>{t("git.repositorySettings.createBranch")}</span>
                </label>
                <button
                  type="button"
                  className="git-repository-settings-button git-repository-settings-button--primary"
                  onClick={() => void addWorktree()}
                  disabled={busy === "worktree:add"}
                >
                  {busy === "worktree:add" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  {t("git.repositorySettings.addWorktree")}
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
};

export default GitRepositorySettings;
