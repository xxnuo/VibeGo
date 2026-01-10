import React from "react";
import { fileApi } from "@/api/file";
import { usePreviewStore } from "@/stores/previewStore";
import { Download, ExternalLink } from "lucide-react";

const MediaPreview: React.FC = () => {
  const { file } = usePreviewStore();

  if (!file) return null;

  const mediaUrl = fileApi.downloadUrl(file.path);
  const isVideo =
    file.mimeType?.startsWith("video/") ||
    [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"].includes(
      file.extension?.toLowerCase() || "",
    );

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <span className="text-xs text-ide-mute truncate flex-1">
          {file.name}
        </span>
        <a
          href={mediaUrl}
          download={file.name}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Download"
        >
          <Download size={16} />
        </a>
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Open in new tab"
        >
          <ExternalLink size={16} />
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
            Your browser does not support video playback.
          </video>
        ) : (
          <audio src={mediaUrl} controls className="w-full max-w-md">
            Your browser does not support audio playback.
          </audio>
        )}
      </div>
    </div>
  );
};

export default MediaPreview;
