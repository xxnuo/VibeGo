import { GitMerge, GitPullRequest, MoreHorizontal, Settings2, X } from "lucide-react";
import React, { useEffect, useRef } from "react";
import type { GitCommit, GitOperationResponse } from "@/api/git";
import GitOperationControls from "@/components/git/git-operation-controls";
import { Drawer, DrawerClose, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { getTranslation, type Locale } from "@/lib/i18n";

interface GitMobileActionsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: Locale;
  isLoading: boolean;
  operation: GitOperationResponse | null;
  selectedCommit?: GitCommit | null;
  currentBranch: string;
  aheadCount: number;
  repositorySettingsOpen: boolean;
  githubPanelOpen: boolean;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onOpenRepositorySettings: () => void;
  onOpenGithub: () => void;
  onMerge: (ref: string) => Promise<boolean>;
  onRebase: (upstream: string) => Promise<boolean>;
  onCherryPick: (commit: string) => Promise<boolean>;
  onRevert: (commit: string) => Promise<boolean>;
  onResetToCommit: (ref: string, mode: "soft" | "mixed" | "hard") => Promise<boolean>;
  onPush: (force?: boolean) => void | Promise<void>;
  onOperationAction: (action: "continue" | "abort" | "skip") => Promise<boolean>;
  onOperationStarted?: () => void;
}

const GitMobileActions: React.FC<GitMobileActionsProps> = ({
  open,
  onOpenChange,
  locale,
  isLoading,
  operation,
  selectedCommit,
  currentBranch,
  aheadCount,
  repositorySettingsOpen,
  githubPanelOpen,
  returnFocusRef,
  onOpenRepositorySettings,
  onOpenGithub,
  onMerge,
  onRebase,
  onCherryPick,
  onRevert,
  onResetToCommit,
  onPush,
  onOperationAction,
  onOperationStarted,
}) => {
  const t = (key: string) => getTranslation(locale, key);
  const wasOpenRef = useRef(open);
  const suppressRestoreRef = useRef(false);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    if (open && !wasOpen) {
      suppressRestoreRef.current = false;
    } else if (!open && wasOpen) {
      if (suppressRestoreRef.current) {
        suppressRestoreRef.current = false;
      } else {
        const target = returnFocusRef.current;
        window.requestAnimationFrame(() => {
          if (target?.isConnected) target.focus();
        });
      }
    }
    wasOpenRef.current = open;
  }, [open, returnFocusRef]);

  const openRepositorySettings = () => {
    suppressRestoreRef.current = true;
    onOpenRepositorySettings();
  };

  const openGithub = () => {
    suppressRestoreRef.current = true;
    onOpenGithub();
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[min(86dvh,42rem)] border-ide-border bg-ide-panel pb-[max(0.75rem,env(safe-area-inset-bottom))] text-ide-text">
        <DrawerHeader className="border-b border-ide-border pb-3 pr-14 text-left">
          <DrawerTitle className="flex items-center gap-2 text-sm text-ide-text">
            <MoreHorizontal size={16} className="text-ide-accent" />
            {t("git.moreActions")}
          </DrawerTitle>
          <DrawerClose
            className="absolute right-3 top-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-bg hover:text-ide-text"
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <X size={17} />
          </DrawerClose>
        </DrawerHeader>

        <div className="min-h-0 overflow-y-auto">
          <section className="border-b border-ide-border px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-ide-text">
              <GitMerge size={15} className="text-ide-accent" />
              {t("git.advancedOperations")}
            </div>
            <GitOperationControls
              variant="mobile"
              locale={locale}
              selectedCommitHash={selectedCommit?.hash}
              currentBranch={currentBranch}
              aheadCount={aheadCount}
              isLoading={isLoading}
              operation={operation}
              onMerge={onMerge}
              onRebase={onRebase}
              onCherryPick={onCherryPick}
              onRevert={onRevert}
              onResetToCommit={onResetToCommit}
              onPush={onPush}
              onOperationAction={onOperationAction}
              onRunComplete={onOperationStarted}
            />
          </section>

          <section className="grid gap-2 px-4 py-3">
            <button
              type="button"
              className={`flex min-h-11 w-full items-center gap-3 rounded-sm border px-3 text-left text-sm transition-colors hover:bg-ide-accent/10 ${repositorySettingsOpen ? "border-ide-accent text-ide-accent" : "border-ide-border text-ide-text"}`}
              onClick={openRepositorySettings}
            >
              <Settings2 size={17} />
              <span className="min-w-0 flex-1 truncate">{t("git.repositorySettings.open")}</span>
            </button>
            <button
              type="button"
              className={`flex min-h-11 w-full items-center gap-3 rounded-sm border px-3 text-left text-sm transition-colors hover:bg-ide-accent/10 ${githubPanelOpen ? "border-ide-accent text-ide-accent" : "border-ide-border text-ide-text"}`}
              onClick={openGithub}
            >
              <GitPullRequest size={17} />
              <span className="min-w-0 flex-1 truncate">{t("git.github.open")}</span>
            </button>
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GitMobileActions;
