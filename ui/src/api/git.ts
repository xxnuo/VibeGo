import { API_BASE, request } from "@/api/request";

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  parentCount: number;
  tags: string[];
}

export interface GitTagInfo {
  name: string;
  commit: string;
  remote: boolean;
}

export interface GitTagsSnapshot {
  tags: GitTagInfo[];
  tagsToPush: string[];
  tagsToPushError?: string;
}

export interface GitSubmoduleStatus {
  initialized: boolean;
  commitChanged: boolean;
  modifiedChanges: boolean;
  untrackedChanges: boolean;
  conflict: boolean;
}

export interface GitSubmoduleEntry {
  path: string;
  url?: string;
  sha?: string;
  indexSHA?: string;
  describe?: string;
  status: GitSubmoduleStatus;
}

export interface GitSubmoduleDiff {
  path: string;
  fullPath: string;
  url?: string;
  status: GitSubmoduleStatus;
  oldSHA?: string | null;
  newSHA?: string | null;
}

export interface GitDiff {
  path: string;
  old: string;
  new: string;
  kind?: string;
  patch?: string;
  capability?: GitDiffCapability;
  submodule?: GitSubmoduleDiff;
  oldSize?: number;
  newSize?: number;
  oldBinary?: boolean;
  newBinary?: boolean;
  oldTruncated?: boolean;
  newTruncated?: boolean;
  binary?: boolean;
  large?: boolean;
  image?: GitImageDiff;
}

/** Bounded base64 image payload used by working-tree and history diffs. */
export interface GitImageDiff {
  mimeType: string;
  old?: string;
  new?: string;
}

export interface GitStructuredFile {
  path: string;
  name: string;
  indexStatus: string;
  worktreeStatus: string;
  changeType: string;
  includedState: "none" | "partial" | "all";
  conflicted: boolean;
  submodule?: GitSubmoduleStatus;
}

export interface GitStatusSummary {
  changed: number;
  staged: number;
  unstaged: number;
  included: number;
  conflicted: number;
}

export interface GitStructuredStatus {
  files: GitStructuredFile[];
  summary: GitStatusSummary;
}

export interface GitDiffLine {
  id: string;
  kind: "context" | "add" | "del";
  content: string;
  oldLine: number;
  newLine: number;
  selectable: boolean;
  selected: boolean;
}

export interface GitDiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
  patch: string;
}

export interface GitDiffStats {
  added: number;
  deleted: number;
  hunks: number;
  lines: number;
}

export interface GitDiffCapability {
  lineSelectable: boolean;
}

export interface GitInteractiveDiff {
  path: string;
  mode: "working" | "staged" | "stash";
  kind?: string;
  patch: string;
  patchHash: string;
  hunks: GitDiffHunk[];
  stats: GitDiffStats;
  capability: GitDiffCapability;
  old: string;
  new: string;
  patchSize: number;
  patchTruncated: boolean;
  oldSize: number;
  newSize: number;
  oldBinary: boolean;
  newBinary: boolean;
  oldTruncated: boolean;
  newTruncated: boolean;
  binary: boolean;
  large: boolean;
  includedState: "none" | "partial" | "all";
  submodule?: GitSubmoduleDiff;
  image?: GitImageDiff;
}

export interface GitApplySelectionResponse {
  ok: boolean;
  status: GitStructuredStatus;
  diff?: GitInteractiveDiff;
}

export interface GitApplySelectionBatchResponse {
  ok: boolean;
  status: GitStructuredStatus;
}

export interface GitStashFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied";
}

export interface GitConflictSegment {
  type: "plain" | "conflict";
  text?: string;
  blockId?: string;
  ours?: string[];
  base?: string[];
  theirs?: string[];
}

export interface GitConflictStage {
  present: boolean;
  deleted: boolean;
}

export interface GitConflictStages {
  base: GitConflictStage;
  ours: GitConflictStage;
  theirs: GitConflictStage;
}

export interface GitConflictDetails {
  path: string;
  hash: string;
  segments: GitConflictSegment[];
  blocksTotal: number;
  stages?: GitConflictStages;
}

