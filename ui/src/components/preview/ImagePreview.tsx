import React, { useState, useRef, useEffect } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2 } from 'lucide-react';
import { fileApi } from '@/api/file';
import { usePreviewStore } from '@/stores/previewStore';

const ImagePreview: React.FC = () => {
  const { file } = usePreviewStore();
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const imageUrl = file ? fileApi.downloadUrl(file.path) : '';

  const handleZoomIn = () => setScale((s) => Math.min(s * 1.25, 5));
  const handleZoomOut = () => setScale((s) => Math.max(s / 1.25, 0.1));
  const handleReset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) handleZoomIn();
    else handleZoomOut();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
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

  useEffect(() => {
    handleReset();
  }, [file?.path]);

  if (!file) return null;

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <button
          onClick={handleZoomOut}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs text-ide-mute min-w-[50px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
        <button
          onClick={handleReset}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          title="Reset"
        >
          <RotateCcw size={16} />
        </button>
        <button
          onClick={() => window.open(imageUrl, '_blank')}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text ml-auto"
          title="Open in new tab"
        >
          <Maximize2 size={16} />
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
          src={imageUrl}
          alt={file.name}
          className="max-w-none select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
          draggable={false}
        />
      </div>
    </div>
  );
};

export default ImagePreview;
