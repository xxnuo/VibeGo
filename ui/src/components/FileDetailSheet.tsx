import React from "react";
import {
  File,
  Folder,
  Calendar,
  HardDrive,
  Shield,
  Link2,
  Download,
  Trash2,
  Edit3,
  Copy,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { FileItem } from "@/stores/fileManagerStore";
import { fileApi } from "@/api/file";

import { useTranslation, type Locale } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";

interface FileDetailSheetProps {
  file: FileItem | null;
  open: boolean;
  onClose: () => void;
  onDelete?: (file: FileItem) => void;
  onRename?: (file: FileItem) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function formatPermissions(mode: string): string {
  const modeNum = parseInt(mode, 8);
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const owner = perms[(modeNum >> 6) & 7];
  const group = perms[(modeNum >> 3) & 7];
  const other = perms[modeNum & 7];
  return `${owner}${group}${other}`;
}

const FileDetailSheet: React.FC<FileDetailSheetProps> = ({
  file,
  open,
  onClose,
  onDelete,
  onRename,
}) => {
  const locale = (useSettingsStore((s) => s.settings.locale) || "zh") as Locale;
  const t = useTranslation(locale);

  if (!file) return null;

  const handleDownload = () => {
    if (!file.isDir) {
      window.open(fileApi.downloadUrl(file.path), "_blank");
    }
  };

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(file.path);
  };

  const InfoRow = ({
    icon: Icon,
    label,
    value,
  }: {
    icon: React.ElementType;
    label: string;
    value: string;
  }) => (
    <div className="flex items-start gap-3 py-2">
      <Icon size={18} className="text-ide-mute mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-ide-mute uppercase tracking-wider">
          {label}
        </div>
        <div className="text-sm text-ide-text break-all">{value}</div>
      </div>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className="bg-ide-panel border-t border-ide-border rounded-t-xl max-h-[70vh]"
      >
        <SheetHeader className="pb-2 border-b border-ide-border">
          <div className="flex items-center gap-3">
            {file.isDir ? (
              <Folder size={24} className="text-ide-accent" />
            ) : (
              <File size={24} className="text-ide-accent" />
            )}
            <SheetTitle className="text-ide-text text-left flex-1 truncate">
              {file.name}
            </SheetTitle>
          </div>
        </SheetHeader>

        <div className="px-4 py-3 space-y-1 overflow-y-auto max-h-[40vh]">
          <InfoRow
            icon={HardDrive}
            label={t("fileDetail.size")}
            value={file.isDir ? "--" : formatFileSize(file.size)}
          />
          <InfoRow
            icon={Calendar}
            label={t("fileDetail.modified")}
            value={formatDate(file.modTime)}
          />
          <InfoRow
            icon={Shield}
            label={t("fileDetail.permissions")}
            value={`${file.mode} (${formatPermissions(file.mode)})`}
          />
          {file.mimeType && (
            <InfoRow
              icon={File}
              label={t("fileDetail.type")}
              value={file.mimeType}
            />
          )}
          {file.isSymlink && (
            <InfoRow icon={Link2} label={t("fileDetail.symlink")} value="Yes" />
          )}
          <InfoRow
            icon={Folder}
            label={t("fileDetail.path")}
            value={file.path}
          />
        </div>

        <div className="px-4 pt-3 border-t border-ide-border">
          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={handleCopyPath}
              className="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-ide-bg transition-colors"
            >
              <Copy size={20} className="text-ide-mute" />
              <span className="text-[10px] text-ide-mute">
                {t("fileDetail.copyPath")}
              </span>
            </button>
            {onRename && (
              <button
                onClick={() => onRename(file)}
                className="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-ide-bg transition-colors"
              >
                <Edit3 size={20} className="text-ide-mute" />
                <span className="text-[10px] text-ide-mute">
                  {t("common.rename")}
                </span>
              </button>
            )}
            {!file.isDir && (
              <button
                onClick={handleDownload}
                className="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-ide-bg transition-colors"
              >
                <Download size={20} className="text-ide-mute" />
                <span className="text-[10px] text-ide-mute">
                  {t("fileDetail.download")}
                </span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(file)}
                className="flex flex-col items-center gap-1 p-3 rounded-lg hover:bg-ide-bg transition-colors"
              >
                <Trash2 size={20} className="text-red-500" />
                <span className="text-[10px] text-red-500">
                  {t("common.delete")}
                </span>
              </button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default FileDetailSheet;
