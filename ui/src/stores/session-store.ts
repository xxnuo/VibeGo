import { create } from "zustand";
import { fileApi } from "@/api/file";
import { type SessionInfo, sessionApi, type WorkspaceState } from "@/api/session";
import { settingsApi } from "@/api/settings";
import { terminalApi } from "@/api/terminal";
import { cleanupAllTerminals } from "@/services/terminal-cleanup-service";
import {
  type FileManagerState,
  getOrCreateFileManagerStore,
  removeFileManagerStore,
  resetFileManagerStores,
  type SortField,
  type SortOrder,
  subscribeFileManagerStoreChanges,
  type ViewMode,
} from "@/stores/file-manager-store";
import { type GenericGroup, type GroupPage, type ToolGroup, useFrameStore } from "@/stores/frame-store";
import * as gitStoreModule from "@/stores/git-store";
import { type LayoutNode, type TerminalSession, useTerminalStore } from "@/stores/terminal-store";

const CURRENT_SESSION_SETTING_KEY = "workspaceCurrentSessionId";

let autoSaveUnsub: (() => void) | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let fileManagerSyncTimer: ReturnType<typeof setTimeout> | null = null;

export type SessionState = WorkspaceState;

interface SessionStoreState {
  currentSessionId: string | null;
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;
  initSession: () => Promise<boolean>;
  createSession: (name: string) => Promise<string>;
  openFolder: (folderPath: string) => Promise<string>;
  createSessionFromFolder: (folderPath: string) => Promise<string>;
  closeFolderGroup: (groupId: string) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  refreshCurrentSession: () => Promise<void>;
  saveCurrentSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (id: string | null) => void;
  initAutoSave: () => void;
}

