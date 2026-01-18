import { create } from "zustand";
import { sessionApi, type SessionDetail } from "../api/session";
import { useFrameStore, type FolderGroup } from "./frameStore";

export interface RecentFolder {
  path: string;
  name: string;
  lastOpenAt: number;
  isPinned: boolean;
}

interface SessionState {
  recentFolders: RecentFolder[];
  openFolders: Array<{
    id: string;
    path: string;
    name: string;
    views: FolderGroup["views"];
  }>;
  activeGroupId: string | null;
  preferences: {
    sidebarCollapsed: boolean;
  };
}

interface SessionStoreState {
  session: SessionDetail | null;
  sessionState: SessionState;
  loading: boolean;
  error: string | null;

  fetchCurrentSession: () => Promise<void>;
  saveSessionState: () => Promise<void>;
  addRecentFolder: (path: string, name: string) => void;
  removeRecentFolder: (path: string) => void;
  togglePinFolder: (path: string) => void;
  syncFromFrameStore: () => void;
}

const defaultSessionState: SessionState = {
  recentFolders: [],
  openFolders: [],
  activeGroupId: null,
  preferences: {
    sidebarCollapsed: false,
  },
};

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  session: null,
  sessionState: defaultSessionState,
  loading: false,
  error: null,

  fetchCurrentSession: async () => {
    set({ loading: true, error: null });
    try {
      const session = await sessionApi.getCurrent();
      let state = defaultSessionState;
      if (session.state && session.state !== "{}") {
        try {
          state = { ...defaultSessionState, ...JSON.parse(session.state) };
        } catch {
          state = defaultSessionState;
        }
      }
      set({ session, sessionState: state, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  saveSessionState: async () => {
    const { session } = get();
    if (!session) return;
    get().syncFromFrameStore();
    const { sessionState } = get();
    try {
      await sessionApi.saveCurrentState(JSON.stringify(sessionState));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  addRecentFolder: (path: string, name: string) => {
    set((s) => {
      const existing = s.sessionState.recentFolders.find((f) => f.path === path);
      if (existing) {
        return {
          sessionState: {
            ...s.sessionState,
            recentFolders: s.sessionState.recentFolders.map((f) =>
              f.path === path ? { ...f, lastOpenAt: Date.now() } : f
            ),
          },
        };
      }
      return {
        sessionState: {
          ...s.sessionState,
          recentFolders: [
            { path, name, lastOpenAt: Date.now(), isPinned: false },
            ...s.sessionState.recentFolders,
          ].slice(0, 20),
        },
      };
    });
  },

  removeRecentFolder: (path: string) => {
    set((s) => ({
      sessionState: {
        ...s.sessionState,
        recentFolders: s.sessionState.recentFolders.filter((f) => f.path !== path),
      },
    }));
  },

  togglePinFolder: (path: string) => {
    set((s) => ({
      sessionState: {
        ...s.sessionState,
        recentFolders: s.sessionState.recentFolders.map((f) =>
          f.path === path ? { ...f, isPinned: !f.isPinned } : f
        ),
      },
    }));
  },

  syncFromFrameStore: () => {
    const frameState = useFrameStore.getState();
    const folderGroups = frameState.groups.filter(
      (g): g is FolderGroup => g.type === "folder"
    );
    set((s) => ({
      sessionState: {
        ...s.sessionState,
        activeGroupId: frameState.activeGroupId,
        openFolders: folderGroups.map((g) => ({
          id: g.id,
          path: g.path,
          name: g.name,
          views: g.views,
        })),
      },
    }));
  },
}));
