import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CloudUpload,
  Download,
  FileText,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitGraph,
  GitPullRequest,
  History,
  ListRestart,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Settings2,
  SkipForward,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  BranchStatusInfo,
  GitBranchesSnapshot,
  GitCommit,
  GitDiff,
  GitDraft,
  GitOperationResponse,
  GitSubmoduleStatus,
  GitWSSnapshot,
  RemoteInfo,
  StashEntry,
} from "@/api/git";
import { gitApi } from "@/api/git";
import { useDialog } from "@/components/common";
import BranchSelector from "@/components/git/branch-selector";
import DesktopGitWorkspace from "@/components/git/desktop-git-workspace";
import GitChangesView from "@/components/git/git-changes-view";
import GitHistoryView from "@/components/git/git-history-view";
import GitMobileActions from "@/components/git/git-mobile-actions";
import GitRepositoryDialog from "@/components/git/git-repository-dialog";
import GitRepositorySettings from "@/components/git/git-repository-settings";
import GithubPanel from "@/components/git/github-panel";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { getTranslation, type Locale } from "@/lib/i18n";
import { getOrCreateGitStore, useGitStore } from "@/stores";
import { useSessionStore } from "@/stores/session-store";

interface GitDiffRequest {
  original: string;
  modified: string;
  title: string;
  filename?: string;
  filePath?: string;
  repoPath?: string;
  allowSelection?: boolean;
  submodule?: GitSubmoduleStatus;
  metadata?: Pick<
    GitDiff,
    | "oldSize"
    | "newSize"
    | "oldBinary"
    | "newBinary"
    | "oldTruncated"
    | "newTruncated"
    | "binary"
    | "large"
    | "kind"
    | "patch"
    | "capability"
    | "submodule"
    | "image"
  >;
}

interface GitViewProps {
  groupId: string;
  path: string;
  locale: Locale;
  onFileDiff: (payload: GitDiffRequest) => void;
  onConflict?: (repoPath: string, filePath: string) => void;
  isActive?: boolean;
}

// History is rendered newest-first. When every commit involved in a rewrite
// is loaded, provide the parent of the oldest one so Git only replays the
// affected suffix. If the oldest item is the pagination boundary (or a hash
// was entered manually and is not loaded), leave the value unset and let the
// backend derive the safe first-parent boundary.
export const getLastRetainedCommitRef = (commits: GitCommit[], refs: string[]): string | undefined => {
  if (refs.length === 0) return undefined;
  const indexes = refs.map((ref) => {
    const trimmed = ref.trim();
    if (!trimmed) return -1;
    return commits.findIndex((commit) => commit.hash === trimmed || commit.hash.startsWith(trimmed));
  });
  if (indexes.some((index) => index < 0)) return undefined;
  const oldestIndex = Math.max(...indexes);
  if (oldestIndex >= commits.length - 1) return undefined;
  return `${commits[oldestIndex].hash}^`;
};

/** Git history is newest-first; cherry-pick dependent commits oldest-first. */
export const orderHistoryCommits = (history: GitCommit[], selected: GitCommit[]): GitCommit[] => {
  const historyIndexByHash = new Map(history.map((commit, index) => [commit.hash, index]));
  return selected
    .map((commit, selectionIndex) => ({
      commit,
      selectionIndex,
      historyIndex: historyIndexByHash.get(commit.hash),
    }))
    .sort((a, b) => {
      if (a.historyIndex === undefined || b.historyIndex === undefined) {
        if (a.historyIndex === undefined && b.historyIndex === undefined) {
          return a.selectionIndex - b.selectionIndex;
        }
        return a.historyIndex === undefined ? 1 : -1;
      }
      return b.historyIndex - a.historyIndex;
    })
    .map(({ commit }) => commit);
};

export const getHistoryCherryPickRequest = (commits: GitCommit[]) => {
  const hashes = commits.map((commit) => commit.hash);
  if (hashes.length <= 1) {
    return { commit: hashes[0] ?? "", action: "start" as const };
  }
  // The backend appends `commit` to `commits`; keep the scalar field empty for
  // a multi-commit request so the first hash is not submitted twice.
  return { commit: "", action: "start" as const, options: { commits: hashes } };
};

const gitOperationTranslationKey = (operation: string): string => {
  switch (operation) {
    case "cherry-pick":
      return "cherryPick";
    case "reset":
    case "reset-to-commit":
      return "resetToCommit";
    default:
      return operation;
  }
};

