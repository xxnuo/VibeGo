import { create } from "zustand";
import { workspaceApi, type WorkspaceInfo } from "../api/workspace";

interface WorkspaceState {
  workspaces: WorkspaceInfo[];
  recentWorkspaces: WorkspaceInfo[];
  currentWorkspaceId: string | null;
  loading: boolean;
  error: string | null;

  fetchRecent: (limit?: number) => Promise<void>;
  fetchList: (page?: number, pageSize?: number) => Promise<void>;
  openWorkspace: (path: string) => Promise<WorkspaceInfo>;
  closeWorkspace: (id: string) => void;
  setCurrentWorkspace: (id: string | null) => void;
  togglePin: (id: string, isPinned: boolean) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  saveWorkspaceState: (id: string, state: Record<string, unknown>) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  recentWorkspaces: [],
  currentWorkspaceId: null,
  loading: false,
  error: null,

  fetchRecent: async (limit = 10) => {
    set({ loading: true, error: null });
    try {
      const res = await workspaceApi.recent(limit);
      set({ recentWorkspaces: res.workspaces, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  fetchList: async (page = 1, pageSize = 20) => {
    set({ loading: true, error: null });
    try {
      const res = await workspaceApi.list(page, pageSize);
      set({ workspaces: res.workspaces, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  openWorkspace: async (path: string) => {
    set({ loading: true, error: null });
    try {
      const res = await workspaceApi.open(path);
      const workspace = res.workspace;
      set((s) => {
        const exists = s.recentWorkspaces.find((w) => w.id === workspace.id);
        const updated = exists
          ? s.recentWorkspaces.map((w) =>
              w.id === workspace.id ? workspace : w
            )
          : [workspace, ...s.recentWorkspaces];
        return {
          recentWorkspaces: updated.slice(0, 10),
          currentWorkspaceId: workspace.id,
          loading: false,
        };
      });
      return workspace;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  closeWorkspace: (id: string) => {
    const { currentWorkspaceId } = get();
    if (currentWorkspaceId === id) {
      set({ currentWorkspaceId: null });
    }
  },

  setCurrentWorkspace: (id: string | null) => {
    set({ currentWorkspaceId: id });
  },

  togglePin: async (id: string, isPinned: boolean) => {
    try {
      await workspaceApi.togglePin(id, isPinned);
      set((s) => ({
        recentWorkspaces: s.recentWorkspaces.map((w) =>
          w.id === id ? { ...w, is_pinned: isPinned } : w
        ),
        workspaces: s.workspaces.map((w) =>
          w.id === id ? { ...w, is_pinned: isPinned } : w
        ),
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  deleteWorkspace: async (id: string) => {
    try {
      await workspaceApi.delete(id);
      set((s) => ({
        recentWorkspaces: s.recentWorkspaces.filter((w) => w.id !== id),
        workspaces: s.workspaces.filter((w) => w.id !== id),
        currentWorkspaceId:
          s.currentWorkspaceId === id ? null : s.currentWorkspaceId,
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  saveWorkspaceState: async (id: string, state: Record<string, unknown>) => {
    try {
      await workspaceApi.saveState(id, JSON.stringify(state));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));
