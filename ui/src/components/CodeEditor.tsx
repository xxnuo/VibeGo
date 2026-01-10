import React, { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import MobileToolbar from './MobileToolbar';
import type { Theme } from '../types';

interface CodeEditorProps {
  content: string;
  language: string;
  theme: Theme;
  onChange: (newContent: string) => void;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ content, language, theme, onChange }) => {
  const editorRef = useRef<any>(null);

  const handleEditorDidMount: OnMount = (editor, _monaco) => {
    editorRef.current = editor;
  };

  const handleInsert = (text: string) => {
    if (editorRef.current) {
        const editor = editorRef.current;
        const selection = editor.getSelection();
        // const id = { major: 1, minor: 1 };
        const op = { range: selection, text: text, forceMoveMarkers: true };
        editor.executeEdits("my-source", [op]);
        editor.focus();
    }
  };

  // Map theme to Monaco theme
  const getMonacoTheme = (t: Theme) => {
      switch(t) {
        case 'light': return 'light';
        case 'dark': 
        case 'hacker':
        case 'terminal': return 'vs-dark'; // Default dark for now
        default: return 'vs-dark';
      }
  };

  return (
    <div className="flex flex-col h-full relative group">
      <div className="flex-1 overflow-hidden relative">
        <Editor
            height="100%"
            language={language}
            value={content}
            theme={getMonacoTheme(theme)}
            onChange={(value) => onChange(value || '')}
            onMount={handleEditorDidMount}
            options={{
                minimap: { enabled: true },
                fontSize: 14,
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 16 }
            }}
        />
      </div>
      
      {/* Mobile Sticky Toolbar */}
      <MobileToolbar onInsert={handleInsert} />
    </div>
  );
};

export default CodeEditor;
