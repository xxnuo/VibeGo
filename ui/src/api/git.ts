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

export interface GitDiff {
  path: string;
  old: string;
  new: string;
}

export interface GitStructuredFile {
  path: string;
  name: string;
  indexStatus: string;
  worktreeStatus: string;
  changeType: string;
  includedState: "none" | "partial" | "all";
  conflicted: boolean;
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
  patch: string;
  patchHash: string;
  hunks: GitDiffHunk[];
  stats: GitDiffStats;
  capability: GitDiffCapability;
  old: string;
  new: string;
  binary: boolean;
  includedState: "none" | "partial" | "all";
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

export interface GitConflictDetails {
  path: string;
  hash: string;
  segments: GitConflictSegment[];
  blocksTotal: number;
}

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

export interface StashEntry {
  index: number;
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

export interface GitBranchesSnapshot {
  branches: string[];
  remoteBranches: string[];
  currentBranch: string;
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
  status: GitStructuredStatus;
  branchStatus: BranchStatusInfo;
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

export interface GitWSEvent {
  type: GitWSEventType;
  data: unknown;
}

export interface GitDraft {
  summary: string;
  description: string;
  isAmend: boolean;
}

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
    request<{ content: string }>("/git/show", {
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

  commit: (path: string, message: string, author?: string, email?: string) =>
    request<{ ok: boolean; hash: string }>("/git/commit", {
      method: "POST",
      body: JSON.stringify({ path, message, author, email }),
    }),

  commitSelected: (
    path: string,
    files: string[],
    patches: { filePath: string; patch: string }[],
    summary: string,
    description?: string,
    scope?: { workspace_session_id?: string; group_id?: string }
  ) =>
    request<CommitSelectedResponse>("/git/commit-selected", {
      method: "POST",
      body: JSON.stringify({ path, files, patches, summary, description, ...scope }),
    }),

  amend: (
    path: string,
    files: string[],
    patches: { filePath: string; patch: string }[],
    summary: string,
    description?: string,
    scope?: { workspace_session_id?: string; group_id?: string }
  ) =>
    request<CommitSelectedResponse>("/git/amend", {
      method: "POST",
      body: JSON.stringify({ path, files, patches, summary, description, ...scope }),
    }),

  undo: (path: string) =>
    request<{ ok: boolean; status: GitStructuredStatus; commits: GitCommit[] }>("/git/undo", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  branches: (path: string) =>
    request<{
      branches: BranchInfo[];
      remoteBranches: string[];
      currentBranch: string;
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

  smartSwitchBranch: (path: string, branch: string) =>
    request<SmartSwitchResponse>("/git/smart-switch-branch", {
      method: "POST",
      body: JSON.stringify({ path, branch }),
    }),

  commitFiles: (path: string, commit: string) =>
    request<{ files: CommitFileInfo[] }>("/git/commit-files", {
      method: "POST",
      body: JSON.stringify({ path, commit }),
    }),

  commitDiff: (path: string, commit: string, filePath: string) =>
    request<GitDiff>("/git/commit-diff", {
      method: "POST",
      body: JSON.stringify({ path, commit, filePath }),
    }),

  remotes: (path: string) =>
    request<{ remotes: RemoteInfo[] }>("/git/remotes", {
      method: "POST",
      body: JSON.stringify({ path }),
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

  stashFiles: (path: string, index: number) =>
    request<{ files: GitStashFile[] }>("/git/stash-files", {
      method: "POST",
      body: JSON.stringify({ path, index }),
    }),

  stashDiff: (path: string, index: number, filePath: string) =>
    request<GitInteractiveDiff>("/git/stash-diff", {
      method: "POST",
      body: JSON.stringify({ path, index, filePath }),
    }),

  stashPop: (path: string, index = 0) =>
    request<{ ok: boolean; status: GitStructuredStatus }>("/git/stash-pop", {
      method: "POST",
      body: JSON.stringify({ path, index }),
    }),

  stashDrop: (path: string, index = 0) =>
    request<{ ok: boolean }>("/git/stash-drop", {
      method: "POST",
      body: JSON.stringify({ path, index }),
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
    mode: "line-map" | "manual" | "ours" | "theirs",
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

  deleteBranch: (path: string, branch: string) =>
    request<{ ok: boolean }>("/git/delete-branch", {
      method: "POST",
      body: JSON.stringify({ path, branch }),
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
