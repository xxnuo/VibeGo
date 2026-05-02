import { Edit, Eye } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { FileManager } from "@/components/file";
import { FilePreview } from "@/components/preview";
import { useContributedEditorActions, type WorkbenchAction } from "@/framework/workbench";
import { useTranslation } from "@/lib/i18n";
import type { PageViewProps } from "@/pages/types";
import { type FileItem, useFrameStore } from "@/stores";
import { useAppStore } from "@/stores/app-store";
import { getPreviewType, usePreviewStore } from "@/stores/preview-store";

const FilesView: React.FC<PageViewProps> = ({ context }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const editMode = usePreviewStore((s) => s.editMode);
  const setEditMode = usePreviewStore((s) => s.setEditMode);
  const pinTab = useFrameStore((s) => s.pinTab);
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const openPreviewTab = useFrameStore((s) => s.openPreviewTab);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const previewFile = useMemo<FileItem | null>(() => {
    if (!activeTab) return null;
    return (
      (activeTab.data?.file as FileItem | undefined) || {
        path: (activeTab.data?.path as string) || activeTab.id,
        name: activeTab.title,
        size: 0,
        isDir: false,
        isSymlink: false,
        isHidden: false,
        mode: "",
        modTime: "",
        extension: activeTab.title.includes(".") ? `.${activeTab.title.split(".").pop()}` : "",
      }
    );
  }, [activeTab]);
  const previewType = previewFile ? getPreviewType(previewFile.mimeType, previewFile.extension) : null;
  const editorActions = useMemo<WorkbenchAction[]>(() => {
    if (!context.isActive || !activeTabId || (previewType !== "code" && previewType !== "markdown")) return [];
    return [
      {
        id: "toggle-edit-mode",
        icon: editMode ? <Eye size={18} /> : <Edit size={18} />,
        title: editMode ? t("common.view") : t("common.edit"),
        onClick: () => {
          if (!editMode) pinTab(activeTabId);
          setEditMode(!editMode);
        },
        active: editMode,
      },
    ];
  }, [context.groupId, context.isActive, activeTabId, previewType, editMode, pinTab, setEditMode, t]);
  useContributedEditorActions(editorActions);

  const handleFileOpen = useCallback(
    (file: FileItem) => {
      openPreviewTab({
        id: `tab-${file.path}`,
        title: file.name,
        data: { type: "code", path: file.path, file },
      });
    },
    [openPreviewTab]
  );

  const pagePath = context.path || ".";

  if (activeTabId !== null && previewFile) {
    return <FilePreview file={previewFile} />;
  }

  return <FileManager groupId={context.groupId} initialPath={pagePath} onFileOpen={handleFileOpen} />;
};

export default FilesView;
