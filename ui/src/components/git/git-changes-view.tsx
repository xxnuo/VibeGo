import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  RefreshCw,
  Search,
  Square,
  SquareCheck,
  SquareMinus,
  X,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import type { GitInteractiveDiff, GitStashFile, StashEntry } from "@/api/git";
import GitCommitComposer from "@/components/git/git-commit-composer";
import GitStashDetail from "@/components/git/git-stash-detail";
import { getTranslation, type Locale } from "@/lib/i18n";
import type { GitFileNode } from "@/stores";

type FileSelectionType = "all" | "partial" | "none";

interface GitChangesViewProps {
  groupId: string;
  path: string;
  allFiles: GitFileNode[];
  isLoading: boolean;
  locale: Locale;
  currentBranch: string;
  stashes: StashEntry[];
  selectedStashIndex: number | null;
  selectedStashFile: string | null;
  stashFiles: GitStashFile[];
  stashDiff: GitInteractiveDiff | null;
  stashLoading: boolean;
  conflicts: string[];
  hasRemote: boolean;
  aheadCount: number;
  behindCount: number;
  onFileClick: (path: string) => void;
  onToggleFile: (path: string) => Promise<void>;
  onToggleAll: () => Promise<void>;
  onDiscardFile: (path: string) => void;
  onConflictClick: (path: string) => void;
  onStash: (message?: string, files?: string[]) => void;
  onStashPop: (index: number, oid?: string) => void;
  onStashDrop: (index: number, oid?: string) => void;
  onStashSelect: (index: number | null) => void;
  onStashFileSelect: (filePath: string | null) => void;
  onPull: () => void;
  onPush: (force?: boolean) => void;
  onFetch: () => void;
  onUndoLastCommit: () => Promise<boolean>;
}

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

const getStatusVerb = (status: string): string => {
  switch (status) {
    case "added":
    case "untracked":
      return "Create";
    case "deleted":
      return "Delete";
    case "renamed":
      return "Rename";
    case "copied":
      return "Copy";
    default:
      return "Update";
  }
};

const generateAutoSummary = (allFiles: GitFileNode[]): string => {
  const selected = allFiles.filter((f) => f.includedState !== "none");
  if (selected.length === 0) return "";
  if (selected.length === 1) {
    const file = selected[0];
    return `${getStatusVerb(file.status)} ${file.name}`;
  }
  const statusCounts = new Map<string, number>();
  for (const file of selected) {
    const verb = getStatusVerb(file.status);
    statusCounts.set(verb, (statusCounts.get(verb) || 0) + 1);
  }
  if (statusCounts.size === 1) {
    const [verb, count] = [...statusCounts.entries()][0];
    return `${verb} ${count} files`;
  }
  const parts = [...statusCounts.entries()].map(([verb, count]) => `${verb} ${count}`);
  return parts.join(", ");
};

const getFileSelectionType = (file: GitFileNode): FileSelectionType => file.includedState;

const getAggregateSelectionType = (allFiles: GitFileNode[]): FileSelectionType => {
  if (allFiles.length === 0) {
    return "none";
  }
  const types = allFiles.map((file) => getFileSelectionType(file));
  if (types.every((type) => type === "all")) {
    return "all";
  }
  if (types.every((type) => type === "none")) {
    return "none";
  }
  return "partial";
};

const renderSelectionIcon = (selectionType: FileSelectionType, size: number, className: string) => {
  if (selectionType === "all") {
    return <SquareCheck size={size} className={className} />;
  }
  if (selectionType === "partial") {
    return <SquareMinus size={size} className={className} />;
  }
  return <Square size={size} className={className} />;
};

const getFileRowClassName = (selectionType: FileSelectionType) => {
  if (selectionType === "all") {
    return "bg-ide-accent/8 ring-1 ring-inset ring-ide-accent/20 hover:bg-ide-accent/12";
  }
  if (selectionType === "partial") {
    return "bg-amber-500/7 ring-1 ring-inset ring-amber-400/18 hover:bg-amber-500/10";
  }
  return "hover:bg-ide-accent/10";
};

const getFileNameClassName = (selectionType: FileSelectionType) => {
  if (selectionType === "all") {
    return "text-xs text-ide-text truncate leading-tight";
  }
  if (selectionType === "partial") {
    return "text-xs text-amber-100 truncate leading-tight";
  }
  return "text-xs text-ide-text truncate leading-tight";
};

