import { FolderOpen, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useStore } from "zustand";
import { FileManager } from "@/components/file";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { type Locale, useTranslation } from "@/lib/i18n";
import { createFileManagerStore } from "@/stores/file-manager-store";

interface DirectoryPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  locale: Locale;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

const DirectoryPicker: React.FC<DirectoryPickerProps> = ({
  isOpen,
  onClose,
  onSelect,
  initialPath = ".",
  locale,
  restoreFocusRef,
}) => {
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

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-label={t("directoryPicker.title")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = restoreFocusRef?.current;
          if (target?.isConnected) {
            window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
          }
        }}
        className="inset-0 top-0 bottom-0 flex h-[100dvh] max-h-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-ide-panel p-0 pb-0 shadow-none [&>div:first-child]:hidden md:inset-auto md:top-1/2 md:left-1/2 md:h-[84dvh] md:max-h-[84dvh] md:w-[calc(100%-2rem)] md:max-w-5xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-ide-border md:shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ide-border px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 md:px-4 md:py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ide-text md:text-base">{t("directoryPicker.title")}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-8 md:w-8"
          >
            <X size={20} />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          <FileManager initialPath={initialPath} mode="directory-picker" store={pickerStore} />
        </div>

        <div className="shrink-0 border-t border-ide-border px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:py-3">
          <div className="mb-2 flex min-h-11 items-center gap-2 rounded-md bg-ide-bg px-3 py-2 md:mb-3 md:min-h-0">
            <FolderOpen size={18} className="shrink-0 text-ide-accent" />
            <span className="truncate text-sm text-ide-text">{currentPath}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-md border border-ide-border px-3 text-sm text-ide-text hover:bg-ide-bg md:min-h-9"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleSelect}
              disabled={loading || !!error}
              className="min-h-11 rounded-md bg-ide-accent px-3 text-sm font-medium text-ide-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9"
            >
              {t("common.select")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DirectoryPicker;
