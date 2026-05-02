import { Calendar, Copy, Download, Edit3, File, Folder, HardDrive, Link2, Shield, Trash2, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { fileApi } from "@/api/file";
import { ActionButton } from "@/components/common/action-button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { getIntlLocale, type Locale, useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import type { FileItem } from "@/stores/file-manager-store";

interface FileDetailSheetProps {
  file: FileItem | null;
  open: boolean;
  onClose: () => void;
  onDelete?: (file: FileItem) => void;
  onRename?: (file: FileItem) => void | Promise<void>;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / k ** i).toFixed(2)) + " " + sizes[i];
}

function formatDate(dateStr: string, locale: Locale): string {
  const date = new Date(dateStr);
  return date.toLocaleString(getIntlLocale(locale));
}

function formatPermissions(mode: string): string {
  const modeNum = parseInt(mode, 8);
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const owner = perms[(modeNum >> 6) & 7];
  const group = perms[(modeNum >> 3) & 7];
  const other = perms[modeNum & 7];
  return `${owner}${group}${other}`;
}

const FileDetailSheet: React.FC<FileDetailSheetProps> = ({ file, open, onClose, onDelete, onRename }) => {
  const locale = (useSettingsStore((s) => s.settings.locale) || "zh") as Locale;
  const t = useTranslation(locale);
  const renamingRef = useRef(false);
  const suppressCloseUntilRef = useRef(0);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [copiedInfoLabel, setCopiedInfoLabel] = useState<string | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const restorePreviousFocus = () => {
    const element = previousFocusRef.current;
    previousFocusRef.current = null;
    if (element && element.isConnected) {
      window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
    }
  };

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      if (infoCopyTimerRef.current) clearTimeout(infoCopyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (!open && wasOpenRef.current) {
      restorePreviousFocus();
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(
    () => () => {
      if (wasOpenRef.current) restorePreviousFocus();
    },
    []
  );

  if (!file) return null;

  const handleDownload = () => {
    if (!file.isDir) {
      window.open(fileApi.downloadUrl(file.path), "_blank");
    }
  };

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const handleCopyPath = async () => {
    await copyText(file.path);
    setCopySuccess(true);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopySuccess(false);
      copyFeedbackTimerRef.current = null;
    }, 1400);
  };

  const handleRename = async () => {
    if (!onRename || renamingRef.current) return;
    renamingRef.current = true;
    suppressCloseUntilRef.current = Date.now() + 800;
    try {
      await onRename(file);
    } finally {
      renamingRef.current = false;
      suppressCloseUntilRef.current = Date.now() + 300;
    }
  };

  const InfoRow = ({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) => {
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearLongPress = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };

    const markInfoCopied = async () => {
      await copyText(value);
      setCopiedInfoLabel(label);
      if (infoCopyTimerRef.current) clearTimeout(infoCopyTimerRef.current);
      infoCopyTimerRef.current = setTimeout(() => {
        setCopiedInfoLabel(null);
        infoCopyTimerRef.current = null;
      }, 1200);
    };

    return (
      <div
        className="flex items-start gap-3 py-2"
        onContextMenu={(e) => {
          e.preventDefault();
          markInfoCopied();
        }}
        onTouchStart={() => {
          longPressTimerRef.current = setTimeout(() => {
            markInfoCopied();
            longPressTimerRef.current = null;
          }, 500);
        }}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        onTouchCancel={clearLongPress}
      >
        <Icon size={18} className="text-ide-mute mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] text-ide-mute uppercase tracking-wider">{label}</div>
            {copiedInfoLabel === label && <div className="text-[10px] text-ide-accent">{t("common.copied")}</div>}
          </div>
          <div className="text-sm text-ide-text break-all select-text">{value}</div>
        </div>
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !renamingRef.current && Date.now() > suppressCloseUntilRef.current) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="inset-x-0 top-auto bottom-0 translate-x-0 translate-y-0 w-full max-w-2xl rounded-t-2xl rounded-b-none border-t border-x-0 border-b-0 bg-ide-panel p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:inset-auto md:top-[50%] md:left-[50%] md:-translate-x-[50%] md:-translate-y-[50%] md:w-[480px] md:max-w-md md:rounded-2xl md:border md:pb-6"
      >
        <div className="bg-muted mx-auto h-1.5 w-10 rounded-full" />

        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-bg hover:text-ide-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent md:right-4 md:top-4 md:h-8 md:w-8"
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <X size={18} />
        </button>

        <div className="px-4 py-3 space-y-1 overflow-y-auto max-h-[40vh]">
          <InfoRow icon={File} label={t("fileDetail.name")} value={file.name} />
          <InfoRow
            icon={HardDrive}
            label={t("fileDetail.size")}
            value={file.isDir ? "--" : formatFileSize(file.size)}
          />
          <InfoRow icon={Calendar} label={t("fileDetail.modified")} value={formatDate(file.modTime, locale)} />
          <InfoRow
            icon={Shield}
            label={t("fileDetail.permissions")}
            value={`${file.mode} (${formatPermissions(file.mode)})`}
          />
          {file.mimeType && <InfoRow icon={File} label={t("fileDetail.type")} value={file.mimeType} />}
          {file.isSymlink && <InfoRow icon={Link2} label={t("fileDetail.symlink")} value={t("common.yes")} />}
          <InfoRow icon={Folder} label={t("fileDetail.path")} value={file.path} />
        </div>

        <div className="px-4 pt-3 border-t border-ide-border">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <ActionButton
              onClick={handleCopyPath}
              icon={<Copy size={20} className="text-ide-mute" />}
              label={copySuccess ? t("common.copied") : t("fileDetail.copyPath")}
            />
            {onRename && (
              <ActionButton
                onClick={handleRename}
                icon={<Edit3 size={20} className="text-ide-mute" />}
                label={t("common.rename")}
              />
            )}
            {!file.isDir && (
              <ActionButton
                onClick={handleDownload}
                icon={<Download size={20} className="text-ide-mute" />}
                label={t("fileDetail.download")}
              />
            )}
            {onDelete && (
              <ActionButton
                onClick={() => onDelete(file)}
                icon={<Trash2 size={20} className="text-red-500" />}
                label={t("common.delete")}
                destructive
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FileDetailSheet;
