import React, { useState, useRef, useCallback } from "react";
import type { FileItem } from "@/stores/fileManagerStore";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ExternalLink,
  Download,
} from "lucide-react";
import { fileApi } from "@/api/file";
import { usePreviewStore } from "@/stores/previewStore";

const ImagePreviewContent: React.FC<{ file: FileItem }> = ({ file }) => {
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <button
          onClick={handleZoomOut}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Zoom Out"
        >
          <ZoomOut size={18} />
        </button>
        <span className="text-xs text-ide-mute min-w-[50px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Zoom In"
        >
          <ZoomIn size={18} />
        </button>
        <button
          onClick={handleReset}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Reset"
        >
          <RotateCcw size={18} />
        </button>
        <div className="flex-1" />
        <a
          href={imageUrl}
          download={file.name}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Download"
        >
          <Download size={18} />
        </a>
        <button
          onClick={() => window.open(imageUrl, "_blank")}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Open in new tab"
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
