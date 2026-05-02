import { Bookmark, BookmarkPlus, Check, Clipboard, LoaderCircle, Play, Search, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type BlockTermBookmark, type BlockTermBookmarkInput, blockTermApi } from "@/api/blockterm";
import {
  createBlockTermBookmarkDraft,
  getBlockTermBookmarkDisplayTitle,
  getBlockTermBookmarkSelectionAfterDelete,
  upsertBlockTermBookmark,
  validateBlockTermBookmarkDraft,
} from "@/components/terminal/blockterm-bookmark";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";

interface BlockTermBookmarkDialogProps {
  open: boolean;
  initialCommand?: string;
  onOpenChange: (open: boolean) => void;
  onUseCommand: (command: string) => void;
}

const SEARCH_DEBOUNCE_MS = 180;

const BlockTermBookmarkDialog: React.FC<BlockTermBookmarkDialogProps> = ({
  open,
  initialCommand,
  onOpenChange,
  onUseCommand,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const [query, setQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<BlockTermBookmark[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BlockTermBookmarkInput>(() => createBlockTermBookmarkDraft());
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const searchRevisionRef = useRef(0);
  const selectedBookmarkRef = useRef<BlockTermBookmark | null>(null);

  const startCreate = useCallback((command = "") => {
    selectedBookmarkRef.current = null;
    setSelectedId(null);
    setDraft(createBlockTermBookmarkDraft(null, command));
    setValidationError(null);
    setCopied(false);
  }, []);

  const selectBookmark = useCallback((bookmark: BlockTermBookmark) => {
    selectedBookmarkRef.current = bookmark;
    setSelectedId(bookmark.id);
    setDraft(createBlockTermBookmarkDraft(bookmark));
    setValidationError(null);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    startCreate(initialCommand || "");
  }, [initialCommand, open, startCreate]);

  useEffect(() => {
    const revision = searchRevisionRef.current + 1;
    searchRevisionRef.current = revision;
    if (!open) {
      setBookmarks([]);
      setLoading(false);
      setFailed(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    const timer = window.setTimeout(() => {
      void blockTermApi
        .listBookmarks({ query: query || undefined, limit: 200, signal: controller.signal })
        .then((result) => {
          if (searchRevisionRef.current !== revision) return;
          setBookmarks(result.bookmarks);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted || searchRevisionRef.current !== revision) return;
          setBookmarks([]);
          setLoading(false);
          setFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, reloadRevision]);

  const updateDraft = useCallback((patch: Partial<BlockTermBookmarkInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
  }, []);

  const saveBookmark = useCallback(async () => {
    const error = validateBlockTermBookmarkDraft(draft);
    if (error) {
      setValidationError(error);
      return;
    }

    setSaving(true);
    try {
      const result = selectedId
        ? await blockTermApi.updateBookmark(selectedId, draft)
        : await blockTermApi.createBookmark(draft);
      searchRevisionRef.current += 1;
      setBookmarks((current) => upsertBlockTermBookmark(current, result.bookmark));
      selectedBookmarkRef.current = result.bookmark;
      setSelectedId(result.bookmark.id);
      setDraft(createBlockTermBookmarkDraft(result.bookmark));
      setQuery("");
      setValidationError(null);
      setReloadRevision((current) => current + 1);
      toast.success(t("plugin.blockTerm.bookmarkSaved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.bookmarkSaveFailed"));
    } finally {
      setSaving(false);
    }
  }, [draft, selectedId, t]);

  const deleteBookmark = useCallback(async () => {
    if (!selectedId) return;
    const deletedId = selectedId;
    const nextId = getBlockTermBookmarkSelectionAfterDelete(bookmarks, deletedId);
    setDeleting(true);
    try {
      await blockTermApi.removeBookmark(deletedId);
      searchRevisionRef.current += 1;
      const remaining = bookmarks.filter((bookmark) => bookmark.id !== deletedId);
      setBookmarks(remaining);
      const nextBookmark = remaining.find((bookmark) => bookmark.id === nextId);
      if (nextBookmark) selectBookmark(nextBookmark);
      else startCreate();
      setReloadRevision((current) => current + 1);
      toast.success(t("plugin.blockTerm.bookmarkDeleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.bookmarkDeleteFailed"));
    } finally {
      setDeleting(false);
    }
  }, [bookmarks, selectedId, selectBookmark, startCreate, t]);

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      toast.success(t("plugin.blockTerm.bookmarkCommandCopied"));
    } catch {
      toast.error(t("plugin.blockTerm.bookmarkCommandCopyFailed"));
    }
  }, [draft.command, t]);

  const resetDraft = useCallback(() => {
    const selected = selectedBookmarkRef.current;
    if (selected) selectBookmark(selected);
    else startCreate(initialCommand || "");
  }, [initialCommand, selectBookmark, startCreate]);

  const useCommand = useCallback(() => {
    if (!draft.command.trim()) return;
    onUseCommand(draft.command);
    onOpenChange(false);
  }, [draft.command, onOpenChange, onUseCommand]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(82dvh,44rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-t-md p-0 md:max-w-4xl md:grid-rows-[auto_minmax(0,1fr)] md:rounded-md">
        <DialogHeader className="border-b border-ide-border px-4 py-3 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base text-ide-text">
            <Bookmark size={16} className="text-ide-accent" />
            {t("plugin.blockTerm.bookmarks")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("plugin.blockTerm.bookmarkManagerDescription")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-rows-[12rem_minmax(0,1fr)] md:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.15fr)] md:grid-rows-1">
          <section className="flex min-h-0 flex-col border-b border-ide-border md:border-r md:border-b-0">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ide-border px-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-ide-mute">
                <Search size={14} className="shrink-0" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 min-w-0 flex-1 bg-transparent text-sm text-ide-text outline-none placeholder:text-ide-mute"
                  placeholder={t("plugin.blockTerm.searchBookmarks")}
                />
              </div>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center border border-ide-border text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                title={t("plugin.blockTerm.newBookmark")}
                aria-label={t("plugin.blockTerm.newBookmark")}
                onClick={() => startCreate()}
              >
                <BookmarkPlus size={14} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
              {loading ? (
                <div className="flex h-24 items-center justify-center text-ide-mute">
                  <LoaderCircle size={16} className="animate-spin" />
                  <span className="sr-only">{t("common.loading")}</span>
                </div>
              ) : failed ? (
                <div className="px-4 py-8 text-center text-sm text-red-500">
                  {t("plugin.blockTerm.bookmarkSearchFailed")}
                </div>
              ) : bookmarks.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-ide-mute">{t("plugin.blockTerm.bookmarkEmpty")}</div>
              ) : (
                bookmarks.map((bookmark) => {
                  const selected = bookmark.id === selectedId;
                  return (
                    <button
                      key={bookmark.id}
                      type="button"
                      className={`block w-full border-b border-ide-border px-3 py-2.5 text-left last:border-b-0 ${
                        selected ? "bg-ide-bg text-ide-accent" : "text-ide-text hover:bg-ide-bg"
                      }`}
                      onClick={() => selectBookmark(bookmark)}
                    >
                      <span className="block truncate text-sm font-medium">
                        {getBlockTermBookmarkDisplayTitle(bookmark)}
                      </span>
                      {bookmark.description && (
                        <span className="mt-1 line-clamp-1 block text-xs text-ide-mute">{bookmark.description}</span>
                      )}
                      <span className="mt-1 line-clamp-2 block whitespace-pre-wrap break-words font-mono text-[11px] text-ide-mute">
                        {bookmark.command}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <form
            className="flex min-h-0 flex-col bg-ide-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void saveBookmark();
            }}
          >
            <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-ide-border px-3">
              <span className="truncate text-sm font-medium text-ide-text">
                {selectedId ? t("plugin.blockTerm.editBookmark") : t("plugin.blockTerm.newBookmark")}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-50"
                  title={t("plugin.blockTerm.copyBookmarkCommand")}
                  aria-label={t("plugin.blockTerm.copyBookmarkCommand")}
                  disabled={!draft.command}
                  onClick={() => void copyCommand()}
                >
                  {copied ? <Check size={14} /> : <Clipboard size={14} />}
                </button>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-50"
                  title={t("plugin.blockTerm.useBookmarkCommand")}
                  aria-label={t("plugin.blockTerm.useBookmarkCommand")}
                  disabled={!draft.command.trim()}
                  onClick={useCommand}
                >
                  <Play size={14} />
                </button>
                {selectedId && (
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-red-500 disabled:opacity-50"
                    title={t("plugin.blockTerm.deleteBookmark")}
                    aria-label={t("plugin.blockTerm.deleteBookmark")}
                    disabled={deleting || saving}
                    onClick={() => void deleteBookmark()}
                  >
                    {deleting ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 custom-scrollbar">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ide-text">{t("plugin.blockTerm.bookmarkTitle")}</span>
                <input
                  value={draft.title}
                  onChange={(event) => updateDraft({ title: event.target.value })}
                  aria-invalid={validationError === "titleTooLong"}
                  className="h-9 w-full border border-ide-border bg-ide-bg px-2.5 text-sm text-ide-text outline-none focus:border-ide-accent aria-invalid:border-red-500"
                  placeholder={t("plugin.blockTerm.bookmarkTitlePlaceholder")}
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ide-text">{t("plugin.blockTerm.bookmarkDescription")}</span>
                <textarea
                  value={draft.description}
                  onChange={(event) => updateDraft({ description: event.target.value })}
                  rows={3}
                  aria-invalid={validationError === "descriptionTooLong"}
                  className="block w-full resize-y border border-ide-border bg-ide-bg px-2.5 py-2 text-sm text-ide-text outline-none focus:border-ide-accent aria-invalid:border-red-500"
                  placeholder={t("plugin.blockTerm.bookmarkDescriptionPlaceholder")}
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ide-text">{t("plugin.blockTerm.bookmarkCommand")}</span>
                <textarea
                  value={draft.command}
                  onChange={(event) => updateDraft({ command: event.target.value })}
                  rows={8}
                  aria-invalid={validationError === "commandRequired" || validationError === "commandTooLong"}
                  className="block min-h-36 w-full resize-y border border-ide-border bg-ide-bg px-2.5 py-2 font-mono text-sm text-ide-text outline-none focus:border-ide-accent aria-invalid:border-red-500"
                  placeholder={t("plugin.blockTerm.bookmarkCommandPlaceholder")}
                />
              </label>

              {validationError && (
                <div className="text-xs text-red-500">
                  {t(`plugin.blockTerm.bookmarkValidation.${validationError}`)}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ide-border px-4 py-3">
              <button
                type="button"
                className="h-8 border border-ide-border px-3 text-xs text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                disabled={saving || deleting}
                onClick={resetDraft}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="flex h-8 min-w-20 items-center justify-center gap-1.5 bg-ide-accent px-3 text-xs text-ide-on-accent disabled:bg-ide-border disabled:text-ide-mute"
                disabled={saving || deleting}
              >
                {saving && <LoaderCircle size={14} className="animate-spin" />}
                {t("common.save")}
              </button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BlockTermBookmarkDialog;
