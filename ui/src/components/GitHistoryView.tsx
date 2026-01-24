import React, { useState, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitCommit as GitCommitIcon,
  Clock,
  User,
} from "lucide-react";
import type { Locale } from "@/stores";
import type { GitCommit } from "@/api/git";

interface GitHistoryViewProps {
  commits: GitCommit[];
  isLoading: boolean;
  locale: Locale;
  onCommitSelect: (commit: GitCommit) => void;
  onFileClick: (commit: GitCommit, filePath: string) => void;
  selectedCommitFiles: { path: string; status: string }[];
  selectedCommitHash: string | null;
}

const i18n = {
  en: {
    noCommits: "No commits yet",
    changedFiles: "Changed files",
    loading: "Loading...",
  },
  zh: {
    noCommits: "暂无提交记录",
    changedFiles: "变更文件",
    loading: "加载中...",
  },
};

const formatRelativeTime = (dateStr: string, locale: Locale): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (locale === "zh") {
    if (days > 30) return date.toLocaleDateString("zh-CN");
    if (days > 0) return `${days} 天前`;
    if (hours > 0) return `${hours} 小时前`;
    if (minutes > 0) return `${minutes} 分钟前`;
    return "刚刚";
  } else {
    if (days > 30) return date.toLocaleDateString("en-US");
    if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    return "just now";
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case "M":
    case "modified":
      return "text-yellow-500";
    case "A":
    case "added":
      return "text-green-500";
    case "D":
    case "deleted":
      return "text-red-500";
    default:
      return "text-ide-mute";
  }
};

interface CommitItemProps {
  commit: GitCommit;
  isExpanded: boolean;
  isSelected: boolean;
  locale: Locale;
  onToggle: () => void;
  onFileClick: (filePath: string) => void;
  files: { path: string; status: string }[];
}

const CommitItem: React.FC<CommitItemProps> = ({
  commit,
  isExpanded,
  isSelected,
  locale,
  onToggle,
  onFileClick,
  files,
}) => {
  const shortHash = commit.hash.substring(0, 7);

  return (
    <div
      className={`border-b border-ide-border/50 ${isSelected ? "bg-ide-accent/5" : ""}`}
    >
      <div
        className="flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-ide-accent/10"
        onClick={onToggle}
      >
        <div className="pt-0.5">
          {isExpanded ? (
            <ChevronDown size={14} className="text-ide-mute" />
          ) : (
            <ChevronRight size={14} className="text-ide-mute" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ide-text font-medium line-clamp-2">
            {commit.message}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-ide-mute">
            <span className="flex items-center gap-1">
              <User size={10} />
              {commit.author}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatRelativeTime(commit.date, locale)}
            </span>
            <span className="flex items-center gap-1 font-mono">
              <GitCommitIcon size={10} />
              {shortHash}
            </span>
          </div>
        </div>
      </div>

      {isExpanded && files.length > 0 && (
        <div className="bg-ide-panel/30 border-t border-ide-border/50">
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center gap-2 px-6 py-1.5 hover:bg-ide-accent/10 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onFileClick(file.path);
              }}
            >
              <span
                className={`w-4 text-center font-bold text-xs ${getStatusColor(file.status)}`}
              >
                {file.status[0].toUpperCase()}
              </span>
              <span className="text-xs text-ide-text truncate">
                {file.path}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const GitHistoryView: React.FC<GitHistoryViewProps> = ({
  commits,
  isLoading,
  locale,
  onCommitSelect,
  onFileClick,
  selectedCommitFiles,
  selectedCommitHash,
}) => {
  const t = i18n[locale] || i18n.en;
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  const handleToggle = useCallback(
    (commit: GitCommit) => {
      if (expandedHash === commit.hash) {
        setExpandedHash(null);
      } else {
        setExpandedHash(commit.hash);
        onCommitSelect(commit);
      }
    },
    [expandedHash, onCommitSelect],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-ide-mute text-sm">
        {t.loading}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-ide-mute text-sm">
        {t.noCommits}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-ide-bg">
      {commits.map((commit) => (
        <CommitItem
          key={commit.hash}
          commit={commit}
          isExpanded={expandedHash === commit.hash}
          isSelected={selectedCommitHash === commit.hash}
          locale={locale}
          onToggle={() => handleToggle(commit)}
          onFileClick={(path) => onFileClick(commit, path)}
          files={expandedHash === commit.hash ? selectedCommitFiles : []}
        />
      ))}
    </div>
  );
};

export default GitHistoryView;
