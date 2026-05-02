import { GitGraph } from "lucide-react";
import React, { useCallback } from "react";
import type { GitDiff, GitSubmoduleStatus } from "@/api/git";
import { ConflictView, DiffView, GitView } from "@/components/git";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";
import { getOrCreateGitStore, useFrameStore } from "@/stores";
import { useAppStore } from "@/stores/app-store";

interface GitDiffTabPayload {
  original: string;
  modified: string;
  title: string;
  filename?: string;
  filePath?: string;
  repoPath?: string;
  allowSelection?: boolean;
  submodule?: GitSubmoduleStatus;
  metadata?: Pick<
    GitDiff,
    | "oldSize"
    | "newSize"
    | "oldBinary"
    | "newBinary"
    | "oldTruncated"
    | "newTruncated"
    | "binary"
    | "large"
    | "kind"
    | "patch"
    | "capability"
    | "submodule"
    | "image"
  >;
}

const GitViewPage: React.FC<PageViewProps> = ({ context }) => {
  const locale = useAppStore((s) => s.locale);
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const openPreviewTab = useFrameStore((s) => s.openPreviewTab);
  const addCurrentTab = useFrameStore((s) => s.addCurrentTab);
  const removeCurrentTab = useFrameStore((s) => s.removeCurrentTab);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const handleGitDiff = useCallback(
    ({
      original,
      modified,
      title,
      filename,
      filePath,
      repoPath,
      allowSelection,
      submodule,
      metadata,
    }: GitDiffTabPayload) => {
      openPreviewTab({
        id: `diff-${repoPath || context.path || "repo"}-${filePath || filename || title}`,
        title,
        data: {
          type: "diff",
          original,
          modified,
          filename,
          filePath,
          repoPath,
          allowSelection,
          submodule,
          metadata,
        },
      });
    },
    [context.path, openPreviewTab]
  );

  const handleConflict = useCallback(
    (repoPath: string, filePath: string) => {
      const fileName = filePath.split("/").pop() || filePath;
      addCurrentTab({
        id: `conflict-${Date.now()}`,
        title: `${fileName} [CONFLICT]`,
        data: {
          type: "conflict",
          repoPath,
          filePath,
        },
      });
    },
    [addCurrentTab]
  );

  const pagePath = context.path || "";

  if (activeTabId === null) {
    return (
      <GitView
        groupId={context.groupId}
        path={pagePath}
        locale={locale}
        onFileDiff={handleGitDiff}
        onConflict={handleConflict}
        isActive={context.isActive}
      />
    );
  }

  if (activeTab?.data?.type === "diff") {
    return (
      <DiffView
        groupId={context.groupId}
        original={(activeTab.data.original as string) || ""}
        modified={(activeTab.data.modified as string) || ""}
        filename={(activeTab.data.filename as string) || undefined}
        filePath={(activeTab.data.filePath as string) || undefined}
        repoPath={(activeTab.data.repoPath as string) || pagePath}
        allowSelection={Boolean(activeTab.data.allowSelection)}
        submodule={activeTab.data.submodule as GitSubmoduleStatus | undefined}
        metadata={activeTab.data.metadata as GitDiffTabPayload["metadata"]}
      />
    );
  }

  if (activeTab?.data?.type === "conflict") {
    return (
      <ConflictView
        repoPath={(activeTab.data.repoPath as string) || ""}
        filePath={(activeTab.data.filePath as string) || ""}
        locale={locale}
        onResolve={async (content, hash, mode = "manual") => {
          const { resolveConflict } = getOrCreateGitStore(context.groupId).getState();
          return resolveConflict(activeTab.data?.filePath as string, content, hash, mode);
        }}
        onCancel={() => {
          removeCurrentTab(activeTab.id);
        }}
      />
    );
  }

  return null;
};

registerPage({
  id: "git",
  name: "Git",
  nameKey: "sidebar.git",
  icon: GitGraph,
  category: "workspace",
  order: 20,
  View: GitViewPage,
});

export default GitViewPage;
