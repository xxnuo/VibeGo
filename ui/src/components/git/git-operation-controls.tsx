import { ArrowUp, ListRestart, Play, RotateCcw, SkipForward } from "lucide-react";
import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { GitOperationResponse } from "@/api/git";
import { getTranslation, type Locale } from "@/lib/i18n";

export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "reset";
export type GitResetMode = "soft" | "mixed" | "hard";

export function defaultGitOperationRef(
  operation: GitOperationKind,
  selectedCommitHash: string | undefined,
  currentBranch: string
): string {
  return operation === "cherry-pick" ? "" : selectedCommitHash || currentBranch;
}

export interface GitOperationControlsProps {
  locale: Locale;
  variant?: "desktop" | "mobile";
  selectedCommitHash?: string;
  currentBranch: string;
  aheadCount: number;
  isLoading: boolean;
  operation: GitOperationResponse | null;
  onMerge: (ref: string) => Promise<boolean>;
  onRebase: (upstream: string) => Promise<boolean>;
  onCherryPick: (commit: string) => Promise<boolean>;
  onRevert: (commit: string) => Promise<boolean>;
  onResetToCommit: (ref: string, mode: GitResetMode) => Promise<boolean>;
  onPush: (force?: boolean) => void | Promise<void>;
  onOperationAction: (action: "continue" | "abort" | "skip") => Promise<boolean>;
  onRunComplete?: () => void;
}

