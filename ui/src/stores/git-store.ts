import { useStore } from "zustand";
import { createStore, type StateCreator } from "zustand/vanilla";
import {
  type BranchStatusInfo,
  type CommitFileInfo,
  type GitBranchesSnapshot,
  type GitCommit,
  type GitCommitOptions,
  type GitConflictResolveMode,
  type GitDiff,
  type GitDraft,
  type GitInteractiveDiff,
  type GitOperationResponse,
  type GitRemoteCheckoutResponse,
  type GitReorderOptions,
  type GitSquashOptions,
  type GitStashFile,
  type GitStructuredFile,
  type GitSubmoduleStatus,
  type GitTagInfo,
  type GitTagsSnapshot,
  type GitWSSnapshot,
  gitApi,
  type RemoteInfo,
  type StashEntry,
} from "@/api/git";
import { useSettingsStore } from "@/lib/settings";

export interface GitFileNode {
  path: string;
  name: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";
  includedState: "none" | "partial" | "all";
  submodule?: GitSubmoduleStatus;
}

export interface GitSyncOptions {
  status?: boolean;
  history?: boolean;
  branches?: boolean;
  remotes?: boolean;
  branchStatus?: boolean;
  stashes?: boolean;
  conflicts?: boolean;
  draft?: boolean;
  tags?: boolean;
  silent?: boolean;
}

export interface GitState {
  currentPath: string | null;
  workspaceSessionId: string | null;
  scopeGroupId: string | null;
  isRepo: boolean | null;
  allFiles: GitFileNode[];
  workingDiffs: Record<string, GitDiff>;
  interactiveDiffs: Record<string, GitInteractiveDiff>;
  summary: string;
  description: string;
  isAmend: boolean;
  skipCommitHooks: boolean;
  signOffCommits: boolean;
  allowEmptyCommit: boolean;
  currentBranch: string;
  branches: string[];
  remoteBranches: string[];
  recentBranches: string[];
  aheadCount: number;
  behindCount: number;
  upstreamBranch: string | null;
  hasRemote: boolean;
  remoteNames: string[];
  remoteUrls: string[];
  commits: GitCommit[];
  selectedCommit: GitCommit | null;
  selectedCommitFiles: CommitFileInfo[];
  activeTab: "changes" | "history";
  stashes: StashEntry[];
  selectedStashIndex: number | null;
  selectedStashFile: string | null;
  stashFiles: GitStashFile[];
  stashDiff: GitInteractiveDiff | null;
  stashLoading: boolean;
  conflicts: string[];
  operation: GitOperationResponse | null;
  tags: GitTagInfo[];
  tagsToPush: string[];
  tagsToPushError: string | null;
  isLoading: boolean;
  error: string | null;

  setCurrentPath: (path: string | null) => void;
  setScope: (workspaceSessionId: string | null) => void;
  setSummary: (s: string) => void;
  setDescription: (d: string) => void;
  setIsAmend: (v: boolean) => void;
  setSkipCommitHooks: (v: boolean) => void;
  setSignOffCommits: (v: boolean) => void;
  setAllowEmptyCommit: (v: boolean) => void;
  setActiveTab: (tab: "changes" | "history") => void;
  setSelectedCommit: (c: GitCommit | null) => void;
  toggleFile: (path: string) => Promise<void>;
  toggleAllFiles: () => Promise<void>;
  reset: () => void;

  checkRepo: () => Promise<boolean>;
  initRepo: () => Promise<boolean>;
  fetchStatus: () => Promise<void>;
  fetchLog: (limit?: number) => Promise<void>;
  fetchMoreLog: (limit?: number) => Promise<void>;
  fetchBranches: () => Promise<void>;
  fetchRemotes: () => Promise<void>;
  fetchBranchStatus: () => Promise<void>;
  fetchStashes: () => Promise<void>;
  fetchConflicts: () => Promise<void>;
  fetchDraft: () => Promise<void>;
  fetchTags: () => Promise<void>;
  fetchOperationStatus: () => Promise<void>;
  syncRepo: (options?: GitSyncOptions) => Promise<void>;

  commitSelected: () => Promise<boolean>;
  amendCommit: () => Promise<boolean>;
  undoLastCommit: () => Promise<boolean>;
  smartSwitchBranch: (branch: string) => Promise<boolean>;
  createBranch: (branch: string, from?: string) => Promise<boolean>;
  deleteBranch: (branch: string, force?: boolean) => Promise<boolean>;
  checkoutRemoteBranch: (remote: string, branch: string, localBranch?: string) => Promise<boolean>;
  switchRemoteBranch: (remote: string, branch: string, localBranch?: string) => Promise<boolean>;
  renameBranch: (branch: string, newBranch: string) => Promise<boolean>;
  deleteRemoteBranch: (remote: string, branch: string) => Promise<boolean>;
  pruneRemote: (remote?: string) => Promise<boolean>;
  createTag: (name: string, commit: string) => Promise<boolean>;
  deleteTag: (name: string) => Promise<boolean>;
  gitFetch: () => Promise<boolean>;
  gitPull: () => Promise<boolean>;
  gitPush: (force?: boolean) => Promise<boolean>;
  stash: (message?: string, files?: string[]) => Promise<boolean>;
  stashPop: (index?: number, oid?: string) => Promise<boolean>;
  stashDrop: (index?: number, oid?: string) => Promise<boolean>;
  selectStash: (index: number | null) => Promise<void>;
  selectStashFile: (filePath: string | null) => Promise<void>;
  discardFile: (path: string) => Promise<void>;
  resolveConflict: (
    filePath: string,
    content: string,
    hash: string,
    mode?: Exclude<GitConflictResolveMode, "line-map">
  ) => Promise<boolean>;
  getDiff: (filePath: string) => Promise<GitDiff | null>;
  getInteractiveDiff: (filePath: string, mode?: "working" | "staged") => Promise<GitInteractiveDiff | null>;
  applySelection: (
    filePath: string,
    mode: "working" | "staged",
    target: "line" | "hunk" | "file",
    action: "include" | "exclude" | "discard",
    patchHash: string,
    lineIds: string[],
    hunkIds: string[]
  ) => Promise<GitInteractiveDiff | null>;
  getCommitFiles: (commitHash: string) => Promise<CommitFileInfo[]>;
  getCommitDiff: (commitHash: string, filePath: string) => Promise<GitDiff | null>;
  addPatch: (filePath: string, patch: string) => Promise<boolean>;
  mergeOperation: (
    ref: string,
    action?: "start" | "continue" | "abort",
    options?: { noFF?: boolean; files?: string[] }
  ) => Promise<boolean>;
  rebaseOperation: (
    upstream: string,
    action?: "start" | "continue" | "abort" | "skip",
    options?: { target?: string; files?: string[] }
  ) => Promise<boolean>;
  cherryPickOperation: (
    commit: string,
    action?: "start" | "continue" | "abort" | "skip",
    options?: { mainline?: number; commits?: string[]; files?: string[] }
  ) => Promise<boolean>;
  revertOperation: (
    commit: string,
    action?: "start" | "continue" | "abort" | "skip",
    files?: string[]
  ) => Promise<boolean>;
  resetToCommit: (ref: string, mode?: "soft" | "mixed" | "hard") => Promise<boolean>;
  squashOperation: (toSquash: string[], squashOnto: string, options?: GitSquashOptions) => Promise<boolean>;
  reorderOperation: (toMove: string[], beforeCommit?: string, options?: GitReorderOptions) => Promise<boolean>;

