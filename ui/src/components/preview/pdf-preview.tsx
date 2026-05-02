import { Download, ExternalLink } from "lucide-react";
import React from "react";
import { fileApi } from "@/api/file";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";
import { usePreviewStore } from "@/stores/preview-store";

const PDFPreview: React.FC = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const { file } = usePreviewStore();

  if (!file) return null;

  const pdfUrl = fileApi.downloadUrl(file.path);

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-ide-border bg-ide-panel px-2 py-2 md:gap-2 md:px-3">
        <span className="text-xs text-ide-mute truncate flex-1">{file.name}</span>
        <a
          href={pdfUrl}
          download={file.name}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.download")}
          aria-label={t("preview.download")}
        >
          <Download size={18} />
        </a>
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.openInNewTab")}
          aria-label={t("preview.openInNewTab")}
        >
          <ExternalLink size={18} />
        </a>
      </div>
      <div className="flex-1">
        <iframe src={pdfUrl} className="w-full h-full border-0" title={file.name} />
      </div>
    </div>
  );
};

export default PDFPreview;
