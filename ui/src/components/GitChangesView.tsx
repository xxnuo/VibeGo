import React, { useCallback } from "react";
import { Plus, Minus, X, Check, ChevronRight, FileText } from "lucide-react";
import type { GitFileNode, Locale } from "@/stores";

interface GitChangesViewProps {
  stagedFiles: GitFileNode[];
  unstagedFiles: GitFileNode[];
  commitMessage: string;
  isLoading: boolean;
  locale: Locale;
  onFileClick: (file: GitFileNode) => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommitMessageChange: (msg: string) => void;
  onCommit: () => void;
}

const i18n = {
  en: {
    staged: "Staged Changes",
    unstaged: "Changes",
    stageAll: "Stage All",
    unstageAll: "Unstage All",
    noChanges: "No changes",
    commitPlaceholder: "Commit message...",
    commit: "Commit",
    stage: "Stage",
    unstage: "Unstage",
    discard: "Discard",
  },
  zh: {
    staged: "已暂存",
    unstaged: "更改",
    stageAll: "全部暂存",
    unstageAll: "取消全部",
    noChanges: "没有更改",
    commitPlaceholder: "提交信息...",
    commit: "提交",
    stage: "暂存",
    unstage: "取消暂存",
    discard: "放弃",
  },
};

const getStatusColor = (status: string) => {
  switch (status) {
    case "modified":
      return "text-yellow-500";
    case "added":
    case "untracked":
      return "text-green-500";
    case "deleted":
      return "text-red-500";
    case "renamed":
    case "copied":
      return "text-blue-500";
    default:
      return "text-ide-mute";
  }
};

const getStatusLabel = (status: string) => {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    default:
      return "?";
  }
};

interface FileItemProps {
  file: GitFileNode;
  locale: Locale;
  onFileClick: (file: GitFileNode) => void;
  onAction: () => void;
  onSecondaryAction?: () => void;
  actionIcon: React.ReactNode;
  secondaryActionIcon?: React.ReactNode;
}

const FileItem: React.FC<FileItemProps> = ({
  file,
  onFileClick,
  onAction,
  onSecondaryAction,
  actionIcon,
  secondaryActionIcon,
}) => {
  const handleClick = useCallback(() => {
    onFileClick(file);
  }, [file, onFileClick]);

  const handleAction = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onAction();
    },
    [onAction],
  );

  const handleSecondaryAction = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSecondaryAction?.();
    },
    [onSecondaryAction],
  );

  return (
    <div
      className="flex items-center gap-2 px-3 py-1 hover:bg-ide-accent/10 cursor-pointer group transition-colors"
      onClick={handleClick}
    >
      <span
        className={`w-4 text-center font-bold text-[10px] ${getStatusColor(file.status)}`}
      >
        {getStatusLabel(file.status)}
      </span>
      <FileText size={14} className="text-ide-mute shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="text-xs text-ide-text truncate group-hover:text-ide-accent leading-tight">
          {file.name}
        </div>
        <div className="text-[10px] text-ide-mute/70 truncate leading-tight">
          {file.path}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {secondaryActionIcon && onSecondaryAction && (
          <button
            className="p-1 hover:bg-ide-accent/20 rounded text-red-400 hover:text-red-300"
            onClick={handleSecondaryAction}
          >
            {secondaryActionIcon}
          </button>
        )}
        <button
          className="p-1 hover:bg-ide-accent/20 rounded text-ide-accent"
          onClick={handleAction}
        >
          {actionIcon}
        </button>
      </div>
      <ChevronRight size={14} className="text-ide-mute" />
    </div>
  );
};

const GitChangesView: React.FC<GitChangesViewProps> = ({
  stagedFiles,
  unstagedFiles,
  commitMessage,
  isLoading,
  locale,
  onFileClick,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onStageAll,
  onUnstageAll,
  onCommitMessageChange,
  onCommit,
}) => {
  const t = i18n[locale] || i18n.en;
  const hasChanges = stagedFiles.length > 0 || unstagedFiles.length > 0;
  const canCommit = stagedFiles.length > 0 && commitMessage.trim().length > 0;

  return (
    <div className="flex flex-col h-full bg-ide-bg">
      <div className="flex-1 overflow-y-auto">
        {!hasChanges && (
          <div className="flex items-center justify-center h-32 text-ide-mute text-sm">
            {t.noChanges}
          </div>
        )}

        {unstagedFiles.length > 0 && (
          <div className="border-b border-ide-border">
            <div className="flex items-center justify-between px-3 py-2 bg-ide-panel/50">
              <span className="text-xs font-bold text-ide-mute uppercase">
                {t.unstaged}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                  {unstagedFiles.length}
                </span>
                <button
                  className="text-xs text-ide-accent hover:underline"
                  onClick={onStageAll}
                >
                  {t.stageAll}
                </button>
              </div>
            </div>
            <div className="divide-y divide-ide-border/50">
              {unstagedFiles.map((file) => (
                <FileItem
                  key={file.id}
                  file={file}
                  locale={locale}
                  onFileClick={onFileClick}
                  onAction={() => onStageFile(file.path)}
                  onSecondaryAction={
                    file.status !== "untracked"
                      ? () => onDiscardFile(file.path)
                      : undefined
                  }
                  actionIcon={<Plus size={14} />}
                  secondaryActionIcon={
                    file.status !== "untracked" ? <X size={14} /> : undefined
                  }
                />
              ))}
            </div>
          </div>
        )}

        {stagedFiles.length > 0 && (
          <div className="border-b border-ide-border">
            <div className="flex items-center justify-between px-3 py-2 bg-ide-panel/50">
              <span className="text-xs font-bold text-ide-mute uppercase">
                {t.staged}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                  {stagedFiles.length}
                </span>
                <button
                  className="text-xs text-ide-accent hover:underline"
                  onClick={onUnstageAll}
                >
                  {t.unstageAll}
                </button>
              </div>
            </div>
            <div className="divide-y divide-ide-border/50">
              {stagedFiles.map((file) => (
                <FileItem
                  key={file.id}
                  file={file}
                  locale={locale}
                  onFileClick={onFileClick}
                  onAction={() => onUnstageFile(file.path)}
                  actionIcon={<Minus size={14} />}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-ide-border bg-ide-panel/30 p-3 space-y-2">
        <textarea
          placeholder={t.commitPlaceholder}
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          className="w-full bg-ide-bg border border-ide-border rounded px-3 py-2 text-sm text-ide-text focus:outline-none focus:border-ide-accent min-h-[60px] resize-none placeholder-ide-mute/50"
        />
        <button
          disabled={!canCommit || isLoading}
          onClick={onCommit}
          className="w-full bg-ide-accent text-ide-bg font-bold py-2 text-sm flex items-center justify-center gap-2 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-ide-accent/80 transition-colors"
        >
          <Check size={14} />
          {t.commit}
          {stagedFiles.length > 0 && (
            <span className="text-xs opacity-80">({stagedFiles.length})</span>
          )}
        </button>
      </div>
    </div>
  );
};

export default GitChangesView;
