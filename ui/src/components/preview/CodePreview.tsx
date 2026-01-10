import React, { useEffect, useRef, useMemo } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  usePreviewStore,
  getLanguageFromExtension,
} from "@/stores/previewStore";
import { useAppStore } from "@/stores/appStore";
import { Loader2, Save } from "lucide-react";
import { fileApi } from "@/api/file";

interface CodePreviewProps {
  onSave?: () => void;
}

const CodePreview: React.FC<CodePreviewProps> = ({ onSave }) => {
  const appTheme = useAppStore((s) => s.theme);
  const {
    file,
    content,
    originalContent,
    editMode,
    isDirty,
    setContent,
    setIsDirty,
    setError,
  } = usePreviewStore();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const language = getLanguageFromExtension(file?.extension);

  const editorTheme = useMemo(() => {
    return appTheme === "light" ? "light" : "vs-dark";
  }, [appTheme]);

  const isMobile = useMemo(() => {
    return typeof window !== "undefined" && window.innerWidth < 768;
  }, []);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleChange = (value: string | undefined) => {
    if (value !== undefined && editMode) {
      setContent(value);
      setIsDirty(value !== originalContent);
    }
  };

  const handleSave = async () => {
    if (!file || !isDirty) return;
    try {
      await fileApi.write(file.path, content);
      usePreviewStore.getState().setOriginalContent(content);
      setIsDirty(false);
      onSave?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save file");
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [file, content, isDirty]);

  return (
    <div className="h-full w-full flex flex-col">
      {editMode && isDirty && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-ide-panel border-b border-ide-border">
          <span className="text-xs text-yellow-500">Unsaved changes</span>
          <button
            onClick={handleSave}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-ide-accent text-ide-bg rounded hover:opacity-90"
          >
            <Save size={12} />
            Save
          </button>
        </div>
      )}
      <div className="flex-1">
        <Editor
          height="100%"
          language={language}
          value={content}
          onChange={handleChange}
          onMount={handleEditorMount}
          theme={editorTheme}
          loading={
            <div className="h-full flex items-center justify-center">
              <Loader2 className="animate-spin text-ide-accent" size={24} />
            </div>
          }
          options={{
            readOnly: !editMode,
            minimap: { enabled: false },
            fontSize: isMobile ? 12 : 13,
            fontFamily: "JetBrains Mono, Fira Code, monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            lineNumbers: isMobile ? "off" : "on",
            renderLineHighlight: "line",
            scrollbar: {
              verticalScrollbarSize: isMobile ? 4 : 8,
              horizontalScrollbarSize: isMobile ? 4 : 8,
            },
            padding: { top: 8, bottom: 8 },
            lineNumbersMinChars: isMobile ? 2 : 4,
            folding: !isMobile,
            glyphMargin: false,
          }}
        />
      </div>
    </div>
  );
};

export default CodePreview;
