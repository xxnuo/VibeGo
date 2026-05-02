import { Download, ExternalLink, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { fileApi } from "@/api/file";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";
import type { FileItem } from "@/stores/file-manager-store";
import { usePreviewStore } from "@/stores/preview-store";

const ImagePreviewContent: React.FC<{ file: FileItem }> = ({ file }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const [scale, setScale] = useState(1);
  const [initialScale, setInitialScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const imageUrl = fileApi.downloadUrl(file.path);

  const handleZoomIn = () => setScale((s) => Math.min(s * 1.25, 5));
  const handleZoomOut = () => setScale((s) => Math.max(s / 1.25, 0.1));
  const handleReset = useCallback(() => {
    setScale(initialScale);
    setPosition({ x: 0, y: 0 });
  }, [initialScale]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) handleZoomIn();
    else handleZoomOut();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleImageLoad = () => {
    if (containerRef.current && imageRef.current) {
      const container = containerRef.current;
      const img = imageRef.current;
      const containerWidth = container.clientWidth - 32;
      const containerHeight = container.clientHeight - 32;
      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;
      const scaleX = containerWidth / imgWidth;
      const scaleY = containerHeight / imgHeight;
      const fitScale = Math.min(scaleX, scaleY, 1);
      setInitialScale(fitScale);
      setScale(fitScale);
      setImageLoaded(true);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-ide-border bg-ide-panel px-2 py-2 md:gap-2 md:px-3">
        <button
          type="button"
          onClick={handleZoomOut}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.zoomOut")}
          aria-label={t("preview.zoomOut")}
        >
          <ZoomOut size={18} />
        </button>
        <span className="min-w-11 shrink-0 text-center text-xs text-ide-mute md:min-w-[50px]">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={handleZoomIn}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.zoomIn")}
          aria-label={t("preview.zoomIn")}
        >
          <ZoomIn size={18} />
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.reset")}
          aria-label={t("preview.reset")}
        >
          <RotateCcw size={18} />
        </button>
        <div className="min-w-2 flex-1" />
        <a
          href={imageUrl}
          download={file.name}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.download")}
          aria-label={t("preview.download")}
        >
          <Download size={18} />
        </a>
        <button
          type="button"
          onClick={() => window.open(imageUrl, "_blank")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-auto md:w-auto md:p-1.5"
          title={t("preview.openInNewTab")}
          aria-label={t("preview.openInNewTab")}
        >
          <ExternalLink size={18} />
        </button>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt={file.name}
          className="max-w-none select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging ? "none" : "transform 0.1s ease-out",
            opacity: imageLoaded ? 1 : 0,
          }}
          draggable={false}
          onLoad={handleImageLoad}
        />
      </div>
    </div>
  );
};

const ImagePreview: React.FC = () => {
  const { file } = usePreviewStore();
  if (!file) return null;
  return <ImagePreviewContent file={file} key={file.path} />;
};

export default ImagePreview;