async function getStoredSessionId(): Promise<string | null> {
  try {
    const res = await settingsApi.get(CURRENT_SESSION_SETTING_KEY);
    const value = res.value.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function setStoredSessionId(id: string | null): Promise<void> {
  try {
    if (id) {
      await settingsApi.set(CURRENT_SESSION_SETTING_KEY, id);
      return;
    }
    await settingsApi.delete(CURRENT_SESSION_SETTING_KEY);
  } catch {}
}

function createEmptySessionState(): SessionState {
  return {
    openGroups: [],
    openTools: [],
    taskbarOrder: [],
    terminalsByGroup: {},
    activeTerminalByGroup: {},
    listManagerOpenByGroup: {},
    terminalLayouts: {},
    focusedIdByGroup: {},
    settingsOpen: false,
    activeGroupId: null,
    fileManagerByGroup: {},
  };
}

function hasRestorableSessionContent(state: SessionState): boolean {
  return state.openGroups.length > 0 || state.openTools.length > 0 || state.settingsOpen;
}

function getFilesPagePath(group: { pages: GroupPage[] }): string {
  return group.pages.find((page) => page.type === "files")?.path || ".";
}

function getFolderName(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  if (!normalized) {
    return path || "/";
  }
  return normalized.split("/").pop() || normalized;
}

function getAutoSessionName(groups: Array<{ name: string }>): string {
  if (groups.length === 0) {
    return "Untitled Session";
  }
  const firstName = groups[0]?.name || "Untitled Session";
  if (groups.length === 1) {
    return firstName;
  }
  return `${firstName} +${groups.length - 1}`;
}

function normalizeFileManagerSnapshot(
  snapshot: Partial<SessionState["fileManagerByGroup"][string]> | undefined,
  fallbackPath: string
): SessionState["fileManagerByGroup"][string] {
  const safePath = fallbackPath || ".";
  const currentPath =
    typeof snapshot?.currentPath === "string" && snapshot.currentPath.length > 0 ? snapshot.currentPath : safePath;
  const rootPath =
    typeof snapshot?.rootPath === "string" && snapshot.rootPath.length > 0 ? snapshot.rootPath : safePath;
  const pathHistory =
    Array.isArray(snapshot?.pathHistory) && snapshot.pathHistory.length > 0
      ? snapshot.pathHistory.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [currentPath];
  const historyLength = pathHistory.length;
  const historyIndexRaw =
    typeof snapshot?.historyIndex === "number" && Number.isFinite(snapshot.historyIndex)
      ? snapshot.historyIndex
      : historyLength - 1;
  const historyIndex = Math.min(Math.max(Math.trunc(historyIndexRaw), 0), historyLength - 1);
  return {
    currentPath: pathHistory[historyIndex] || currentPath,
    rootPath,
    pathHistory,
    historyIndex,
    searchQuery: typeof snapshot?.searchQuery === "string" ? snapshot.searchQuery : "",
    searchActive: !!snapshot?.searchActive,
    sortField: (snapshot?.sortField as SortField) || "name",
    sortOrder: (snapshot?.sortOrder as SortOrder) || "asc",
    showHidden: !!snapshot?.showHidden,
    viewMode: (snapshot?.viewMode as ViewMode) || "list",
  };
}

function isDefaultFileManagerState(state: FileManagerState): boolean {
  return (
    !state.initialized &&
    state.currentPath === "." &&
    state.rootPath === "." &&
    state.pathHistory.length === 1 &&
    state.pathHistory[0] === "." &&
    state.historyIndex === 0 &&
    state.searchQuery === "" &&
    !state.searchActive &&
    state.sortField === "name" &&
    state.sortOrder === "asc" &&
    !state.showHidden &&
    state.viewMode === "list"
  );
}

function readFileManagerSnapshot(groupId: string, fallbackPath: string) {
  const store = getOrCreateFileManagerStore(groupId);
  const state = store.getState();
  if (isDefaultFileManagerState(state)) {
    return normalizeFileManagerSnapshot(undefined, fallbackPath);
  }
  return normalizeFileManagerSnapshot(
    {
      currentPath: state.currentPath,
      rootPath: state.rootPath,
      pathHistory: state.pathHistory,
      historyIndex: state.historyIndex,
      searchQuery: state.searchQuery,
      searchActive: state.searchActive,
      sortField: state.sortField,
      sortOrder: state.sortOrder,
      showHidden: state.showHidden,
      viewMode: state.viewMode,
    },
    fallbackPath
  );
}

function applyFileManagerSnapshot(
  groupId: string,
  snapshot: Partial<SessionState["fileManagerByGroup"][string]> | undefined,
  fallbackPath: string
): void {
  const store = getOrCreateFileManagerStore(groupId);
  const restored = normalizeFileManagerSnapshot(snapshot, fallbackPath);
  store.getState().reset();
  store.setState({
    currentPath: restored.currentPath,
    rootPath: restored.rootPath,
    pathHistory: restored.pathHistory,
    historyIndex: restored.historyIndex,
    searchQuery: restored.searchQuery,
    searchActive: restored.searchActive,
    sortField: restored.sortField,
    sortOrder: restored.sortOrder,
    showHidden: restored.showHidden,
    viewMode: restored.viewMode,
    initialized: false,
    files: [],
    selectedFiles: new Set(),
    focusIndex: 0,
    loading: false,
    error: null,
    detailFile: null,
  });
}

function removeGitStore(groupId: string): void {
  const fn = (gitStoreModule as Record<string, unknown>).removeGitStore;
  if (typeof fn === "function") {
    (fn as (value: string) => void)(groupId);
  }
}

function resetGitStores(): void {
  const fn = (gitStoreModule as Record<string, unknown>).resetGitStores;
  if (typeof fn === "function") {
    (fn as () => void)();
  }
}

function clearGroupRuntimeState(groupId: string): void {
  removeFileManagerStore(groupId);
  removeGitStore(groupId);
}

function resetWorkspaceRuntimeState(): void {
  resetFileManagerStores();
  resetGitStores();
}

function buildTerminalWorkspaceAssignments(state: Pick<SessionState, "terminalsByGroup">) {
  return Object.entries(state.terminalsByGroup).flatMap(([groupId, terminals]) =>
    terminals.map((terminal) => ({
      id: terminal.id,
      group_id: groupId,
      parent_id: terminal.parentId,
    }))
  );
}

function collectLayoutTerminalIds(node: LayoutNode): string[] {
  if (node.type === "terminal") {
    return [node.terminalId];
  }
  return [...collectLayoutTerminalIds(node.first), ...collectLayoutTerminalIds(node.second)];
}

function sanitizeLayoutNode(node: LayoutNode, validTerminalIDs: Set<string>): LayoutNode | null {
  if (node.type === "terminal") {
    return validTerminalIDs.has(node.terminalId) ? node : null;
  }

  const first = sanitizeLayoutNode(node.first, validTerminalIDs);
  const second = sanitizeLayoutNode(node.second, validTerminalIDs);

  if (!first && !second) {
    return null;
  }
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  return {
    ...node,
    first,
    second,
  };
}

function sanitizeTerminalWorkspaceState(
  state: Pick<
    SessionState,
    "terminalsByGroup" | "activeTerminalByGroup" | "listManagerOpenByGroup" | "terminalLayouts" | "focusedIdByGroup"
  >
) {
  const terminalsByGroup: Record<string, TerminalSession[]> = {};
  const validTerminalIDs = new Set<string>();

  for (const [groupId, terminals] of Object.entries(state.terminalsByGroup)) {
    const deduped = new Map<string, TerminalSession>();
    for (const terminal of terminals) {
      if (!terminal.id || deduped.has(terminal.id)) {
        continue;
      }
      deduped.set(terminal.id, { ...terminal });
      validTerminalIDs.add(terminal.id);
    }

    const groupTerminalIDs = new Set(deduped.keys());
    terminalsByGroup[groupId] = Array.from(deduped.values()).map((terminal) => ({
      ...terminal,
      parentId:
        terminal.parentId && terminal.parentId !== terminal.id && groupTerminalIDs.has(terminal.parentId)
          ? terminal.parentId
          : undefined,
    }));
  }

  const terminalLayouts: Record<string, LayoutNode> = {};
  for (const [rootId, layout] of Object.entries(state.terminalLayouts)) {
    const sanitized = sanitizeLayoutNode(layout, validTerminalIDs);
    if (!sanitized) {
      continue;
    }
    const layoutTerminalIDs = collectLayoutTerminalIds(sanitized);
    if (layoutTerminalIDs.length === 0) {
      continue;
    }
    const nextRootId = validTerminalIDs.has(rootId) ? rootId : layoutTerminalIDs[0];
    terminalLayouts[nextRootId] = sanitized;
  }

  const activeTerminalByGroup: Record<string, string | null> = {};
  const focusedIdByGroup: Record<string, string | null> = {};
  const listManagerOpenByGroup: Record<string, boolean> = {};

  for (const [groupId, terminals] of Object.entries(terminalsByGroup)) {
    const groupTerminalIDs = new Set(terminals.map((terminal) => terminal.id));
    const activeId = state.activeTerminalByGroup[groupId];
    const focusedId = state.focusedIdByGroup[groupId];
    activeTerminalByGroup[groupId] = activeId && groupTerminalIDs.has(activeId) ? activeId : null;
    focusedIdByGroup[groupId] = focusedId && groupTerminalIDs.has(focusedId) ? focusedId : null;
    listManagerOpenByGroup[groupId] =
      terminals.filter((terminal) => !terminal.parentId).length === 0 ? true : !!state.listManagerOpenByGroup[groupId];
  }

  return {
    terminalsByGroup,
    activeTerminalByGroup,
    listManagerOpenByGroup,
    terminalLayouts,
    focusedIdByGroup,
  };
}

export async function syncTerminalWorkspaceState(
  sessionID: string,
  state?: Pick<
    SessionState,
    "terminalsByGroup" | "activeTerminalByGroup" | "listManagerOpenByGroup" | "terminalLayouts" | "focusedIdByGroup"
  >
): Promise<void> {
  if (!sessionID) {
    return;
  }

  const sourceState =
    state ||
    ({
      terminalsByGroup: useTerminalStore.getState().terminalsByGroup,
      activeTerminalByGroup: useTerminalStore.getState().activeIdByGroup,
      listManagerOpenByGroup: useTerminalStore.getState().listManagerOpenByGroup,
      terminalLayouts: useTerminalStore.getState().terminalLayouts,
      focusedIdByGroup: useTerminalStore.getState().focusedIdByGroup,
    } satisfies Pick<
      SessionState,
      "terminalsByGroup" | "activeTerminalByGroup" | "listManagerOpenByGroup" | "terminalLayouts" | "focusedIdByGroup"
    >);

  const sanitized = sanitizeTerminalWorkspaceState(sourceState);
  await terminalApi.syncWorkspace(sessionID, buildTerminalWorkspaceAssignments(sanitized), sanitized);
}

function buildFileManagerWorkspaceState(): SessionState["fileManagerByGroup"] {
  const frameState = useFrameStore.getState();
  const genericGroups = frameState.groups.filter((group): group is GenericGroup => group.type === "group");
  const fileManagerByGroup: SessionState["fileManagerByGroup"] = {};

  genericGroups.forEach((group) => {
    const filesPagePath = getFilesPagePath(group);
    fileManagerByGroup[group.id] = readFileManagerSnapshot(group.id, filesPagePath);
  });

  return fileManagerByGroup;
}

function buildSessionWorkspacePatch(state: SessionState) {
  return {
    openGroups: state.openGroups,
    openTools: state.openTools,
    taskbarOrder: state.taskbarOrder,
    settingsOpen: state.settingsOpen,
    activeGroupId: state.activeGroupId,
    fileManagerByGroup: state.fileManagerByGroup,
  };
}

function reconcileRemoteTerminals(
  localTerminalsByGroup: Record<string, TerminalSession[]>,
  remoteTerminals: Awaited<ReturnType<typeof terminalApi.list>>["terminals"]
): Record<string, TerminalSession[]> {
  const result: Record<string, TerminalSession[]> = {};
  const seenRemoteIds = new Set(remoteTerminals.map((terminal) => terminal.id));

  for (const [groupId, terminals] of Object.entries(localTerminalsByGroup)) {
    result[groupId] = terminals.map((terminal) => {
      const remote = remoteTerminals.find((item) => item.id === terminal.id);
      if (remote) {
        return {
          ...terminal,
          capabilities: remote.capabilities || terminal.capabilities,
          currentCwd: remote.current_cwd || terminal.currentCwd,
          name: remote.name || terminal.name,
          readonly: remote.readonly ?? terminal.readonly,
          runtimeType: remote.runtime_type || terminal.runtimeType,
          shellIntegration: remote.shell_integration ?? terminal.shellIntegration,
          shellState: remote.shell_state || terminal.shellState,
          shellType: remote.shell_type || terminal.shellType,
          lastCommand: remote.last_command || terminal.lastCommand,
          lastCommandExitCode: remote.last_command_exit_code ?? terminal.lastCommandExitCode,
          status: remote.status || terminal.status,
          parentId: remote.parent_id || terminal.parentId,
        };
      }
      if (!terminal.status || terminal.status === "running") {
        return { ...terminal, status: "exited" };
      }
      return terminal;
    });
  }

  for (const remote of remoteTerminals) {
    if (!remote.group_id) {
      continue;
    }
    if (seenRemoteIds.has(remote.id)) {
      const groupTerminals = result[remote.group_id] || [];
      if (groupTerminals.some((terminal) => terminal.id === remote.id)) {
        continue;
      }
    }
    if (!result[remote.group_id]) {
      result[remote.group_id] = [];
    }
    result[remote.group_id].push({
      capabilities: remote.capabilities,
      currentCwd: remote.current_cwd,
      id: remote.id,
      name: remote.name,
      readonly: remote.readonly,
      runtimeType: remote.runtime_type,
      shellIntegration: remote.shell_integration,
      shellState: remote.shell_state,
      shellType: remote.shell_type,
      lastCommand: remote.last_command,
      lastCommandExitCode: remote.last_command_exit_code ?? null,
      status: remote.status,
      parentId: remote.parent_id || undefined,
    });
  }

  return result;
}

function buildSessionState(): SessionState {
  const frameState = useFrameStore.getState();
  const terminalState = useTerminalStore.getState();
  const genericGroups = frameState.groups.filter((group): group is GenericGroup => group.type === "group");
  const toolGroups = frameState.groups.filter((group): group is ToolGroup => group.type === "tool");
  const settingsGroup = frameState.groups.find((group) => group.type === "settings");
  const fileManagerByGroup: SessionState["fileManagerByGroup"] = {};

  genericGroups.forEach((group) => {
    const filesPagePath = getFilesPagePath(group);
    fileManagerByGroup[group.id] = readFileManagerSnapshot(group.id, filesPagePath);
  });

  const sanitizedTerminalState = sanitizeTerminalWorkspaceState({
    terminalsByGroup: terminalState.terminalsByGroup,
    activeTerminalByGroup: terminalState.activeIdByGroup,
    listManagerOpenByGroup: terminalState.listManagerOpenByGroup,
    terminalLayouts: terminalState.terminalLayouts,
    focusedIdByGroup: terminalState.focusedIdByGroup,
  });

  return {
    openGroups: genericGroups.map((group) => ({
      id: group.id,
      name: group.name,
      pages: group.pages,
      activePageId: group.activePageId,
    })),
    openTools: toolGroups.map((group) => ({
      id: group.id,
      pageId: group.pageId,
      name: group.name,
      tabs: group.tabs,
      activeTabId: group.activeTabId,
    })),
    taskbarOrder: frameState.taskbarOrder,
    terminalsByGroup: sanitizedTerminalState.terminalsByGroup,
    activeTerminalByGroup: sanitizedTerminalState.activeTerminalByGroup,
    listManagerOpenByGroup: sanitizedTerminalState.listManagerOpenByGroup,
    terminalLayouts: sanitizedTerminalState.terminalLayouts,
    focusedIdByGroup: sanitizedTerminalState.focusedIdByGroup,
    settingsOpen: !!settingsGroup,
    activeGroupId: frameState.activeGroupId,
    fileManagerByGroup,
  };
}

function restoreSessionState(state: SessionState): void {
  const frameStore = useFrameStore.getState();
  frameStore.initDefaultGroups();
  resetWorkspaceRuntimeState();
  useTerminalStore.getState().reset();
  const sanitizedTerminalState = sanitizeTerminalWorkspaceState({
    terminalsByGroup: state.terminalsByGroup || {},
    activeTerminalByGroup: state.activeTerminalByGroup || {},
    listManagerOpenByGroup: state.listManagerOpenByGroup || {},
    terminalLayouts: state.terminalLayouts || {},
    focusedIdByGroup: state.focusedIdByGroup || {},
  });

  state.openGroups.forEach((group) => {
    frameStore.addFolderGroup(getFilesPagePath(group), group.name, group.id);
  });

  state.openGroups.forEach((group) => {
    frameStore.replaceGroupState(group.id, {
      name: group.name,
      pages: group.pages,
      activePageId: group.activePageId,
    });
    applyFileManagerSnapshot(group.id, state.fileManagerByGroup?.[group.id], getFilesPagePath(group));
  });

  state.openTools.forEach((tool) => {
    frameStore.addToolGroup(tool.pageId, tool.name, tool.id);
  });

  useFrameStore.setState((frameState) => ({
    groups: frameState.groups.map((group) => {
      if (group.type !== "tool") return group;
      const tool = state.openTools.find((item) => item.id === group.id);
      if (!tool) return group;
      return {
        ...group,
        tabs: tool.tabs || [],
        activeTabId: tool.activeTabId || null,
      };
    }),
    taskbarOrder: state.taskbarOrder || [],
  }));

  if (state.settingsOpen || state.activeGroupId === "settings") {
    frameStore.addSettingsGroup();
  }

  useTerminalStore.setState({
    terminalsByGroup: sanitizedTerminalState.terminalsByGroup,
    activeIdByGroup: sanitizedTerminalState.activeTerminalByGroup,
    listManagerOpenByGroup: sanitizedTerminalState.listManagerOpenByGroup,
    terminalLayouts: sanitizedTerminalState.terminalLayouts,
    focusedIdByGroup: sanitizedTerminalState.focusedIdByGroup,
  });

  const currentGroups = useFrameStore.getState().groups;
  const fallbackActiveGroupId =
    state.openGroups.find((group) => currentGroups.some((currentGroup) => currentGroup.id === group.id))?.id ||
    (state.settingsOpen && currentGroups.some((group) => group.id === "settings") ? "settings" : null) ||
    state.openTools.find((tool) => currentGroups.some((group) => group.id === tool.id))?.id ||
    currentGroups[0]?.id ||
    null;
  const activeGroupId =
    state.activeGroupId && currentGroups.some((group) => group.id === state.activeGroupId)
      ? state.activeGroupId
      : fallbackActiveGroupId;

  if (activeGroupId) {
    frameStore.setActiveGroup(activeGroupId);
  }
}

function updateSessionNameInList(sessions: SessionInfo[], sessionId: string, name: string): SessionInfo[] {
  return sessions.map((session) => (session.id === sessionId ? { ...session, name } : session));
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  currentSessionId: null,
  sessions: [],
  loading: false,
  error: null,

  initAutoSave: () => {
    if (autoSaveUnsub) return;

    const scheduleAutoSave = () => {
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        get().saveCurrentSession();
      }, 1000);
    };

    const scheduleFileManagerSync = () => {
      const scheduledSessionId = get().currentSessionId;
      if (fileManagerSyncTimer) clearTimeout(fileManagerSyncTimer);
      fileManagerSyncTimer = setTimeout(() => {
        const currentSessionId = get().currentSessionId;
        if (!currentSessionId || currentSessionId !== scheduledSessionId) {
          return;
        }
        void sessionApi.patchWorkspace(currentSessionId, {
          fileManagerByGroup: buildFileManagerWorkspaceState(),
        });
      }, 300);
    };

    const frameUnsub = useFrameStore.subscribe(scheduleAutoSave);
    const terminalUnsub = useTerminalStore.subscribe(scheduleAutoSave);
    const fileManagerUnsub = subscribeFileManagerStoreChanges(scheduleFileManagerSync);

    autoSaveUnsub = () => {
      frameUnsub();
      terminalUnsub();
      fileManagerUnsub();
    };
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
    const storedSessionId = await getStoredSessionId();
    const { sessions, switchSession } = get();
    if (storedSessionId && sessions.some((session) => session.id === storedSessionId)) {
      await switchSession(storedSessionId);
      return get().currentSessionId !== null;
    }
    if (storedSessionId) {
      await setStoredSessionId(null);
    }
    set({ currentSessionId: null });
    return false;
  },

  createSession: async (name: string) => {
    try {
      const res = await sessionApi.create(name);
      await get().loadSessions();
      set({ currentSessionId: res.id });
      await setStoredSessionId(res.id);
      return res.id;
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },

  openFolder: async (folderPath: string) => {
    try {
      const folder = await fileApi.list(folderPath);
      const resolvedPath = folder.path || folderPath;
      const folderName = getFolderName(resolvedPath);
      const frameStore = useFrameStore.getState();
      const existingGroup = frameStore.groups.find(
        (group): group is GenericGroup => group.type === "group" && getFilesPagePath(group) === resolvedPath
      );

      if (existingGroup) {
        frameStore.setActiveGroup(existingGroup.id);
        return get().currentSessionId || "";
      }

      let sessionId = get().currentSessionId;
      if (!sessionId) {
        const created = await sessionApi.create(folderName);
        sessionId = created.id;
        set({ currentSessionId: sessionId });
        await setStoredSessionId(sessionId);
      }

      const groupId = frameStore.addFolderGroup(resolvedPath, folderName);
      applyFileManagerSnapshot(groupId, undefined, resolvedPath);

      const state = buildSessionState();
      const sessionName = getAutoSessionName(state.openGroups);

      await sessionApi.update(sessionId, { name: sessionName });
      await sessionApi.patchWorkspace(sessionId, buildSessionWorkspacePatch(state));

      set((store) => ({
        currentSessionId: sessionId,
        sessions: updateSessionNameInList(store.sessions, sessionId, sessionName),
      }));
      await setStoredSessionId(sessionId);
      await get().loadSessions();
      return sessionId;
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },

  createSessionFromFolder: async (folderPath: string) => {
    return get().openFolder(folderPath);
  },

  closeFolderGroup: async (groupId: string) => {
    const frameStore = useFrameStore.getState();
    const targetGroup = frameStore.groups.find(
      (group): group is GenericGroup => group.type === "group" && group.id === groupId
    );

    if (!targetGroup) {
      frameStore.removeGroup(groupId);
      return;
    }

    const folderGroups = frameStore.groups.filter((group): group is GenericGroup => group.type === "group");
    const { currentSessionId } = get();

    try {
      if (!currentSessionId || folderGroups.length <= 1) {
        frameStore.removeGroup(groupId);
        clearGroupRuntimeState(groupId);

        if (currentSessionId) {
          await sessionApi.delete(currentSessionId);
          await terminalApi.syncWorkspace(currentSessionId, []);
        }

        set((store) => ({
          currentSessionId: null,
          sessions: currentSessionId
            ? store.sessions.filter((session) => session.id !== currentSessionId)
            : store.sessions,
        }));
        await setStoredSessionId(null);
        resetWorkspaceRuntimeState();
        await get().loadSessions();
        return;
      }

      frameStore.removeGroup(groupId);
      clearGroupRuntimeState(groupId);

      const state = buildSessionState();
      const sessionName = getAutoSessionName(state.openGroups);

      await sessionApi.update(currentSessionId, { name: sessionName });
      await sessionApi.patchWorkspace(currentSessionId, buildSessionWorkspacePatch(state));
      await syncTerminalWorkspaceState(currentSessionId, {
        terminalsByGroup: state.terminalsByGroup,
        activeTerminalByGroup: state.activeTerminalByGroup,
        listManagerOpenByGroup: state.listManagerOpenByGroup,
        terminalLayouts: state.terminalLayouts,
        focusedIdByGroup: state.focusedIdByGroup,
      });

      set((store) => ({
        sessions: updateSessionNameInList(store.sessions, currentSessionId, sessionName),
      }));
      await get().loadSessions();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  switchSession: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const previousSessionId = get().currentSessionId;
      if (previousSessionId && previousSessionId !== id) {
        await get().saveCurrentSession();
      }

      await cleanupAllTerminals();

      let remoteState: SessionState | null = null;
      try {
        const detail = await sessionApi.get(id);
        if (detail.workspace_state && hasRestorableSessionContent(detail.workspace_state)) {
          remoteState = detail.workspace_state;
        }
      } catch {
        set({ currentSessionId: null, loading: false });
        await setStoredSessionId(null);
        useFrameStore.getState().initDefaultGroups();
        resetWorkspaceRuntimeState();
        await get().loadSessions();
        return;
      }

      const restoreCandidates: SessionState[] = [];

      if (remoteState) {
        restoreCandidates.push(remoteState);
      }

      if (restoreCandidates.length === 0) {
        restoreCandidates.push(createEmptySessionState());
      }

      let restoredState = createEmptySessionState();
      let restored = false;
      for (const candidate of restoreCandidates) {
        try {
          restoreSessionState(candidate);
          restoredState = candidate;
          restored = true;
          break;
        } catch {}
      }

      if (!restored) {
        restoreSessionState(restoredState);
      }

      try {
        const terminalList = await terminalApi.list({ workspace_session_id: id });
        const terminalStore = useTerminalStore.getState();
        const normalized = reconcileRemoteTerminals(terminalStore.terminalsByGroup, terminalList.terminals);
        const sanitized = sanitizeTerminalWorkspaceState({
          terminalsByGroup: normalized,
          activeTerminalByGroup: terminalStore.activeIdByGroup,
          listManagerOpenByGroup: terminalStore.listManagerOpenByGroup,
          terminalLayouts: terminalStore.terminalLayouts,
          focusedIdByGroup: terminalStore.focusedIdByGroup,
        });

        useTerminalStore.setState({
          terminalsByGroup: sanitized.terminalsByGroup,
          activeIdByGroup: sanitized.activeTerminalByGroup,
          listManagerOpenByGroup: sanitized.listManagerOpenByGroup,
          terminalLayouts: sanitized.terminalLayouts,
          focusedIdByGroup: sanitized.focusedIdByGroup,
        });
      } catch {}

      set({ currentSessionId: id, loading: false });
      await setStoredSessionId(id);
    } catch (e) {
      set({ currentSessionId: null, error: (e as Error).message, loading: false });
      await setStoredSessionId(null);
      useFrameStore.getState().initDefaultGroups();
      resetWorkspaceRuntimeState();
    }
  },

  refreshCurrentSession: async () => {
    const { currentSessionId } = get();
    if (!currentSessionId) {
      return;
    }

    try {
      const terminalList = await terminalApi.list({ workspace_session_id: currentSessionId });
      const terminalStore = useTerminalStore.getState();
      const normalized = reconcileRemoteTerminals(terminalStore.terminalsByGroup, terminalList.terminals);
      const sanitized = sanitizeTerminalWorkspaceState({
        terminalsByGroup: normalized,
        activeTerminalByGroup: terminalStore.activeIdByGroup,
        listManagerOpenByGroup: terminalStore.listManagerOpenByGroup,
        terminalLayouts: terminalStore.terminalLayouts,
        focusedIdByGroup: terminalStore.focusedIdByGroup,
      });

      useTerminalStore.setState({
        terminalsByGroup: sanitized.terminalsByGroup,
        activeIdByGroup: sanitized.activeTerminalByGroup,
        listManagerOpenByGroup: sanitized.listManagerOpenByGroup,
        terminalLayouts: sanitized.terminalLayouts,
        focusedIdByGroup: sanitized.focusedIdByGroup,
      });
    } catch {}
  },

  saveCurrentSession: async () => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;

    const state = buildSessionState();
    const sessionName = state.openGroups.length > 0 ? getAutoSessionName(state.openGroups) : undefined;

    try {
      await sessionApi.update(currentSessionId, { name: sessionName });
      await sessionApi.patchWorkspace(currentSessionId, buildSessionWorkspacePatch(state));
      await syncTerminalWorkspaceState(currentSessionId, {
        terminalsByGroup: state.terminalsByGroup,
        activeTerminalByGroup: state.activeTerminalByGroup,
        listManagerOpenByGroup: state.listManagerOpenByGroup,
        terminalLayouts: state.terminalLayouts,
        focusedIdByGroup: state.focusedIdByGroup,
      });

      if (sessionName) {
        set((store) => ({
          sessions: updateSessionNameInList(store.sessions, currentSessionId, sessionName),
        }));
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  deleteSession: async (id: string) => {
    try {
      await sessionApi.delete(id);
      await terminalApi.syncWorkspace(id, []);
      const { currentSessionId, sessions } = get();
      if (currentSessionId === id) {
        const remaining = sessions.filter((session) => session.id !== id);
        const nextSessionId = remaining[0]?.id || null;
        set({ currentSessionId: nextSessionId });
        await setStoredSessionId(nextSessionId);
        if (nextSessionId) {
          await get().switchSession(nextSessionId);
        } else {
          useFrameStore.getState().initDefaultGroups();
          resetWorkspaceRuntimeState();
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
        await terminalApi.syncWorkspace(session.id, []);
      }
      set({ currentSessionId: null, sessions: [] });
      await setStoredSessionId(null);
      useFrameStore.getState().initDefaultGroups();
      resetWorkspaceRuntimeState();
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
    void setStoredSessionId(id);
  },
}));
