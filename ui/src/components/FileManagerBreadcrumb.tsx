import React, { useRef, useEffect } from 'react';
import { ChevronRight, Home, ChevronLeft, ChevronRight as Forward } from 'lucide-react';
import { useFileManagerStore } from '@/stores/fileManagerStore';

interface FileManagerBreadcrumbProps {
  className?: string;
}

const FileManagerBreadcrumb: React.FC<FileManagerBreadcrumbProps> = ({ className = '' }) => {
  const {
    currentPath,
    historyIndex,
    pathHistory,
    goToPath,
    goBack,
    goForward,
  } = useFileManagerStore();

  const scrollRef = useRef<HTMLDivElement>(null);

  const pathParts = currentPath === '/' || currentPath === '.'
    ? []
    : currentPath.split('/').filter(Boolean);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < pathHistory.length - 1;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [currentPath]);

  const handlePartClick = (index: number) => {
    if (index === -1) {
      goToPath('/');
    } else {
      const newPath = '/' + pathParts.slice(0, index + 1).join('/');
      goToPath(newPath);
    }
  };

  return (
    <div className={`flex items-center gap-1 h-10 px-2 bg-ide-panel border-b border-ide-border ${className}`}>
      <button
        onClick={goBack}
        disabled={!canGoBack}
        className={`p-1.5 rounded-md transition-colors ${
          canGoBack
            ? 'text-ide-text hover:bg-ide-bg active:bg-ide-accent/20'
            : 'text-ide-mute/50 cursor-not-allowed'
        }`}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        onClick={goForward}
        disabled={!canGoForward}
        className={`p-1.5 rounded-md transition-colors ${
          canGoForward
            ? 'text-ide-text hover:bg-ide-bg active:bg-ide-accent/20'
            : 'text-ide-mute/50 cursor-not-allowed'
        }`}
      >
        <Forward size={18} />
      </button>

      <div className="w-px h-5 bg-ide-border mx-1" />

      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-0.5 overflow-x-auto no-scrollbar"
      >
        <button
          onClick={() => handlePartClick(-1)}
          className="shrink-0 p-1.5 rounded-md text-ide-mute hover:text-ide-accent hover:bg-ide-bg transition-colors"
        >
          <Home size={16} />
        </button>

        {pathParts.map((part, index) => (
          <React.Fragment key={index}>
            <ChevronRight size={14} className="shrink-0 text-ide-mute/50" />
            <button
              onClick={() => handlePartClick(index)}
              className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors truncate max-w-[120px] ${
                index === pathParts.length - 1
                  ? 'text-ide-accent bg-ide-accent/10'
                  : 'text-ide-text hover:text-ide-accent hover:bg-ide-bg'
              }`}
            >
              {part}
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export default FileManagerBreadcrumb;