const GitOperationControls: React.FC<GitOperationControlsProps> = ({
  locale,
  variant = "desktop",
  selectedCommitHash,
  currentBranch,
  aheadCount,
  isLoading,
  operation,
  onMerge,
  onRebase,
  onCherryPick,
  onRevert,
  onResetToCommit,
  onPush,
  onOperationAction,
  onRunComplete,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const [operationKind, setOperationKind] = useState<GitOperationKind>("merge");
  const [operationRef, setOperationRef] = useState("");
  const [resetMode, setResetMode] = useState<GitResetMode>("mixed");
  const operationKindId = useId();
  const resetModeId = useId();
  const operationRefId = useId();
  const operationInProgress = operation?.state === "in_progress" || operation?.state === "conflicts";
  const operationRefDefault = defaultGitOperationRef(operationKind, selectedCommitHash, currentBranch);

  useEffect(() => {
    if (!operationRef && operationRefDefault) setOperationRef(operationRefDefault);
  }, [operationRef, operationRefDefault]);

  useEffect(() => {
    if (!operationInProgress || !operation) return;
    if (
      operation.operation === "merge" ||
      operation.operation === "rebase" ||
      operation.operation === "cherry-pick" ||
      operation.operation === "revert"
    ) {
      setOperationKind(operation.operation);
    }
  }, [operation, operationInProgress]);

  const runSelectedOperation = useCallback(async () => {
    const ref = operationRef.trim();
    if (!ref || isLoading || operationInProgress) return;
    let ok: boolean;
    if (operationKind === "reset") {
      ok = await onResetToCommit(ref, resetMode);
    } else if (operationKind === "merge") {
      ok = await onMerge(ref);
    } else if (operationKind === "rebase") {
      ok = await onRebase(ref);
    } else if (operationKind === "cherry-pick") {
      ok = await onCherryPick(ref);
    } else {
      ok = await onRevert(ref);
    }
    if (ok) onRunComplete?.();
  }, [
    isLoading,
    onCherryPick,
    onMerge,
    onRebase,
    onResetToCommit,
    onRevert,
    onRunComplete,
    operationInProgress,
    operationKind,
    operationRef,
    resetMode,
  ]);

  const operationSupportsActions = useMemo(
    () =>
      operation?.operation === "merge" ||
      operation?.operation === "rebase" ||
      operation?.operation === "cherry-pick" ||
      operation?.operation === "revert",
    [operation?.operation]
  );
  const mobile = variant === "mobile";
  const selectClass = mobile
    ? "h-11 min-w-0 rounded-sm border border-ide-border bg-ide-bg px-3 text-base text-ide-text outline-none focus:border-ide-accent disabled:opacity-50"
    : "desktop-git-operation-select";
  const inputClass = mobile
    ? "h-11 w-full min-w-0 rounded-sm border border-ide-border bg-ide-bg px-3 font-mono text-base text-ide-text outline-none placeholder:text-ide-mute focus:border-ide-accent disabled:opacity-50"
    : "desktop-git-operation-input";
  const buttonClass = mobile
    ? "flex min-h-11 w-full items-center justify-center gap-2 rounded-sm border border-ide-border px-3 text-sm text-ide-text transition-colors hover:bg-ide-accent/10 disabled:opacity-50"
    : "desktop-git-action-button";

  return (
    <div className={mobile ? "grid gap-3 py-3" : "desktop-git-operation-controls"}>
      <div className={mobile ? "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2" : "contents"}>
        <select
          id={operationKindId}
          name="gitOperation"
          className={selectClass}
          value={operationKind}
          onChange={(event) => {
            const next = event.target.value as GitOperationKind;
            setOperationKind(next);
            setOperationRef(defaultGitOperationRef(next, selectedCommitHash, currentBranch));
          }}
          disabled={Boolean(operationInProgress) || isLoading}
          aria-label={t("git.operation")}
        >
          <option value="merge">{t("git.merge")}</option>
          <option value="rebase">{t("git.rebase")}</option>
          <option value="cherry-pick">{t("git.cherryPick")}</option>
          <option value="revert">{t("git.revert")}</option>
          <option value="reset">{t("git.resetToCommit")}</option>
        </select>
        {operationKind === "reset" && (
          <select
            id={resetModeId}
            name="gitResetMode"
            className={selectClass}
            value={resetMode}
            onChange={(event) => setResetMode(event.target.value as GitResetMode)}
            disabled={Boolean(operationInProgress) || isLoading}
            aria-label={t("git.resetMode")}
          >
            <option value="soft">soft</option>
            <option value="mixed">mixed</option>
            <option value="hard">hard</option>
          </select>
        )}
      </div>
      <input
        id={operationRefId}
        name="gitOperationRef"
        className={inputClass}
        value={operationRef}
        onChange={(event) => setOperationRef(event.target.value)}
        placeholder={t("git.commitOrBranch")}
        aria-label={t("git.commitOrBranch")}
        disabled={Boolean(operationInProgress) || isLoading}
      />
      <button
        type="button"
        className={`${buttonClass} ${mobile ? "border-ide-accent bg-ide-accent text-ide-on-accent hover:bg-ide-accent/85" : "desktop-git-action-button--primary"}`}
        onClick={() => void runSelectedOperation()}
        disabled={Boolean(operationInProgress) || isLoading || !operationRef.trim()}
      >
        <Play size={mobile ? 16 : 12} />
        {t("git.run")}
      </button>
      {aheadCount > 0 && (
        <button
          type="button"
          className={`${buttonClass} ${mobile ? "border-red-500/40 text-red-400 hover:bg-red-500/10" : "desktop-git-action-button--danger"}`}
          onClick={() => void onPush(true)}
          disabled={isLoading}
        >
          <ArrowUp size={mobile ? 16 : 12} />
          {t("git.forcePush")}
        </button>
      )}
      {operationInProgress && operationSupportsActions && (
        <div
          className={
            mobile
              ? `grid gap-2 ${operation?.operation === "merge" ? "grid-cols-2" : "grid-cols-3"}`
              : "desktop-git-operation-actions"
          }
        >
          {(operation?.operation === "rebase" ||
            operation?.operation === "cherry-pick" ||
            operation?.operation === "revert") && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => void onOperationAction("skip")}
              disabled={isLoading}
            >
              <SkipForward size={mobile ? 16 : 12} />
              {t("git.skip")}
            </button>
          )}
          <button
            type="button"
            className={buttonClass}
            onClick={() => void onOperationAction("continue")}
            disabled={isLoading}
          >
            <ListRestart size={mobile ? 16 : 12} />
            {t("git.continue")}
          </button>
          <button
            type="button"
            className={`${buttonClass} ${mobile ? "text-red-400 hover:bg-red-500/10" : "desktop-git-action-button--danger"}`}
            onClick={() => void onOperationAction("abort")}
            disabled={isLoading}
          >
            <RotateCcw size={mobile ? 16 : 12} />
            {t("git.abort")}
          </button>
        </div>
      )}
      {operation?.progress && (
        <div className={mobile ? "text-center text-xs text-ide-mute" : "desktop-git-operation-progress"}>
          {operation.progress.position}/{operation.progress.total}
          {operation.progress.currentCommitSummary ? ` · ${operation.progress.currentCommitSummary}` : ""}
        </div>
      )}
    </div>
  );
};

export default GitOperationControls;
