import { AlertCircle, Code, Download, FileQuestion, Loader2 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fileApi } from "@/api/file";
import { PluginErrorBoundary } from "@/components/common/plugin-kit";
import CodePreview from "@/components/preview/code-preview";
import ImagePreview from "@/components/preview/image-preview";
import MarkdownPreview from "@/components/preview/markdown-preview";
import MediaPreview from "@/components/preview/media-preview";
import PDFPreview from "@/components/preview/pdf-preview";
import { formatFileSize, isFileTooLarge } from "@/components/preview/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { PluginHostScope, usePluginHost } from "@/framework/host";
import { commands } from "@/framework/host/command-service";
import { contextKeys, useContextKeyStore } from "@/framework/host/context-key-service";
import { useWorkbenchRegistry } from "@/framework/workbench/registry";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";
import type { FileItem } from "@/stores/file-manager-store";
import { useFrameStore } from "@/stores/frame-store";
import { getPreviewType, usePreviewStore } from "@/stores/preview-store";

interface FilePreviewProps {
  file: FileItem | null;
}

const FilePreview: React.FC<FilePreviewProps> = ({ file }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const loadGeneration = useRef(0);
  useEffect(
    () => () => {
      loadGeneration.current++;
    },
    []
  );
  const [openAsCode, setOpenAsCode] = useState(false);
  const host = usePluginHost();
  const registry = useWorkbenchRegistry();
  useContextKeyStore((state) => state.revision);
  const activeTab = useFrameStore((state) =>
    state.getCurrentTabs().find((tab) => tab.id === state.getCurrentActiveTabId())
  );
  const editors = registry.getCustomEditors(file?.extension);
  const editorId = activeTab?.data?.editorId as string | undefined;
  const custom =
    editorId === "default"
      ? undefined
      : editors.find((editor) => editor.id === editorId) || (!editorId ? editors[0] : undefined);
  const selectEditor = async (id: string) => {
    if (
      usePreviewStore.getState().isDirty &&
      !(await host.ui.confirm(locale === "en" ? "Discard changes?" : "放弃未保存的更改？"))
    )
      return;
    usePreviewStore.getState().setIsDirty(false);
    if (activeTab) useFrameStore.getState().updateTab(host.workspace.groupId, activeTab.id, { data: { editorId: id } });
    if (id === "default" && !activeTab) loadFileAsCode();
  };
  const showOpenWith = async () => {
    const item = await host.ui.showQuickPick(
      [
        { id: "default", label: t("preview.openAsText") },
        ...editors.map((editor) => ({ id: editor.id, label: editor.name || editor.id })),
      ],
      { placeholder: locale === "en" ? "Open With" : "打开方式" }
    );
    if (item) await selectEditor(item.id);
  };
  const { loading, error, setFile, setContent, setOriginalContent, setLoading, setError, setEditMode, reset } =
    usePreviewStore();

  useEffect(() => {
    loadGeneration.current++;
    if (!file) {
      reset();
      return;
    }

    if (usePreviewStore.getState().file?.path !== file.path) usePreviewStore.getState().setIsDirty(false);
    setFile(file);
    setOpenAsCode(editorId === "default");
    setError(null);
    setLoading(false);
    if (custom) return;
    const previewType = getPreviewType(file.mimeType, file.extension);

    if (editorId === "default" || previewType === "code" || previewType === "markdown") {
      if (isFileTooLarge(file.size, "text")) {
        setError(`${t("preview.fileTooLargeToPreview")} (${formatFileSize(file.size)})`);
        return;
      }

      setLoading(true);
      setError(null);

      let cancelled = false;
      fileApi
        .read(file.path)
        .then((res) => {
          if (cancelled) return;
          setContent(res.content);
          setOriginalContent(res.content);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : t("preview.loadFailed"));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
        setEditMode(false);
      };
    }

    return () => {
      setEditMode(false);
    };
  }, [
    custom?.id,
    editorId,
    file?.path,
    setContent,
    setEditMode,
    setError,
    setFile,
    setLoading,
    setOriginalContent,
    reset,
    t,
  ]);

  const loadFileAsCode = () => {
    if (!file) return;
    const generation = ++loadGeneration.current;
    if (isFileTooLarge(file.size, "text")) {
      setError(`${t("preview.fileTooLargeToOpen")} (${formatFileSize(file.size)})`);
      return;
    }
    setLoading(true);
    setError(null);
    fileApi
      .read(file.path)
      .then((res) => {
        if (generation !== loadGeneration.current) return;
        setContent(res.content);
        setOriginalContent(res.content);
        setOpenAsCode(true);
      })
      .catch((e) => {
        if (generation !== loadGeneration.current) return;
        setError(e instanceof Error ? e.message : t("preview.loadFailed"));
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
  };

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-ide-mute gap-4">
        <FileQuestion size={48} className="opacity-50" />
        <p className="text-sm">{t("preview.selectFile")}</p>
      </div>
    );
  }

  const previewType = getPreviewType(file.mimeType, file.extension);

  if (loading && !custom) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="animate-spin text-ide-accent" size={32} />
      </div>
    );
  }

  if (error && !custom) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-red-500 gap-2 p-4">
        <AlertCircle size={32} />
        <p className="text-sm text-center">{error}</p>
      </div>
    );
  }

  const renderContent = () => {
    if (custom) {
      const CustomView = custom.Component;
      return (
        <PluginErrorBoundary key={`${file.path}:${custom.id}`} pluginId={custom.pluginId}>
          <PluginHostScope.Provider
            value={{ pluginId: custom.pluginId, groupId: host.workspace.groupId, path: host.workspace.currentPath }}
          >
            <CustomView file={file} />
          </PluginHostScope.Provider>
        </PluginErrorBoundary>
      );
    }
    if (openAsCode) {
      return (
        <CodePreview
          key={file.path}
          onOpenWith={
            editors.length
              ? () => {
                  void showOpenWith();
                }
              : undefined
          }
        />
      );
    }
    switch (previewType) {
      case "code":
        return (
          <CodePreview
            key={file.path}
            onOpenWith={
              editors.length
                ? () => {
                    void showOpenWith();
                  }
                : undefined
            }
          />
        );
      case "image":
        return <ImagePreview />;
      case "video":
      case "audio":
        return <MediaPreview />;
      case "markdown":
        return <MarkdownPreview />;
      case "pdf":
        return <PDFPreview />;
      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center text-ide-mute gap-4 p-4">
            <FileQuestion size={48} className="opacity-50" />
            <p className="text-sm">{t("preview.notAvailable")}</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={loadFileAsCode}
                className="flex min-h-11 items-center gap-2 rounded border border-ide-border bg-ide-panel px-4 text-sm text-ide-text hover:bg-ide-bg"
              >
                <Code size={18} />
                {t("preview.openAsText")}
              </button>
              <a
                href={fileApi.downloadUrl(file.path)}
                download={file.name}
                className="flex min-h-11 items-center justify-center gap-2 rounded bg-ide-accent px-4 text-sm text-ide-bg hover:opacity-90"
                aria-label={t("preview.download")}
              >
                <Download size={18} />
                {t("preview.download")}
              </a>
            </div>
          </div>
        );
    }
  };

  const menuItems = registry.getMenus("file-context").filter((item) => contextKeys.evalWhen(item.when));
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="h-full flex flex-col overflow-hidden">
          {editors.length > 0 && (
            <div className="flex shrink-0 items-center justify-end border-b border-ide-border bg-ide-panel px-2 py-1 text-xs">
              <label className="flex items-center gap-2">
                {locale === "en" ? "Open With" : "打开方式"}
                <select
                  aria-label={locale === "en" ? "Open With" : "打开方式"}
                  value={custom?.id || "default"}
                  onChange={(event) => void selectEditor(event.target.value)}
                  className="min-h-11 rounded border border-ide-border bg-ide-bg px-2 md:min-h-7"
                >
                  <option value="default">{t("preview.openAsText")}</option>
                  {editors.map((editor) => (
                    <option key={editor.id} value={editor.id}>
                      {editor.name || editor.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="min-h-0 flex-1">{renderContent()}</div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {editors.map((editor) => (
          <ContextMenuItem key={editor.id} onSelect={() => void selectEditor(editor.id)}>
            {locale === "en" ? "Open With" : "打开方式"}: {editor.name || editor.id}
          </ContextMenuItem>
        ))}
        <ContextMenuItem onSelect={() => void selectEditor("default")}>{t("preview.openAsText")}</ContextMenuItem>
        {menuItems.map((item) => (
          <ContextMenuItem
            key={item.id}
            onSelect={() => {
              void commands.execute(item.command, file).catch((error) => toast.error(String(error)));
            }}
          >
            {item.titleKey ? t(item.titleKey) : item.title}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default FilePreview;