const getFilePathClassName = (selectionType: FileSelectionType) => {
  if (selectionType === "all") {
    return "text-[10px] text-ide-accent/80 truncate leading-tight";
  }
  if (selectionType === "partial") {
    return "text-[10px] text-amber-300/80 truncate leading-tight";
  }
  return "text-[10px] text-ide-mute/70 truncate leading-tight";
};

const GitChangesView: React.FC<GitChangesViewProps> = ({
  groupId,
  path,
  allFiles,
  isLoading,
  locale,
  currentBranch,
  stashes,
  selectedStashIndex,
  selectedStashFile,
  stashFiles,
  stashDiff,
  stashLoading,
  conflicts,
  hasRemote,
  aheadCount,
  behindCount,
  onFileClick,
  onToggleFile,
  onToggleAll,
  onDiscardFile,
  onConflictClick,
  onStash,
  onStashPop,
  onStashDrop,
  onStashSelect,
  onStashFileSelect,
  onPull,
  onPush,
  onFetch,
  onUndoLastCommit,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);

  const [showStashes, setShowStashes] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");

  const safeStashes = stashes ?? [];
  const safeConflicts = conflicts ?? [];
  const hasChanges = allFiles.length > 0;
  const showFilter = allFiles.length > 5;
  const filteredFiles = useMemo(() => {
    if (!filterText.trim()) return allFiles;
    const lower = filterText.toLowerCase();
    return allFiles.filter((f) => f.path.toLowerCase().includes(lower) || f.name.toLowerCase().includes(lower));
  }, [allFiles, filterText]);
  const checkedCount = useMemo(() => allFiles.filter((file) => file.includedState !== "none").length, [allFiles]);
  const allSelectionType = getAggregateSelectionType(allFiles);
  const autoSummary = useMemo(() => generateAutoSummary(allFiles), [allFiles]);

  const handleDiscardClick = useCallback((path: string) => setDiscardConfirm(path), []);
  const handleConfirmDiscard = useCallback(() => {
    if (discardConfirm) {
      onDiscardFile(discardConfirm);
      setDiscardConfirm(null);
    }
  }, [discardConfirm, onDiscardFile]);

  return (
    <div className="flex flex-col h-full bg-ide-bg">
      <div className="flex-1 overflow-y-auto">
        {safeConflicts.length > 0 && (
          <div className="bg-red-500/10 border-b border-red-500/30 px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-400 shrink-0" />
            <span className="text-xs text-red-400 font-medium flex-1">
              {safeConflicts.length} {t("git.conflicts")}
            </span>
          </div>
        )}

        {safeConflicts.length > 0 && (
          <div className="border-b border-ide-border">
            {safeConflicts.map((p) => (
              <div
                key={p}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-red-500/10 cursor-pointer"
                onClick={() => onConflictClick(p)}
              >
                <AlertTriangle size={12} className="text-red-400 shrink-0" />
                <span className="flex-1 text-xs text-red-400 truncate">{p}</span>
                <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">{t("git.resolve")}</span>
              </div>
            ))}
          </div>
        )}

        {!hasChanges && safeConflicts.length === 0 && (
          <div className="flex flex-col items-center justify-center p-6 mt-10 gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <Check className="text-green-500/50 mb-2" size={32} />
              <span className="text-ide-text text-sm font-medium">{t("git.noChanges")}</span>
              <span className="text-ide-mute text-xs max-w-[200px]">
                {!hasRemote
                  ? t("git.noRemoteHint")
                  : behindCount > 0 && aheadCount > 0
                    ? `${t("git.behind")} ${behindCount}, ${t("git.ahead")} ${aheadCount}`
                    : behindCount > 0
                      ? `${t("git.behind")} ${behindCount}`
                      : aheadCount > 0
                        ? `${t("git.ahead")} ${aheadCount}`
                        : t("git.upToDate")}
              </span>
            </div>

            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {!hasRemote ? (
                <button
                  onClick={() => onPush()}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-ide-mute hover:text-ide-text hover:bg-ide-panel/80 border border-transparent hover:border-ide-border transition-all disabled:opacity-50"
                  title={t("git.publish")}
                >
                  <CloudUpload size={14} className="text-ide-accent/70 shrink-0" />
                  {t("git.publish")}
                </button>
              ) : (
                <>
                  <button
                    onClick={onFetch}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-ide-mute hover:text-ide-text hover:bg-ide-panel/80 border border-transparent hover:border-ide-border transition-all disabled:opacity-50"
                  >
                    <RefreshCw size={14} className="text-ide-mute/70 shrink-0" />
                    {t("git.fetch")}
                  </button>
                  {behindCount > 0 && (
                    <button
                      onClick={onPull}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-ide-mute hover:text-ide-text hover:bg-ide-panel/80 border border-transparent hover:border-ide-border transition-all disabled:opacity-50"
                    >
                      <ArrowDown size={14} className="text-orange-400/70 shrink-0" />
                      {t("git.pull")} {behindCount}
                    </button>
                  )}
                  {aheadCount > 0 && (
                    <div className="flex items-center ml-1">
                      <button
                        onClick={() => onPush()}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-l-full text-xs text-ide-mute hover:text-ide-text hover:bg-ide-panel/80 border border-transparent hover:border-ide-border transition-all disabled:opacity-50 border-r border-ide-border/50"
                      >
                        <ArrowUp size={14} className="text-blue-400/70 shrink-0" />
                        {t("git.push")} {aheadCount}
                      </button>
                      <button
                        onClick={() => onPush(true)}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-r-full text-xs text-red-500/70 hover:text-red-500 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-all disabled:opacity-50 border-l border-ide-border/50"
                        title={t("git.forcePush")}
                      >
                        <ArrowUp size={14} className="shrink-0" />
                        {t("git.forcePush")} {aheadCount}
                      </button>
                    </div>
                  )}
                </>
              )}
              {safeStashes.length > 0 && (
                <button
                  onClick={() => onStashPop(safeStashes[0].index, safeStashes[0].oid)}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-ide-mute hover:text-ide-text hover:bg-ide-panel/80 border border-transparent hover:border-ide-border transition-all disabled:opacity-50 max-w-[150px]"
                  title={safeStashes[0].message}
                >
                  <Archive size={14} className="text-purple-400/70 shrink-0" />
                  <span className="truncate">
                    {t("git.stashes")} ({safeStashes.length})
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {hasChanges && (
          <>
            {showFilter && (
              <div className="px-3 py-2 border-b border-ide-border/50 bg-ide-bg">
                <div className="flex items-center gap-1.5 bg-ide-panel border border-ide-border rounded px-2 py-1.5 focus-within:border-ide-accent focus-within:ring-1 focus-within:ring-ide-accent/20 transition-all">
                  <Search size={12} className="text-ide-mute shrink-0" />
                  <input
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder={t("git.searchFiles")}
                    className="flex-1 bg-transparent text-xs text-ide-text placeholder-ide-mute focus:outline-none min-w-0"
                  />
                  {filterText && (
                    <button
                      onClick={() => setFilterText("")}
                      className="text-ide-mute hover:text-ide-text transition-colors"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel/30">
              <div
                className="flex items-center gap-2 flex-1 cursor-pointer"
                onClick={() => {
                  void onToggleAll();
                }}
              >
                {renderSelectionIcon(
                  allSelectionType,
                  16,
                  allSelectionType === "none" ? "text-ide-mute shrink-0" : "text-ide-accent shrink-0"
                )}
                <span className="text-xs text-ide-mute font-medium flex-1">{t("git.selectAll")}</span>
                <span className="text-xs text-ide-mute">
                  {checkedCount}/{allFiles.length}
                </span>
              </div>
              <button
                className="p-1 hover:bg-purple-500/20 rounded text-ide-mute hover:text-purple-400 transition-colors shrink-0"
                onClick={() => onStash()}
                title={t("git.stashAll")}
              >
                <Archive size={14} />
              </button>
            </div>

            <div>
              {filteredFiles.map((file) => {
                const selectionType = getFileSelectionType(file);
                return (
                  <div
                    key={file.path}
                    className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer group transition-colors ${getFileRowClassName(selectionType)}`}
                  >
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        void onToggleFile(file.path);
                      }}
                      className="shrink-0"
                    >
                      {renderSelectionIcon(
                        selectionType,
                        16,
                        selectionType === "none" ? "text-ide-mute" : "text-ide-accent"
                      )}
                    </div>
                    <span className={`w-4 text-center font-bold text-[10px] shrink-0 ${getStatusColor(file.status)}`}>
                      {getStatusLabel(file.status)}
                    </span>
                    <div className="flex-1 min-w-0 flex flex-col" onClick={() => onFileClick(file.path)}>
                      <span className={getFileNameClassName(selectionType)}>
                        {file.name}
                        {file.submodule && (
                          <span className="ml-1.5 text-[9px] text-ide-accent">{t("git.submodule")}</span>
                        )}
                      </span>
                      {file.path !== file.name && (
                        <span className={getFilePathClassName(selectionType)}>{file.path}</span>
                      )}
                    </div>
                    <button
                      className={`p-1 hover:bg-purple-500/20 rounded hover:text-purple-400 transition-opacity shrink-0 ${selectionType === "none" ? "text-ide-mute opacity-0 group-hover:opacity-100" : selectionType === "partial" ? "text-amber-300/80 opacity-100" : "text-ide-accent/80 opacity-100"}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStash(undefined, [file.path]);
                      }}
                      title={t("git.stashFile")}
                    >
                      <Archive size={12} />
                    </button>
                    {file.status !== "untracked" && (
                      <button
                        className={`p-1 hover:bg-red-500/20 rounded hover:text-red-400 transition-opacity shrink-0 ${selectionType === "none" ? "text-ide-mute opacity-0 group-hover:opacity-100" : selectionType === "partial" ? "text-amber-300/80 opacity-100" : "text-ide-accent/80 opacity-100"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDiscardClick(file.path);
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
              {filterText && filteredFiles.length === 0 && (
                <div className="flex items-center justify-center py-6 text-ide-mute text-xs">{t("git.noChanges")}</div>
              )}
            </div>
          </>
        )}
      </div>

      {safeStashes.length > 0 && (
        <div className="border-t border-ide-border">
          <div
            className="flex items-center justify-between px-3 py-1.5 bg-ide-panel/30 cursor-pointer"
            onClick={() => setShowStashes(!showStashes)}
          >
            <div className="flex items-center gap-1">
              {showStashes ? (
                <ChevronDown size={12} className="text-ide-mute" />
              ) : (
                <ChevronRight size={12} className="text-ide-mute" />
              )}
              <span className="text-[10px] font-bold text-ide-mute uppercase">{t("git.stashes")}</span>
            </div>
            <span className="text-[10px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">
              {safeStashes.length}
            </span>
          </div>
          {showStashes && (
            <div>
              {safeStashes.map((s) => (
                <div
                  key={s.index}
                  className={`flex items-center gap-2 px-3 py-1.5 hover:bg-ide-accent/10 group ${
                    selectedStashIndex === s.index ? "bg-ide-accent/10" : ""
                  }`}
                >
                  <Archive size={12} className="text-purple-400 shrink-0" />
                  <button
                    type="button"
                    className="flex-1 min-w-0 truncate text-left text-[10px] text-ide-text"
                    onClick={() => onStashSelect(s.index)}
                    title={s.message}
                  >
                    {s.message}
                  </button>
                  <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    <button
                      className="px-1.5 py-0.5 text-[10px] bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
                      onClick={() => onStashPop(s.index, s.oid)}
                      disabled={isLoading}
                    >
                      {t("git.pop")}
                    </button>
                    <button
                      className="px-1.5 py-0.5 text-[10px] bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
                      onClick={() => onStashDrop(s.index, s.oid)}
                      disabled={isLoading}
                    >
                      {t("git.drop")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {selectedStashIndex !== null && (
            <GitStashDetail
              groupId={groupId}
              path={path}
              locale={locale}
              stash={safeStashes.find((stash) => stash.index === selectedStashIndex) || null}
              files={stashFiles}
              selectedFile={selectedStashFile}
              diff={stashDiff}
              loading={stashLoading}
              disabled={isLoading}
              compact
              onClose={() => onStashSelect(null)}
              onFileSelect={onStashFileSelect}
              onPop={onStashPop}
              onDrop={onStashDrop}
            />
          )}
        </div>
      )}

      <GitCommitComposer
        groupId={groupId}
        locale={locale}
        autoSummary={autoSummary}
        checkedCount={checkedCount}
        currentBranch={currentBranch}
        hasConflicts={safeConflicts.length > 0}
        isLoading={isLoading}
        onUndoLastCommit={onUndoLastCommit}
      />

      {discardConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setDiscardConfirm(null)}
        >
          <div
            className="bg-ide-bg border border-ide-border rounded-lg shadow-xl w-80 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={20} className="text-red-400" />
              <span className="text-sm font-medium text-ide-text">{t("git.discardConfirm")}</span>
            </div>
            <p className="text-xs text-ide-mute mb-2 font-mono bg-ide-panel px-2 py-1 rounded truncate">
              {discardConfirm}
            </p>
            <p className="text-xs text-red-400 mb-4">{t("git.discardWarning")}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setDiscardConfirm(null)}
                className="flex-1 px-3 py-1.5 text-sm text-ide-mute hover:text-ide-text border border-ide-border rounded"
              >
                {t("git.cancel")}
              </button>
              <button
                onClick={handleConfirmDiscard}
                className="flex-1 px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600"
              >
                {t("git.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GitChangesView;