  applyStatusUpdate: (files: GitStructuredFile[]) => void;
  applyBranchStatus: (bs: BranchStatusInfo) => void;
  applyBranchesSnapshot: (snapshot: GitBranchesSnapshot) => void;
  applyRemotes: (remotes: RemoteInfo[]) => void;
  applyStashes: (stashes: StashEntry[]) => void;
  applyConflicts: (conflicts: string[]) => void;
  applyOperation: (operation: GitOperationResponse | null) => void;
  applyTagsSnapshot: (snapshot: GitTagsSnapshot) => void;
  applyDraft: (draft?: Partial<GitDraftSnapshot>) => void;
  applySnapshot: (snapshot: GitWSSnapshot) => void;
}

type GitSelector<T> = (state: GitState) => T;

const DEFAULT_GIT_STORE_ID = "__default__";

const mapStatus = (status: string): GitFileNode["status"] => {
  switch (status) {
    case "M":
    case "modified":
      return "modified";
    case "A":
    case "added":
      return "added";
    case "D":
    case "deleted":
      return "deleted";
    case "R":
    case "renamed":
      return "renamed";
    case "C":
    case "copied":
      return "copied";
    case "?":
    case "untracked":
      return "untracked";
    default:
      return "modified";
  }
};

const statusFilesToNodes = (files?: GitStructuredFile[] | null): GitFileNode[] => {
  const map = new Map<string, GitFileNode>();
  for (const file of files ?? []) {
    if (!map.has(file.path)) {
      map.set(file.path, {
        path: file.path,
        name: file.path.split("/").pop() || file.path,
        status: mapStatus(file.changeType || file.worktreeStatus || file.indexStatus),
        includedState: file.includedState ?? "all",
        submodule: file.submodule,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
};

const getDefaultCommitSummary = () => useSettingsStore.getState().get("gitDefaultCommitMessage");

interface GitDraftSnapshot {
  summary: string;
  description: string;
  isAmend: boolean;
  skipCommitHooks: boolean;
  signOffCommits: boolean;
  allowEmptyCommit: boolean;
  noVerify?: boolean;
  signOff?: boolean;
  allowEmpty?: boolean;
}

const toDraftSnapshot = (draft?: Partial<GitDraftSnapshot>) => ({
  summary: draft?.summary || getDefaultCommitSummary(),
  description: draft?.description || "",
  isAmend: draft?.isAmend ?? false,
  skipCommitHooks: draft?.skipCommitHooks ?? draft?.noVerify ?? false,
  signOffCommits: draft?.signOffCommits ?? draft?.signOff ?? false,
  allowEmptyCommit: draft?.allowEmptyCommit ?? draft?.allowEmpty ?? false,
});

const getDraftSnapshotKey = (draft: GitDraftSnapshot) =>
  JSON.stringify([
    draft.summary,
    draft.description,
    draft.isAmend,
    draft.skipCommitHooks,
    draft.signOffCommits,
    draft.allowEmptyCommit,
  ]);

const getValidPathSet = (nodes: GitFileNode[]) => new Set(nodes.map((node) => node.path));

const pickWorkingDiffs = (nodes: GitFileNode[], workingDiffs: Record<string, GitDiff>) => {
  const validPaths = getValidPathSet(nodes);
  return Object.fromEntries(Object.entries(workingDiffs).filter(([path]) => validPaths.has(path)));
};

const pickInteractiveDiffs = (nodes: GitFileNode[], interactiveDiffs: Record<string, GitInteractiveDiff>) => {
  const validPaths = getValidPathSet(nodes);
  return Object.fromEntries(Object.entries(interactiveDiffs).filter(([path]) => validPaths.has(path)));
};

const createInitialGitSnapshot = () => ({
  currentPath: null as string | null,
  workspaceSessionId: null as string | null,
  scopeGroupId: null as string | null,
  isRepo: null as boolean | null,
  allFiles: [] as GitFileNode[],
  workingDiffs: {} as Record<string, GitDiff>,
  interactiveDiffs: {} as Record<string, GitInteractiveDiff>,
  summary: getDefaultCommitSummary(),
  description: "",
  isAmend: false,
  skipCommitHooks: false,
  signOffCommits: false,
  allowEmptyCommit: false,
  currentBranch: "main",
  branches: [] as string[],
  remoteBranches: [] as string[],
  recentBranches: [] as string[],
  aheadCount: 0,
  behindCount: 0,
  upstreamBranch: null as string | null,
  hasRemote: false,
  remoteNames: [] as string[],
  remoteUrls: [] as string[],
  commits: [] as GitCommit[],
  selectedCommit: null as GitCommit | null,
  selectedCommitFiles: [] as CommitFileInfo[],
  activeTab: "changes" as const,
  stashes: [] as StashEntry[],
  selectedStashIndex: null as number | null,
  selectedStashFile: null as string | null,
  stashFiles: [] as GitStashFile[],
  stashDiff: null as GitInteractiveDiff | null,
  stashLoading: false,
  conflicts: [] as string[],
  operation: null as GitOperationResponse | null,
  tags: [] as GitTagInfo[],
  tagsToPush: [] as string[],
  tagsToPushError: null as string | null,
  isLoading: false,
  error: null as string | null,
});

const createGitState =
  (groupId?: string): StateCreator<GitState> =>
  (set, get) => {
    let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let draftIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let commitFilesRequestId = 0;
    let stashRequestId = 0;
    let branchSwitchRequestId = 0;
    let draftReadBlocked = false;
    let pendingDraftRefresh = false;
    let lastSavedDraftKey = getDraftSnapshotKey(toDraftSnapshot());

    const clearStashSelection = () => {
      stashRequestId += 1;
      return {
        selectedStashIndex: null,
        selectedStashFile: null,
        stashFiles: [],
        stashDiff: null,
        stashLoading: false,
      } satisfies Pick<
        GitState,
        "selectedStashIndex" | "selectedStashFile" | "stashFiles" | "stashDiff" | "stashLoading"
      >;
    };

    const applyRemoteCheckoutResponse = (response: GitRemoteCheckoutResponse) => {
      const state = get();
      const stateUpdate: Partial<GitState> = {
        currentBranch: response.branch || response.currentBranch || state.currentBranch,
        branches: response.branches ?? state.branches,
        remoteBranches: response.remoteBranches ?? state.remoteBranches,
        ...clearStashSelection(),
      };
      // Older compatible handlers may omit the status payload. Keep the
      // current file view in that case instead of replacing it with an empty
      // list; the websocket/status sync will refresh it when available.
      if (Array.isArray(response.status?.files)) {
        const nodes = statusFilesToNodes(response.status.files);
        stateUpdate.allFiles = nodes;
        stateUpdate.workingDiffs = {};
        stateUpdate.interactiveDiffs = {};
      }
      set(stateUpdate);
      if (response.branchStatus) {
        get().applyBranchStatus(response.branchStatus);
      }
    };

    const runRemoteCheckout = async (
      remote: string,
      branch: string,
      localBranch: string | undefined,
      call: (path: string, remote: string, branch: string, localBranch?: string) => Promise<GitRemoteCheckoutResponse>,
      errorMessage: string
    ) => {
      const requestId = ++branchSwitchRequestId;
      const { currentPath } = get();
      if (!currentPath) {
        return false;
      }

      set({ isLoading: true, error: null });
      try {
        const response = await call(currentPath, remote, branch, localBranch);
        if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
          // A newer checkout or repository path has superseded this request;
          // do not surface the old result as an operation failure.
          return true;
        }
        applyRemoteCheckoutResponse(response);
        if (response.stashConflict) {
          set({
            error: `Branch switched to ${response.branch}, but the auto-stash could not be restored: ${response.stashError || "resolve the remaining stash manually"}`,
          });
          return false;
        }
        return true;
      } catch (err) {
        if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
          return true;
        }
        set({ error: err instanceof Error ? err.message : errorMessage });
        return false;
      } finally {
        if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
          set({ isLoading: false });
        }
      }
    };

    const getScopePayload = () => ({
      workspace_session_id: get().workspaceSessionId || undefined,
      group_id: get().scopeGroupId || undefined,
    });

    const applyOperationResponse = (response: GitOperationResponse | null) => {
      if (!response) {
        set({ operation: null });
        return;
      }
      if (response.state === "invalid") {
        set({ operation: response });
        return;
      }
      // Older/API-compatible servers may return an operation response without
      // the structured status payload. Preserve the current file view in that
      // case; an explicitly empty files array still means the worktree is clean.
      if (!Array.isArray(response.status?.files)) {
        set((state) => ({
          operation: response,
          conflicts: response.conflicts ?? state.conflicts,
        }));
        return;
      }
      const nodes = statusFilesToNodes(response.status?.files);
      set((state) => ({
        operation: response,
        allFiles: nodes,
        workingDiffs: pickWorkingDiffs(nodes, state.workingDiffs),
        interactiveDiffs: pickInteractiveDiffs(nodes, state.interactiveDiffs),
        conflicts: response.conflicts ?? [],
      }));
    };

    const runOperation = async (call: (path: string) => Promise<GitOperationResponse>): Promise<boolean> => {
      const { currentPath } = get();
      if (!currentPath) return false;
      set({ isLoading: true, error: null });
      try {
        const response = await call(currentPath);
        applyOperationResponse(response);
        if (!response.ok) {
          set({ error: response.error || response.output || "Git operation failed" });
        }
        return response.ok;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : "Git operation failed" });
        return false;
      } finally {
        set({ isLoading: false });
      }
    };

    const clearDraftSaveTimer = () => {
      if (draftSaveTimer) {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
      }
    };

    const clearDraftIdleTimer = () => {
      if (draftIdleTimer) {
        clearTimeout(draftIdleTimer);
        draftIdleTimer = null;
      }
    };

    const getCurrentDraftSnapshot = (): GitDraftSnapshot => {
      const { summary, description, isAmend, skipCommitHooks, signOffCommits, allowEmptyCommit } = get();
      return { summary, description, isAmend, skipCommitHooks, signOffCommits, allowEmptyCommit };
    };

    const getCurrentDraftKey = () => getDraftSnapshotKey(getCurrentDraftSnapshot());

    const resetDraftSyncState = (draft?: Partial<GitDraftSnapshot>) => {
      clearDraftSaveTimer();
      clearDraftIdleTimer();
      draftReadBlocked = false;
      pendingDraftRefresh = false;
      const nextDraft = toDraftSnapshot(draft);
      lastSavedDraftKey = getDraftSnapshotKey(nextDraft);
      return nextDraft;
    };

    const queueDraftRefreshAfterIdle = () => {
      draftReadBlocked = true;
      clearDraftIdleTimer();
      draftIdleTimer = setTimeout(() => {
        draftIdleTimer = null;
        draftReadBlocked = false;
        if (pendingDraftRefresh && get().currentPath) {
          pendingDraftRefresh = false;
          void get().syncRepo({ draft: true, silent: true });
        }
      }, 700);
    };

    const applyIncomingDraft = (draft?: Partial<GitDraftSnapshot>) => {
      const nextDraft = toDraftSnapshot(draft);
      const nextDraftKey = getDraftSnapshotKey(nextDraft);
      const currentDraftKey = getCurrentDraftKey();

      if (currentDraftKey === nextDraftKey) {
        lastSavedDraftKey = nextDraftKey;
        return null;
      }

      if (draftReadBlocked) {
        pendingDraftRefresh = true;
        return null;
      }

      if (currentDraftKey !== lastSavedDraftKey) {
        return null;
      }

      lastSavedDraftKey = nextDraftKey;
      return nextDraft;
    };

    const scheduleDraftPersist = () => {
      clearDraftSaveTimer();
      draftSaveTimer = setTimeout(() => {
        draftSaveTimer = null;
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }
        const draft = getCurrentDraftSnapshot();
        const draftKey = getDraftSnapshotKey(draft);
        void gitApi.setDraft(currentPath, draft, getScopePayload()).then(() => {
          if (getCurrentDraftKey() === draftKey) {
            lastSavedDraftKey = draftKey;
          }
        });
      }, 250);
    };

    return {
      ...createInitialGitSnapshot(),
      scopeGroupId: groupId || null,

      setCurrentPath: (path) => {
        branchSwitchRequestId += 1;
        const nextDraft = resetDraftSyncState();
        set(() => ({
          currentPath: path,
          ...clearStashSelection(),
          isLoading: false,
          summary: nextDraft.summary,
          description: nextDraft.description,
          isAmend: nextDraft.isAmend,
          skipCommitHooks: nextDraft.skipCommitHooks,
          signOffCommits: nextDraft.signOffCommits,
          allowEmptyCommit: nextDraft.allowEmptyCommit,
        }));
      },
      setScope: (workspaceSessionId) => set({ workspaceSessionId }),
      setSummary: (summary) => {
        set({ summary });
        queueDraftRefreshAfterIdle();
        scheduleDraftPersist();
      },
      setDescription: (description) => {
        set({ description });
        queueDraftRefreshAfterIdle();
        scheduleDraftPersist();
      },
      setIsAmend: (isAmend) => {
        set({ isAmend });
        queueDraftRefreshAfterIdle();
        scheduleDraftPersist();
      },
      setSkipCommitHooks: (skipCommitHooks) => {
        set({ skipCommitHooks });
        queueDraftRefreshAfterIdle();
        scheduleDraftPersist();
      },
      setSignOffCommits: (signOffCommits) => {
        set({ signOffCommits });
        queueDraftRefreshAfterIdle();
        scheduleDraftPersist();
      },
      setAllowEmptyCommit: (allowEmptyCommit) => {
        set({ allowEmptyCommit });
        queueDraftRefreshAfterIdle();
        scheduleDraftPersist();
      },
      setActiveTab: (activeTab) => set({ activeTab }),
      setSelectedCommit: (selectedCommit) =>
        set((state) => ({
          selectedCommit,
          selectedCommitFiles: state.selectedCommit?.hash === selectedCommit?.hash ? state.selectedCommitFiles : [],
        })),

      toggleFile: async (path) => {
        const { currentPath, allFiles } = get();
        if (!currentPath) {
          return;
        }

        const file = allFiles.find((item) => item.path === path);
        if (!file) {
          return;
        }

        const action = file.includedState === "none" ? "include" : "exclude";

        try {
          const res = await gitApi.applySelection(
            currentPath,
            path,
            "working",
            "file",
            action,
            "",
            [],
            [],
            getScopePayload()
          );
          const nodes = statusFilesToNodes(res.status.files);
          set((state) => ({
            allFiles: nodes,
            workingDiffs: pickWorkingDiffs(nodes, state.workingDiffs),
            interactiveDiffs: {
              ...pickInteractiveDiffs(nodes, state.interactiveDiffs),
              ...(res.diff ? { [path]: res.diff } : {}),
            },
          }));
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to update selection" });
        }
      },

      toggleAllFiles: async () => {
        const { currentPath, allFiles } = get();
        if (!currentPath || allFiles.length === 0) {
          return;
        }

        const allIncluded = allFiles.every((file) => file.includedState === "all");
        const action = allIncluded ? "exclude" : "include";

        try {
          const res = await gitApi.applySelectionBatch(
            currentPath,
            "working",
            action,
            allFiles.map((file) => file.path),
            getScopePayload()
          );
          const nodes = statusFilesToNodes(res.status.files);
          set((state) => ({
            allFiles: nodes,
            workingDiffs: pickWorkingDiffs(nodes, state.workingDiffs),
            interactiveDiffs: pickInteractiveDiffs(nodes, state.interactiveDiffs),
          }));
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to update selection" });
        }
      },
      reset: () => {
        branchSwitchRequestId += 1;
        const nextDraft = resetDraftSyncState();
        set(() => ({
          ...createInitialGitSnapshot(),
          ...clearStashSelection(),
          workspaceSessionId: get().workspaceSessionId,
          scopeGroupId: groupId || get().scopeGroupId,
          summary: nextDraft.summary,
          description: nextDraft.description,
          isAmend: nextDraft.isAmend,
          skipCommitHooks: nextDraft.skipCommitHooks,
          signOffCommits: nextDraft.signOffCommits,
          allowEmptyCommit: nextDraft.allowEmptyCommit,
        }));
      },

      checkRepo: async () => {
        const { currentPath } = get();
        if (!currentPath) return false;
        try {
          const res = await gitApi.check(currentPath);
          set({ isRepo: res.isRepo });
          return res.isRepo;
        } catch {
          set({ isRepo: false });
          return false;
        }
      },

      initRepo: async () => {
        const { currentPath } = get();
        if (!currentPath) return false;
        try {
          await gitApi.init(currentPath);
          set({ isRepo: true, error: null });
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to init repository" });
          return false;
        }
      },

      applyStatusUpdate: (files) => {
        const nodes = statusFilesToNodes(files);
        const { workingDiffs, interactiveDiffs } = get();

        set({
          allFiles: nodes,
          workingDiffs: pickWorkingDiffs(nodes, workingDiffs),
          interactiveDiffs: pickInteractiveDiffs(nodes, interactiveDiffs),
        });
      },

      applyBranchStatus: (branchStatus) => {
        set({
          currentBranch: branchStatus.branch || get().currentBranch,
          upstreamBranch: branchStatus.upstream || null,
          aheadCount: branchStatus.ahead || 0,
          behindCount: branchStatus.behind || 0,
        });
      },

      applyBranchesSnapshot: (snapshot) => {
        set({
          branches: snapshot.branches ?? [],
          remoteBranches: snapshot.remoteBranches ?? [],
          recentBranches: snapshot.recentBranches ?? [],
          currentBranch: snapshot.currentBranch || get().currentBranch,
        });
      },

      applyRemotes: (remotes) => {
        set({
          hasRemote: remotes.length > 0,
          remoteNames: remotes.map((remote) => remote.name),
          remoteUrls: remotes.flatMap((remote) => remote.urls),
        });
      },

      applyStashes: (stashes) => {
        const nextStashes = stashes ?? [];
        const previousStashes = get().stashes;
        const stashListChanged =
          previousStashes.length !== nextStashes.length ||
          previousStashes.some(
            (stash, index) =>
              stash.index !== nextStashes[index]?.index ||
              stash.oid !== nextStashes[index]?.oid ||
              stash.message !== nextStashes[index]?.message
          );
        const selectedStashIndex = get().selectedStashIndex;
        if (selectedStashIndex !== null && stashListChanged) {
          stashRequestId += 1;
          set({
            stashes: nextStashes,
            selectedStashIndex: null,
            selectedStashFile: null,
            stashFiles: [],
            stashDiff: null,
            stashLoading: false,
          });
          return;
        }
        set({ stashes: nextStashes });
      },

      applyConflicts: (conflicts) => {
        set({ conflicts: conflicts ?? [] });
      },

      applyOperation: (operation) => {
        applyOperationResponse(operation);
      },

      applyTagsSnapshot: (snapshot) => {
        set({
          tags: snapshot.tags ?? [],
          tagsToPush: snapshot.tagsToPush ?? [],
          tagsToPushError: snapshot.tagsToPushError ?? null,
        });
      },

      applyDraft: (draft) => {
        const nextDraft = applyIncomingDraft(draft);
        if (nextDraft) {
          set(nextDraft);
        }
      },

      applySnapshot: (snapshot) => {
        const nodes = statusFilesToNodes(snapshot.status.files);
        const { workingDiffs, interactiveDiffs } = get();
        const stateUpdate: Partial<GitState> = {
          allFiles: nodes,
          workingDiffs: pickWorkingDiffs(nodes, workingDiffs),
          interactiveDiffs: pickInteractiveDiffs(nodes, interactiveDiffs),
          branches: snapshot.branches.branches ?? [],
          remoteBranches: snapshot.branches.remoteBranches ?? [],
          recentBranches: snapshot.branches.recentBranches ?? [],
          currentBranch: snapshot.branches.currentBranch || get().currentBranch,
          hasRemote: snapshot.remotes.length > 0,
          remoteNames: snapshot.remotes.map((remote) => remote.name),
          remoteUrls: snapshot.remotes.flatMap((remote) => remote.urls),
          conflicts: snapshot.conflicts ?? [],
        };

        const nextDraft = applyIncomingDraft(snapshot.draft);
        if (nextDraft) {
          stateUpdate.summary = nextDraft.summary;
          stateUpdate.description = nextDraft.description;
          stateUpdate.isAmend = nextDraft.isAmend;
          stateUpdate.skipCommitHooks = nextDraft.skipCommitHooks;
          stateUpdate.signOffCommits = nextDraft.signOffCommits;
          stateUpdate.allowEmptyCommit = nextDraft.allowEmptyCommit;
        }

        set(stateUpdate);
        get().applyStashes(snapshot.stashes ?? []);
        get().applyBranchStatus(snapshot.branchStatus);
      },

      fetchStatus: async () => {
        const { currentPath, isRepo } = get();
        if (!currentPath || isRepo === false) {
          return;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.status(currentPath, getScopePayload());
          const nodes = statusFilesToNodes(res.files);
          const { workingDiffs, interactiveDiffs } = get();
          set({
            allFiles: nodes,
            workingDiffs: pickWorkingDiffs(nodes, workingDiffs),
            interactiveDiffs: pickInteractiveDiffs(nodes, interactiveDiffs),
          });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to fetch status" });
        } finally {
          set({ isLoading: false });
        }
      },

      fetchLog: async (limit = 50) => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.log(currentPath, limit);
          set({ commits: res.commits });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to fetch log" });
        }
      },

      fetchMoreLog: async (limit = 50) => {
        const { currentPath, commits } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.log(currentPath, limit, commits.length);
          if (res.commits.length > 0) {
            set({ commits: [...commits, ...res.commits] });
          }
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to fetch log" });
        }
      },

      fetchBranches: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.branches(currentPath);
          set({
            branches: res.branches.map((branch) => branch.name),
            remoteBranches: res.remoteBranches ?? [],
            recentBranches: res.recentBranches ?? get().recentBranches,
            currentBranch: res.currentBranch,
          });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to fetch branches" });
        }
      },

      fetchRemotes: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.remotes(currentPath);
          const urls = res.remotes.flatMap((r) => r.urls);
          set({
            hasRemote: res.remotes.length > 0,
            remoteNames: res.remotes.map((remote) => remote.name),
            remoteUrls: urls,
          });
        } catch {
          set({ hasRemote: false, remoteNames: [], remoteUrls: [] });
        }
      },

      fetchBranchStatus: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const branchStatus = await gitApi.branchStatus(currentPath);
          get().applyBranchStatus(branchStatus);
        } catch {}
      },

      fetchStashes: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.stashList(currentPath);
          get().applyStashes(res.stashes ?? []);
        } catch {
          get().applyStashes([]);
        }
      },

      fetchConflicts: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.conflicts(currentPath);
          set({ conflicts: res.conflicts ?? [] });
        } catch {
          set({ conflicts: [] });
        }
      },

      fetchDraft: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        if (draftReadBlocked) {
          pendingDraftRefresh = true;
          return;
        }

        try {
          const draft = await gitApi.getDraft(currentPath, getScopePayload());
          const nextDraft = applyIncomingDraft(draft);
          if (nextDraft) {
            set(nextDraft);
          }
        } catch {
          const nextDraft = applyIncomingDraft();
          if (nextDraft) {
            set(nextDraft);
          }
        }
      },

      fetchTags: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const snapshot = await gitApi.tags(currentPath);
          get().applyTagsSnapshot(snapshot);
        } catch (err) {
          set({
            tagsToPush: [],
            tagsToPushError: err instanceof Error ? err.message : "Failed to fetch tags",
          });
        }
      },

      fetchOperationStatus: async () => {
        const { currentPath } = get();
        if (!currentPath) return;
        try {
          const response = await gitApi.operationStatus(currentPath);
          applyOperationResponse(response);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to fetch Git operation status" });
        }
      },

      syncRepo: async (options = {}) => {
        const { currentPath, isRepo } = get();
        if (!currentPath || isRepo === false) {
          return;
        }

        const hasSelection =
          options.status !== undefined ||
          options.history !== undefined ||
          options.branches !== undefined ||
          options.remotes !== undefined ||
          options.branchStatus !== undefined ||
          options.stashes !== undefined ||
          options.conflicts !== undefined ||
          options.draft !== undefined ||
          options.tags !== undefined;

        const shouldSyncStatus = options.status ?? !hasSelection;
        const shouldSyncHistory = options.history ?? !hasSelection;
        const shouldSyncBranches = options.branches ?? !hasSelection;
        const shouldSyncRemotes = options.remotes ?? !hasSelection;
        const shouldSyncBranchStatus = options.branchStatus ?? !hasSelection;
        const shouldSyncStashes = options.stashes ?? !hasSelection;
        const shouldSyncConflicts = options.conflicts ?? !hasSelection;
        const shouldSyncTags = options.tags ?? !hasSelection;
        const wantsDraftSync = options.draft ?? !hasSelection;
        const shouldSyncDraft = wantsDraftSync && !draftReadBlocked;
        const silent = options.silent ?? false;

        if (wantsDraftSync && draftReadBlocked) {
          pendingDraftRefresh = true;
        }

        if (!silent) {
          set({ isLoading: true, error: null });
        }

        const statusPromise = shouldSyncStatus ? gitApi.status(currentPath, getScopePayload()) : null;
        const logPromise = shouldSyncHistory ? gitApi.log(currentPath, Math.max(get().commits.length, 50)) : null;
        const branchesPromise = shouldSyncBranches ? gitApi.branches(currentPath) : null;
        const remotesPromise = shouldSyncRemotes ? gitApi.remotes(currentPath) : null;
        const branchStatusPromise = shouldSyncBranchStatus ? gitApi.branchStatus(currentPath) : null;
        const stashesPromise = shouldSyncStashes ? gitApi.stashList(currentPath) : null;
        const conflictsPromise = shouldSyncConflicts ? gitApi.conflicts(currentPath) : null;
        const tagsPromise = shouldSyncTags ? gitApi.tags(currentPath) : null;
        const draftPromise = shouldSyncDraft ? gitApi.getDraft(currentPath, getScopePayload()) : null;

        const [
          statusResult,
          logResult,
          branchesResult,
          remotesResult,
          branchStatusResult,
          stashesResult,
          conflictsResult,
          tagsResult,
          draftResult,
        ] = await Promise.allSettled([
          statusPromise ?? Promise.resolve(null),
          logPromise ?? Promise.resolve(null),
          branchesPromise ?? Promise.resolve(null),
          remotesPromise ?? Promise.resolve(null),
          branchStatusPromise ?? Promise.resolve(null),
          stashesPromise ?? Promise.resolve(null),
          conflictsPromise ?? Promise.resolve(null),
          tagsPromise ?? Promise.resolve(null),
          draftPromise ?? Promise.resolve(null),
        ]);

        if (get().currentPath !== currentPath) {
          if (!silent) {
            set({ isLoading: false });
          }
          return;
        }

        const stateUpdate: Partial<GitState> = {};
        let syncedStashes: StashEntry[] | null = null;

        if (shouldSyncStatus && statusResult.status === "fulfilled" && statusResult.value) {
          const nodes = statusFilesToNodes(statusResult.value.files);
          const { workingDiffs, interactiveDiffs } = get();
          stateUpdate.allFiles = nodes;
          stateUpdate.workingDiffs = pickWorkingDiffs(nodes, workingDiffs);
          stateUpdate.interactiveDiffs = pickInteractiveDiffs(nodes, interactiveDiffs);
        }

        if (shouldSyncHistory && logResult.status === "fulfilled" && logResult.value) {
          const commits = logResult.value.commits;
          const selectedCommitHash = get().selectedCommit?.hash ?? null;
          stateUpdate.commits = commits;
          if (selectedCommitHash) {
            const nextSelectedCommit = commits.find((commit) => commit.hash === selectedCommitHash) ?? null;
            stateUpdate.selectedCommit = nextSelectedCommit;
            if (!nextSelectedCommit) {
              stateUpdate.selectedCommitFiles = [];
            }
          }
        }

        if (shouldSyncBranches && branchesResult.status === "fulfilled" && branchesResult.value) {
          stateUpdate.branches = branchesResult.value.branches.map((branch) => branch.name);
          stateUpdate.remoteBranches = branchesResult.value.remoteBranches ?? [];
          stateUpdate.currentBranch = branchesResult.value.currentBranch;
        }

        if (shouldSyncRemotes && remotesResult.status === "fulfilled" && remotesResult.value) {
          const urls = remotesResult.value.remotes.flatMap((remote) => remote.urls);
          stateUpdate.hasRemote = remotesResult.value.remotes.length > 0;
          stateUpdate.remoteNames = remotesResult.value.remotes.map((remote) => remote.name);
          stateUpdate.remoteUrls = urls;
        }

        if (shouldSyncStashes && stashesResult.status === "fulfilled" && stashesResult.value) {
          syncedStashes = stashesResult.value.stashes ?? [];
        }

        if (shouldSyncConflicts && conflictsResult.status === "fulfilled" && conflictsResult.value) {
          stateUpdate.conflicts = conflictsResult.value.conflicts ?? [];
        }

        if (shouldSyncTags && tagsResult.status === "fulfilled" && tagsResult.value) {
          stateUpdate.tags = tagsResult.value.tags ?? [];
          stateUpdate.tagsToPush = tagsResult.value.tagsToPush ?? [];
          stateUpdate.tagsToPushError = tagsResult.value.tagsToPushError ?? null;
        } else if (shouldSyncTags && tagsResult.status === "rejected") {
          stateUpdate.tagsToPush = [];
          stateUpdate.tagsToPushError =
            tagsResult.reason instanceof Error ? tagsResult.reason.message : "Failed to fetch tags";
        }

        if (shouldSyncDraft && draftResult.status === "fulfilled" && draftResult.value) {
          const nextDraft = applyIncomingDraft(draftResult.value as GitDraft);
          if (nextDraft) {
            stateUpdate.summary = nextDraft.summary;
            stateUpdate.description = nextDraft.description;
            stateUpdate.isAmend = nextDraft.isAmend;
            stateUpdate.skipCommitHooks = nextDraft.skipCommitHooks;
            stateUpdate.signOffCommits = nextDraft.signOffCommits;
            stateUpdate.allowEmptyCommit = nextDraft.allowEmptyCommit;
          }
        }

        if (Object.keys(stateUpdate).length > 0) {
          set(stateUpdate);
        }

        if (syncedStashes) {
          get().applyStashes(syncedStashes);
        }

        if (shouldSyncBranchStatus && branchStatusResult.status === "fulfilled" && branchStatusResult.value) {
          get().applyBranchStatus(branchStatusResult.value);
        }

        if (!silent) {
          const firstRejected = [
            statusResult,
            logResult,
            branchesResult,
            remotesResult,
            branchStatusResult,
            stashesResult,
            conflictsResult,
            tagsResult,
            draftResult,
          ].find((result) => result.status === "rejected");

          if (firstRejected?.status === "rejected") {
            set({
              error: firstRejected.reason instanceof Error ? firstRejected.reason.message : "Failed to sync git data",
            });
          }

          set({ isLoading: false });
        }
      },

      commitSelected: async () => {
        const { currentPath, allFiles, summary, description, skipCommitHooks, signOffCommits, allowEmptyCommit } =
          get();
        if (
          !currentPath ||
          !summary.trim() ||
          (!allowEmptyCommit && !allFiles.some((file) => file.includedState !== "none"))
        ) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const options: GitCommitOptions = {
            noVerify: skipCommitHooks,
            signOff: signOffCommits,
            allowEmpty: allowEmptyCommit,
          };
          const res = await gitApi.commitSelected(
            currentPath,
            [],
            [],
            summary,
            description,
            getScopePayload(),
            options
          );
          const clearedDraft = resetDraftSyncState({
            skipCommitHooks,
            signOffCommits,
            allowEmptyCommit: false,
          });

          if (res.status?.files) {
            const nodes = statusFilesToNodes(res.status.files);
            set({
              allFiles: nodes,
              workingDiffs: {},
              interactiveDiffs: {},
              commits: res.commits ?? get().commits,
              selectedCommit: null,
              selectedCommitFiles: [],
              summary: clearedDraft.summary,
              description: clearedDraft.description,
              isAmend: clearedDraft.isAmend,
              skipCommitHooks: clearedDraft.skipCommitHooks,
              signOffCommits: clearedDraft.signOffCommits,
              allowEmptyCommit: clearedDraft.allowEmptyCommit,
            });
          } else {
            set({
              workingDiffs: {},
              interactiveDiffs: {},
              selectedCommit: null,
              selectedCommitFiles: [],
              summary: clearedDraft.summary,
              description: clearedDraft.description,
              isAmend: clearedDraft.isAmend,
              skipCommitHooks: clearedDraft.skipCommitHooks,
              signOffCommits: clearedDraft.signOffCommits,
              allowEmptyCommit: clearedDraft.allowEmptyCommit,
            });
            void Promise.allSettled([
              gitApi.status(currentPath, getScopePayload()),
              gitApi.log(currentPath, 50),
              gitApi.conflicts(currentPath),
              res.branchStatus ? Promise.resolve(res.branchStatus) : gitApi.branchStatus(currentPath),
            ]).then(([statusResult, logResult, conflictsResult, branchResult]) => {
              const stateUpdate: Partial<GitState> = {};

              if (statusResult.status === "fulfilled") {
                const nodes = statusFilesToNodes(statusResult.value.files);
                stateUpdate.allFiles = nodes;
                stateUpdate.workingDiffs = {};
                stateUpdate.interactiveDiffs = {};
              }

              if (logResult.status === "fulfilled") {
                stateUpdate.commits = logResult.value.commits;
              }

              if (conflictsResult.status === "fulfilled") {
                stateUpdate.conflicts = conflictsResult.value.conflicts ?? [];
              }

              if (Object.keys(stateUpdate).length > 0) {
                set(stateUpdate);
              }

              if (branchResult.status === "fulfilled") {
                get().applyBranchStatus(branchResult.value);
              }
            });
          }

          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to commit" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      amendCommit: async () => {
        const { currentPath, allFiles, summary, description, skipCommitHooks, signOffCommits, allowEmptyCommit } =
          get();
        if (
          !currentPath ||
          !summary.trim() ||
          (!allowEmptyCommit && !allFiles.some((file) => file.includedState !== "none"))
        ) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const options: GitCommitOptions = {
            noVerify: skipCommitHooks,
            signOff: signOffCommits,
            allowEmpty: allowEmptyCommit,
          };
          const res = await gitApi.amend(currentPath, [], [], summary, description, getScopePayload(), options);
          const clearedDraft = resetDraftSyncState({
            skipCommitHooks,
            signOffCommits,
            allowEmptyCommit: false,
          });

          if (res.status?.files) {
            const nodes = statusFilesToNodes(res.status.files);
            set({
              allFiles: nodes,
              workingDiffs: {},
              interactiveDiffs: {},
              commits: res.commits ?? get().commits,
              selectedCommit: null,
              selectedCommitFiles: [],
              summary: clearedDraft.summary,
              description: clearedDraft.description,
              isAmend: clearedDraft.isAmend,
              skipCommitHooks: clearedDraft.skipCommitHooks,
              signOffCommits: clearedDraft.signOffCommits,
              allowEmptyCommit: clearedDraft.allowEmptyCommit,
            });
          } else {
            set({
              workingDiffs: {},
              interactiveDiffs: {},
              selectedCommit: null,
              selectedCommitFiles: [],
              summary: clearedDraft.summary,
              description: clearedDraft.description,
              isAmend: clearedDraft.isAmend,
              skipCommitHooks: clearedDraft.skipCommitHooks,
              signOffCommits: clearedDraft.signOffCommits,
              allowEmptyCommit: clearedDraft.allowEmptyCommit,
            });
            void Promise.allSettled([
              gitApi.status(currentPath, getScopePayload()),
              gitApi.log(currentPath, 50),
              gitApi.conflicts(currentPath),
              res.branchStatus ? Promise.resolve(res.branchStatus) : gitApi.branchStatus(currentPath),
            ]).then(([statusResult, logResult, conflictsResult, branchResult]) => {
              const stateUpdate: Partial<GitState> = {};

              if (statusResult.status === "fulfilled") {
                const nodes = statusFilesToNodes(statusResult.value.files);
                stateUpdate.allFiles = nodes;
                stateUpdate.workingDiffs = {};
                stateUpdate.interactiveDiffs = {};
              }

              if (logResult.status === "fulfilled") {
                stateUpdate.commits = logResult.value.commits;
              }

              if (conflictsResult.status === "fulfilled") {
                stateUpdate.conflicts = conflictsResult.value.conflicts ?? [];
              }

              if (Object.keys(stateUpdate).length > 0) {
                set(stateUpdate);
              }

              if (branchResult.status === "fulfilled") {
                get().applyBranchStatus(branchResult.value);
              }
            });
          }

          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to amend" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      undoLastCommit: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.undo(currentPath);
          const nodes = statusFilesToNodes(res.status.files);
          set({
            allFiles: nodes,
            workingDiffs: {},
            interactiveDiffs: {},
            commits: res.commits,
            selectedCommit: null,
            selectedCommitFiles: [],
          });
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to undo" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      smartSwitchBranch: async (branch) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.smartSwitchBranch(currentPath, branch);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          const stateUpdate: Partial<GitState> = {
            currentBranch: res.branch,
            ...clearStashSelection(),
          };
          if (Array.isArray(res.status?.files)) {
            stateUpdate.allFiles = statusFilesToNodes(res.status.files);
            stateUpdate.workingDiffs = {};
            stateUpdate.interactiveDiffs = {};
          }
          set(stateUpdate);
          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          if (res.stashConflict) {
            set({
              error: `Branch switched to ${res.branch}, but the auto-stash could not be restored: ${res.stashError || "resolve the remaining stash manually"}`,
            });
            return false;
          }
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to switch branch" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      createBranch: async (branch, from) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          await gitApi.createBranch(currentPath, branch, from);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to create branch" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      deleteBranch: async (branch, force = false) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          await gitApi.deleteBranch(currentPath, branch, force);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to delete branch" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      checkoutRemoteBranch: async (remote, branch, localBranch) => {
        return runRemoteCheckout(
          remote,
          branch,
          localBranch,
          (path, targetRemote, targetBranch, targetLocalBranch) =>
            gitApi.checkoutRemoteBranch(path, targetRemote, targetBranch, targetLocalBranch),
          "Failed to checkout remote branch"
        );
      },

      switchRemoteBranch: async (remote, branch, localBranch) => {
        return runRemoteCheckout(
          remote,
          branch,
          localBranch,
          (path, targetRemote, targetBranch, targetLocalBranch) =>
            gitApi.switchRemoteBranch(path, targetRemote, targetBranch, targetLocalBranch),
          "Failed to switch remote branch"
        );
      },

      renameBranch: async (branch, newBranch) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.renameBranch(currentPath, branch, newBranch);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          if (res.branches) {
            set({
              branches: res.branches,
              remoteBranches: res.remoteBranches ?? get().remoteBranches,
              currentBranch: res.currentBranch ?? get().currentBranch,
            });
          } else {
            const snapshot = await gitApi.branches(currentPath);
            if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
              return true;
            }
            set({
              branches: snapshot.branches.map((item) => item.name),
              remoteBranches: snapshot.remoteBranches ?? [],
              currentBranch: snapshot.currentBranch,
            });
          }
          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to rename branch" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      deleteRemoteBranch: async (remote, branch) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.deleteRemoteBranch(currentPath, remote, branch);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          if (res.branches) {
            set({
              branches: res.branches,
              remoteBranches: res.remoteBranches ?? get().remoteBranches,
              currentBranch: res.currentBranch ?? get().currentBranch,
            });
          } else {
            const snapshot = await gitApi.branches(currentPath);
            if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
              return true;
            }
            set({
              branches: snapshot.branches.map((item) => item.name),
              remoteBranches: snapshot.remoteBranches ?? [],
              currentBranch: snapshot.currentBranch,
            });
          }
          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to delete remote branch" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      pruneRemote: async (remote = "origin") => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.pruneRemote(currentPath, remote);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({
            branches: res.branches ?? get().branches,
            remoteBranches: res.remoteBranches ?? get().remoteBranches,
            currentBranch: res.currentBranch ?? get().currentBranch,
          });
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to prune remote branches" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      createTag: async (name, commit) => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const snapshot = await gitApi.createTag(currentPath, name, commit);
          get().applyTagsSnapshot(snapshot);
          const log = await gitApi.log(currentPath, Math.max(get().commits.length, 50));
          set({ commits: log.commits });
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to create tag" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      deleteTag: async (name) => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const snapshot = await gitApi.deleteTag(currentPath, name);
          get().applyTagsSnapshot(snapshot);
          const log = await gitApi.log(currentPath, Math.max(get().commits.length, 50));
          set({ commits: log.commits });
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to delete tag" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      gitFetch: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.fetch(currentPath);
          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          void get().fetchTags();
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to fetch" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      gitPull: async () => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.pull(currentPath);
          const nodes = statusFilesToNodes(res.status.files);
          set({
            allFiles: nodes,
            workingDiffs: {},
            interactiveDiffs: {},
            commits: res.commits,
            conflicts: res.conflicts ?? [],
          });
          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          if (res.conflicts && res.conflicts.length > 0) {
            set({ activeTab: "changes" });
          }
          void get().fetchTags();
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to pull" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      gitPush: async (force?: boolean) => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const tags = get().tagsToPushError ? [] : get().tagsToPush;
          const res = await gitApi.push(currentPath, "origin", force, tags);
          if (res.branchStatus) {
            get().applyBranchStatus(res.branchStatus);
          }
          void get().fetchTags();
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to push" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      stash: async (message, files) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.stash(currentPath, message, files);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          if (res.status) {
            const nodes = statusFilesToNodes(res.status.files);
            set({
              allFiles: nodes,
              workingDiffs: {},
              interactiveDiffs: {},
            });
          }
          set(clearStashSelection());
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to stash" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      stashPop: async (index = 0, oid) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath, stashes } = get();
        if (!currentPath) {
          return false;
        }
        const stashOID = oid ?? stashes.find((stash) => stash.index === index)?.oid;

        set({ isLoading: true, error: null });

        try {
          const res = await gitApi.stashPop(currentPath, index, stashOID);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          if (res.status) {
            const nodes = statusFilesToNodes(res.status.files);
            set({
              allFiles: nodes,
              workingDiffs: {},
              interactiveDiffs: {},
            });
          }
          set(clearStashSelection());
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to pop stash" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      stashDrop: async (index = 0, oid) => {
        const requestId = ++branchSwitchRequestId;
        const { currentPath, stashes } = get();
        if (!currentPath) {
          return false;
        }
        const stashOID = oid ?? stashes.find((stash) => stash.index === index)?.oid;

        set({ isLoading: true, error: null });

        try {
          await gitApi.stashDrop(currentPath, index, stashOID);
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set(clearStashSelection());
          return true;
        } catch (err) {
          if (requestId !== branchSwitchRequestId || get().currentPath !== currentPath) {
            return true;
          }
          set({ error: err instanceof Error ? err.message : "Failed to drop stash" });
          return false;
        } finally {
          if (requestId === branchSwitchRequestId && get().currentPath === currentPath) {
            set({ isLoading: false });
          }
        }
      },

      selectStash: async (index) => {
        const { currentPath, stashes } = get();
        stashRequestId += 1;
        const requestId = stashRequestId;
        if (index === null) {
          set({
            selectedStashIndex: null,
            selectedStashFile: null,
            stashFiles: [],
            stashDiff: null,
            stashLoading: false,
          });
          return;
        }
        const selectedStash = stashes.find((stash) => stash.index === index);
        if (!currentPath || !selectedStash) {
          set({
            selectedStashIndex: null,
            selectedStashFile: null,
            stashFiles: [],
            stashDiff: null,
            stashLoading: false,
          });
          return;
        }

        set({
          selectedStashIndex: index,
          selectedStashFile: null,
          stashFiles: [],
          stashDiff: null,
          stashLoading: true,
          error: null,
        });
        try {
          const response = await gitApi.stashFiles(currentPath, index, selectedStash.oid);
          const state = get();
          if (
            requestId === stashRequestId &&
            state.currentPath === currentPath &&
            state.selectedStashIndex === index &&
            state.stashes.find((stash) => stash.index === index)?.oid === selectedStash.oid
          ) {
            set({ stashFiles: response.files ?? [], stashLoading: false });
          }
        } catch (err) {
          const state = get();
          if (
            requestId === stashRequestId &&
            state.currentPath === currentPath &&
            state.selectedStashIndex === index &&
            state.stashes.find((stash) => stash.index === index)?.oid === selectedStash.oid
          ) {
            set({
              stashFiles: [],
              stashLoading: false,
              error: err instanceof Error ? err.message : "Failed to get stash files",
            });
          }
        }
      },

      selectStashFile: async (filePath) => {
        const { currentPath, selectedStashIndex, stashes } = get();
        stashRequestId += 1;
        const requestId = stashRequestId;
        if (filePath === null || selectedStashIndex === null) {
          set({ selectedStashFile: null, stashDiff: null, stashLoading: false });
          return;
        }
        if (!currentPath) {
          set({ selectedStashFile: null, stashDiff: null, stashLoading: false });
          return;
        }
        const selectedStashOID = stashes.find((stash) => stash.index === selectedStashIndex)?.oid;

        set({ selectedStashFile: filePath, stashDiff: null, stashLoading: true, error: null });
        try {
          const diff = await gitApi.stashDiff(currentPath, selectedStashIndex, filePath, selectedStashOID);
          const state = get();
          if (
            requestId === stashRequestId &&
            state.currentPath === currentPath &&
            state.selectedStashIndex === selectedStashIndex &&
            state.stashes.find((stash) => stash.index === selectedStashIndex)?.oid === selectedStashOID &&
            state.selectedStashFile === filePath
          ) {
            set({ stashDiff: diff, stashLoading: false });
          }
        } catch (err) {
          const state = get();
          if (
            requestId === stashRequestId &&
            state.currentPath === currentPath &&
            state.selectedStashIndex === selectedStashIndex &&
            state.stashes.find((stash) => stash.index === selectedStashIndex)?.oid === selectedStashOID &&
            state.selectedStashFile === filePath
          ) {
            set({
              stashDiff: null,
              stashLoading: false,
              error: err instanceof Error ? err.message : "Failed to get stash diff",
            });
          }
        }
      },

      discardFile: async (path) => {
        const { currentPath } = get();
        if (!currentPath) {
          return;
        }

        try {
          const res = await gitApi.applySelection(
            currentPath,
            path,
            "working",
            "file",
            "discard",
            "",
            [],
            [],
            getScopePayload()
          );
          const nodes = statusFilesToNodes(res.status.files);
          set((state) => ({
            allFiles: nodes,
            workingDiffs: pickWorkingDiffs(nodes, state.workingDiffs),
            interactiveDiffs: {
              ...pickInteractiveDiffs(nodes, state.interactiveDiffs),
              ...(res.diff ? { [path]: res.diff } : {}),
            },
          }));
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to discard changes" });
        }
      },

      resolveConflict: async (filePath, content, hash, mode = "manual") => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const manualContent = mode === "manual" ? content : undefined;
          const res = await gitApi.conflictResolve(currentPath, filePath, mode, hash, undefined, manualContent);
          const nodes = statusFilesToNodes(res.status.files);
          set((state) => ({
            allFiles: nodes,
            workingDiffs: pickWorkingDiffs(nodes, state.workingDiffs),
            interactiveDiffs: pickInteractiveDiffs(nodes, state.interactiveDiffs),
            conflicts: res.conflicts ?? [],
          }));
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to resolve conflict" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      getDiff: async (filePath) => {
        const { currentPath, workingDiffs } = get();
        if (!currentPath) {
          return null;
        }

        const cached = workingDiffs[filePath];
        if (cached) {
          return cached;
        }

        try {
          const diff = await gitApi.diff(currentPath, filePath);
          set((state) => ({
            workingDiffs: {
              ...state.workingDiffs,
              [filePath]: diff,
            },
          }));
          return diff;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to get diff" });
          return null;
        }
      },

      getInteractiveDiff: async (filePath, mode = "working") => {
        const { currentPath, interactiveDiffs } = get();
        if (!currentPath) {
          return null;
        }

        const cached = interactiveDiffs[filePath];
        if (cached && cached.mode === mode) {
          return cached;
        }

        try {
          const diff = await gitApi.fileDiff(currentPath, filePath, mode, getScopePayload());
          set((state) => ({
            interactiveDiffs: {
              ...state.interactiveDiffs,
              [filePath]: diff,
            },
          }));
          return diff;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to get interactive diff" });
          return null;
        }
      },

      applySelection: async (filePath, mode, target, action, patchHash, lineIds, hunkIds) => {
        const { currentPath } = get();
        if (!currentPath) {
          return null;
        }

        try {
          const res = await gitApi.applySelection(
            currentPath,
            filePath,
            mode,
            target,
            action,
            patchHash,
            lineIds,
            hunkIds,
            getScopePayload()
          );
          const nodes = statusFilesToNodes(res.status.files);
          set((state) => ({
            allFiles: nodes,
            workingDiffs: pickWorkingDiffs(nodes, state.workingDiffs),
            interactiveDiffs: {
              ...pickInteractiveDiffs(nodes, state.interactiveDiffs),
              ...(res.diff ? { [filePath]: res.diff } : {}),
            },
          }));
          return res.diff ?? null;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to apply selection" });
          return null;
        }
      },

      getCommitFiles: async (commitHash) => {
        const { currentPath } = get();
        if (!currentPath) {
          return [];
        }
        const requestId = ++commitFilesRequestId;
        const requestPath = currentPath;

        try {
          const res = await gitApi.commitFiles(requestPath, commitHash);
          const state = get();
          if (
            requestId === commitFilesRequestId &&
            state.currentPath === requestPath &&
            state.selectedCommit?.hash === commitHash
          ) {
            set({ selectedCommitFiles: res.files });
          }
          return res.files;
        } catch (err) {
          const state = get();
          if (
            requestId === commitFilesRequestId &&
            state.currentPath === requestPath &&
            state.selectedCommit?.hash === commitHash
          ) {
            set({ error: err instanceof Error ? err.message : "Failed to get commit files" });
          }
          return [];
        }
      },

      getCommitDiff: async (commitHash, filePath) => {
        const { currentPath } = get();
        if (!currentPath) {
          return null;
        }

        try {
          return await gitApi.commitDiff(currentPath, commitHash, filePath);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to get commit diff" });
          return null;
        }
      },

      addPatch: async (filePath, patch) => {
        const { currentPath } = get();
        if (!currentPath) {
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          await gitApi.addPatch(currentPath, filePath, patch);
          return true;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : "Failed to add patch" });
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      mergeOperation: (ref, action = "start", options) =>
        runOperation((path) => gitApi.merge(path, ref, action, options)),

      rebaseOperation: (upstream, action = "start", options) =>
        runOperation((path) => gitApi.rebase(path, upstream, action, options)),

      cherryPickOperation: (commit, action = "start", options) =>
        runOperation((path) => gitApi.cherryPick(path, commit, action, options)),

      revertOperation: (commit, action = "start", files) =>
        runOperation((path) => gitApi.revert(path, commit, action, files)),

      resetToCommit: (ref, mode = "mixed") => runOperation((path) => gitApi.resetToCommit(path, ref, mode)),

      squashOperation: (toSquash, squashOnto, options) =>
        runOperation((path) => gitApi.squash(path, toSquash, squashOnto, options)),

      reorderOperation: (toMove, beforeCommit, options) =>
        runOperation((path) => gitApi.reorder(path, toMove, beforeCommit, options)),
    };
  };

