import React, { useState } from "react";
import MobileToolbar from "@/components/common/mobile-toolbar";

interface CodeEditorProps {
  content: string;
  language: string;
  onChange: (newContent: string) => void;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ content, onChange }) => {
  // Simple syntax highlighting simulation (just coloring for demo)
  const [value, setValue] = useState(content);

  const handleInsert = (char: string) => {
    setValue((prev) => {
      const next = prev + char;
      onChange(next);
      return next;
    });
  };

  const lines = value.split("\n");

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex-1 flex overflow-hidden relative">
        {/* Line Numbers */}
        <div className="w-10 bg-ide-bg border-r border-ide-border pt-4 text-right pr-2 text-xs font-mono text-ide-mute select-none overflow-hidden">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">
              {i + 1}
            </div>
          ))}
        </div>

        {/* Editor Area */}
        <div className="flex-1 relative overflow-auto">
          <textarea
            id="code-editor"
            name="code-editor"
            aria-label="Code editor"
            className="h-full w-full resize-none whitespace-pre bg-transparent p-4 font-mono text-base leading-6 text-ide-text focus:outline-none md:text-sm"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              onChange(e.target.value);
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
        </div>
      </div>

      {/* Mobile Sticky Toolbar */}
      <MobileToolbar onInsert={handleInsert} />
    </div>
  );
};

export default CodeEditor;
