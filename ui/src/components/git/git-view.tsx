import {
  ArrowDown,
  ArrowUp,
  CloudUpload,
  FileText,
  FolderGit2,
  GitBranch,
  GitGraph,
  History,
  Loader2,
  RefreshCw,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  BranchStatusInfo,
  GitBranchesSnapshot,
  GitCommit,
  GitDraft,
  GitWSSnapshot,
  RemoteInfo,
  StashEntry,
} from "@/api/git";
import { gitApi } from "@/api/git";
import { useDialog } from "@/components/common";
import BranchSelector from "@/components/git/branch-selector";
import GitChangesView from "@/components/git/git-changes-view";
import GitHistoryView from "@/components/git/git-history-view";
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
}

interface GitViewProps {
  groupId: string;
  path: string;
  locale: Locale;
  onFileDiff: (payload: GitDiffRequest) => void;
  onConflict?: (repoPath: string, filePath: string) => void;
  isActive?: boolean;
}

const GitView: React.FC<GitViewProps> = ({ groupId, path, locale, onFileDiff, onConflict, isActive = true }) => {
  const t = (key: string) => getTranslation(locale, key);
  const dialog = useDialog();
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
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
    activeTab,
    hasRemote,
    remoteUrls,
    aheadCount,
    behindCount,
    tagsToPush,
    tagsToPushError,
    stashes,
    conflicts,
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
    gitPull,
    gitPush,
    gitFetch,
    stash,
    stashPop,
    stashDrop,
    createBranch,
    deleteBranch,
    createTag,
    deleteTag,
    setSelectedCommit,
    getCommitFiles,
    getCommitDiff,
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
      activeTab: state.activeTab,
      hasRemote: state.hasRemote,
      remoteUrls: state.remoteUrls,
      aheadCount: state.aheadCount,
      behindCount: state.behindCount,
      tagsToPush: state.tagsToPush,
      tagsToPushError: state.tagsToPushError,
      stashes: state.stashes,
      conflicts: state.conflicts,
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
      gitPull: state.gitPull,
      gitPush: state.gitPush,
      gitFetch: state.gitFetch,
      stash: state.stash,
      stashPop: state.stashPop,
      stashDrop: state.stashDrop,
      createBranch: state.createBranch,
      deleteBranch: state.deleteBranch,
      createTag: state.createTag,
      deleteTag: state.deleteTag,
      setSelectedCommit: state.setSelectedCommit,
      getCommitFiles: state.getCommitFiles,
      getCommitDiff: state.getCommitDiff,
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
    }))
  );

  const wsCleanupRef = useRef<(() => void) | null>(null);
  const historySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyDirtyRef = useRef(true);

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
    scheduleHistoryRefresh,
  ]);

  useEffect(() => {
    if (activeTab === "history" && isActive && isRepo === true && (commits.length === 0 || historyDirtyRef.current)) {
      scheduleHistoryRefresh(0);
    }
  }, [activeTab, commits.length, isActive, isRepo, scheduleHistoryRefresh]);

  const handleRefresh = useCallback(() => {
    void syncRepo();
  }, [syncRepo]);

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

  const handlePush = useCallback(
    async (force?: boolean) => {
      const ok = await gitPush(force);
      if (!ok) {
        await dialog.alert(t("git.operationFailed"), getOrCreateGitStore(groupId).getState().error || undefined);
      }
    },
    [dialog, gitPush, groupId, t]
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

  const topBarConfig = useMemo(() => {
    if (!isActive) return null;
    if (isRepo !== true) {
      return {
        show: true,
        leftButtons: [{ icon: <GitGraph size={18} />, active: true }],
        centerContent: null,
        rightButtons: [],
      };
    }
    return {
      show: true,
      leftButtons: [{ icon: <GitGraph size={18} />, active: true }],
      centerContent: (
        <div className="flex items-center gap-1 h-full">
          <div
            onClick={() => setActiveTab("changes")}
            className={`shrink-0 px-2.5 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
              activeTab === "changes"
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <FileText size={12} />
            <span className="font-medium">
              {t("git.changes")}
              {allFiles.length > 0 && ` (${allFiles.length})`}
            </span>
          </div>
          <div
            onClick={() => setActiveTab("history")}
            className={`shrink-0 px-2.5 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
              activeTab === "history"
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <History size={12} />
            <span className="font-medium">{t("git.history")}</span>
          </div>
        </div>
      ),
      rightButtons: [
        {
          icon: <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />,
          onClick: handleRefresh,
          disabled: isLoading,
        },
      ],
    };
  }, [isActive, isRepo, activeTab, allFiles.length, isLoading, t, setActiveTab, handleRefresh]);

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

  const handleFileClick = useCallback(
    async (filePath: string) => {
      const file = allFiles.find((item) => item.path === filePath);
      const fileName = filePath.split("/").pop() || filePath;
      onFileDiff({
        original: "",
        modified: "",
        title: `${fileName} [DIFF]`,
        filename: fileName,
        filePath,
        repoPath: path,
        allowSelection: file ? ["modified", "added", "untracked"].includes(file.status) : false,
      });
    },
    [allFiles, onFileDiff, path]
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
        });
      }
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
      <div className="flex flex-col items-center justify-center h-full bg-ide-bg gap-4">
        <FolderGit2 size={48} className="text-ide-mute/40" />
        <div className="flex flex-col items-center gap-1.5 text-center">
          <span className="text-ide-text text-sm font-medium">{t("git.notARepo")}</span>
          <span className="text-ide-mute text-xs max-w-[240px]">{t("git.notARepoHint")}</span>
        </div>
        <button
          onClick={handleInitRepo}
          disabled={isLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-ide-accent text-ide-bg hover:bg-ide-accent/80 transition-colors disabled:opacity-50"
        >
          <GitGraph size={16} />
          {t("git.initRepo")}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full bg-ide-bg">
        <div className="h-9 flex items-center gap-2 px-3 bg-ide-panel border-b border-ide-border shrink-0">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-ide-text hover:bg-ide-accent/10 active:bg-ide-accent/15 transition-colors min-w-0"
            onClick={() => setShowBranchSelector(true)}
            disabled={branches.length === 0}
          >
            <GitBranch size={14} className="text-ide-accent shrink-0" />
            <span className="truncate max-w-[120px]">{currentBranch || "branch"}</span>
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
          <div className="flex-1" />
          {(hasRemote || aheadCount > 0 || (!tagsToPushError && tagsToPush.length > 0)) && (
            <button
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-ide-accent hover:bg-ide-accent/10 active:bg-ide-accent/15 transition-colors disabled:opacity-50 shrink-0"
              onClick={() => {
                void smartAction.action();
              }}
              disabled={isLoading}
            >
              {smartAction.icon}
              <span>{smartAction.label}</span>
            </button>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          {activeTab === "changes" ? (
            <GitChangesView
              groupId={groupId}
              allFiles={allFiles}
              isLoading={isLoading}
              locale={locale}
              currentBranch={currentBranch}
              stashes={stashes}
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
              onStashPop={stashPop}
              onStashDrop={stashDrop}
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
            />
          )}
        </div>
      </div>
      <BranchSelector
        isOpen={showBranchSelector}
        branches={branches}
        remoteBranches={remoteBranches}
        currentBranch={currentBranch}
        aheadCount={aheadCount}
        behindCount={behindCount}
        locale={locale}
        onClose={() => setShowBranchSelector(false)}
        onSwitch={smartSwitchBranch}
        onCreate={createBranch}
        onDelete={deleteBranch}
      />
    </>
  );
};

export default GitView;
