import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePreviewStore } from '@/stores/previewStore';
import { Edit, Eye } from 'lucide-react';
import CodePreview from './CodePreview';

const MarkdownPreview: React.FC = () => {
  const { file, content, editMode, setEditMode } = usePreviewStore();

  if (!file) return null;

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <span className="text-xs text-ide-mute truncate flex-1">{file.name}</span>
        <button
          onClick={() => setEditMode(!editMode)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
            editMode
              ? 'bg-ide-accent text-ide-bg'
              : 'bg-ide-bg text-ide-mute hover:text-ide-text'
          }`}
        >
          {editMode ? <Eye size={12} /> : <Edit size={12} />}
          {editMode ? 'Preview' : 'Edit'}
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {editMode ? (
          <CodePreview />
        ) : (
          <div className="h-full overflow-auto p-4">
            <article className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </article>
          </div>
        )}
      </div>
    </div>
  );
};

export default MarkdownPreview;
