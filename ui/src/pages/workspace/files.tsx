import React, { useCallback } from "react";
import { FileManager } from "@/components/file";
import { FilePreview } from "@/components/preview";
import type { PageViewProps } from "@/pages/types";
import { type FileItem, useFrameStore } from "@/stores";

const FilesView: React.FC<PageViewProps> = ({ context }) => {
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const openPreviewTab = useFrameStore((s) => s.openPreviewTab);

  const activeTab = tabs.find((t) => t.id === activeTabId);

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

  if (activeTabId !== null && activeTab) {
    const tabFile = activeTab.data?.file as FileItem | undefined;
    return (
      <FilePreview
        file={
          tabFile || {
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
        }
      />
    );
  }

  return <FileManager groupId={context.groupId} initialPath={pagePath} onFileOpen={handleFileOpen} />;
};

export default FilesView;