const GitView: React.FC<GitViewProps> = ({ groupId, path, locale, onFileDiff, onConflict, isActive = true }) => {
  const t = (key: string) => getTranslation(locale, key);
  const dialog = useDialog();
  const isMobile = useIsMobile();
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [repositoryDialogMode, setRepositoryDialogMode] = useState<"create" | "clone" | null>(null);
  const [repositorySettingsOpen, setRepositorySettingsOpen] = useState(false);
  const [githubPanelOpen, setGithubPanelOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const mobileActionsTriggerRef = useRef<HTMLElement | null>(null);
  // Keep commit selection outside the responsive views so changing viewport or
  // switching between Changes and History does not lose the user's selection.
  const [selectedHistoryHashes, setSelectedHistoryHashes] = useState<string[]>([]);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const changesTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const openFolder = useSessionStore((s) => s.openFolder);
  const {
    currentPath: currentRepoPath,
    isRepo,
    allFiles,
    commits,
    isLoading,
    selectedCommit,
    selectedCommitFiles,
    currentBranch,
    branches,
    remoteBranches,
    recentBranches,
    activeTab,
    hasRemote,
    remoteNames,
    remoteUrls,
    aheadCount,
    behindCount,
    tagsToPush,
    tagsToPushError,
    stashes,
    selectedStashIndex,
    selectedStashFile,
    stashFiles,
    stashDiff,
    stashLoading,
    conflicts,
    operation,
    error,
    setCurrentPath,
    setScope,
    setActiveTab,
    reset,
    checkRepo,
    initRepo,
    fetchLog,
    fetchMoreLog,
    syncRepo,
    smartSwitchBranch,
    checkoutRemoteBranch,
    gitPull,
    gitPush,
    gitFetch,
    stash,
    stashPop,
    stashDrop,
    selectStash,
    selectStashFile,
    createBranch,
    deleteBranch,
    renameBranch,
    deleteRemoteBranch,
    pruneRemote,
    createTag,
    deleteTag,
    setSelectedCommit,
    getCommitFiles,
    getCommitDiff,
    getDiff,
    toggleFile,
    toggleAllFiles,
    discardFile,
    undoLastCommit,
    applyStatusUpdate,
    applyBranchStatus,
    applyBranchesSnapshot,
    applyRemotes,
    applyStashes,
    applyConflicts,
    applyDraft,
    applySnapshot,
    applyOperation,
    fetchOperationStatus,
    mergeOperation,
    rebaseOperation,
    cherryPickOperation,
    revertOperation,
    resetToCommit,
    squashOperation,
    reorderOperation,
  } = useGitStore(
    groupId,
    useShallow((state) => ({
      currentPath: state.currentPath,
      isRepo: state.isRepo,
      allFiles: state.allFiles,
      commits: state.commits,
      isLoading: state.isLoading,
      selectedCommit: state.selectedCommit,
      selectedCommitFiles: state.selectedCommitFiles,
      currentBranch: state.currentBranch,
      branches: state.branches,
      remoteBranches: state.remoteBranches,
      recentBranches: state.recentBranches,
      activeTab: state.activeTab,
      hasRemote: state.hasRemote,
      remoteNames: state.remoteNames,
      remoteUrls: state.remoteUrls,
      aheadCount: state.aheadCount,
      behindCount: state.behindCount,
      tagsToPush: state.tagsToPush,
      tagsToPushError: state.tagsToPushError,
      stashes: state.stashes,
      selectedStashIndex: state.selectedStashIndex,
      selectedStashFile: state.selectedStashFile,
      stashFiles: state.stashFiles,
      stashDiff: state.stashDiff,
      stashLoading: state.stashLoading,
      conflicts: state.conflicts,
      operation: state.operation,
      error: state.error,
      setCurrentPath: state.setCurrentPath,
      setScope: state.setScope,
      setActiveTab: state.setActiveTab,
      reset: state.reset,
      checkRepo: state.checkRepo,
      initRepo: state.initRepo,
      fetchLog: state.fetchLog,
      fetchMoreLog: state.fetchMoreLog,
      syncRepo: state.syncRepo,
      smartSwitchBranch: state.smartSwitchBranch,
      checkoutRemoteBranch: state.checkoutRemoteBranch,
      gitPull: state.gitPull,
      gitPush: state.gitPush,
      gitFetch: state.gitFetch,
      stash: state.stash,
      stashPop: state.stashPop,
      stashDrop: state.stashDrop,
      selectStash: state.selectStash,
      selectStashFile: state.selectStashFile,
      createBranch: state.createBranch,
      deleteBranch: state.deleteBranch,
      renameBranch: state.renameBranch,
      deleteRemoteBranch: state.deleteRemoteBranch,
      pruneRemote: state.pruneRemote,
      createTag: state.createTag,
      deleteTag: state.deleteTag,
      setSelectedCommit: state.setSelectedCommit,
      getCommitFiles: state.getCommitFiles,
      getCommitDiff: state.getCommitDiff,
      getDiff: state.getDiff,
      toggleFile: state.toggleFile,
      toggleAllFiles: state.toggleAllFiles,
      discardFile: state.discardFile,
      undoLastCommit: state.undoLastCommit,
      applyStatusUpdate: state.applyStatusUpdate,
      applyBranchStatus: state.applyBranchStatus,
      applyBranchesSnapshot: state.applyBranchesSnapshot,
      applyRemotes: state.applyRemotes,
      applyStashes: state.applyStashes,
      applyConflicts: state.applyConflicts,
      applyDraft: state.applyDraft,
      applySnapshot: state.applySnapshot,
      applyOperation: state.applyOperation,
      fetchOperationStatus: state.fetchOperationStatus,
      mergeOperation: state.mergeOperation,
      rebaseOperation: state.rebaseOperation,
      cherryPickOperation: state.cherryPickOperation,
      revertOperation: state.revertOperation,
      resetToCommit: state.resetToCommit,
      squashOperation: state.squashOperation,
      reorderOperation: state.reorderOperation,
    }))
  );

  const wsCleanupRef = useRef<(() => void) | null>(null);
  const historySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyDirtyRef = useRef(true);
  const forcePushPromptRef = useRef(false);

  const scheduleHistoryRefresh = useCallback(
    (delay = 0) => {
      historyDirtyRef.current = true;
      if (!isActive || isRepo !== true || activeTab !== "history") {
        return;
      }
      if (historySyncTimerRef.current) {
        return;
      }
      historySyncTimerRef.current = setTimeout(() => {
        historySyncTimerRef.current = null;
        historyDirtyRef.current = false;
        void fetchLog();
      }, delay);
    },
    [activeTab, fetchLog, isActive, isRepo]
  );

  useEffect(() => {
    if (currentRepoPath !== path) {
      reset();
      setCurrentPath(path);
      return;
    }

    if (isRepo !== null) {
      return;
    }

    let cancelled = false;

    void checkRepo().then((ok) => {
      if (!ok || cancelled) {
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [path, currentRepoPath, isRepo, setCurrentPath, reset, checkRepo]);

  useEffect(() => {
    return () => {
      if (historySyncTimerRef.current) {
        clearTimeout(historySyncTimerRef.current);
        historySyncTimerRef.current = null;
      }
      historyDirtyRef.current = true;
    };
  }, []);

  useEffect(() => {
    setScope(currentSessionId);
  }, [currentSessionId, setScope]);

  useEffect(() => {
    setSelectedHistoryHashes([]);
  }, [groupId, path]);

  useEffect(() => {
    setSelectedHistoryHashes((selected) => {
      if (selected.length === 0) return selected;
      const availableHashes = new Set(commits.map((commit) => commit.hash));
      const next = selected.filter((hash) => availableHashes.has(hash));
      return next.length === selected.length ? selected : next;
    });
  }, [commits]);

  useEffect(() => {
    if (!path || !isActive || isRepo !== true) return;
    wsCleanupRef.current = gitApi.connectWs(
      path,
      (event) => {
        if (event.type === "snapshot") {
          applySnapshot(event.data as GitWSSnapshot);
          return;
        }
        if (event.type === "status_changed") {
          const payload = event.data as { files?: unknown[] };
          applyStatusUpdate((payload.files as any) || []);
          return;
        }
        if (event.type === "branch_status_changed") {
          applyBranchStatus(event.data as BranchStatusInfo);
          return;
        }
        if (event.type === "branches_changed") {
          applyBranchesSnapshot(event.data as GitBranchesSnapshot);
          return;
        }
        if (event.type === "remotes_changed") {
          const payload = event.data as { remotes?: RemoteInfo[] };
          applyRemotes(payload.remotes ?? []);
          return;
        }
        if (event.type === "stashes_changed") {
          const payload = event.data as { stashes?: StashEntry[] };
          applyStashes(payload.stashes ?? []);
          return;
        }
        if (event.type === "conflicts_changed") {
          const payload = event.data as { conflicts?: string[] };
          applyConflicts(payload.conflicts ?? []);
          return;
        }
        if (event.type === "draft_changed") {
          applyDraft(event.data as GitDraft);
          return;
        }
        if (event.type === "history_changed") {
          scheduleHistoryRefresh(120);
          return;
        }
        if (event.type === "operation_done") {
          applyOperation(event.data as GitOperationResponse);
        }
      },
      { workspace_session_id: currentSessionId || undefined, group_id: groupId }
    );
    return () => {
      wsCleanupRef.current?.();
      wsCleanupRef.current = null;
    };
  }, [
    path,
    isActive,
    isRepo,
    currentSessionId,
    groupId,
    applyStatusUpdate,
    applyBranchStatus,
    applyBranchesSnapshot,
    applyRemotes,
    applyStashes,
    applyConflicts,
    applyDraft,
    applySnapshot,
    applyOperation,
    scheduleHistoryRefresh,
  ]);

  useEffect(() => {
    if (activeTab === "history" && isActive && isRepo === true && (commits.length === 0 || historyDirtyRef.current)) {
      scheduleHistoryRefresh(0);
    }
  }, [activeTab, commits.length, isActive, isRepo, scheduleHistoryRefresh]);

  useEffect(() => {
    if (isActive && isRepo === true) {
      void fetchOperationStatus();
    }
  }, [fetchOperationStatus, isActive, isRepo]);

  const handleRefresh = useCallback(() => {
    void syncRepo();
    void fetchOperationStatus();
  }, [fetchOperationStatus, syncRepo]);

  const handleFetch = useCallback(async () => {
    const ok = await gitFetch();
    if (!ok) {
      await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
    }
  }, [dialog, gitFetch, groupId, t]);

  const handlePull = useCallback(async () => {
    const ok = await gitPull();
    if (!ok) {
      await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
    }
  }, [dialog, gitPull, groupId, t]);

  const handleDesktopDiscardFile = useCallback(
    async (filePath: string) => {
      const confirmed = await dialog.confirm(t("git.discardConfirm"), `${filePath}\n${t("git.discardWarning")}`, {
        confirmText: t("git.confirm"),
        confirmVariant: "danger",
      });
      if (confirmed) await discardFile(filePath);
    },
    [dialog, discardFile, t]
  );

  const handlePush = useCallback(
    async (force?: boolean) => {
      if (force) {
        // A force push rewrites the remote branch even though the backend uses
        // --force-with-lease. Keep the confirmation in this shared entry point
        // so desktop and mobile controls cannot bypass it.
        if (forcePushPromptRef.current) return;
        forcePushPromptRef.current = true;
        try {
          const branch = currentBranch.trim() || "HEAD";
          const confirmed = await dialog.confirm(
            t("git.forcePushConfirmTitle"),
            t("git.forcePushConfirmMessage")
              .replace("{branch}", branch)
              .replace("{remote}", remoteNames[0] || "origin"),
            { confirmText: t("git.forcePush"), confirmVariant: "danger" }
          );
          if (!confirmed) return;
        } finally {
          forcePushPromptRef.current = false;
        }
      }
      const ok = await gitPush(force);
      if (!ok) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [currentBranch, dialog, gitPush, groupId, remoteNames, t]
  );

  const handleOperationResult = useCallback(
    async (ok: boolean) => {
      if (!ok) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
      return ok;
    },
    [dialog, groupId, t]
  );

  const handleMerge = useCallback(
    (ref: string) => mergeOperation(ref).then(handleOperationResult),
    [handleOperationResult, mergeOperation]
  );
  const handleRebase = useCallback(
    (upstream: string) => rebaseOperation(upstream).then(handleOperationResult),
    [handleOperationResult, rebaseOperation]
  );
  const handleCherryPick = useCallback(
    (commit: string) => cherryPickOperation(commit).then(handleOperationResult),
    [cherryPickOperation, handleOperationResult]
  );
  const handleHistoryCherryPick = useCallback(
    async (selected: GitCommit[]) => {
      if (selected.length === 0) return;
      const request = getHistoryCherryPickRequest(orderHistoryCommits(commits, selected));
      const ok = await cherryPickOperation(request.commit, request.action, request.options);
      await handleOperationResult(ok);
      if (ok) setSelectedHistoryHashes([]);
    },
    [cherryPickOperation, commits, handleOperationResult]
  );
  const handleRevert = useCallback(
    (commit: string) => revertOperation(commit).then(handleOperationResult),
    [handleOperationResult, revertOperation]
  );
  const handleHistoryRevert = useCallback(
    async (commit: GitCommit) => {
      const ok = await handleRevert(commit.hash);
      if (ok) setSelectedHistoryHashes([]);
      return ok;
    },
    [handleRevert]
  );
  const handleResetToCommit = useCallback(
    async (ref: string, mode: "soft" | "mixed" | "hard") => {
      if (mode === "hard") {
        const confirmed = await dialog.confirm(t("git.hardResetConfirmTitle"), t("git.hardResetConfirmMessage"), {
          confirmText: t("git.resetToCommit"),
          confirmVariant: "danger",
        });
        if (!confirmed) return false;
      }
      return handleOperationResult(await resetToCommit(ref, mode));
    },
    [dialog, handleOperationResult, resetToCommit, t]
  );
  const handleHistoryReset = useCallback(
    async (commit: GitCommit) => {
      const ok = await handleResetToCommit(commit.hash, "mixed");
      if (ok) setSelectedHistoryHashes([]);
      return ok;
    },
    [handleResetToCommit]
  );

  const handleSquash = useCallback(
    async (squashOnto: GitCommit) => {
      const raw = await dialog.prompt(t("git.squashCommits"), {
        placeholder: t("git.commitHashesPlaceholder"),
      });
      if (raw === null) return false;
      const toSquash = raw
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (toSquash.length === 0) return false;
      const message = await dialog.prompt(t("git.squashMessage"), {
        defaultValue: squashOnto.message,
      });
      if (message === null) return false;
      const lastRetainedCommitRef = getLastRetainedCommitRef(commits, [...toSquash, squashOnto.hash]);
      return handleOperationResult(
        await squashOperation(toSquash, squashOnto.hash, { message, lastRetainedCommitRef })
      );
    },
    [commits, dialog, handleOperationResult, squashOperation, t]
  );

  const handleReorder = useCallback(
    async (beforeCommit: GitCommit) => {
      const raw = await dialog.prompt(t("git.reorderCommits"), {
        placeholder: t("git.commitHashesPlaceholder"),
      });
      if (raw === null) return false;
      const toMove = raw
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (toMove.length === 0) return false;
      const lastRetainedCommitRef = getLastRetainedCommitRef(commits, [...toMove, beforeCommit.hash]);
      return handleOperationResult(await reorderOperation(toMove, beforeCommit.hash, { lastRetainedCommitRef }));
    },
    [commits, dialog, handleOperationResult, reorderOperation, t]
  );

  const handleHistorySquash = useCallback(
    async (selected: GitCommit[], squashOnto: GitCommit) => {
      const toSquash = selected.map((commit) => commit.hash).filter((hash) => hash !== squashOnto.hash);
      if (toSquash.length === 0) return;
      const message = await dialog.prompt(t("git.squashMessage"), { defaultValue: squashOnto.message });
      if (message === null) return;
      const lastRetainedCommitRef = getLastRetainedCommitRef(commits, [...toSquash, squashOnto.hash]);
      const ok = await handleOperationResult(
        await squashOperation(toSquash, squashOnto.hash, { message, lastRetainedCommitRef })
      );
      if (ok) setSelectedHistoryHashes([]);
    },
    [commits, dialog, handleOperationResult, squashOperation, t]
  );

  const handleHistoryReorder = useCallback(
    async (selected: GitCommit[], beforeCommit: GitCommit) => {
      const toMove = selected.map((commit) => commit.hash).filter((hash) => hash !== beforeCommit.hash);
      if (toMove.length === 0) return;
      const lastRetainedCommitRef = getLastRetainedCommitRef(commits, [...toMove, beforeCommit.hash]);
      const ok = await handleOperationResult(
        await reorderOperation(toMove, beforeCommit.hash, { lastRetainedCommitRef })
      );
      if (ok) setSelectedHistoryHashes([]);
    },
    [commits, handleOperationResult, reorderOperation]
  );

  const handleOperationAction = useCallback(
    async (action: "continue" | "abort" | "skip") => {
      const current = getOrCreateGitStore(groupId).getState().operation;
      if (!current) return false;
      let ok = false;
      // ConflictResolve (or an explicit `git add` in the terminal) stages the
      // resolved paths. Do not pass current.conflicts here: Git would also add
      // files that still contain unresolved conflict markers.
      switch (current.operation) {
        case "merge":
          ok = await mergeOperation("", action === "skip" ? "abort" : action);
          break;
        case "rebase":
          ok = await rebaseOperation("", action);
          break;
        case "cherry-pick":
          ok = await cherryPickOperation("", action);
          break;
        case "revert":
          ok = await revertOperation("", action);
          break;
        default:
          return false;
      }
      return handleOperationResult(ok);
    },
    [
      cherryPickOperation,
      getOrCreateGitStore,
      groupId,
      handleOperationResult,
      mergeOperation,
      rebaseOperation,
      revertOperation,
    ]
  );

  const smartAction = useMemo(() => {
    const tagCount = tagsToPushError ? 0 : tagsToPush.length;
    const pushLabel =
      tagCount > 0
        ? `${t("git.push")} (${aheadCount}${aheadCount > 0 ? " + " : ""}${tagCount} ${t("git.tag")})`
        : `${t("git.push")} (${aheadCount})`;
    if (!hasRemote) return { label: t("git.publish"), icon: <CloudUpload size={14} />, action: handlePush };
    if (behindCount > 0)
      return { label: `${t("git.pull")} (${behindCount})`, icon: <ArrowDown size={14} />, action: handlePull };
    if (aheadCount > 0 || tagCount > 0) return { label: pushLabel, icon: <ArrowUp size={14} />, action: handlePush };
    return { label: t("git.fetch"), icon: <RefreshCw size={14} />, action: handleFetch };
  }, [hasRemote, aheadCount, behindCount, tagsToPush, tagsToPushError, handleFetch, handlePull, handlePush, t]);
  const operationInProgress = operation?.state === "in_progress" || operation?.state === "conflicts";
  const operationCanSkip =
    operation?.operation === "rebase" || operation?.operation === "cherry-pick" || operation?.operation === "revert";
  const operationLabel = operation
    ? getTranslation(locale, `git.${gitOperationTranslationKey(operation.operation)}`) || operation.operation
    : "";
  const focusMobileTab = useCallback(
    (tab: "changes" | "history") => {
      setActiveTab(tab);
      window.requestAnimationFrame(() => {
        const targetRef = tab === "changes" ? changesTabRef : historyTabRef;
        if (targetRef.current?.isConnected) targetRef.current.focus();
      });
    },
    [setActiveTab]
  );

  const topBarConfig = useMemo(() => {
    if (!isActive) return null;
    if (isRepo !== true) {
      return {
        show: true,
        leftButtons: [],
        centerContent: null,
        rightButtons: [],
      };
    }
    if (!isMobile) {
      const normalizedPath = path.replace(/[\\/]+$/, "");
      const repositoryName = normalizedPath.split(/[\\/]/).pop() || path;
      return {
        show: true,
        leftButtons: [{ icon: <GitGraph size={18} />, active: true }],
        centerContent: (
          <div className="flex min-w-0 items-center gap-2">
            <FolderGit2 size={15} className="shrink-0 text-ide-mute" />
            <span className="hidden max-w-48 truncate text-xs text-ide-mute lg:inline" title={path}>
              {repositoryName}
            </span>
            <button
              ref={branchTriggerRef}
              type="button"
              className="flex h-8 min-w-0 max-w-64 shrink-0 items-center gap-1.5 rounded-md border border-ide-border bg-ide-panel px-2.5 text-xs text-ide-text transition-colors hover:bg-ide-bg disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setShowBranchSelector(true)}
              disabled={isLoading}
              title={t("git.branches")}
              aria-haspopup="dialog"
              aria-expanded={showBranchSelector}
            >
              <GitBranch size={14} className="shrink-0 text-ide-accent" />
              <span className="truncate">{currentBranch || t("git.branches")}</span>
              {(aheadCount > 0 || behindCount > 0) && (
                <span className="flex shrink-0 items-center gap-1">
                  {aheadCount > 0 && (
                    <span className="text-[10px] text-blue-400">
                      {aheadCount}
                      <ArrowUp size={8} className="inline" />
                    </span>
                  )}
                  {behindCount > 0 && (
                    <span className="text-[10px] text-orange-400">
                      {behindCount}
                      <ArrowDown size={8} className="inline" />
                    </span>
                  )}
                </span>
              )}
            </button>
          </div>
        ),
        rightButtons: [
          {
            icon: smartAction.icon,
            label: smartAction.label,
            title: smartAction.label,
            onClick: () => {
              void smartAction.action();
            },
            disabled: isLoading,
          },
          {
            icon: <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />,
            title: t("git.refresh"),
            onClick: handleRefresh,
            disabled: isLoading,
          },
          {
            icon: <Settings2 size={16} />,
            title: t("git.repositorySettings.open"),
            onClick: () => setRepositorySettingsOpen((open) => !open),
            active: repositorySettingsOpen,
          },
          {
            icon: <GitPullRequest size={16} />,
            title: t("git.github.open"),
            onClick: () => setGithubPanelOpen((open) => !open),
            active: githubPanelOpen,
          },
        ],
      };
    }
    return {
      show: true,
      leftButtons: [],
      centerContent: (
        <div
          className="flex h-full items-center gap-0.5 min-[360px]:gap-1"
          role="tablist"
          aria-label={t("sidebar.git")}
        >
          <button
            ref={changesTabRef}
            type="button"
            role="tab"
            aria-selected={activeTab === "changes"}
            tabIndex={activeTab === "changes" ? 0 : -1}
            onClick={() => setActiveTab("changes")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              focusMobileTab("history");
            }}
            aria-label={`${t("git.changes")}${allFiles.length > 0 ? ` (${allFiles.length})` : ""}`}
            className={`flex h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-md border px-1.5 text-xs transition-all min-[360px]:gap-1 min-[360px]:px-2.5 ${
              activeTab === "changes"
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <FileText size={12} className="hidden min-[360px]:block" />
            <span className="font-medium">
              {t("git.changes")}
              {allFiles.length > 0 && <span className="hidden min-[390px]:inline"> ({allFiles.length})</span>}
            </span>
          </button>
          <button
            ref={historyTabRef}
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            tabIndex={activeTab === "history" ? 0 : -1}
            onClick={() => setActiveTab("history")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              focusMobileTab("changes");
            }}
            className={`flex h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-md border px-1.5 text-xs transition-all min-[360px]:gap-1 min-[360px]:px-2.5 ${
              activeTab === "history"
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <History size={12} className="hidden min-[360px]:block" />
            <span className="font-medium">{t("git.history")}</span>
          </button>
        </div>
      ),
      rightButtons: [
        {
          icon: <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />,
          title: t("git.refresh"),
          onClick: handleRefresh,
          disabled: isLoading,
        },
        {
          icon: <MoreHorizontal size={18} />,
          title: t("git.moreActions"),
          onClick: () => {
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement && activeElement !== document.body) {
              mobileActionsTriggerRef.current = activeElement;
            } else {
              mobileActionsTriggerRef.current =
                Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]")).find(
                  (element) => element.getAttribute("aria-label") === t("git.moreActions")
                ) ?? null;
            }
            setMobileActionsOpen(true);
          },
          active: mobileActionsOpen,
        },
      ],
    };
  }, [
    isActive,
    isMobile,
    isRepo,
    activeTab,
    allFiles.length,
    isLoading,
    t,
    setActiveTab,
    focusMobileTab,
    handleRefresh,
    path,
    currentBranch,
    aheadCount,
    behindCount,
    showBranchSelector,
    smartAction,
    repositorySettingsOpen,
    githubPanelOpen,
    mobileActionsOpen,
  ]);

  usePageTopBar(topBarConfig, [topBarConfig]);

  const handleInitRepo = useCallback(async () => {
    const confirmed = await dialog.confirm(t("git.initRepoConfirmTitle"), t("git.initRepoConfirmMessage"), {
      confirmText: t("git.initRepo"),
    });
    if (!confirmed) return;
    const ok = await initRepo();
    if (ok) {
      historyDirtyRef.current = true;
    }
  }, [dialog, t, initRepo]);

  const handleOpenCreatedRepository = useCallback(
    async (repositoryPath: string) => {
      await openFolder(repositoryPath);
    },
    [openFolder]
  );

  const handleStashPop = useCallback(
    async (index: number, oid?: string) => {
      if (!(await stashPop(index, oid))) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [dialog, groupId, stashPop, t]
  );

  const handleStashDrop = useCallback(
    async (index: number, oid?: string) => {
      const stashEntry = stashes.find((entry) => entry.index === index && (!oid || entry.oid === oid));
      const confirmed = await dialog.confirm(
        t("git.stashDropConfirmTitle"),
        (t("git.stashDropConfirmMessage") || "{message}").replace(
          "{message}",
          stashEntry?.message || `stash@{${index}}`
        ),
        { confirmText: t("git.drop"), confirmVariant: "danger" }
      );
      if (!confirmed) return;
      if (!(await stashDrop(index, oid))) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [dialog, groupId, stashDrop, stashes, t]
  );

  const handleFileClick = useCallback(
    async (filePath: string) => {
      const file = allFiles.find((item) => item.path === filePath);
      const fileName = filePath.split("/").pop() || filePath;
      const diff = await getDiff(filePath);
      onFileDiff({
        original: diff?.old || "",
        modified: diff?.new || "",
        title: `${fileName} [DIFF]`,
        filename: fileName,
        filePath,
        repoPath: path,
        allowSelection: file ? !file.submodule && ["modified", "added", "untracked"].includes(file.status) : false,
        submodule: file?.submodule,
        metadata: diff || undefined,
      });
    },
    [allFiles, getDiff, onFileDiff, path]
  );

  const handleCommitSelect = useCallback(
    async (commitInfo: GitCommit) => {
      setSelectedCommit(commitInfo);
      await getCommitFiles(commitInfo.hash);
    },
    [setSelectedCommit, getCommitFiles]
  );

  const handleHistoryFileClick = useCallback(
    async (commitInfo: GitCommit, filePath: string) => {
      const diff = await getCommitDiff(commitInfo.hash, filePath);
      if (diff) {
        const fileName = filePath.split("/").pop() || filePath;
        const shortHash = commitInfo.hash.substring(0, 7);
        onFileDiff({
          original: diff.old,
          modified: diff.new,
          title: `${fileName} @ ${shortHash}`,
          filename: fileName,
          filePath,
          repoPath: path,
          allowSelection: false,
          metadata: diff,
        });
      }
      return diff;
    },
    [getCommitDiff, onFileDiff, path]
  );

  const handleHistoryUndoCommit = useCallback(
    async (commitInfo: GitCommit) => {
      if (isLoading || commits[0]?.hash !== commitInfo.hash || commitInfo.parentCount === 0) {
        return;
      }

      if (allFiles.length > 0 || conflicts.length > 0) {
        const confirmed = await dialog.confirm(t("git.undoCommitConfirmTitle"), t("git.undoCommitConfirmMessage"), {
          confirmText: t("git.undoCommit"),
          confirmVariant: "danger",
        });

        if (!confirmed) {
          return;
        }
      }

      const ok = await undoLastCommit();
      if (!ok) {
        await dialog.alert(t("git.undoCommitFailed"), error || undefined);
        return;
      }

      setActiveTab("changes");
    },
    [allFiles.length, commits, conflicts.length, dialog, error, isLoading, setActiveTab, t, undoLastCommit]
  );

  const handleCreateTag = useCallback(
    async (commitInfo: GitCommit) => {
      const name = await dialog.prompt(t("git.createTag"), { placeholder: t("git.newTag") });
      const tagName = name?.trim();
      if (!tagName) {
        return;
      }
      const ok = await createTag(tagName, commitInfo.hash);
      if (!ok) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [createTag, dialog, groupId, t]
  );

  const handleDeleteTag = useCallback(
    async (tag: string) => {
      const ok = await deleteTag(tag);
      if (!ok) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [deleteTag, dialog, groupId, t]
  );

  const handleRenameBranch = useCallback(
    async (branch: string) => {
      const value = await dialog.prompt(t("git.renameBranch"), {
        defaultValue: branch,
        confirmText: t("common.rename"),
      });
      const newBranch = value?.trim();
      if (!newBranch || newBranch === branch) return;
      if (!(await renameBranch(branch, newBranch))) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [dialog, groupId, renameBranch, t]
  );

  const handleDeleteBranch = useCallback(
    async (branch: string) => {
      const confirmed = await dialog.confirm(
        t("git.deleteBranch"),
        t("git.deleteBranchConfirm").replace("{branch}", branch),
        { confirmText: t("common.delete"), confirmVariant: "danger" }
      );
      if (!confirmed) return;
      if (await deleteBranch(branch)) {
        return;
      }
      const deleteError = getOrCreateGitStore(groupId).getState().error || "";
      if (/not fully merged|not merged|unmerged/i.test(deleteError)) {
        const forceConfirmed = await dialog.confirm(
          t("git.forceDeleteBranch"),
          t("git.forceDeleteBranchConfirm").replace("{branch}", branch),
          { confirmText: t("git.forceDelete"), confirmVariant: "danger" }
        );
        if (forceConfirmed && !(await deleteBranch(branch, true))) {
          await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
        }
        return;
      }
      await dialog.alert(t("git.operationFailed"), deleteError || undefined);
    },
    [deleteBranch, dialog, groupId, t]
  );

  const handleCheckoutRemoteBranch = useCallback(
    async (remote: string, branch: string) => {
      if (!(await checkoutRemoteBranch(remote, branch))) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [checkoutRemoteBranch, dialog, groupId, t]
  );

  const handleSwitchBranch = useCallback(
    async (branch: string) => {
      if (!(await smartSwitchBranch(branch))) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [dialog, groupId, smartSwitchBranch, t]
  );

  const handleDeleteRemoteBranch = useCallback(
    async (remote: string, branch: string) => {
      const displayName = `${remote}/${branch}`;
      const confirmed = await dialog.confirm(
        t("git.deleteRemoteBranch"),
        t("git.deleteRemoteBranchConfirm").replace("{branch}", displayName),
        { confirmText: t("common.delete"), confirmVariant: "danger" }
      );
      if (!confirmed) return;
      if (!(await deleteRemoteBranch(remote, branch))) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [deleteRemoteBranch, dialog, groupId, t]
  );

  const handlePruneRemote = useCallback(async () => {
    const remotes = remoteNames;
    let remote = remotes.includes("origin") ? "origin" : remotes[0] || "origin";
    if (remotes.length > 1) {
      const selected = await dialog.prompt(t("git.pruneRemote"), { defaultValue: remote });
      if (!selected?.trim()) return;
      remote = selected.trim();
    }
    const confirmed = await dialog.confirm(
      t("git.pruneRemote"),
      t("git.pruneRemoteConfirm").replace("{remote}", remote),
      { confirmText: t("git.prune") }
    );
    if (!confirmed) return;
    if (!(await pruneRemote(remote))) {
      await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
    }
  }, [dialog, groupId, pruneRemote, remoteNames, t]);

  const handleConflictClick = useCallback(
    (conflictPath: string) => {
      onConflict?.(path, conflictPath);
    },
    [path, onConflict]
  );

  if (isRepo === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-ide-bg">
        <Loader2 size={24} className="text-ide-mute animate-spin" />
      </div>
    );
  }

  if (isRepo === false) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-full bg-ide-bg gap-4 px-4">
          <FolderGit2 size={48} className="text-ide-mute/40" />
          <div className="flex flex-col items-center gap-1.5 text-center">
            <span className="text-ide-text text-sm font-medium">{t("git.notARepo")}</span>
            <span className="text-ide-mute text-xs max-w-[280px]">{t("git.notARepoHint")}</span>
          </div>
          <div className="flex w-full max-w-sm flex-col items-stretch justify-center gap-2 sm:w-auto sm:max-w-none sm:flex-row sm:flex-wrap sm:items-center">
            <button
              type="button"
              onClick={handleInitRepo}
              disabled={isLoading}
              className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-ide-accent px-3 py-2 text-sm font-medium text-ide-bg transition-colors hover:bg-ide-accent/80 disabled:opacity-50"
            >
              <GitGraph size={16} />
              {t("git.initRepo")}
            </button>
            <button
              type="button"
              onClick={() => setRepositoryDialogMode("create")}
              disabled={isLoading}
              className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-ide-border bg-ide-panel px-3 py-2 text-sm text-ide-text transition-colors hover:bg-ide-bg disabled:opacity-50"
            >
              <FolderPlus size={16} />
              {t("git.createRepositoryAction")}
            </button>
            <button
              type="button"
              onClick={() => setRepositoryDialogMode("clone")}
              disabled={isLoading}
              className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-ide-border bg-ide-panel px-3 py-2 text-sm text-ide-text transition-colors hover:bg-ide-bg disabled:opacity-50"
            >
              <Download size={16} />
              {t("git.cloneRepositoryAction")}
            </button>
          </div>
        </div>
        {repositoryDialogMode && (
          <GitRepositoryDialog
            open
            mode={repositoryDialogMode}
            locale={locale}
            initialPath={path}
            onClose={() => setRepositoryDialogMode(null)}
            onOpenRepository={handleOpenCreatedRepository}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full bg-ide-bg">
        <div
          className={`h-11 items-center gap-2 border-b border-ide-border bg-ide-panel px-3 ${isMobile ? "flex" : "hidden"}`}
        >
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-xs text-ide-text transition-colors hover:bg-ide-accent/10 active:bg-ide-accent/15"
            onClick={() => setShowBranchSelector(true)}
            disabled={branches.length === 0}
            aria-haspopup="dialog"
            aria-expanded={showBranchSelector}
            aria-label={`${t("git.branches")}: ${currentBranch || t("git.branches")}`}
          >
            <GitBranch size={14} className="text-ide-accent shrink-0" />
            <span className="truncate">{currentBranch || "branch"}</span>
            {(aheadCount > 0 || behindCount > 0) && (
              <span className="flex items-center gap-1 shrink-0">
                {aheadCount > 0 && (
                  <span className="text-[10px] text-blue-400">
                    {aheadCount}
                    <ArrowUp size={8} className="inline" />
                  </span>
                )}
                {behindCount > 0 && (
                  <span className="text-[10px] text-orange-400">
                    {behindCount}
                    <ArrowDown size={8} className="inline" />
                  </span>
                )}
              </span>
            )}
          </button>
          {(hasRemote || aheadCount > 0 || (!tagsToPushError && tagsToPush.length > 0)) && (
            <button
              type="button"
              className="flex min-h-11 max-w-[48%] shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-ide-accent transition-colors hover:bg-ide-accent/10 active:bg-ide-accent/15 disabled:opacity-50"
              onClick={() => {
                void smartAction.action();
              }}
              disabled={isLoading}
              title={smartAction.label}
            >
              {smartAction.icon}
              <span className="truncate">{smartAction.label}</span>
            </button>
          )}
        </div>

        {isMobile && error && !operationInProgress && (
          <div
            className="flex min-h-10 items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-2"
            role="alert"
            aria-live="assertive"
          >
            <AlertCircle size={14} className="shrink-0 text-red-400" />
            <span className="min-w-0 flex-1 truncate text-xs text-red-400" title={error}>
              {error}
            </span>
          </div>
        )}

        {isMobile && operationInProgress && operation && (
          <div
            className="flex min-h-12 flex-wrap items-center gap-2 border-b border-orange-500/30 bg-orange-500/10 px-2 py-1.5"
            role="status"
            aria-live="polite"
          >
            <AlertCircle size={14} className="shrink-0 text-orange-400" />
            <span className="min-w-0 flex-1 truncate text-xs text-orange-300">
              {operationLabel}
              {operation.progress ? ` ${operation.progress.position}/${operation.progress.total}` : ""}
              {operation.progress?.currentCommitSummary ? ` · ${operation.progress.currentCommitSummary}` : ""}
            </span>
            {operationCanSkip && (
              <button
                type="button"
                className="flex min-h-11 items-center gap-1 rounded-sm px-2 text-[11px] text-ide-text hover:bg-ide-panel disabled:opacity-50"
                onClick={() => void handleOperationAction("skip")}
                disabled={isLoading}
              >
                <SkipForward size={13} />
                {t("git.skip")}
              </button>
            )}
            <button
              type="button"
              className="flex min-h-11 items-center gap-1 rounded-sm px-2 text-[11px] text-ide-text hover:bg-ide-panel disabled:opacity-50"
              onClick={() => void handleOperationAction("continue")}
              disabled={isLoading}
            >
              <ListRestart size={13} />
              {t("git.continue")}
            </button>
            <button
              type="button"
              className="flex min-h-11 items-center gap-1 rounded-sm px-2 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              onClick={() => void handleOperationAction("abort")}
              disabled={isLoading}
            >
              <RotateCcw size={13} />
              {t("git.abort")}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {!isMobile ? (
            <DesktopGitWorkspace
              groupId={groupId}
              path={path}
              locale={locale}
              allFiles={allFiles}
              commits={commits}
              isLoading={isLoading}
              selectedCommit={selectedCommit}
              selectedCommitFiles={selectedCommitFiles}
              currentBranch={currentBranch}
              branches={branches}
              activeTab={activeTab}
              hasRemote={hasRemote}
              remoteUrls={remoteUrls}
              aheadCount={aheadCount}
              behindCount={behindCount}
              tagsToPush={tagsToPush}
              tagsToPushError={tagsToPushError}
              stashes={stashes}
              selectedStashIndex={selectedStashIndex}
              selectedStashFile={selectedStashFile}
              stashFiles={stashFiles}
              stashDiff={stashDiff}
              stashLoading={stashLoading}
              conflicts={conflicts}
              operation={operation}
              error={error}
              onActiveTabChange={setActiveTab}
              onBranchOpen={() => setShowBranchSelector(true)}
              onRefresh={handleRefresh}
              repositorySettingsOpen={repositorySettingsOpen}
              githubPanelOpen={githubPanelOpen}
              onRepositorySettingsOpenChange={setRepositorySettingsOpen}
              onGithubPanelOpenChange={setGithubPanelOpen}
              onOpenWorktree={(worktreePath) => void openFolder(worktreePath)}
              onFetch={() => void handleFetch()}
              onPull={() => void handlePull()}
              onPush={(force) => void handlePush(force)}
              onToggleFile={toggleFile}
              onToggleAll={toggleAllFiles}
              onDiscardFile={handleDesktopDiscardFile}
              onConflictClick={handleConflictClick}
              onStash={(message, files) => void stash(message, files)}
              onStashPop={(index, oid) => void handleStashPop(index, oid)}
              onStashDrop={(index, oid) => void handleStashDrop(index, oid)}
              onStashSelect={(index) => void selectStash(index)}
              onStashFileSelect={(filePath) => void selectStashFile(filePath)}
              onUndoLastCommit={undoLastCommit}
              onCommitSelect={handleCommitSelect}
              selectedCommitHashes={selectedHistoryHashes}
              onSelectedCommitHashesChange={setSelectedHistoryHashes}
              onHistoryFileClick={(commitInfo, filePath) => getCommitDiff(commitInfo.hash, filePath)}
              onUndoCommit={handleHistoryUndoCommit}
              onCreateTag={handleCreateTag}
              onDeleteTag={handleDeleteTag}
              getDiff={getDiff}
              onLoadMore={fetchMoreLog}
              onMerge={handleMerge}
              onRebase={handleRebase}
              onCherryPick={handleCherryPick}
              onRevert={handleRevert}
              onResetToCommit={handleResetToCommit}
              onCherryPickCommits={handleHistoryCherryPick}
              onRevertCommit={handleHistoryRevert}
              onResetCommit={handleHistoryReset}
              onSquashCommits={handleHistorySquash}
              onReorderCommits={handleHistoryReorder}
              onOperationAction={handleOperationAction}
              onSquash={handleSquash}
              onReorder={handleReorder}
            />
          ) : activeTab === "changes" ? (
            <GitChangesView
              groupId={groupId}
              path={path}
              allFiles={allFiles}
              isLoading={isLoading}
              locale={locale}
              currentBranch={currentBranch}
              stashes={stashes}
              selectedStashIndex={selectedStashIndex}
              selectedStashFile={selectedStashFile}
              stashFiles={stashFiles}
              stashDiff={stashDiff}
              stashLoading={stashLoading}
              conflicts={conflicts}
              hasRemote={hasRemote}
              aheadCount={aheadCount}
              behindCount={behindCount}
              onFileClick={handleFileClick}
              onToggleFile={toggleFile}
              onToggleAll={toggleAllFiles}
              onDiscardFile={discardFile}
              onConflictClick={handleConflictClick}
              onStash={stash}
              onStashPop={handleStashPop}
              onStashDrop={handleStashDrop}
              onStashSelect={selectStash}
              onStashFileSelect={selectStashFile}
              onPull={handlePull}
              onPush={handlePush}
              onFetch={handleFetch}
              onUndoLastCommit={undoLastCommit}
            />
          ) : (
            <GitHistoryView
              commits={commits}
              isLoading={isLoading}
              locale={locale}
              remoteUrls={remoteUrls}
              aheadCount={aheadCount}
              tagsToPush={tagsToPush}
              tagsToPushError={tagsToPushError}
              onCommitSelect={handleCommitSelect}
              onUndoCommit={handleHistoryUndoCommit}
              onCreateTag={handleCreateTag}
              onDeleteTag={handleDeleteTag}
              onFileClick={handleHistoryFileClick}
              selectedCommitFiles={selectedCommitFiles}
              selectedCommitHash={selectedCommit?.hash || null}
              onLoadMore={fetchMoreLog}
              selectedCommitHashes={selectedHistoryHashes}
              onSelectedCommitHashesChange={setSelectedHistoryHashes}
              onCherryPick={handleHistoryCherryPick}
              onRevert={handleHistoryRevert}
              onResetToCommit={handleHistoryReset}
              onSquash={handleHistorySquash}
            />
          )}
        </div>
      </div>
      <BranchSelector
        isOpen={showBranchSelector}
        isLoading={isLoading}
        branches={branches}
        remoteBranches={remoteBranches}
        recentBranches={recentBranches}
        remoteNames={remoteNames}
        currentBranch={currentBranch}
        aheadCount={aheadCount}
        behindCount={behindCount}
        locale={locale}
        onClose={() => setShowBranchSelector(false)}
        onSwitch={handleSwitchBranch}
        onSwitchRemote={handleCheckoutRemoteBranch}
        onCreate={createBranch}
        onDelete={handleDeleteBranch}
        onRename={handleRenameBranch}
        onDeleteRemote={handleDeleteRemoteBranch}
        onPrune={handlePruneRemote}
        anchorRef={isMobile ? undefined : branchTriggerRef}
      />
      {isMobile && (
        <GitMobileActions
          open={mobileActionsOpen}
          onOpenChange={setMobileActionsOpen}
          locale={locale}
          isLoading={isLoading}
          operation={operation}
          selectedCommit={selectedCommit}
          currentBranch={currentBranch}
          aheadCount={aheadCount}
          repositorySettingsOpen={repositorySettingsOpen}
          githubPanelOpen={githubPanelOpen}
          returnFocusRef={mobileActionsTriggerRef}
          onOpenRepositorySettings={() => {
            setMobileActionsOpen(false);
            setGithubPanelOpen(false);
            setRepositorySettingsOpen(true);
          }}
          onOpenGithub={() => {
            setMobileActionsOpen(false);
            setRepositorySettingsOpen(false);
            setGithubPanelOpen(true);
          }}
          onMerge={handleMerge}
          onRebase={handleRebase}
          onCherryPick={handleCherryPick}
          onRevert={handleRevert}
          onResetToCommit={handleResetToCommit}
          onPush={handlePush}
          onOperationAction={handleOperationAction}
          onOperationStarted={() => setMobileActionsOpen(false)}
        />
      )}
      {isMobile && repositorySettingsOpen && (
        <GitRepositorySettings
          path={path}
          locale={locale}
          returnFocusRef={mobileActionsTriggerRef}
          onClose={() => setRepositorySettingsOpen(false)}
          onChanged={handleRefresh}
          onOpenWorktree={(worktreePath) => void openFolder(worktreePath)}
        />
      )}
      {isMobile && githubPanelOpen && (
        <GithubPanel
          path={path}
          locale={locale}
          returnFocusRef={mobileActionsTriggerRef}
          remoteUrls={remoteUrls}
          currentBranch={currentBranch}
          headHash={commits[0]?.hash}
          onClose={() => setGithubPanelOpen(false)}
          onChanged={handleRefresh}
        />
      )}
    </>
  );
};

export default GitView;