export type GitConflictResolveMode = "line-map" | "manual" | "ours" | "theirs" | "delete";

export interface CommitFileInfo {
  path: string;
  status: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface RemoteInfo {
  name: string;
  urls: string[];
}

export interface GitRepositoryConfig {
  localUserName: string;
  localUserEmail: string;
  globalUserName: string;
  globalUserEmail: string;
  effectiveName: string;
  effectiveEmail: string;
}

export interface GitRepositoryRemote {
  name: string;
  fetchUrl: string;
  pushUrls: string[];
}

export interface GitLFSStatus {
  installed: boolean;
  version?: string;
  initialized: boolean;
  trackedFiles: string[];
  error?: string;
}

export interface GitRepositorySettings {
  config: GitRepositoryConfig;
  remotes: GitRepositoryRemote[];
  gitignore: string;
  lfs: GitLFSStatus;
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
}

export interface StashEntry {
  index: number;
  oid?: string;
  message: string;
}

export interface BranchStatusInfo {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
}

export interface GitBranchMutationResponse {
  ok: boolean;
  branch?: string;
  oldBranch?: string;
  remote?: string;
  currentBranch?: string;
  branches?: string[];
  remoteBranches?: string[];
  branchStatus?: BranchStatusInfo;
}

export interface GitRemoteCheckoutResponse extends GitBranchMutationResponse {
  remote: string;
  remoteBranch: string;
  created: boolean;
  stashed: boolean;
  stashConflict: boolean;
  stashError?: string;
  status?: GitStructuredStatus;
}

export interface GitPruneResponse extends GitBranchMutationResponse {
  dryRun: boolean;
  removed: string[];
}

export interface GitBranchesSnapshot {
  branches: string[];
  remoteBranches: string[];
  currentBranch: string;
  /** Branches most recently left according to the local HEAD reflog. */
  recentBranches?: string[];
}

export interface CommitSelectedResponse {
  ok: boolean;
  hash?: string;
  status?: GitStructuredStatus;
  commits?: GitCommit[];
  branchStatus?: BranchStatusInfo;
}

export interface PullResponse {
  ok: boolean;
  status: GitStructuredStatus;
  commits: GitCommit[];
  conflicts: string[];
  branchStatus: BranchStatusInfo;
}

export interface SmartSwitchResponse {
  ok: boolean;
  branch: string;
  stashed: boolean;
  stashConflict: boolean;
  stashError?: string;
  status?: GitStructuredStatus;
  branchStatus?: BranchStatusInfo;
}

export interface GitOperationProgress {
  position: number;
  total: number;
  value: number;
  currentCommit?: string;
  currentCommitSummary?: string;
}

export interface GitOperationResponse {
  ok: boolean;
  operation: "none" | "merge" | "rebase" | "cherry-pick" | "revert" | "reset" | string;
  state: string;
  status: GitStructuredStatus;
  conflicts: string[];
  progress?: GitOperationProgress;
  headHash?: string;
  headRef?: string;
  originalHead?: string;
  baseRef?: string;
  targetRef?: string;
  currentCommit?: string;
  output?: string;
  error?: string;
}

export interface GitSquashOptions {
  lastRetainedCommitRef?: string;
  message?: string;
  commitMessage?: string;
}

export interface GitReorderOptions {
  lastRetainedCommitRef?: string;
}

export type GitWSEventType =
  | "snapshot"
  | "status_changed"
  | "branch_status_changed"
  | "branches_changed"
  | "remotes_changed"
  | "stashes_changed"
  | "conflicts_changed"
  | "draft_changed"
  | "history_changed"
  | "push_progress"
  | "pull_progress"
  | "operation_done";

export interface GitWSSnapshot {
  status: GitStructuredStatus;
  branchStatus: BranchStatusInfo;
  branches: GitBranchesSnapshot;
  remotes: RemoteInfo[];
  stashes: StashEntry[];
  conflicts: string[];
  draft: GitDraft;
  headHash: string;
}

export interface GitScope {
  workspace_session_id?: string;
  group_id?: string;
}

/** Options passed through to `git commit`. */
export interface GitCommitOptions {
  noVerify?: boolean;
  signOff?: boolean;
  allowEmpty?: boolean;
}

export interface GitWSEvent {
  type: GitWSEventType;
  data: unknown;
}

export interface GitDraft {
  summary: string;
  description: string;
  isAmend: boolean;
  /** Persisted commit option state (older servers may omit these fields). */
  skipCommitHooks?: boolean;
  signOffCommits?: boolean;
  allowEmptyCommit?: boolean;
  /** Canonical flag names accepted by the commit endpoints. */
  noVerify?: boolean;
  signOff?: boolean;
  allowEmpty?: boolean;
}

const isGitCommitOptions = (value: GitScope | GitCommitOptions | undefined): value is GitCommitOptions =>
  value !== undefined && ("noVerify" in value || "signOff" in value || "allowEmpty" in value);

const resolveCommitArgs = (
  scopeOrOptions?: GitScope | GitCommitOptions,
  optionsOrScope?: GitScope | GitCommitOptions
): { scope?: GitScope; options?: GitCommitOptions } => {
  if (isGitCommitOptions(scopeOrOptions)) {
    return {
      options: scopeOrOptions,
      scope: optionsOrScope && !isGitCommitOptions(optionsOrScope) ? optionsOrScope : undefined,
    };
  }
  return {
    scope: scopeOrOptions,
    options: optionsOrScope && isGitCommitOptions(optionsOrScope) ? optionsOrScope : undefined,
  };
};

const commitOptionBody = (options?: GitCommitOptions) => ({
  noVerify: options?.noVerify ?? false,
  signOff: options?.signOff ?? false,
  allowEmpty: options?.allowEmpty ?? false,
});

export const gitApi = {
  check: (path: string) =>
    request<{ isRepo: boolean }>("/git/check", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  init: (path: string) =>
    request<{ ok: boolean }>("/git/init", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  clone: (url: string, path: string) =>
    request<{ ok: boolean }>("/git/clone", {
      method: "POST",
      body: JSON.stringify({ url, path }),
    }),

  status: (path: string, scope?: { workspace_session_id?: string; group_id?: string }) =>
    request<GitStructuredStatus>("/git/status", {
      method: "POST",
      body: JSON.stringify({ path, ...scope }),
    }),

  log: (path: string, limit = 20, skip = 0) =>
    request<{ commits: GitCommit[] }>("/git/log", {
      method: "POST",
      body: JSON.stringify({ path, limit, skip }),
    }),

  diff: (path: string, filePath: string) =>
    request<GitDiff>("/git/diff", {
      method: "POST",
      body: JSON.stringify({ path, filePath }),
    }),

  fileDiff: (
    path: string,
    filePath: string,
    mode: "working" | "staged" = "working",
    scope?: { workspace_session_id?: string; group_id?: string }
  ) =>
    request<GitInteractiveDiff>("/git/file-diff", {
      method: "POST",
      body: JSON.stringify({ path, filePath, mode, ...scope }),
    }),

  applySelection: (
    path: string,
    filePath: string,
    mode: "working" | "staged",
    target: "line" | "hunk" | "file",
    action: "include" | "exclude" | "discard",
    patchHash: string,
    lineIds: string[],
    hunkIds: string[],
    scope?: { workspace_session_id?: string; group_id?: string }
  ) =>
    request<GitApplySelectionResponse>("/git/apply-selection", {
      method: "POST",
      body: JSON.stringify({ path, filePath, mode, target, action, patchHash, lineIds, hunkIds, ...scope }),
    }),

  applySelectionBatch: (
    path: string,
    mode: "working" | "staged",
    action: "include" | "exclude",
    filePaths: string[],
    scope?: { workspace_session_id?: string; group_id?: string }
  ) =>
    request<GitApplySelectionBatchResponse>("/git/apply-selection-batch", {
      method: "POST",
      body: JSON.stringify({ path, mode, action, filePaths, ...scope }),
    }),

  getDraft: (path: string, scope?: { workspace_session_id?: string; group_id?: string }) => {
    const params = new URLSearchParams({ path });
    if (scope?.workspace_session_id) params.set("workspace_session_id", scope.workspace_session_id);
    if (scope?.group_id) params.set("group_id", scope.group_id);
    return request<GitDraft>(`/git/draft?${params.toString()}`);
  },

  setDraft: (path: string, draft: Partial<GitDraft>, scope?: { workspace_session_id?: string; group_id?: string }) =>
    request<GitDraft>("/git/draft", {
      method: "POST",
      body: JSON.stringify({ path, ...draft, ...scope }),
    }),

  show: (path: string, filePath: string, ref = "HEAD") =>
    request<{ content: string; size: number; binary: boolean; truncated: boolean }>("/git/show", {
      method: "POST",
      body: JSON.stringify({ path, filePath, ref }),
    }),

  add: (path: string, files: string[]) =>
    request<{ ok: boolean }>("/git/add", {
      method: "POST",
      body: JSON.stringify({ path, files }),
    }),

  reset: (path: string, files?: string[]) =>
    request<{ ok: boolean }>("/git/reset", {
      method: "POST",
      body: JSON.stringify({ path, files }),
    }),

  checkout: (path: string, files: string[]) =>
    request<{ ok: boolean; status: GitStructuredStatus }>("/git/checkout", {
      method: "POST",
      body: JSON.stringify({ path, files }),
    }),

  commit: (path: string, message: string, author?: string, email?: string, options?: GitCommitOptions) =>
    request<{ ok: boolean; hash: string }>("/git/commit", {
      method: "POST",
      body: JSON.stringify({ path, message, author, email, ...commitOptionBody(options) }),
    }),

  commitSelected: (
    path: string,
    files: string[],
    patches: { filePath: string; patch: string }[],
    summary: string,
    description?: string,
    scopeOrOptions?: GitScope | GitCommitOptions,
    optionsOrScope?: GitScope | GitCommitOptions
  ) => {
    const { scope, options } = resolveCommitArgs(scopeOrOptions, optionsOrScope);
    return request<CommitSelectedResponse>("/git/commit-selected", {
      method: "POST",
      body: JSON.stringify({ path, files, patches, summary, description, ...scope, ...commitOptionBody(options) }),
    });
  },

  amend: (
    path: string,
    files: string[],
    patches: { filePath: string; patch: string }[],
    summary: string,
    description?: string,
    scopeOrOptions?: GitScope | GitCommitOptions,
    optionsOrScope?: GitScope | GitCommitOptions
  ) => {
    const { scope, options } = resolveCommitArgs(scopeOrOptions, optionsOrScope);
    return request<CommitSelectedResponse>("/git/amend", {
      method: "POST",
      body: JSON.stringify({ path, files, patches, summary, description, ...scope, ...commitOptionBody(options) }),
    });
  },

  undo: (path: string) =>
    request<{ ok: boolean; status: GitStructuredStatus; commits: GitCommit[] }>("/git/undo", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  operationStatus: (path: string) =>
    request<GitOperationResponse>("/git/operation-status", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  merge: (
    path: string,
    ref?: string,
    action: "start" | "continue" | "abort" = "start",
    options?: { noFF?: boolean; noVerify?: boolean; files?: string[] }
  ) =>
    request<GitOperationResponse>("/git/merge", {
      method: "POST",
      body: JSON.stringify({
        path,
        ref,
        action,
        noFF: options?.noFF,
        noVerify: options?.noVerify,
        files: options?.files,
      }),
    }),

  rebase: (
    path: string,
    upstream?: string,
    action: "start" | "continue" | "abort" | "skip" = "start",
    options?: { target?: string; noVerify?: boolean; files?: string[] }
  ) =>
    request<GitOperationResponse>("/git/rebase", {
      method: "POST",
      body: JSON.stringify({
        path,
        upstream,
        action,
        target: options?.target,
        noVerify: options?.noVerify,
        files: options?.files,
      }),
    }),

  cherryPick: (
    path: string,
    commit?: string,
    action: "start" | "continue" | "abort" | "skip" = "start",
    options?: { mainline?: number; commits?: string[]; files?: string[] }
  ) =>
    request<GitOperationResponse>("/git/cherry-pick", {
      method: "POST",
      body: JSON.stringify({
        path,
        commit,
        action,
        mainline: options?.mainline,
        commits: options?.commits,
        files: options?.files,
      }),
    }),

  revert: (
    path: string,
    commit?: string,
    action: "start" | "continue" | "abort" | "skip" = "start",
    files?: string[]
  ) =>
    request<GitOperationResponse>("/git/revert", {
      method: "POST",
      body: JSON.stringify({ path, commit, action, files }),
    }),

  resetToCommit: (path: string, ref: string, mode: "soft" | "mixed" | "hard" = "mixed") =>
    request<GitOperationResponse>("/git/reset-to-commit", {
      method: "POST",
      body: JSON.stringify({ path, ref, mode }),
    }),

  squash: (path: string, toSquash: string[], squashOnto: string, options?: GitSquashOptions) =>
    request<GitOperationResponse>("/git/squash", {
      method: "POST",
      body: JSON.stringify({ path, toSquash, squashOnto, ...options }),
    }),

  reorder: (path: string, toMove: string[], beforeCommit?: string, options?: GitReorderOptions) =>
    request<GitOperationResponse>("/git/reorder", {
      method: "POST",
      body: JSON.stringify({ path, toMove, beforeCommit, ...options }),
    }),

  branches: (path: string) =>
    request<{
      branches: BranchInfo[];
      remoteBranches: string[];
      currentBranch: string;
      recentBranches?: string[];
    }>("/git/branches", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  branchStatus: (path: string) =>
    request<BranchStatusInfo>("/git/branch-status", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  switchBranch: (path: string, branch: string) =>
    request<{ ok: boolean; branch: string }>("/git/switch-branch", {
      method: "POST",
      body: JSON.stringify({ path, branch }),
    }),

  checkoutRemoteBranch: (path: string, remote: string, branch: string, localBranch?: string) =>
    request<GitRemoteCheckoutResponse>("/git/checkout-remote-branch", {
      method: "POST",
      body: JSON.stringify({ path, remote, branch, localBranch }),
    }),

  // Keep the switch-oriented name for branch pickers that distinguish this
  // operation from a generic checkout while sharing the same response shape.
  switchRemoteBranch: (path: string, remote: string, branch: string, localBranch?: string) =>
    request<GitRemoteCheckoutResponse>("/git/switch-remote-branch", {
      method: "POST",
      body: JSON.stringify({ path, remote, branch, localBranch }),
    }),

  smartSwitchBranch: (path: string, branch: string) =>
    request<SmartSwitchResponse>("/git/smart-switch-branch", {
      method: "POST",
      body: JSON.stringify({ path, branch }),
    }),

  commitFiles: (path: string, commit: string, fromCommit?: string) =>
    request<{ files: CommitFileInfo[] }>("/git/commit-files", {
      method: "POST",
      body: JSON.stringify({ path, commit, fromCommit }),
    }),

  commitDiff: (path: string, commit: string, filePath: string, fromCommit?: string) =>
    request<GitDiff>("/git/commit-diff", {
      method: "POST",
      body: JSON.stringify({ path, commit, filePath, fromCommit }),
    }),

  remotes: (path: string) =>
    request<{ remotes: RemoteInfo[] }>("/git/remotes", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  repositorySettings: (path: string) =>
    request<GitRepositorySettings>("/git/repository-settings", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  updateConfig: (path: string, scope: "local" | "global", name: string, email: string) =>
    request<GitRepositorySettings>("/git/config", {
      method: "POST",
      body: JSON.stringify({ path, scope, name, email }),
    }),

  setRemote: (path: string, name: string, url: string, pushUrl?: string) =>
    request<{ remotes: GitRepositoryRemote[] }>("/git/remote-set", {
      method: "POST",
      body: JSON.stringify({ path, name, url, pushUrl }),
    }),

  addRemote: (path: string, name: string, url: string) =>
    request<{ remotes: GitRepositoryRemote[] }>("/git/remote-add", {
      method: "POST",
      body: JSON.stringify({ path, name, url }),
    }),

  deleteRemote: (path: string, name: string) =>
    request<{ remotes: GitRepositoryRemote[] }>("/git/remote-delete", {
      method: "POST",
      body: JSON.stringify({ path, name }),
    }),

  updateGitIgnore: (path: string, content: string) =>
    request<{ gitignore: string }>("/git/gitignore", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),

  gitLFS: (path: string, action: "status" | "init" = "status") =>
    request<GitLFSStatus>("/git/lfs", {
      method: "POST",
      body: JSON.stringify({ path, action }),
    }),

  submodules: (path: string) =>
    request<{ submodules: GitSubmoduleEntry[] }>("/git/submodules", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  updateSubmodules: (
    path: string,
    paths: string[] = [],
    options?: { recursive?: boolean; allowFileProtocol?: boolean }
  ) =>
    request<{ ok: boolean; submodules: GitSubmoduleEntry[] }>("/git/submodules-update", {
      method: "POST",
      body: JSON.stringify({
        path,
        paths,
        recursive: options?.recursive,
        allowFileProtocol: options?.allowFileProtocol,
      }),
    }),

  resetSubmodules: (
    path: string,
    paths: string[] = [],
    options?: { recursive?: boolean; allowFileProtocol?: boolean }
  ) =>
    request<{ ok: boolean; submodules: GitSubmoduleEntry[] }>("/git/submodules-reset", {
      method: "POST",
      body: JSON.stringify({
        path,
        paths,
        recursive: options?.recursive,
        allowFileProtocol: options?.allowFileProtocol,
      }),
    }),

  worktrees: (path: string) =>
    request<{ worktrees: GitWorktreeEntry[] }>("/git/worktrees", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  addWorktree: (
    path: string,
    worktreePath: string,
    options?: { branch?: string; commit?: string; createBranch?: boolean }
  ) =>
    request<{ ok: boolean }>("/git/worktree-add", {
      method: "POST",
      body: JSON.stringify({ path, worktreePath, ...options }),
    }),

  removeWorktree: (path: string, worktreePath: string, force = false) =>
    request<{ ok: boolean }>("/git/worktree-remove", {
      method: "POST",
      body: JSON.stringify({ path, worktreePath, force }),
    }),

  moveWorktree: (path: string, oldPath: string, newPath: string) =>
    request<{ ok: boolean }>("/git/worktree-move", {
      method: "POST",
      body: JSON.stringify({ path, oldPath, newPath }),
    }),

  tags: (path: string, remote = "origin") =>
    request<GitTagsSnapshot>("/git/tags", {
      method: "POST",
      body: JSON.stringify({ path, remote }),
    }),

  createTag: (path: string, name: string, commit: string, remote = "origin") =>
    request<GitTagsSnapshot>("/git/create-tag", {
      method: "POST",
      body: JSON.stringify({ path, name, commit, remote }),
    }),

  deleteTag: (path: string, name: string, remote = "origin") =>
    request<GitTagsSnapshot>("/git/delete-tag", {
      method: "POST",
      body: JSON.stringify({ path, name, remote }),
    }),

  fetch: (path: string, remote = "origin") =>
    request<{ ok: boolean; branchStatus: BranchStatusInfo }>("/git/fetch", {
      method: "POST",
      body: JSON.stringify({ path, remote }),
    }),

  pull: (path: string, remote = "origin", branch?: string) =>
    request<PullResponse>("/git/pull", {
      method: "POST",
      body: JSON.stringify({ path, remote, branch }),
    }),

  push: (path: string, remote = "origin", force?: boolean, tags?: string[]) =>
    request<{ ok: boolean; branchStatus: BranchStatusInfo }>("/git/push", {
      method: "POST",
      body: JSON.stringify({ path, remote, force, tags }),
    }),

  stash: (path: string, message?: string, files?: string[]) =>
    request<{ ok: boolean; message: string; status: GitStructuredStatus }>("/git/stash", {
      method: "POST",
      body: JSON.stringify({ path, message, files }),
    }),

  stashList: (path: string) =>
    request<{ stashes: StashEntry[] }>("/git/stash-list", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  stashFiles: (path: string, index: number, oid?: string) =>
    request<{ files: GitStashFile[] }>("/git/stash-files", {
      method: "POST",
      body: JSON.stringify({ path, index, oid }),
    }),

  stashDiff: (path: string, index: number, filePath: string, oid?: string) =>
    request<GitInteractiveDiff>("/git/stash-diff", {
      method: "POST",
      body: JSON.stringify({ path, index, oid, filePath }),
    }),

  stashPop: (path: string, index = 0, oid?: string) =>
    request<{ ok: boolean; status: GitStructuredStatus }>("/git/stash-pop", {
      method: "POST",
      body: JSON.stringify({ path, index, oid }),
    }),

  stashDrop: (path: string, index = 0, oid?: string) =>
    request<{ ok: boolean }>("/git/stash-drop", {
      method: "POST",
      body: JSON.stringify({ path, index, oid }),
    }),

  conflicts: (path: string) =>
    request<{ conflicts: string[] }>("/git/conflicts", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  conflictDetails: (path: string, filePath: string) =>
    request<GitConflictDetails>("/git/conflict-details", {
      method: "POST",
      body: JSON.stringify({ path, filePath }),
    }),

  conflictResolve: (
    path: string,
    filePath: string,
    mode: GitConflictResolveMode,
    hash: string,
    resolvedContent?: string,
    manualContent?: string
  ) =>
    request<{ ok: boolean; conflicts: string[]; status: GitStructuredStatus }>("/git/conflict-resolve", {
      method: "POST",
      body: JSON.stringify({ path, filePath, mode, hash, resolvedContent, manualContent }),
    }),

  createBranch: (path: string, branch: string, from?: string) =>
    request<{ ok: boolean; branch: string }>("/git/create-branch", {
      method: "POST",
      body: JSON.stringify({ path, branch, from }),
    }),

  renameBranch: (path: string, oldBranch: string, newBranch: string) =>
    request<GitBranchMutationResponse>("/git/rename-branch", {
      method: "POST",
      body: JSON.stringify({ path, oldBranch, newBranch }),
    }),

  deleteBranch: (path: string, branch: string, force = false) =>
    request<{ ok: boolean }>("/git/delete-branch", {
      method: "POST",
      body: JSON.stringify({ path, branch, force }),
    }),

  deleteRemoteBranch: (path: string, remote: string, branch: string) =>
    request<GitBranchMutationResponse>("/git/delete-remote-branch", {
      method: "POST",
      body: JSON.stringify(remote ? { path, remote, branch } : { path, remoteBranch: branch }),
    }),

  pruneRemote: (path: string, remote = "origin", dryRun = false) =>
    request<GitPruneResponse>("/git/prune-remote", {
      method: "POST",
      body: JSON.stringify({ path, remote, dryRun }),
    }),

  addPatch: (path: string, filePath: string, patch: string) =>
    request<{ ok: boolean }>("/git/add-patch", {
      method: "POST",
      body: JSON.stringify({ path, filePath, patch }),
    }),

  resolveConflict: (path: string, filePath: string, content: string) =>
    request<{ ok: boolean; conflicts: string[]; status: GitStructuredStatus }>("/git/conflict-resolve", {
      method: "POST",
      body: JSON.stringify({ path, filePath, mode: "manual", hash: "", manualContent: content }),
    }),

  connectWs: (
    path: string,
    onEvent: (event: GitWSEvent) => void,
    scope?: { workspace_session_id?: string; group_id?: string }
  ): (() => void) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const key = localStorage.getItem("vibego_auth_key");
    const params = new URLSearchParams({ path });
    if (key) params.set("key", key);
    if (scope?.workspace_session_id) params.set("workspace_session_id", scope.workspace_session_id);
    if (scope?.group_id) params.set("group_id", scope.group_id);
    const url = `${protocol}//${host}${API_BASE}/git/ws?${params.toString()}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as GitWSEvent;
          onEvent(event);
        } catch {}
      };
      ws.onclose = () => {
        if (!closed) {
          const baseDelay = 400;
          const maxDelay = 10_000;
          const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
          attempt++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  },
};
