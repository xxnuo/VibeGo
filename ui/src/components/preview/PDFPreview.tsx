import React from "react";
import { fileApi } from "@/api/file";
import { usePreviewStore } from "@/stores/previewStore";
import { Download, ExternalLink } from "lucide-react";

const PDFPreview: React.FC = () => {
  const { file } = usePreviewStore();

  if (!file) return null;

  const pdfUrl = fileApi.downloadUrl(file.path);

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <span className="text-xs text-ide-mute truncate flex-1">
          {file.name}
        </span>
        <a
          href={pdfUrl}
          download={file.name}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Download"
        >
          <Download size={18} />
        </a>
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Open in new tab"
        >
          <ExternalLink size={18} />
        </a>
      </div>
      <div className="flex-1">
        <iframe
          src={pdfUrl}
          className="w-full h-full border-0"
          title={file.name}
        />
      </div>
    </div>
  );
};

export default PDFPreview;
