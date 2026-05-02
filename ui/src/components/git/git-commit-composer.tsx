import { Check, Loader2, Settings2, Sparkles, Undo2, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getTranslation, type Locale } from "@/lib/i18n";
import { useGitStore } from "@/stores";

interface GitCommitComposerProps {
  groupId: string;
  locale: Locale;
  autoSummary: string;
  checkedCount: number;
  currentBranch: string;
  hasConflicts: boolean;
  isLoading: boolean;
  onUndoLastCommit: () => Promise<boolean>;
}

const GitCommitComposer: React.FC<GitCommitComposerProps> = ({
  groupId,
  locale,
  autoSummary,
  checkedCount,
  currentBranch,
  hasConflicts,
  isLoading,
  onUndoLastCommit,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const {
    summary,
    description,
    isAmend,
    skipCommitHooks,
    signOffCommits,
    allowEmptyCommit,
    setSummary,
    setDescription,
    setIsAmend,
    setSkipCommitHooks,
    setSignOffCommits,
    setAllowEmptyCommit,
    commitSelected,
    amendCommit,
  } = useGitStore(
    groupId,
    useShallow((state) => ({
      summary: state.summary,
      description: state.description,
      isAmend: state.isAmend,
      skipCommitHooks: state.skipCommitHooks,
      signOffCommits: state.signOffCommits,
      allowEmptyCommit: state.allowEmptyCommit,
      setSummary: state.setSummary,
      setDescription: state.setDescription,
      setIsAmend: state.setIsAmend,
      setSkipCommitHooks: state.setSkipCommitHooks,
      setSignOffCommits: state.setSignOffCommits,
      setAllowEmptyCommit: state.setAllowEmptyCommit,
      commitSelected: state.commitSelected,
      amendCommit: state.amendCommit,
    }))
  );

  const [showDescription, setShowDescription] = useState(false);
  const [showCommitOptions, setShowCommitOptions] = useState(false);
  const [undoToast, setUndoToast] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canCommit =
    (checkedCount > 0 || allowEmptyCommit) && (summary.trim() || autoSummary).length > 0 && !hasConflicts;

  useEffect(() => {
    if (description) {
      setShowDescription(true);
    }
  }, [description]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!composerRef.current?.contains(document.activeElement)) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit && !isLoading) {
        e.preventDefault();
        if (!summary.trim() && autoSummary) {
          setSummary(autoSummary);
        }
        if (isAmend) {
          void amendCommit();
          return;
        }
        void commitSelected();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [amendCommit, autoSummary, canCommit, commitSelected, isAmend, isLoading, setSummary, summary]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showCommitOptions) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !composerRef.current?.contains(event.target)) {
        setShowCommitOptions(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowCommitOptions(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showCommitOptions]);

  const handleCommit = useCallback(async () => {
    if (!summary.trim() && autoSummary) {
      setSummary(autoSummary);
    }
    const ok = isAmend ? await amendCommit() : await commitSelected();
    if (!ok) {
      return;
    }
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }
    setUndoToast(true);
    undoTimerRef.current = setTimeout(() => setUndoToast(false), 5000);
  }, [amendCommit, autoSummary, commitSelected, isAmend, setSummary, summary]);

  const handleUndoFromToast = useCallback(async () => {
    setUndoToast(false);
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }
    await onUndoLastCommit();
  }, [onUndoLastCommit]);

  return (
    <>
      <div ref={composerRef} className="relative shrink-0 border-t border-ide-border bg-ide-panel/30 p-3 space-y-2">
        <div className="relative">
          <input
            type="text"
            placeholder={autoSummary || t("git.summaryPlaceholder")}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className={`w-full bg-ide-bg border rounded pl-3 pr-14 py-2 text-sm text-ide-text focus:outline-none ${
              !summary && autoSummary ? "placeholder-ide-accent/50" : "placeholder-ide-mute"
            } ${
              summary.length > 72
                ? "border-orange-500/50 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                : "border-ide-border focus:border-ide-accent focus:ring-1 focus:ring-ide-accent/20"
            }`}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {!summary && autoSummary && (
              <button
                onClick={() => setSummary(autoSummary)}
                className="p-0.5 text-ide-accent/60 hover:text-ide-accent transition-colors"
                title={t("git.useAutoMessage")}
              >
                <Sparkles size={12} />
              </button>
            )}
            {summary.length > 0 && (
              <span className={`text-[10px] ${summary.length > 72 ? "text-orange-500 font-medium" : "text-ide-mute"}`}>
                {summary.length}
              </span>
            )}
          </div>
        </div>

        {showDescription ? (
          <textarea
            placeholder={t("git.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-ide-bg border border-ide-border rounded px-3 py-2 text-xs text-ide-text focus:outline-none focus:border-ide-accent min-h-[48px] resize-none placeholder-ide-mute/50"
          />
        ) : (
          <button className="text-[10px] text-ide-mute hover:text-ide-accent" onClick={() => setShowDescription(true)}>
            + {t("git.descriptionPlaceholder")}
          </button>
        )}

        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isAmend}
              onChange={(e) => setIsAmend(e.target.checked)}
              className="accent-ide-accent w-3.5 h-3.5"
            />
            <span className="text-[10px] text-ide-mute">{t("git.amend")}</span>
          </label>
          <button
            type="button"
            onClick={() => setShowCommitOptions((open) => !open)}
            className={`p-1 text-ide-mute hover:text-ide-text transition-colors ${
              skipCommitHooks || signOffCommits || allowEmptyCommit ? "text-ide-accent" : ""
            }`}
            title={t("git.commitOptions")}
            aria-label={t("git.commitOptions")}
            aria-expanded={showCommitOptions}
          >
            <Settings2 size={14} />
          </button>
        </div>

        {showCommitOptions && (
          <div className="absolute right-3 bottom-12 z-20 w-56 border border-ide-border bg-ide-panel p-2 shadow-xl shadow-black/20">
            <div className="mb-1 px-1 text-[10px] font-medium text-ide-text">{t("git.commitOptions")}</div>
            <label className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-[11px] text-ide-mute hover:bg-ide-bg hover:text-ide-text">
              <input
                type="checkbox"
                checked={skipCommitHooks}
                onChange={(e) => setSkipCommitHooks(e.target.checked)}
                className="accent-ide-accent w-3.5 h-3.5"
              />
              <span>{t("git.skipCommitHooks")}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-[11px] text-ide-mute hover:bg-ide-bg hover:text-ide-text">
              <input
                type="checkbox"
                checked={signOffCommits}
                onChange={(e) => setSignOffCommits(e.target.checked)}
                className="accent-ide-accent w-3.5 h-3.5"
              />
              <span>{t("git.signOffCommits")}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-[11px] text-ide-mute hover:bg-ide-bg hover:text-ide-text">
              <input
                type="checkbox"
                checked={allowEmptyCommit}
                onChange={(e) => setAllowEmptyCommit(e.target.checked)}
                className="accent-ide-accent w-3.5 h-3.5"
              />
              <span>{t("git.allowEmptyCommit")}</span>
            </label>
          </div>
        )}

        <button
          disabled={!canCommit || isLoading}
          onClick={handleCommit}
          className="w-full bg-ide-accent text-ide-bg font-bold py-2 text-sm flex items-center justify-center gap-2 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-ide-accent/80 transition-colors"
          title={t("git.commitShortcut")}
        >
          {isLoading ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t("common.loading")}
            </>
          ) : (
            <>
              <Check size={14} />
              {t("git.commitTo")} {currentBranch}
              {checkedCount > 0 && <span className="text-xs opacity-80">({checkedCount})</span>}
            </>
          )}
        </button>
      </div>

      {undoToast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div className="flex items-center gap-2.5 bg-ide-panel border border-ide-border rounded-md px-3 py-2 shadow-xl shadow-black/20">
            <Check size={14} className="text-green-500 shrink-0" />
            <span className="text-xs text-ide-text mr-1">{t("git.commit")}</span>
            <button
              onClick={handleUndoFromToast}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-ide-accent hover:bg-ide-accent/10 font-medium transition-colors"
            >
              <Undo2 size={10} />
              {t("git.undo")}
            </button>
            <div className="w-px h-3 bg-ide-border mx-1"></div>
            <button onClick={() => setUndoToast(false)} className="text-ide-mute hover:text-ide-text transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default GitCommitComposer;
