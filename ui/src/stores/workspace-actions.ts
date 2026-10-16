import { useFrameStore, type TabItem } from "./frame-store";
import { useWorkspaceSyncStore } from "./workspace-sync-store";

export interface TabOpenOptions {
  id: string;
  title: string;
  tab_type?: "file" | "diff" | "preview" | "custom_editor";
  file_path?: string;
  page_id?: string;
  pinned?: boolean;
  icon?: string;
  closable?: boolean;
  data?: Record<string, unknown>;
}

function tabUpdates(tab: Partial<TabOpenOptions>): Partial<TabItem> {
  const { tab_type, file_path, page_id: _page, ...rest } = tab;
  return {
    ...rest,
    data: {
      ...tab.data,
      ...(tab_type ? { type: tab_type === "file" ? "code" : tab_type } : {}),
      ...(file_path !== undefined ? { path: file_path } : {}),
    },
  };
}

export const workspaceActions = {
  openFolder: async (path: string, name: string, folderId?: string) => {
    useFrameStore.getState().addFolderGroup(path, name, folderId);
  },
  addFolderPage: (path: string, name?: string) => useFrameStore.getState().addFolderGroup(path, name),
  addTerminalPage: (cwd?: string, name?: string, associatedFolderId?: string) =>
    useFrameStore.getState().addTerminalGroup(cwd, name, associatedFolderId),
  addGitPage: (repoPath?: string, name?: string, associatedFolderId?: string) =>
    useFrameStore.getState().addGitGroup(repoPath, name, associatedFolderId),
  closeFolder: async (folderId: string) => {
    useFrameStore.getState().removeGroup(folderId);
  },
  reorderFolders: (folderIds: string[]) =>
    useWorkspaceSyncStore.getState().dispatch("folder/reorder", { folder_ids: folderIds }),
  openTab: async (folderId: string, tab: TabOpenOptions) => {
    useFrameStore.getState().addTab(folderId, { ...tabUpdates(tab), id: tab.id, title: tab.title }, tab.page_id);
  },
  closeTab: async (folderId: string, tabId: string, pageId?: string) => {
    useFrameStore.getState().removeTab(folderId, tabId, pageId);
  },
  pinTab: async (folderId: string, tabId: string, pinned: boolean, pageId?: string) => {
    useFrameStore.getState().updateTab(folderId, tabId, { pinned }, pageId);
  },
  updateTab: async (folderId: string, tabId: string, updates: Partial<TabOpenOptions>, pageId?: string) => {
    useFrameStore.getState().updateTab(folderId, tabId, tabUpdates(updates), pageId);
  },
  openTool: async (pageId: string, name: string, data?: Record<string, unknown>, toolId?: string) => {
    const frame = useFrameStore.getState();
    frame.addToolGroup(pageId, name, toolId);
    const id = useFrameStore.getState().activeGroupId;
    if (id && data) frame.updateGroupData(id, data);
  },
  closeTool: async (toolId: string) => {
    useFrameStore.getState().removeGroup(toolId);
  },
  updateToolData: async (toolId: string, data: Record<string, unknown>) => {
    useFrameStore.getState().updateGroupData(toolId, data);
  },
  renameWorkspace: (name: string) => useWorkspaceSyncStore.getState().dispatch("workspace/rename", { name }),
};
