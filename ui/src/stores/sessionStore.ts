import { create } from "zustand";
import { sessionApi, type SessionDetail } from "../api/session";
import { useFrameStore, type WorkspaceGroup } from "./frameStore";

interface SessionState {
  activeWorkspaceId: string | null;
  openWorkspaceIds: string[];
  workspaceStates: Record<string, WorkspaceGroup["views"]>;
  preferences: {
    lastActiveGroupId: string | null;
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
  setActiveWorkspace: (id: string | null) => void;
  addOpenWorkspace: (id: string) => void;
  removeOpenWorkspace: (id: string) => void;
  setPreference: <K extends keyof SessionState["preferences"]>(
    key: K,
    value: SessionState["preferences"][K]
  ) => void;
  syncFromFrameStore: () => void;
}

const defaultSessionState: SessionState = {
  activeWorkspaceId: null,
  openWorkspaceIds: [],
  workspaceStates: {},
  preferences: {
    lastActiveGroupId: null,
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

  setActiveWorkspace: (id: string | null) => {
    set((s) => ({
      sessionState: { ...s.sessionState, activeWorkspaceId: id },
    }));
  },

  addOpenWorkspace: (id: string) => {
    set((s) => {
      if (s.sessionState.openWorkspaceIds.includes(id)) return s;
      return {
        sessionState: {
          ...s.sessionState,
          openWorkspaceIds: [...s.sessionState.openWorkspaceIds, id],
        },
      };
    });
  },

  removeOpenWorkspace: (id: string) => {
    set((s) => ({
      sessionState: {
        ...s.sessionState,
        openWorkspaceIds: s.sessionState.openWorkspaceIds.filter(
          (wid) => wid !== id
        ),
        activeWorkspaceId:
          s.sessionState.activeWorkspaceId === id
            ? null
            : s.sessionState.activeWorkspaceId,
      },
    }));
  },

  setPreference: (key, value) => {
    set((s) => ({
      sessionState: {
        ...s.sessionState,
        preferences: { ...s.sessionState.preferences, [key]: value },
      },
    }));
  },

  syncFromFrameStore: () => {
    const frameState = useFrameStore.getState();
    const workspaceGroups = frameState.groups.filter(
      (g): g is WorkspaceGroup => g.type === "workspace"
    );
    const openWorkspaceIds = workspaceGroups.map((g) => g.id);
    const workspaceStates: Record<string, WorkspaceGroup["views"]> = {};
    workspaceGroups.forEach((g) => {
      workspaceStates[g.id] = g.views;
    });
    set((s) => ({
      sessionState: {
        ...s.sessionState,
        activeWorkspaceId: frameState.activeGroupId,
        openWorkspaceIds,
        workspaceStates,
        preferences: {
          ...s.sessionState.preferences,
          lastActiveGroupId: frameState.activeGroupId,
        },
      },
    }));
  },
}));
