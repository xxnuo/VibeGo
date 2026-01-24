import React, { useState, useEffect, useCallback } from "react";
import { GitBranch, RotateCw, History, FileText } from "lucide-react";
import GitChangesView from "./GitChangesView";
import GitHistoryView from "./GitHistoryView";
import {
  useGitStore,
  useFrameStore,
  type GitFileNode,
  type Locale,
} from "@/stores";
import type { GitCommit } from "@/api/git";

interface GitViewProps {
  path: string;
  locale: Locale;
  onFileDiff: (original: string, modified: string, title: string) => void;
}

type TabType = "changes" | "history";

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

const GitView: React.FC<GitViewProps> = ({ path, locale, onFileDiff }) => {
  const t = i18n[locale] || i18n.en;
  const [activeTab, setActiveTab] = useState<TabType>("changes");
  const setTopBarConfig = useFrameStore((s) => s.setTopBarConfig);

  const {
    currentBranch,
    stagedFiles,
    unstagedFiles,
    commits,
    commitMessage,
    isLoading,
    selectedCommitFiles,
    selectedCommit,
    setCurrentPath,
    setCommitMessage,
    fetchStatus,
    fetchLog,
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
    setCurrentPath(path);
    fetchStatus();
    fetchLog();
  }, [path, setCurrentPath, fetchStatus, fetchLog]);

  const handleRefresh = useCallback(() => {
    fetchStatus();
    if (activeTab === "history") {
      fetchLog();
    }
  }, [fetchStatus, fetchLog, activeTab]);

  useEffect(() => {
    setTopBarConfig({
      show: true,
      leftButtons: [
        {
          icon: <GitBranch size={16} />,
          label: currentBranch,
          disabled: true,
        },
      ],
      centerContent: (
        <div className="flex bg-ide-panel/50 rounded-md p-0.5 border border-ide-border">
          <button
            onClick={() => setActiveTab("changes")}
            className={`px-3 py-0.5 text-xs font-medium rounded-sm transition-colors ${
              activeTab === "changes"
                ? "bg-ide-accent text-ide-bg shadow-sm"
                : "text-ide-mute hover:text-ide-text"
            }`}
          >
            {t.changes}
            {stagedFiles.length + unstagedFiles.length > 0 &&
              ` (${stagedFiles.length + unstagedFiles.length})`}
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`px-3 py-0.5 text-xs font-medium rounded-sm transition-colors ${
              activeTab === "history"
                ? "bg-ide-accent text-ide-bg shadow-sm"
                : "text-ide-mute hover:text-ide-text"
            }`}
          >
            {t.history}
          </button>
        </div>
      ),
      rightButtons: [
        {
          icon: (
            <RotateCw size={16} className={isLoading ? "animate-spin" : ""} />
          ),
          label: t.refresh,
          onClick: handleRefresh,
          disabled: isLoading,
        },
      ],
    });

    return () => {
      setTopBarConfig({ show: false });
    };
  }, [
    setTopBarConfig,
    currentBranch,
    activeTab,
    stagedFiles.length,
    unstagedFiles.length,
    isLoading,
    t,
    handleRefresh,
  ]);

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