export const createGitStore = (groupId?: string) => createStore<GitState>(createGitState(groupId));

export type GitStoreApi = ReturnType<typeof createGitStore>;

const gitStores = new Map<string, GitStoreApi>();

const normalizeGitStoreId = (groupId?: string) => groupId || DEFAULT_GIT_STORE_ID;

export function getOrCreateGitStore(groupId: string): GitStoreApi {
  const storeId = normalizeGitStoreId(groupId);
  const existing = gitStores.get(storeId);
  if (existing) {
    return existing;
  }
  const store = createGitStore(groupId);
  gitStores.set(storeId, store);
  return store;
}

export function removeGitStore(groupId: string): void {
  gitStores.delete(normalizeGitStoreId(groupId));
}

export function resetGitStores(): void {
  gitStores.clear();
}

export function useGitStore(): GitState;
export function useGitStore<T>(selector: GitSelector<T>): T;
export function useGitStore(groupId: string): GitState;
export function useGitStore<T>(groupId: string, selector: GitSelector<T>): T;
export function useGitStore<T>(
  groupIdOrSelector?: string | GitSelector<T>,
  maybeSelector?: GitSelector<T>
): T | GitState {
  const storeId = typeof groupIdOrSelector === "string" ? groupIdOrSelector : DEFAULT_GIT_STORE_ID;
  const selector =
    typeof groupIdOrSelector === "function" ? groupIdOrSelector : (maybeSelector ?? ((state: GitState) => state as T));
  return useStore(getOrCreateGitStore(storeId), selector);
}
