import React, { useEffect, useState } from 'react';
import { usePreviewStore, getPreviewType } from '@/stores/previewStore';
import { useFrameStore } from '@/stores/frameStore';
import type { FileItem } from '@/stores/fileManagerStore';
import { fileApi } from '@/api/file';
import { Loader2, AlertCircle, FileQuestion, X, Edit, Eye, Code } from 'lucide-react';
import { isFileTooLarge, formatFileSize } from './utils';
import CodePreview from './CodePreview';
import ImagePreview from './ImagePreview';
import MediaPreview from './MediaPreview';
import MarkdownPreview from './MarkdownPreview';
import PDFPreview from './PDFPreview';

interface FilePreviewProps {
  file: FileItem | null;
  onClose?: () => void;
}

const FilePreview: React.FC<FilePreviewProps> = ({ file, onClose }) => {
  const [openAsCode, setOpenAsCode] = useState(false);
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const pinTab = useFrameStore((s) => s.pinTab);
  const {
    loading,
    error,
    editMode,
    setFile,
    setContent,
    setOriginalContent,
    setLoading,
    setError,
    setEditMode,
    reset,
  } = usePreviewStore();

  const handleToggleEdit = () => {
    if (!editMode && activeTabId) {
      pinTab(activeTabId);
    }
    setEditMode(!editMode);
  };

  useEffect(() => {
    if (!file) {
      reset();
      return;
    }

    setFile(file);
    setOpenAsCode(false);
    const previewType = getPreviewType(file.mimeType, file.extension);

    if (previewType === 'code' || previewType === 'markdown') {
      if (isFileTooLarge(file.size, 'text')) {
        setError(`File too large to preview (${formatFileSize(file.size)})`);
        return;
      }

      setLoading(true);
      setError(null);

      fileApi
        .read(file.path)
        .then((res) => {
          setContent(res.content);
          setOriginalContent(res.content);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : 'Failed to load file');
        })
        .finally(() => {
          setLoading(false);
        });
    }

    return () => {
      setEditMode(false);
    };
  }, [file?.path]);

  const loadFileAsCode = () => {
    if (!file) return;
    if (isFileTooLarge(file.size, 'text')) {
      setError(`File too large to open (${formatFileSize(file.size)})`);
      return;
    }
    setLoading(true);
    setError(null);
    fileApi
      .read(file.path)
      .then((res) => {
        setContent(res.content);
        setOriginalContent(res.content);
        setOpenAsCode(true);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load file');
      })
      .finally(() => {
        setLoading(false);
      });
  };

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-ide-mute gap-4">
        <FileQuestion size={48} className="opacity-50" />
        <p className="text-sm">Select a file to preview</p>
      </div>
    );
  }

  const previewType = getPreviewType(file.mimeType, file.extension);
  const showAsCode = previewType === 'code' || openAsCode;

  const renderHeader = () => (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel shrink-0">
      <span className="text-sm text-ide-text font-medium truncate flex-1">{file.name}</span>
      {showAsCode && (
        <button
          onClick={handleToggleEdit}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
            editMode
              ? 'bg-ide-accent text-ide-bg'
              : 'bg-ide-bg text-ide-mute hover:text-ide-text'
          }`}
        >
          {editMode ? <Eye size={12} /> : <Edit size={12} />}
          {editMode ? 'View' : 'Edit'}
        </button>
      )}
      {onClose && (
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-text"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="h-full flex flex-col">
        {renderHeader()}
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="animate-spin text-ide-accent" size={32} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col">
        {renderHeader()}
        <div className="flex-1 flex flex-col items-center justify-center text-red-500 gap-2 p-4">
          <AlertCircle size={32} />
          <p className="text-sm text-center">{error}</p>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (openAsCode) {
      return <CodePreview />;
    }
    switch (previewType) {
      case 'code':
        return <CodePreview />;
      case 'image':
        return <ImagePreview />;
      case 'video':
      case 'audio':
        return <MediaPreview />;
      case 'markdown':
        return <MarkdownPreview />;
      case 'pdf':
        return <PDFPreview />;
      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center text-ide-mute gap-4 p-4">
            <FileQuestion size={48} className="opacity-50" />
            <p className="text-sm">Preview not available for this file type</p>
            <div className="flex gap-2">
              <button
                onClick={loadFileAsCode}
                className="flex items-center gap-2 px-4 py-2 bg-ide-panel border border-ide-border text-ide-text rounded text-sm hover:bg-ide-bg"
              >
                <Code size={16} />
                Open as Text
              </button>
              <a
                href={fileApi.downloadUrl(file.path)}
                download={file.name}
                className="px-4 py-2 bg-ide-accent text-ide-bg rounded text-sm hover:opacity-90"
              >
                Download
              </a>
            </div>
          </div>
        );
    }
  };

  if (previewType === 'markdown' || previewType === 'image' || previewType === 'video' || previewType === 'audio' || previewType === 'pdf') {
    return <div className="h-full flex flex-col">{renderContent()}</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {renderHeader()}
      <div className="flex-1 overflow-hidden">{renderContent()}</div>
    </div>
  );
};

export default FilePreview;
