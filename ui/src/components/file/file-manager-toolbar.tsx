import {
  ArrowUpDown,
  CheckSquare,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  LayoutGrid,
  LayoutList,
  MoreHorizontal,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import ContextSheet from "@/components/ui/context-sheet";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";
import { type FileManagerStoreApi, fileManagerStore, type SortField } from "@/stores/file-manager-store";

interface FileManagerToolbarProps {
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onDeleteSelected: () => void;
  mode?: "default" | "directory-picker";
  store?: FileManagerStoreApi;
}

const FileManagerToolbar: React.FC<FileManagerToolbarProps> = ({
  onRefresh,
  onNewFile,
  onNewFolder,
  onUpload,
  onDeleteSelected,
  mode = "default",
  store,
}) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const storeApi = store ?? fileManagerStore;
  const {
    searchQuery,
    searchActive,
    setSearchQuery,
    setSearchActive,
    showHidden,
    toggleShowHidden,
    viewMode,
    setViewMode,
    selectionMode,
    toggleSelectionMode,
    selectedFiles,
    selectAll,
    clearSelection,
    sortField,
    toggleSort,
  } = useStore(storeApi);

  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showMobileActions, setShowMobileActions] = useState(false);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSortMenu) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      sortMenuRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowSortMenu(false);
        sortTriggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Tab") return;
      const menu = sortMenuRef.current;
      if (!menu) return;
      const focusable = Array.from(menu.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!menu.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      if (previousFocus?.isConnected && previousFocus !== document.body) {
        window.requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
      }
    };
  }, [showSortMenu]);

  const sortOptions: { field: SortField; label: string }[] = [
    { field: "name", label: t("fileManager.sortName") },
    { field: "size", label: t("fileManager.sortSize") },
    { field: "modTime", label: t("fileManager.sortDate") },
    { field: "type", label: t("fileManager.sortType") },
  ];

  return (
    <div className="flex flex-col bg-ide-panel border-b border-ide-border">
      <div className="flex h-12 items-center gap-1 overflow-x-auto px-2 custom-scrollbar touch-pan-x md:h-10">
        {selectionMode ? (
          <>
            <button
              type="button"
              onClick={toggleSelectionMode}
              title={t("common.close")}
              aria-label={t("common.close")}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-accent hover:bg-ide-bg md:size-auto md:p-2"
            >
              <X size={18} />
            </button>
            <span className="text-xs text-ide-mute px-2">
              {t("fileManager.selectedCount").replace("{count}", String(selectedFiles.size))}
            </span>
            <button
              type="button"
              onClick={selectAll}
              title={t("common.selectAll")}
              aria-label={t("common.selectAll")}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-2"
            >
              <CheckSquare size={18} />
            </button>
            <button
              type="button"
              onClick={clearSelection}
              title={t("common.clear")}
              aria-label={t("common.clear")}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-2"
            >
              <Square size={18} />
            </button>
            <div className="flex-1" />
            {selectedFiles.size > 0 && (
              <button
                type="button"
                onClick={onDeleteSelected}
                title={t("common.delete")}
                aria-label={t("common.delete")}
                className="flex size-11 shrink-0 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 md:size-auto md:p-2"
              >
                <Trash2 size={18} />
              </button>
            )}
          </>
        ) : (
          <>
            {searchActive ? (
              <div className="flex h-11 min-w-[12rem] flex-1 items-center gap-2 rounded-md bg-ide-bg px-2 md:h-auto md:min-w-0">
                <Search size={18} className="text-ide-mute" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("fileManager.searchPlaceholder")}
                  name="file-manager-search"
                  aria-label={t("fileManager.searchPlaceholder")}
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-base text-ide-text outline-none md:text-sm"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchActive(false);
                  }}
                  title={t("common.close")}
                  aria-label={t("common.close")}
                  className="flex size-11 shrink-0 items-center justify-center rounded hover:bg-ide-panel md:size-auto md:p-1"
                >
                  <X size={18} className="text-ide-mute" />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setSearchActive(true)}
                  title={t("common.search")}
                  aria-label={t("common.search")}
                  className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-2"
                >
                  <Search size={18} />
                </button>
                <div className="flex-1" />
              </>
            )}

            {!searchActive && (
              <>
                <div className="relative">
                  <button
                    ref={sortTriggerRef}
                    type="button"
                    onClick={() => setShowSortMenu(!showSortMenu)}
                    title={t("common.sort")}
                    aria-label={t("common.sort")}
                    aria-haspopup="menu"
                    aria-expanded={showSortMenu}
                    className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-2"
                  >
                    <ArrowUpDown size={18} />
                  </button>
                  {showSortMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowSortMenu(false)} />
                      <div
                        ref={sortMenuRef}
                        role="menu"
                        aria-label={t("common.sort")}
                        className="absolute right-0 top-full z-20 mt-1 max-h-[min(60dvh,20rem)] min-w-[120px] overflow-y-auto rounded-md border border-ide-border bg-ide-panel shadow-lg"
                      >
                        {sortOptions.map((opt) => (
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={sortField === opt.field}
                            key={opt.field}
                            onClick={() => {
                              toggleSort(opt.field);
                              setShowSortMenu(false);
                            }}
                            className={`min-h-11 w-full px-3 py-2 text-left text-xs hover:bg-ide-bg md:min-h-0 ${
                              sortField === opt.field ? "text-ide-accent" : "text-ide-text"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
                  title={viewMode === "list" ? t("settings.option.grid") : t("settings.option.list")}
                  aria-label={viewMode === "list" ? t("settings.option.grid") : t("settings.option.list")}
                  className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-2"
                >
                  {viewMode === "list" ? <LayoutGrid size={18} /> : <LayoutList size={18} />}
                </button>

                <button
                  type="button"
                  onClick={toggleShowHidden}
                  title={showHidden ? t("fileManager.hideHidden") : t("fileManager.showHidden")}
                  aria-label={showHidden ? t("fileManager.hideHidden") : t("fileManager.showHidden")}
                  className={`hidden size-11 shrink-0 items-center justify-center rounded-md hover:bg-ide-bg md:flex md:size-auto md:p-2 ${
                    showHidden ? "text-ide-accent" : "text-ide-mute hover:text-ide-text"
                  }`}
                >
                  {showHidden ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>

                <div className="mx-1 hidden h-5 w-px bg-ide-border md:block" />

                <button
                  type="button"
                  onClick={onRefresh}
                  title={t("common.refresh")}
                  aria-label={t("common.refresh")}
                  className="hidden size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:flex md:size-auto md:p-2"
                >
                  <RefreshCw size={18} />
                </button>

                {mode === "default" && (
                  <>
                    <button
                      type="button"
                      onClick={toggleSelectionMode}
                      title={t("common.select")}
                      aria-label={t("common.select")}
                      className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-2"
                    >
                      <CheckSquare size={18} />
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowMobileActions(true)}
                      title={t("common.moreActions")}
                      aria-label={t("common.moreActions")}
                      aria-haspopup="dialog"
                      aria-expanded={showMobileActions}
                      className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:hidden"
                    >
                      <MoreHorizontal size={18} />
                    </button>

                    <div className="mx-1 hidden h-5 w-px bg-ide-border md:block" />

                    <button
                      type="button"
                      onClick={onUpload}
                      title={t("fileManager.upload")}
                      aria-label={t("fileManager.upload")}
                      className="hidden size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:flex md:size-auto md:p-2"
                    >
                      <Upload size={18} />
                    </button>

                    <button
                      type="button"
                      onClick={onNewFile}
                      title={t("fileManager.newFile")}
                      aria-label={t("fileManager.newFile")}
                      className="hidden size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:flex md:size-auto md:p-2"
                    >
                      <FilePlus size={18} />
                    </button>

                    <button
                      type="button"
                      onClick={onNewFolder}
                      title={t("fileManager.newFolder")}
                      aria-label={t("fileManager.newFolder")}
                      className="hidden size-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:flex md:size-auto md:p-2"
                    >
                      <FolderPlus size={18} />
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <ContextSheet
        open={showMobileActions}
        onClose={() => setShowMobileActions(false)}
        title={t("common.moreActions")}
        items={[
          {
            icon: showHidden ? <EyeOff size={18} /> : <Eye size={18} />,
            label: showHidden ? t("fileManager.hideHidden") : t("fileManager.showHidden"),
            onClick: toggleShowHidden,
          },
          {
            icon: <RefreshCw size={18} />,
            label: t("common.refresh"),
            onClick: onRefresh,
          },
          ...(mode === "default"
            ? [
                {
                  icon: <Upload size={18} />,
                  label: t("fileManager.upload"),
                  onClick: onUpload,
                },
                {
                  icon: <FilePlus size={18} />,
                  label: t("fileManager.newFile"),
                  onClick: onNewFile,
                },
                {
                  icon: <FolderPlus size={18} />,
                  label: t("fileManager.newFolder"),
                  onClick: onNewFolder,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
};

export default FileManagerToolbar;
