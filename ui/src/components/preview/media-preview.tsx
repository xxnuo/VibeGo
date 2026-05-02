import { Download, ExternalLink } from "lucide-react";
import React from "react";
import { fileApi } from "@/api/file";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";
import { usePreviewStore } from "@/stores/preview-store";

const MediaPreview: React.FC = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const { file } = usePreviewStore();

  if (!file) return null;

  const mediaUrl = fileApi.downloadUrl(file.path);
  const isVideo =
    file.mimeType?.startsWith("video/") ||
    [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"].includes(file.extension?.toLowerCase() || "");

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-ide-border bg-ide-panel px-2 py-2 md:gap-2 md:px-3">
        <span className="text-xs text-ide-mute truncate flex-1">{file.name}</span>
        <a
          href={mediaUrl}
          download={file.name}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.download")}
          aria-label={t("preview.download")}
        >
          <Download size={18} />
        </a>
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.openInNewTab")}
          aria-label={t("preview.openInNewTab")}
        >
          <ExternalLink size={18} />
        </a>
      </div>
      <div className="flex-1 flex items-center justify-center p-4">
        {isVideo ? (
          <video
            src={mediaUrl}
            controls
            className="max-w-full max-h-full rounded"
            style={{ maxHeight: "calc(100vh - 200px)" }}
          >
            {t("preview.videoUnsupported")}
          </video>
        ) : (
          <audio src={mediaUrl} controls className="w-full max-w-md">
            {t("preview.audioUnsupported")}
          </audio>
        )}
      </div>
    </div>
  );
};

export default MediaPreview;
