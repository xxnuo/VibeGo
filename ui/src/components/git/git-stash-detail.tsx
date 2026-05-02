import { Archive, ChevronLeft, FileDiff, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import React, { useCallback } from "react";
import type { GitInteractiveDiff, GitStashFile, StashEntry } from "@/api/git";
import DiffView from "@/components/git/diff-view";
import { getTranslation, type Locale } from "@/lib/i18n";

interface GitStashDetailProps {
  groupId: string;
  path: string;
  locale: Locale;
  stash: StashEntry | null;
  files: GitStashFile[];
  selectedFile: string | null;
  diff: GitInteractiveDiff | null;
  loading: boolean;
  disabled?: boolean;
  compact?: boolean;
  onClose: () => void;
  onFileSelect: (filePath: string | null) => void;
  onPop: (index: number, oid?: string) => void;
  onDrop: (index: number, oid?: string) => void;
}

const statusClass: Record<GitStashFile["status"], string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  renamed: "text-blue-400",
  copied: "text-blue-400",
};

const statusLabel: Record<GitStashFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

/** Read-only stash file and diff view shared by desktop and mobile Git views. */
const GitStashDetail: React.FC<GitStashDetailProps> = ({
  groupId,
  path,
  locale,
  stash,
  files,
  selectedFile,
  diff,
  loading,
  disabled = false,
  compact = false,
  onClose,
  onFileSelect,
  onPop,
  onDrop,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);

  if (!stash) return null;

  const detailHeight = compact ? "h-64" : "h-full";
  const selectedName = selectedFile?.split("/").pop() || selectedFile || "";

  return (
    <section
      className={`flex min-h-0 flex-col border-t border-ide-border bg-ide-bg ${compact ? "max-h-[48vh]" : "h-full"}`}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-ide-border bg-ide-panel/50 px-2 py-1">
        {selectedFile ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 p-1 text-[10px] text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            onClick={() => onFileSelect(null)}
            title={t("git.backToStashFiles")}
          >
            <ChevronLeft size={13} />
            <span>{t("git.stashFiles")}</span>
          </button>
        ) : (
          <Archive size={13} className="shrink-0 text-purple-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-ide-text" title={stash.message}>
          {selectedFile ? selectedName : stash.message}
        </span>
        <button
          type="button"
          className="shrink-0 p-1 text-ide-mute hover:bg-ide-panel hover:text-ide-text"
          onClick={onClose}
          title={t("git.closeStash")}
          aria-label={t("git.closeStash")}
        >
          <X size={13} />
        </button>
      </div>

      {!selectedFile ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-end gap-1 border-b border-ide-border px-2 py-1">
            <button
              type="button"
              className="desktop-git-action-button"
              onClick={() => onPop(stash.index, stash.oid)}
              disabled={disabled}
              title={t("git.pop")}
            >
              <RotateCcw size={11} />
              {t("git.pop")}
            </button>
            <button
              type="button"
              className="desktop-git-action-button desktop-git-action-button--danger"
              onClick={() => onDrop(stash.index, stash.oid)}
              disabled={disabled}
              title={t("git.drop")}
            >
              <Trash2 size={11} />
              {t("git.drop")}
            </button>
          </div>
          {loading && files.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-ide-mute">
              <Loader2 size={13} className="animate-spin" />
              {t("git.loading")}
            </div>
          ) : files.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-ide-mute">
              <FileDiff size={14} />
              {t("git.noStashFiles")}
            </div>
          ) : (
            files.map((file) => (
              <button
                type="button"
                key={file.path}
                className="flex min-h-8 w-full items-center gap-2 border-b border-ide-border/60 px-2 py-1.5 text-left hover:bg-ide-accent/10"
                onClick={() => onFileSelect(file.path)}
              >
                <span
                  className={`w-4 shrink-0 text-center font-mono text-[10px] font-semibold ${statusClass[file.status]}`}
                >
                  {statusLabel[file.status]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ide-text">{file.path}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className={`min-h-0 flex-1 ${detailHeight}`}>
          {loading && !diff ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-ide-mute">
              <Loader2 size={13} className="animate-spin" />
              {t("git.loading")}
            </div>
          ) : diff ? (
            <DiffView
              groupId={groupId}
              original={diff.old}
              modified={diff.new}
              filename={selectedName}
              filePath={selectedFile}
              repoPath={path}
              metadata={diff}
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-ide-mute">
              <FileDiff size={14} />
              {t("git.noDiff")}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default GitStashDetail;
