import { create } from "zustand";
import { sessionApi, type SessionInfo } from "../api/session";
import { useFrameStore, type FolderGroup, type PluginGroup } from "./frameStore";
import { useFileManagerStore } from "./fileManagerStore";

const CURRENT_SESSION_KEY = "current_session_id";

let autoSaveUnsub: (() => void) | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

export interface SessionState {
  openFolders: Array<{
    id: string;
    path: string;
    name: string;
    views: FolderGroup["views"];
  }>;
  openPlugins: Array<{
    id: string;
    pluginId: string;
    name: string;
  }>;
  settingsOpen?: boolean;
  activeGroupId: string | null;
}

interface SessionStoreState {
  currentSessionId: string | null;
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;
  initSession: () => Promise<boolean>;
  createSession: (name: string) => Promise<string>;
  createSessionFromFolder: (folderPath: string) => Promise<string>;
  switchSession: (id: string) => Promise<void>;
  saveCurrentSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (id: string | null) => void;
  initAutoSave: () => void;
}


function getStoredSessionId(): string | null {
  return localStorage.getItem(CURRENT_SESSION_KEY);
}

function setStoredSessionId(id: string | null): void {
  if (id) {
    localStorage.setItem(CURRENT_SESSION_KEY, id);
  } else {
    localStorage.removeItem(CURRENT_SESSION_KEY);
  }
}

function buildSessionState(): SessionState {
  const frameState = useFrameStore.getState();
  const folderGroups = frameState.groups.filter(
    (g): g is FolderGroup => g.type === "folder"
  );
  const pluginGroups = frameState.groups.filter(
    (g): g is PluginGroup => g.type === "plugin"
  );
  const settingsGroup = frameState.groups.find((g) => g.type === "settings");

  return {
    openFolders: folderGroups.map((g) => ({
      id: g.id,
      path: g.path,
      name: g.name,
      views: g.views,
    })),
    openPlugins: pluginGroups.map((g) => ({
      id: g.id,
      pluginId: g.pluginId,
      name: g.name,
    })),
    settingsOpen: !!settingsGroup,
    activeGroupId: frameState.activeGroupId,
  };
}

function restoreSessionState(state: SessionState): void {
  const frameStore = useFrameStore.getState();
  const fileManagerStore = useFileManagerStore.getState();

  frameStore.initDefaultGroups();
  fileManagerStore.reset();

  let lastAddedGroupId: string | null = null;

  state.openFolders.forEach((folder) => {
    lastAddedGroupId = frameStore.addFolderGroup(folder.path, folder.name, folder.id);
  });

  state.openPlugins.forEach((plugin) => {
    frameStore.addPluginGroup(plugin.pluginId, plugin.name, plugin.id);
  });

  if (state.settingsOpen || state.activeGroupId === "settings") {
    frameStore.addSettingsGroup();
  }

  const currentGroups = useFrameStore.getState().groups;

  if (state.activeGroupId && state.activeGroupId !== "home") {
    if (currentGroups.some((g) => g.id === state.activeGroupId)) {
      frameStore.setActiveGroup(state.activeGroupId);
    } else if (lastAddedGroupId) {
      frameStore.setActiveGroup(lastAddedGroupId);
    }
  } else if (lastAddedGroupId) {
    frameStore.setActiveGroup(lastAddedGroupId);
  }
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  currentSessionId: getStoredSessionId(),
  sessions: [],
  loading: false,
  error: null,

  initAutoSave: () => {
    if (autoSaveUnsub) return;
    autoSaveUnsub = useFrameStore.subscribe(() => {
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        get().saveCurrentSession();
      }, 1000);
    });
  },

  loadSessions: async () => {
    set({ loading: true, error: null });
    try {
      const res = await sessionApi.list();
      set({ sessions: res.sessions || [], loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  initSession: async () => {
    get().initAutoSave();
    await get().loadSessions();
    const { currentSessionId, sessions, switchSession } = get();
    if (currentSessionId && sessions.some((s) => s.id === currentSessionId)) {
      await switchSession(currentSessionId);
      return true;
    }
    return false;
  },

  createSession: async (name: string) => {
    try {
      const res = await sessionApi.create(name);
      await get().loadSessions();
      set({ currentSessionId: res.id });
      setStoredSessionId(res.id);
      return res.id;
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },

  createSessionFromFolder: async (folderPath: string) => {
    const folderName = folderPath.split("/").pop() || folderPath;
    const frameStore = useFrameStore.getState();
    const fileManagerStore = useFileManagerStore.getState();

    try {
      const res = await sessionApi.create(folderName);
      await get().loadSessions();

      frameStore.initDefaultGroups();
      fileManagerStore.reset();
      const groupId = frameStore.addFolderGroup(folderPath, folderName);

      const state: SessionState = {
        openFolders: [{
          id: groupId,
          path: folderPath,
          name: folderName,
          views: {
            files: { tabs: [], activeTabId: null },
            git: { tabs: [], activeTabId: null },
            terminal: { tabs: [], activeTabId: null },
          },
        }],
        openPlugins: [],
        activeGroupId: groupId,
      };

      await sessionApi.update(res.id, { state: JSON.stringify(state) });

      set({ currentSessionId: res.id });
      setStoredSessionId(res.id);
      return res.id;
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },

  switchSession: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const detail = await sessionApi.get(id);
      let state: SessionState = {
        openFolders: [],
        openPlugins: [],
        activeGroupId: null,
      };

      if (detail.state && detail.state !== "{}") {
        try {
          state = JSON.parse(detail.state);
        } catch {
          state = { openFolders: [], openPlugins: [], activeGroupId: null };
        }
      }

      restoreSessionState(state);
      set({ currentSessionId: id, loading: false });
      setStoredSessionId(id);
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  saveCurrentSession: async () => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;

    const state = buildSessionState();
    try {
      await sessionApi.update(currentSessionId, {
        state: JSON.stringify(state),
      });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  deleteSession: async (id: string) => {
    try {
      await sessionApi.delete(id);
      const { currentSessionId, sessions } = get();
      if (currentSessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        const newCurrentId = remaining.length > 0 ? remaining[0].id : null;
        set({ currentSessionId: newCurrentId });
        setStoredSessionId(newCurrentId);
        if (newCurrentId) {
          await get().switchSession(newCurrentId);
        } else {
          useFrameStore.getState().initDefaultGroups();
        }
      }
      await get().loadSessions();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  clearAllSessions: async () => {
    const { sessions } = get();
    try {
      for (const session of sessions) {
        await sessionApi.delete(session.id);
      }
      set({ currentSessionId: null, sessions: [] });
      setStoredSessionId(null);
      useFrameStore.getState().initDefaultGroups();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  renameSession: async (id: string, name: string) => {
    try {
      await sessionApi.update(id, { name });
      await get().loadSessions();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  getCurrentSessionId: () => get().currentSessionId,

  setCurrentSessionId: (id: string | null) => {
    set({ currentSessionId: id });
    setStoredSessionId(id);
  },
}));
