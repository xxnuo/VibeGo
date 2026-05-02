import { AlertCircle, CheckCircle2, FileUp, FolderUp, Loader2, Upload, X } from "lucide-react";
import React, { useRef, useState } from "react";
import { fileApi, type UploadFileEntry } from "@/api/file";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { type Locale, useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";

type UploadStatus = "uploading" | "done" | "error";

interface UploadRecord {
  id: string;
  name: string;
  count: number;
  size: number;
  progress: number;
  status: UploadStatus;
  errors: string[];
}

interface FileUploadPanelProps {
  open: boolean;
  currentPath: string;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / k ** i).toFixed(1)) + " " + sizes[i];
}

function getEntries(files: FileList | File[]): UploadFileEntry[] {
  return Array.from(files).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

const FileUploadPanel: React.FC<FileUploadPanelProps> = ({ open, currentPath, onOpenChange, onUploaded }) => {
  const locale = (useSettingsStore((s) => s.settings.locale) || "zh") as Locale;
  const t = useTranslation(locale);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [records, setRecords] = useState<UploadRecord[]>([]);
  const [dragging, setDragging] = useState(false);

  const startUpload = async (entries: UploadFileEntry[], fallbackName: string) => {
    if (entries.length === 0) return;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const size = entries.reduce((sum, entry) => sum + entry.file.size, 0);
    const name = entries.length === 1 ? entries[0].relativePath || entries[0].file.name : fallbackName;
    setRecords((current) => [
      {
        id,
        name,
        count: entries.length,
        size,
        progress: 0,
        status: "uploading",
        errors: [],
      },
      ...current,
    ]);
    try {
      const result = await fileApi.upload(currentPath, entries, {
        onProgress: (progress) => {
          setRecords((current) =>
            current.map((record) => (record.id === id ? { ...record, progress: progress.percent } : record))
          );
        },
      });
      setRecords((current) =>
        current.map((record) =>
          record.id === id
            ? {
                ...record,
                progress: 100,
                status: result.errors && result.errors.length > 0 ? "error" : "done",
                errors: result.errors || [],
              }
            : record
        )
      );
      onUploaded();
    } catch (e) {
      setRecords((current) =>
        current.map((record) =>
          record.id === id
            ? {
                ...record,
                status: "error",
                errors: [e instanceof Error ? e.message : t("fileManager.uploadFailed")],
              }
            : record
        )
      );
    }
  };

  const handleFiles = (files: FileList | File[], fallbackName: string) => {
    startUpload(getEntries(files), fallbackName);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-ide-panel border-ide-border text-ide-text md:max-w-lg">
        <div className="flex items-center justify-between gap-3 pr-8">
          <div>
            <h2 className="text-base font-semibold">{t("fileManager.upload")}</h2>
            <div className="text-xs text-ide-mute truncate max-w-[360px]">{currentPath}</div>
          </div>
          <Upload size={20} className="text-ide-mute" />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files, t("fileManager.uploadFiles"));
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files, t("fileManager.uploadFolder"));
            e.target.value = "";
          }}
        />

        <div
          className={`border border-dashed p-4 transition-colors ${
            dragging ? "border-ide-accent bg-ide-accent/10" : "border-ide-border bg-ide-bg"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files, t("fileManager.uploadFiles"));
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 bg-ide-panel px-3 py-3 text-sm hover:bg-ide-border"
            >
              <FileUp size={18} />
              {t("fileManager.uploadFiles")}
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="flex items-center justify-center gap-2 bg-ide-panel px-3 py-3 text-sm hover:bg-ide-border"
            >
              <FolderUp size={18} />
              {t("fileManager.uploadFolder")}
            </button>
          </div>
          <div className="mt-3 text-center text-xs text-ide-mute">{t("fileManager.dropToUpload")}</div>
        </div>

        <div className="space-y-2 max-h-[36vh] overflow-y-auto">
          {records.length === 0 ? (
            <div className="py-6 text-center text-xs text-ide-mute">{t("fileManager.noUploadRecords")}</div>
          ) : (
            records.map((record) => (
              <div key={record.id} className="border border-ide-border bg-ide-bg p-3">
                <div className="flex items-start gap-2">
                  {record.status === "uploading" ? (
                    <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-ide-accent" />
                  ) : record.status === "done" ? (
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ide-accent" />
                  ) : (
                    <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{record.name}</div>
                    <div className="mt-0.5 text-[11px] text-ide-mute">
                      {t("fileManager.uploadRecordMeta")
                        .replace("{count}", String(record.count))
                        .replace("{size}", formatFileSize(record.size))}
                    </div>
                  </div>
                  <div className="text-xs text-ide-mute">{record.progress}%</div>
                </div>
                <div className="mt-2 h-1.5 bg-ide-panel">
                  <div className="h-full bg-ide-accent" style={{ width: `${record.progress}%` }} />
                </div>
                {record.errors.length > 0 && (
                  <div className="mt-2 space-y-1 text-[11px] text-red-500">
                    {record.errors.slice(0, 3).map((error) => (
                      <div key={error} className="truncate">
                        {error}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex items-center gap-2 bg-ide-bg px-3 py-2 text-sm hover:bg-ide-border"
          >
            <X size={16} />
            {t("common.close")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FileUploadPanel;
