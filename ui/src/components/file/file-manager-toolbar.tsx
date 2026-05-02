import {
  ArrowUpDown,
  CheckSquare,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  LayoutGrid,
  LayoutList,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import React, { useState } from "react";
import { useStore } from "zustand";
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

  const sortOptions: { field: SortField; label: string }[] = [
    { field: "name", label: t("fileManager.sortName") },
    { field: "size", label: t("fileManager.sortSize") },
    { field: "modTime", label: t("fileManager.sortDate") },
    { field: "type", label: t("fileManager.sortType") },
  ];

  return (
    <div className="flex flex-col bg-ide-panel border-b border-ide-border">
      <div className="flex items-center gap-1 h-10 px-2">
        {selectionMode ? (
          <>
            <button onClick={toggleSelectionMode} className="p-2 rounded-md text-ide-accent hover:bg-ide-bg">
              <X size={18} />
            </button>
            <span className="text-xs text-ide-mute px-2">
              {t("fileManager.selectedCount").replace("{count}", String(selectedFiles.size))}
            </span>
            <button onClick={selectAll} className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text">
              <CheckSquare size={18} />
            </button>
            <button
              onClick={clearSelection}
              className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
            >
              <Square size={18} />
            </button>
            <div className="flex-1" />
            {selectedFiles.size > 0 && (
              <button onClick={onDeleteSelected} className="p-2 rounded-md text-red-500 hover:bg-red-500/10">
                <Trash2 size={18} />
              </button>
            )}
          </>
        ) : (
          <>
            {searchActive ? (
              <div className="flex-1 flex items-center gap-2 bg-ide-bg rounded-md px-2">
                <Search size={18} className="text-ide-mute" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("fileManager.searchPlaceholder")}
                  className="flex-1 bg-transparent text-sm text-ide-text py-1.5 outline-none"
                  autoFocus
                />
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setSearchActive(false);
                  }}
                  className="p-1 rounded hover:bg-ide-panel"
                >
                  <X size={18} className="text-ide-mute" />
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setSearchActive(true)}
                  className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
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
                    onClick={() => setShowSortMenu(!showSortMenu)}
                    className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                  >
                    <ArrowUpDown size={18} />
                  </button>
                  {showSortMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowSortMenu(false)} />
                      <div className="absolute right-0 top-full mt-1 bg-ide-panel border border-ide-border rounded-md shadow-lg z-20 min-w-[120px]">
                        {sortOptions.map((opt) => (
                          <button
                            key={opt.field}
                            onClick={() => {
                              toggleSort(opt.field);
                              setShowSortMenu(false);
                            }}
                            className={`w-full px-3 py-2 text-left text-xs hover:bg-ide-bg ${
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
                  onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
                  className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                >
                  {viewMode === "list" ? <LayoutGrid size={18} /> : <LayoutList size={18} />}
                </button>

                <button
                  onClick={toggleShowHidden}
                  className={`p-2 rounded-md hover:bg-ide-bg ${
                    showHidden ? "text-ide-accent" : "text-ide-mute hover:text-ide-text"
                  }`}
                >
                  {showHidden ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>

                <div className="w-px h-5 bg-ide-border mx-1" />

                <button
                  onClick={onRefresh}
                  className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                >
                  <RefreshCw size={18} />
                </button>

                {mode === "default" && (
                  <>
                    <button
                      onClick={toggleSelectionMode}
                      className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                    >
                      <CheckSquare size={18} />
                    </button>

                    <div className="w-px h-5 bg-ide-border mx-1" />

                    <button
                      onClick={onUpload}
                      className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                    >
                      <Upload size={18} />
                    </button>

                    <button
                      onClick={onNewFile}
                      className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                    >
                      <FilePlus size={18} />
                    </button>

                    <button
                      onClick={onNewFolder}
                      className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
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
    </div>
  );
};

export default FileManagerToolbar;
