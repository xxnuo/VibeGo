import { History, LoaderCircle, Maximize2 } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import { type BlockTermHistoryEntry, blockTermApi } from "@/api/blockterm";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getIntlLocale, useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";

interface BlockTermHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (command: string) => void;
  onOpenCenter?: () => void;
}

const SEARCH_DEBOUNCE_MS = 180;
const HISTORY_PAGE_SIZE = 100;

const BlockTermHistoryDialog: React.FC<BlockTermHistoryDialogProps> = ({
  open,
  onOpenChange,
  onSelect,
  onOpenCenter,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const searchInputId = useId();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<BlockTermHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const searchRevisionRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  useEffect(() => {
    const revision = searchRevisionRef.current + 1;
    searchRevisionRef.current = revision;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    if (!open) {
      setEntries([]);
      setLoading(false);
      setLoadingMore(false);
      setFailed(false);
      setLoadMoreFailed(false);
      setHasMore(false);
      setNextOffset(0);
      return;
    }

    const controller = new AbortController();
    setEntries([]);
    setLoading(true);
    setLoadingMore(false);
    setFailed(false);
    setLoadMoreFailed(false);
    setHasMore(false);
    setNextOffset(0);
    const timer = window.setTimeout(() => {
      void blockTermApi
        .listHistory({ query: query || undefined, limit: HISTORY_PAGE_SIZE, offset: 0, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted || searchRevisionRef.current !== revision) return;
          setEntries(result.history.filter((entry) => entry.command.trim()));
          setHasMore(result.hasMore);
          setNextOffset(result.nextOffset);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted || searchRevisionRef.current !== revision) return;
          setEntries([]);
          setLoading(false);
          setFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [open, query]);

  const loadMore = () => {
    if (loading || loadingMore || !hasMore || loadMoreAbortRef.current) return;
    const revision = searchRevisionRef.current;
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    void blockTermApi
      .listHistory({
        query: query || undefined,
        limit: HISTORY_PAGE_SIZE,
        offset: nextOffset,
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted || searchRevisionRef.current !== revision) return;
        setEntries((current) => {
          const known = new Set(current.map((entry) => entry.id));
          return [...current, ...result.history.filter((entry) => entry.command.trim() && !known.has(entry.id))];
        });
        setHasMore(result.hasMore);
        setNextOffset(result.nextOffset);
      })
      .catch(() => {
        if (controller.signal.aborted || searchRevisionRef.current !== revision) return;
        setLoadMoreFailed(true);
      })
      .finally(() => {
        if (loadMoreAbortRef.current !== controller) return;
        loadMoreAbortRef.current = null;
        if (controller.signal.aborted || searchRevisionRef.current !== revision) return;
        setLoadingMore(false);
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden rounded-t-md p-0 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-w-2xl md:rounded-md md:pb-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("plugin.blockTerm.commandHistory")}</DialogTitle>
          <DialogDescription>{t("plugin.blockTerm.historySearchDescription")}</DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="relative rounded-none bg-ide-panel text-ide-text [&_[data-slot=command-input-wrapper]]:h-11 [&_[data-slot=command-input]]:h-11"
        >
          <CommandInput
            id={searchInputId}
            name="history-search"
            value={query}
            onValueChange={setQuery}
            placeholder={t("plugin.blockTerm.searchHistory")}
            aria-label={t("plugin.blockTerm.searchHistory")}
            className="pr-12 text-base md:text-sm"
          />
          {onOpenCenter && (
            <button
              type="button"
              onClick={onOpenCenter}
              title={t("plugin.blockTerm.openHistoryCenter")}
              aria-label={t("plugin.blockTerm.openHistoryCenter")}
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-ide-mute hover:text-ide-text"
            >
              <Maximize2 size={14} />
            </button>
          )}
          <CommandList className="max-h-[min(60dvh,28rem)]">
            {loading ? (
              <div className="flex h-24 items-center justify-center text-ide-mute">
                <LoaderCircle size={16} className="animate-spin" />
                <span className="sr-only">{t("common.loading")}</span>
              </div>
            ) : failed ? (
              <div className="px-4 py-8 text-center text-sm text-red-500">
                {t("plugin.blockTerm.historySearchFailed")}
              </div>
            ) : (
              <>
                {entries.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-ide-mute">
                    {t("plugin.blockTerm.historyEmpty")}
                  </div>
                ) : (
                  <CommandGroup>
                    {entries.map((entry) => (
                      <CommandItem
                        key={entry.id}
                        value={entry.id}
                        onSelect={() => {
                          onSelect(entry.command);
                          onOpenChange(false);
                        }}
                        className="min-h-11 items-start rounded-none border-b border-ide-border px-3 py-2.5 last:border-b-0"
                      >
                        <History size={14} className="mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-ide-text">
                            {entry.command}
                          </pre>
                          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-ide-mute">
                            <span className="truncate font-mono">{entry.cwd}</span>
                            <span className="shrink-0">
                              {new Date(entry.createdAt).toLocaleString(getIntlLocale(locale))}
                            </span>
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {loadMoreFailed && (
                  <div className="border-t border-ide-border px-3 py-2 text-center text-xs text-red-500" role="alert">
                    {t("plugin.blockTerm.loadMoreHistoryFailed")}
                  </div>
                )}
                {hasMore && (
                  <button
                    type="button"
                    className="flex h-11 min-h-11 w-full items-center justify-center gap-2 border-t border-ide-border text-xs text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-60 md:h-9 md:min-h-0"
                    disabled={loadingMore}
                    onClick={loadMore}
                  >
                    {loadingMore && <LoaderCircle size={14} className="animate-spin" />}
                    <span>{t("plugin.blockTerm.loadMoreHistory")}</span>
                  </button>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};

export default BlockTermHistoryDialog;
