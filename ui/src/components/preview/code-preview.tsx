import type { OnMount } from "@monaco-editor/react";
import { Loader2, Save } from "lucide-react";
import React, { useEffect, useMemo, useRef } from "react";
import { fileApi } from "@/api/file";
import MobileToolbar from "@/components/common/mobile-toolbar";
import Editor from "@/components/preview/lazy-editor";
import { editorService } from "@/framework/host/editor-service";
import { createStatusBarItem } from "@/framework/host/status-bar-service";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import { useFrameStore } from "@/stores/frame-store";
import { getLanguageFromExtension, usePreviewStore } from "@/stores/preview-store";

interface CodePreviewProps {
  onSave?: () => void;
  onOpenWith?: () => void;
}

const CodePreview: React.FC<CodePreviewProps> = ({ onSave, onOpenWith }) => {
  const appTheme = useAppStore((s) => s.theme);
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const { file, content, editMode, isDirty, setContent, setIsDirty, setError } = usePreviewStore();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const location = useFrameStore(
    (state) => state.getCurrentTabs().find((tab) => tab.id === state.getCurrentActiveTabId())?.data
  );
  useEffect(() => {
    editorService.navigate(location as { line?: number; column?: number });
  }, [location?.line, location?.column]);

  const language = getLanguageFromExtension(file?.extension);

  const editorTheme = useMemo(() => {
    return appTheme === "light" ? "light" : "vs-dark";
  }, [appTheme]);

  const isMobile = useIsMobile();

  const openWithRef = useRef(onOpenWith);
  openWithRef.current = onOpenWith;
  const menuContextRef = useRef<{ set: (value: boolean) => void } | null>(null);
  useEffect(() => {
    menuContextRef.current?.set(Boolean(onOpenWith));
  }, [Boolean(onOpenWith)]);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupRef.current?.(), []);
  const handleEditorMount: OnMount = (editor) => {
    cleanupRef.current?.();
    editorRef.current = editor;
    const tab = useFrameStore
      .getState()
      .getCurrentTabs()
      .find((tab) => tab.id === useFrameStore.getState().getCurrentActiveTabId());
    const detach = editorService.attach(editor, tab?.data as { line?: number; column?: number });
    const item = createStatusBarItem(
      "editor",
      { id: "cursor", alignment: "right" },
      useFrameStore.getState().activeGroupId || undefined
    );
    const update = () => {
      const position = editor.getPosition();
      item.text = `${position?.lineNumber || 1}:${position?.column || 1}  UTF-8`;
      item.tooltip = language;
      item.show();
    };
    update();
    const listener = editor.onDidChangeCursorPosition(update);
    const action = (event: Event) => {
      const name = (event as CustomEvent).detail?.action;
      const ids: Record<string, string> = {
        undo: "undo",
        redo: "redo",
        find: "actions.find",
        replace: "editor.action.startFindReplaceAction",
      };
      if (name === "undo" || name === "redo") editor.trigger("plugin-host", name, null);
      else if (ids[name]) void editor.getAction(ids[name])?.run();
    };
    const hasCustomEditor = editor.createContextKey<boolean>("vibego.hasCustomEditor", Boolean(openWithRef.current));
    menuContextRef.current = hasCustomEditor;
    const openWith = editor.addAction({
      id: "vibego.openWith",
      label: locale === "en" ? "Open With" : "打开方式",
      precondition: "vibego.hasCustomEditor",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 10,
      run: () => {
        openWithRef.current?.();
      },
    });
    window.addEventListener("editor-action", action);
    cleanupRef.current = () => {
      detach();
      listener.dispose();
      openWith.dispose();
      hasCustomEditor.reset();
      item.dispose();
      window.removeEventListener("editor-action", action);
    };
  };

  const handleChange = (value: string | undefined) => {
    if (value !== undefined && usePreviewStore.getState().editMode) {
      setContent(value);
      setIsDirty(value !== usePreviewStore.getState().originalContent);
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
