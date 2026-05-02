import { Archive, ChevronLeft, FileDiff, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import React, { useCallback, useEffect, useRef } from "react";
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
  returnFocusRef?: React.RefObject<HTMLElement | null>;
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
  returnFocusRef,
  onClose,
  onFileSelect,
  onPop,
  onDrop,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const stashFilesContainerRef = useRef<HTMLDivElement | null>(null);
  const selectedFileTriggerRef = useRef<HTMLElement | null>(null);
  const selectedFileTriggerPathRef = useRef<string | null>(null);
  const previousSelectedFileRef = useRef<string | null>(selectedFile);

  const restoreFocus = useCallback((target: HTMLElement | null) => {
    if (!target) return;
    window.requestAnimationFrame(() => {
      if (target.isConnected) target.focus();
    });
  }, []);

  const handleClose = useCallback(() => {
    const target = returnFocusRef?.current ?? null;
    onClose();
    restoreFocus(target);
  }, [onClose, restoreFocus, returnFocusRef]);

  const handleFileSelect = useCallback(
    (filePath: string | null, trigger?: HTMLElement) => {
      if (filePath) {
        selectedFileTriggerRef.current = trigger ?? null;
        selectedFileTriggerPathRef.current = filePath;
        onFileSelect(filePath);
        return;
      }
      onFileSelect(null);
    },
    [onFileSelect]
  );

  useEffect(() => {
    const wasSelected = previousSelectedFileRef.current !== null;
    previousSelectedFileRef.current = selectedFile;
    if (!wasSelected || selectedFile !== null) return;

    const target = selectedFileTriggerRef.current;
    const targetPath = selectedFileTriggerPathRef.current;
    if (!target && !targetPath) return;
    // The parent updates selectedFile asynchronously. Wait for that render
    // before restoring focus. The file list is recreated when leaving the
    // diff, so prefer the newly rendered button when the old node is gone.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const currentTarget =
          (target?.isConnected ? target : null) ??
          (targetPath
            ? Array.from(stashFilesContainerRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
                (button) => button.dataset.stashFilePath === targetPath
              )
            : null);
        if (currentTarget) currentTarget.focus();
      });
    });
  }, [selectedFile]);

  if (!stash) return null;

  const detailHeight = compact ? "h-64" : "h-full";
  const selectedName = selectedFile?.split("/").pop() || selectedFile || "";

  return (
    <section
      className={`flex min-h-0 flex-col border-t border-ide-border bg-ide-bg ${
        compact ? "max-h-[48vh] pb-[env(safe-area-inset-bottom)]" : "h-full"
      }`}
    >
      <div
        className={`flex items-center gap-2 border-b border-ide-border bg-ide-panel/50 px-2 py-1 ${
          compact ? "min-h-11" : "min-h-9"
        }`}
      >
        {selectedFile ? (
          <button
            type="button"
            className={`flex shrink-0 items-center gap-1 text-[10px] text-ide-mute hover:bg-ide-panel hover:text-ide-text ${
              compact ? "min-h-11 px-2 py-1" : "p-1"
            }`}
            onClick={() => handleFileSelect(null)}
            title={t("git.backToStashFiles")}
            aria-label={t("git.backToStashFiles")}
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
          className={`shrink-0 text-ide-mute hover:bg-ide-panel hover:text-ide-text ${compact ? "size-11 p-2" : "p-1"}`}
          onClick={handleClose}
          title={t("git.closeStash")}
          aria-label={t("git.closeStash")}
        >
          <X size={13} />
        </button>
      </div>

      {!selectedFile ? (
        <div ref={stashFilesContainerRef} className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={`flex items-center justify-end gap-1 border-b border-ide-border px-2 py-1 ${compact ? "min-h-11" : ""}`}
          >
            <button
              type="button"
              className={
                compact
                  ? "inline-flex min-h-11 items-center justify-center gap-1 rounded-sm px-3 text-[11px] text-ide-mute hover:bg-ide-accent/10 hover:text-ide-text disabled:cursor-not-allowed disabled:opacity-50"
                  : "desktop-git-action-button"
              }
              onClick={() => onPop(stash.index, stash.oid)}
              disabled={disabled}
              title={t("git.pop")}
              aria-label={t("git.pop")}
            >
              <RotateCcw size={11} />
              {t("git.pop")}
            </button>
            <button
              type="button"
              className={
                compact
                  ? "inline-flex min-h-11 items-center justify-center gap-1 rounded-sm px-3 text-[11px] text-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  : "desktop-git-action-button desktop-git-action-button--danger"
              }
              onClick={() => onDrop(stash.index, stash.oid)}
              disabled={disabled}
              title={t("git.drop")}
              aria-label={t("git.drop")}
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
                className={`flex w-full items-center gap-2 border-b border-ide-border/60 px-2 py-1.5 text-left hover:bg-ide-accent/10 ${
                  compact ? "min-h-11" : "min-h-8"
                }`}
                onClick={(event) => handleFileSelect(file.path, event.currentTarget)}
                aria-label={file.path}
                data-stash-file-path={file.path}
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
