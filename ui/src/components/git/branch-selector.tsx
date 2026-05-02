import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  GitBranch,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { getTranslation, type Locale } from "@/lib/i18n";

interface BranchSelectorProps {
  isOpen: boolean;
  isLoading?: boolean;
  branches: string[];
  remoteBranches: string[];
  recentBranches?: string[];
  remoteNames?: string[];
  currentBranch: string;
  aheadCount: number;
  behindCount: number;
  locale: Locale;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSwitch: (branch: string) => void;
  onSwitchRemote?: (remote: string, branch: string) => void;
  onCreate: (branch: string) => void;
  onDelete: (branch: string) => void;
  onRename?: (branch: string) => void;
  onDeleteRemote?: (remote: string, branch: string) => void;
  onPrune?: () => void;
}

export function parseRemoteBranchDisplay(
  displayName: string,
  remoteNames: string[]
): { remote: string; branch: string } | null {
  const remote = [...remoteNames]
    .sort((left, right) => right.length - left.length)
    .find((name) => displayName.startsWith(`${name}/`) && displayName.length > name.length + 1);
  if (remote) return { remote, branch: displayName.slice(remote.length + 1) };
  return null;
}

const BranchSelector: React.FC<BranchSelectorProps> = ({
  isOpen,
  isLoading = false,
  branches,
  remoteBranches,
  recentBranches = [],
  remoteNames = [],
  currentBranch,
  aheadCount,
  behindCount,
  locale,
  anchorRef,
  onClose,
  onSwitch,
  onSwitchRemote = () => undefined,
  onCreate,
  onDelete,
  onRename = () => undefined,
  onDeleteRemote = () => undefined,
  onPrune = () => undefined,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const searchInputId = useId();
  const newBranchInputId = useId();
  const [desktopAnchorReady, setDesktopAnchorReady] = useState(false);
  const branchListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openingTriggerRef = useRef<HTMLElement | null>(null);
  const virtualAnchorRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const localBranches = useMemo(() => {
    const lower = search.toLowerCase();
    return branches.filter((branch) => branch !== currentBranch && (!lower || branch.toLowerCase().includes(lower)));
  }, [branches, currentBranch, search]);

  const recentLocalBranches = useMemo(() => {
    const lower = search.toLowerCase();
    const known = new Set(branches);
    return recentBranches.filter(
      (branch, index) =>
        branch !== currentBranch &&
        known.has(branch) &&
        recentBranches.indexOf(branch) === index &&
        (!lower || branch.toLowerCase().includes(lower))
    );
  }, [branches, currentBranch, recentBranches, search]);

  const filteredRemote = useMemo(() => {
    const lower = search.toLowerCase();
    return (remoteBranches ?? []).filter((branch) => !lower || branch.toLowerCase().includes(lower));
  }, [remoteBranches, search]);

  const restoreTriggerFocus = useCallback(() => {
    const trigger = openingTriggerRef.current;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    if (isOpen && !wasOpen) {
      const activeElement = document.activeElement;
      const fallbackTrigger = document.querySelector<HTMLElement>(".desktop-git-toolbar-button--branch");
      const trigger =
        anchorRef?.current ??
        (activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : fallbackTrigger);
      openingTriggerRef.current = trigger;
      virtualAnchorRef.current = trigger;
      setDesktopAnchorReady(Boolean(trigger));
    } else if (!isOpen && wasOpen) {
      setDesktopAnchorReady(false);
      setSearch("");
      setIsCreating(false);
      setNewBranchName("");
      restoreTriggerFocus();
    }
    wasOpenRef.current = isOpen;
  }, [anchorRef, isOpen, restoreTriggerFocus]);

  const handleSwitch = useCallback(
    (branch: string) => {
      if (isLoading) return;
      if (branch !== currentBranch) onSwitch(branch);
      onClose();
    },
    [currentBranch, isLoading, onSwitch, onClose]
  );

  const handleCreate = useCallback(() => {
    if (!isLoading && newBranchName.trim()) {
      onCreate(newBranchName.trim());
      setNewBranchName("");
      setIsCreating(false);
    }
  }, [isLoading, newBranchName, onCreate]);

  const handleDelete = useCallback(
    (event: React.MouseEvent, branch: string) => {
      event.stopPropagation();
      if (!isLoading && branch !== currentBranch) onDelete(branch);
    },
    [currentBranch, isLoading, onDelete]
  );

  const handleRename = useCallback(
    (event: React.MouseEvent, branch: string) => {
      event.stopPropagation();
      if (!isLoading) onRename(branch);
    },
    [isLoading, onRename]
  );

  const handleDeleteRemote = useCallback(
    (event: React.MouseEvent, displayName: string) => {
      event.stopPropagation();
      if (isLoading) return;
      const target = parseRemoteBranchDisplay(displayName, remoteNames);
      if (target) onDeleteRemote(target.remote, target.branch);
    },
    [isLoading, onDeleteRemote, remoteNames]
  );

  const handleSwitchRemote = useCallback(
    (displayName: string) => {
      if (isLoading) return;
      const target = parseRemoteBranchDisplay(displayName, remoteNames);
      if (!target) return;
      onSwitchRemote(target.remote, target.branch);
      onClose();
    },
    [isLoading, onClose, onSwitchRemote, remoteNames]
  );

  const getBranchOptions = useCallback(
    () =>
      Array.from(
        branchListRef.current?.querySelectorAll<HTMLButtonElement>('[data-branch-option="true"]:not(:disabled)') ?? []
      ),
    []
  );

  const focusBranchOption = useCallback(
    (position: "first" | "last" | "next" | "previous", current?: HTMLButtonElement) => {
      const options = getBranchOptions();
      if (options.length === 0) return;
      if (position === "first") {
        options[0].focus();
        return;
      }
      if (position === "last") {
        options[options.length - 1].focus();
        return;
      }
      const currentIndex = current ? options.indexOf(current) : -1;
      const offset = position === "next" ? 1 : -1;
      const nextIndex = currentIndex < 0 ? (offset > 0 ? 0 : options.length - 1) : currentIndex + offset;
      options[(nextIndex + options.length) % options.length].focus();
    },
    [getBranchOptions]
  );

  const handleBranchOptionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        focusBranchOption(event.key === "ArrowDown" ? "next" : "previous", event.currentTarget);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusBranchOption(event.key === "Home" ? "first" : "last");
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    },
    [focusBranchOption, onClose]
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        focusBranchOption(event.key === "ArrowDown" ? "first" : "last");
      } else if (event.key === "Enter") {
        event.preventDefault();
        getBranchOptions()[0]?.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    },
    [focusBranchOption, getBranchOptions, onClose]
  );

  const renderSelectorContent = (compact: boolean) => {
    const itemPadding = compact ? "px-3 py-1.5" : "min-h-11 px-4 py-2";
    const iconButtonSize = compact ? "size-7" : "size-11";
    return (
      <>
        <div
          className={`flex items-center justify-between border-b border-ide-border ${compact ? "px-3 py-2" : "px-4 py-3"}`}
        >
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-ide-accent" />
            {compact ? (
              <span className="text-sm font-medium text-ide-text">{t("git.branches")}</span>
            ) : (
              <SheetTitle className="text-sm font-medium text-ide-text">{t("git.branches")}</SheetTitle>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`flex shrink-0 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-panel hover:text-ide-text ${iconButtonSize}`}
            aria-label={t("git.cancel")}
          >
            <X size={16} />
          </button>
        </div>

        <div className={`border-b border-ide-border ${compact ? "p-2" : "px-3 py-2"}`}>
          <div
            className={`flex items-center gap-2 border border-transparent bg-ide-panel focus-within:border-ide-accent ${compact ? "rounded-sm px-2 py-1.5" : "min-h-11 rounded-md px-3"}`}
          >
            <Search size={14} className="text-ide-mute" />
            <input
              id={searchInputId}
              name="gitBranchSearch"
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("git.searchBranches")}
              aria-label={t("git.searchBranches")}
              className={`${compact ? "text-sm" : "h-11 text-base"} min-w-0 flex-1 bg-transparent text-ide-text outline-none placeholder-ide-mute`}
              autoFocus
            />
          </div>
        </div>

        <div ref={branchListRef} className="min-h-0 flex-1 overflow-y-auto" role="group" aria-label={t("git.branches")}>
          <div className="px-3 pb-1 pt-2">
            <span className="text-[10px] font-bold uppercase text-ide-mute">{t("git.current")}</span>
          </div>
          <div className={`flex items-center justify-between gap-2 bg-ide-accent/10 ${itemPadding}`}>
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch size={14} className="shrink-0 text-ide-accent" />
              <span className="truncate text-sm font-medium text-ide-accent">{currentBranch}</span>
              <Check size={14} className="shrink-0 text-ide-accent" />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={(event) => handleRename(event, currentBranch)}
                disabled={isLoading}
                className={`flex shrink-0 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-panel hover:text-ide-accent disabled:opacity-50 ${iconButtonSize}`}
                aria-label={t("git.renameBranch")}
                title={t("git.renameBranch")}
              >
                <Pencil size={13} />
              </button>
              {aheadCount > 0 && (
                <span className="flex items-center gap-0.5 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-400">
                  <ArrowUp size={9} /> {aheadCount}
                </span>
              )}
              {behindCount > 0 && (
                <span className="flex items-center gap-0.5 rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] text-orange-400">
                  <ArrowDown size={9} /> {behindCount}
                </span>
              )}
            </div>
          </div>

          {recentLocalBranches.length > 0 && (
            <>
              <div className="px-3 pb-1 pt-3">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-ide-mute">
                  <Clock size={10} /> {t("git.recentBranches")}
                </span>
              </div>
              {recentLocalBranches.map((branch) => (
                <button
                  key={`recent-${branch}`}
                  type="button"
                  data-branch-option="true"
                  disabled={isLoading}
                  className={`flex w-full items-center justify-between text-left transition-colors hover:bg-ide-panel focus:bg-ide-panel focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${itemPadding}`}
                  onClick={() => handleSwitch(branch)}
                  onKeyDown={handleBranchOptionKeyDown}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Clock size={14} className="shrink-0 text-ide-accent" />
                    <span className="truncate text-sm text-ide-text">{branch}</span>
                  </span>
                  <Check size={13} className="shrink-0 text-ide-mute/50" />
                </button>
              ))}
            </>
          )}

          {localBranches.length > 0 && (
            <>
              <div className="px-3 pb-1 pt-3">
                <span className="text-[10px] font-bold uppercase text-ide-mute">{t("git.local")}</span>
              </div>
              {localBranches.map((branch) => (
                <div
                  key={branch}
                  className="group flex items-center transition-colors hover:bg-ide-panel focus-within:bg-ide-panel"
                  role="presentation"
                >
                  <button
                    type="button"
                    data-branch-option="true"
                    disabled={isLoading}
                    className={`flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${itemPadding}`}
                    onClick={() => handleSwitch(branch)}
                    onKeyDown={handleBranchOptionKeyDown}
                  >
                    <GitBranch size={14} className="shrink-0 text-ide-mute" />
                    <span className="truncate text-sm text-ide-text">{branch}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 pr-3 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => handleRename(event, branch)}
                      disabled={isLoading}
                      className={`flex shrink-0 items-center justify-center rounded-sm text-ide-mute hover:text-ide-accent disabled:opacity-50 ${iconButtonSize}`}
                      aria-label={`${t("git.renameBranch")} ${branch}`}
                      title={t("git.renameBranch")}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => handleDelete(event, branch)}
                      disabled={isLoading}
                      className={`flex shrink-0 items-center justify-center rounded-sm text-ide-mute hover:text-red-400 disabled:opacity-50 ${iconButtonSize}`}
                      aria-label={`${t("git.deleteBranch")} ${branch}`}
                      title={t("git.deleteBranch")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {filteredRemote.length > 0 && (
            <>
              <div className="flex items-center justify-between px-3 pb-1 pt-3">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-ide-mute">
                  <Globe size={10} /> {t("git.remote")}
                </span>
                <button
                  type="button"
                  onClick={onPrune}
                  disabled={isLoading || remoteNames.length === 0}
                  className={`flex shrink-0 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-panel hover:text-ide-accent disabled:opacity-50 ${iconButtonSize}`}
                  aria-label={t("git.pruneRemote")}
                  title={t("git.pruneRemote")}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              {filteredRemote.map((branch) => {
                const target = parseRemoteBranchDisplay(branch, remoteNames);
                return (
                  <div
                    key={branch}
                    className="group flex items-center transition-colors hover:bg-ide-panel focus-within:bg-ide-panel"
                    role="presentation"
                  >
                    <button
                      type="button"
                      data-branch-option="true"
                      disabled={isLoading || !target}
                      className={`flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none disabled:cursor-default disabled:opacity-50 ${itemPadding}`}
                      onClick={() => handleSwitchRemote(branch)}
                      onKeyDown={handleBranchOptionKeyDown}
                    >
                      <Globe size={14} className="shrink-0 text-ide-mute" />
                      <span className="truncate text-sm text-ide-mute">{branch}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => handleDeleteRemote(event, branch)}
                      className={`mr-3 flex shrink-0 items-center justify-center rounded-sm text-ide-mute opacity-100 transition-opacity hover:text-red-400 disabled:opacity-30 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 ${iconButtonSize}`}
                      disabled={isLoading || !target}
                      aria-label={`${t("git.deleteRemoteBranch")} ${branch}`}
                      title={t("git.deleteRemoteBranch")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div
          className={`border-t border-ide-border ${
            compact ? "p-2" : "px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          }`}
        >
          {isCreating ? (
            <div className="space-y-2">
              <input
                id={newBranchInputId}
                name="gitNewBranch"
                type="text"
                value={newBranchName}
                onChange={(event) => setNewBranchName(event.target.value)}
                placeholder={t("git.newBranch")}
                aria-label={t("git.newBranch")}
                className={`w-full border border-ide-border bg-ide-panel px-3 text-ide-text outline-none focus:border-ide-accent ${compact ? "rounded-sm py-1.5 text-sm" : "min-h-11 rounded-md py-2 text-base"}`}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleCreate();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setIsCreating(false);
                    setNewBranchName("");
                    if (!isMobile) onClose();
                  }
                }}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreating(false);
                    setNewBranchName("");
                  }}
                  className={`flex-1 text-sm text-ide-mute hover:bg-ide-panel hover:text-ide-text ${compact ? "rounded-sm px-2 py-1.5" : "min-h-11 rounded-md px-3 py-2"}`}
                >
                  {t("git.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={isLoading || !newBranchName.trim()}
                  className={`flex-1 bg-ide-accent text-sm text-ide-bg disabled:opacity-50 ${compact ? "rounded-sm px-2 py-1.5" : "min-h-11 rounded-md px-3 py-2"}`}
                >
                  {t("git.create")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              disabled={isLoading}
              className={`flex w-full items-center justify-center gap-2 text-sm text-ide-accent hover:bg-ide-accent/10 disabled:opacity-50 ${compact ? "rounded-sm px-2 py-1.5" : "min-h-11 rounded-md px-3 py-2"}`}
            >
              <Plus size={14} />
              {t("git.createBranch")}
            </button>
          )}
        </div>
      </>
    );
  };

  if (!isOpen) return null;

  if (!isMobile) {
    if (!desktopAnchorReady) return null;
    return (
      <Popover
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <PopoverAnchor virtualRef={virtualAnchorRef} />
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="flex max-h-[min(680px,calc(100vh-1rem))] w-[min(430px,calc(100vw-1rem))] flex-col overflow-hidden border-ide-border bg-ide-bg p-0 text-ide-text shadow-xl"
          role="dialog"
          aria-label={t("git.branches")}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreTriggerFocus();
          }}
        >
          {renderSelectorContent(true)}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-[min(78dvh,42rem)] max-h-[min(78dvh,42rem)] min-h-0 gap-0 overflow-hidden rounded-t-md border-ide-border bg-ide-bg p-0 text-ide-text"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreTriggerFocus();
        }}
      >
        {renderSelectorContent(false)}
      </SheetContent>
    </Sheet>
  );
};

export default BranchSelector;
