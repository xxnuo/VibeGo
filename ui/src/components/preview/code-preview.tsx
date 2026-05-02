import Editor, { type OnMount } from "@monaco-editor/react";
import { Loader2, Save } from "lucide-react";
import React, { useEffect, useMemo, useRef } from "react";
import { fileApi } from "@/api/file";
import MobileToolbar from "@/components/common/mobile-toolbar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import { getLanguageFromExtension, usePreviewStore } from "@/stores/preview-store";

interface CodePreviewProps {
  onSave?: () => void;
}

const CodePreview: React.FC<CodePreviewProps> = ({ onSave }) => {
  const appTheme = useAppStore((s) => s.theme);
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const { file, content, originalContent, editMode, isDirty, setContent, setIsDirty, setError } = usePreviewStore();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const language = getLanguageFromExtension(file?.extension);

  const editorTheme = useMemo(() => {
    return appTheme === "light" ? "light" : "vs-dark";
  }, [appTheme]);

  const isMobile = useIsMobile();

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleChange = (value: string | undefined) => {
    if (value !== undefined && editMode) {
      setContent(value);
      setIsDirty(value !== originalContent);
    }
  };

  const handleInsert = (text: string) => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    if (!editor || !selection || !editMode) return;
    editor.executeEdits("mobile-toolbar", [{ range: selection, text, forceMoveMarkers: true }]);
    editor.focus();
  };

  const handleSave = async () => {
    if (!file || !isDirty) return;
    try {
      await fileApi.write(file.path, content);
      usePreviewStore.getState().setOriginalContent(content);
      setIsDirty(false);
      onSave?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveFailed"));
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
  }, [file, content, isDirty, t]);

  return (
    <div className="h-full w-full flex flex-col">
      {editMode && isDirty && (
        <div className="flex min-h-14 items-center justify-between gap-2 bg-ide-panel px-3 py-1.5 border-b border-ide-border md:min-h-0">
          <span className="text-xs text-yellow-500">{t("preview.unsavedChanges")}</span>
          <button
            type="button"
            onClick={handleSave}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded bg-ide-accent px-3 text-xs text-ide-bg hover:opacity-90 md:min-h-0 md:px-2 md:py-1"
            aria-label={t("common.save")}
          >
            <Save size={12} />
            {t("common.save")}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
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
            fontFamily: "var(--font-mono)",
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
      {isMobile && editMode && <MobileToolbar onInsert={handleInsert} />}
    </div>
  );
};

export default CodePreview;
