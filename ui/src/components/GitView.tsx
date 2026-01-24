import React, { useEffect, useCallback, useMemo } from "react";
import GitChangesView from "./GitChangesView";
import GitHistoryView from "./GitHistoryView";
import { useGitStore, type GitFileNode, type Locale } from "@/stores";
import type { GitCommit } from "@/api/git";
import { usePageTopBar } from "@/hooks/usePageTopBar";
import { GitBranch, RefreshCw, FileText, History } from "lucide-react";

interface GitViewProps {
  path: string;
  locale: Locale;
  onFileDiff: (original: string, modified: string, title: string) => void;
  isActive?: boolean;
}

const i18n = {
  en: {
    changes: "Changes",
    history: "History",
    refresh: "Refresh",
  },
  zh: {
    changes: "更改",
    history: "历史",
    refresh: "刷新",
  },
};

const GitView: React.FC<GitViewProps> = ({
  path,
  locale,
  onFileDiff,
  isActive = true,
}) => {
  const t = i18n[locale] || i18n.en;

  const {
    stagedFiles,
    unstagedFiles,
    commits,
    commitMessage,
    isLoading,
    selectedCommitFiles,
    selectedCommit,
    currentBranch,
    branches,
    activeTab,
    setCurrentPath,
    setCommitMessage,
    setActiveTab,
    reset,
    fetchStatus,
    fetchLog,
    fetchBranches,
    switchBranch,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardFile,
    commit,
    getDiff,
    setSelectedCommit,
    setSelectedCommitFiles,
  } = useGitStore();

  useEffect(() => {
    reset();
    setCurrentPath(path);
    fetchStatus();
    fetchLog();
    fetchBranches();
  }, [path, setCurrentPath, reset, fetchStatus, fetchLog, fetchBranches]);

  const handleRefresh = useCallback(() => {
    fetchStatus();
    if (activeTab === "history") {
      fetchLog();
    }
  }, [fetchStatus, fetchLog, activeTab]);

  const handleBranchClick = useCallback(() => {
    if (branches.length === 0) return;

    const branchList = branches
      .map((b, i) => `${i + 1}. ${b}${b === currentBranch ? " (current)" : ""}`)
      .join("\n");
    const input = prompt(
      `Select branch:\n${branchList}\n\nEnter branch name:`,
      currentBranch,
    );

    if (input && input !== currentBranch && branches.includes(input)) {
      switchBranch(input);
    }
  }, [branches, currentBranch, switchBranch]);

  const topBarConfig = useMemo(() => {
    if (!isActive) return null;

    return {
      show: true,
      leftButtons: [
        {
          icon: <GitBranch size={18} />,
          onClick: handleBranchClick,
          disabled: branches.length === 0,
        },
      ],
      centerContent: (
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar touch-pan-x h-full">
          <div
            onClick={() => setActiveTab("changes")}
            className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
              activeTab === "changes"
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <FileText size={12} />
            <span className="font-medium">
              {t.changes}
              {stagedFiles.length + unstagedFiles.length > 0 &&
                ` (${stagedFiles.length + unstagedFiles.length})`}
            </span>
          </div>
          <div
            onClick={() => setActiveTab("history")}
            className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
              activeTab === "history"
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <History size={12} />
            <span className="font-medium">{t.history}</span>
          </div>
        </div>
      ),
      rightButtons: [
        {
          icon: (
            <RefreshCw size={18} className={isLoading ? "animate-spin" : ""} />
          ),
          onClick: handleRefresh,
          disabled: isLoading,
        },
      ],
    };
  }, [
    isActive,
    branches,
    currentBranch,
    activeTab,
    stagedFiles.length,
    unstagedFiles.length,
    isLoading,
    t,
    setActiveTab,
    handleRefresh,
    handleBranchClick,
  ]);

  usePageTopBar(topBarConfig, [topBarConfig]);

  const handleFileClick = useCallback(
    async (file: GitFileNode) => {
      const diff = await getDiff(file.path);
      if (diff) {
        onFileDiff(diff.old, diff.new, `${file.name} [DIFF]`);
      }
    },
    [getDiff, onFileDiff],
  );

  const handleCommitSelect = useCallback(
    async (commitInfo: GitCommit) => {
      setSelectedCommit(commitInfo);
      setSelectedCommitFiles([]);
    },
    [setSelectedCommit, setSelectedCommitFiles],
  );

  const handleHistoryFileClick = useCallback(
    async (_commit: GitCommit, _filePath: string) => {},
    [],
  );

  const handleCommit = useCallback(async () => {
    await commit();
  }, [commit]);

  return (
    <div className="flex flex-col h-full bg-ide-bg">
      <div className="flex-1 overflow-hidden">
        {activeTab === "changes" ? (
          <GitChangesView
            stagedFiles={stagedFiles}
            unstagedFiles={unstagedFiles}
            commitMessage={commitMessage}
            isLoading={isLoading}
            locale={locale}
            onFileClick={handleFileClick}
            onStageFile={stageFile}
            onUnstageFile={unstageFile}
            onDiscardFile={discardFile}
            onStageAll={stageAll}
            onUnstageAll={unstageAll}
            onCommitMessageChange={setCommitMessage}
            onCommit={handleCommit}
          />
        ) : (
          <GitHistoryView
            commits={commits}
            isLoading={isLoading}
            locale={locale}
            onCommitSelect={handleCommitSelect}
            onFileClick={handleHistoryFileClick}
            selectedCommitFiles={selectedCommitFiles.map((f) => ({
              path: f.path,
              status: f.status,
            }))}
            selectedCommitHash={selectedCommit?.hash || null}
          />
        )}
      </div>
    </div>
  );
};

export default GitView;
