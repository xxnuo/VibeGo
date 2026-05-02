import { FolderOpen, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useStore } from "zustand";
import { FileManager } from "@/components/file";
import { type Locale, useTranslation } from "@/lib/i18n";
import { createFileManagerStore } from "@/stores/file-manager-store";

interface DirectoryPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  locale: Locale;
}

const DirectoryPicker: React.FC<DirectoryPickerProps> = ({ isOpen, onClose, onSelect, initialPath = ".", locale }) => {
  const t = useTranslation(locale);
  const [pickerStore] = useState(() => createFileManagerStore());
  const currentPath = useStore(pickerStore, (state) => state.currentPath);
  const loading = useStore(pickerStore, (state) => state.loading);
  const error = useStore(pickerStore, (state) => state.error);

  useEffect(() => {
    if (!isOpen) return;
    pickerStore.getState().reset();
    pickerStore.setState({
      currentPath: initialPath,
      rootPath: initialPath,
      pathHistory: [initialPath],
      historyIndex: 0,
      sortField: "modTime",
      sortOrder: "desc",
    });
  }, [initialPath, isOpen, pickerStore]);

  const handleSelect = () => {
    onSelect(currentPath);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("directoryPicker.title")}
        className="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:p-4"
      >
        <div className="flex h-full w-full flex-col overflow-hidden bg-ide-panel sm:h-[84vh] sm:max-h-[84vh] sm:max-w-5xl sm:rounded-2xl sm:border sm:border-ide-border sm:shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-ide-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ide-text sm:text-base">{t("directoryPicker.title")}</h3>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text">
              <X size={20} />
            </button>
          </div>

          <div className="min-h-0 flex-1">
            <FileManager initialPath={initialPath} mode="directory-picker" store={pickerStore} />
          </div>

          <div className="border-t border-ide-border px-4 py-3">
            <div className="mb-3 flex items-center gap-2 rounded-xl bg-ide-bg px-3 py-2">
              <FolderOpen size={18} className="shrink-0 text-ide-accent" />
              <span className="truncate text-sm text-ide-text">{currentPath}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-ide-border px-4 py-2.5 text-sm text-ide-text hover:bg-ide-bg"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleSelect}
                disabled={loading || !!error}
                className="flex-1 rounded-lg bg-ide-accent px-4 py-2.5 text-sm font-medium text-ide-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("common.select")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default DirectoryPicker;
