import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePreviewStore } from "@/stores/previewStore";
import CodePreview from "./CodePreview";

const MarkdownPreview: React.FC = () => {
  const { file, content, editMode } = usePreviewStore();

  if (!file) return null;

  return (
    <div className="h-full w-full flex flex-col bg-ide-bg">
      <div className="flex-1 overflow-hidden">
        {editMode ? (
          <CodePreview />
        ) : (
          <div className="h-full overflow-auto p-4">
            <article className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </article>
          </div>
        )}
      </div>
    </div>
  );
};

export default MarkdownPreview;
