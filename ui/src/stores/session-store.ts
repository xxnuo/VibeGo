import { create } from "zustand";
import { fileApi } from "@/api/file";
import { type SessionInfo, sessionApi, type WorkspaceState } from "@/api/session";
import { settingsApi } from "@/api/settings";
import { terminalApi } from "@/api/terminal";
import { detachAllTerminals } from "@/services/terminal-cleanup-service";
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
import {
  createWorkspaceSaveLatch,
  getTerminalWorkspaceGroupIds,
  sanitizeTerminalWorkspaceState,
  saveLatestWorkspaceSnapshot,
  type WorkspaceSaveLatch,
} from "@/stores/session-workspace-guard";
import { preservePendingTerminalReorder, type TerminalSession, useTerminalStore } from "@/stores/terminal-store";
import { enqueueWorkspaceMutation } from "@/stores/workspace-mutation-queue";

export { enqueueWorkspaceMutation } from "@/stores/workspace-mutation-queue";

const CURRENT_SESSION_SETTING_KEY = "workspaceCurrentSessionId";

let autoSaveUnsub: (() => void) | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let fileManagerSyncTimer: ReturnType<typeof setTimeout> | null = null;
let storedSessionWriteChain: Promise<void> = Promise.resolve();
let workspaceContentMutationRevision = 0;
let pendingWorkspaceTransitionSave: WorkspaceSaveLatch | null = null;
let sessionListRequestSequence = 0;
let sessionListMutationRevision = 0;
let sessionReorderMutationVersion = 0;
let sessionReorderState: { pendingCount: number; confirmedOrder: string[] } | null = null;
const sessionRenameMutationVersions = new Map<string, number>();
const sessionRenameStates = new Map<
  string,
  {
    pendingCount: number;
    confirmedName: string | null;
    confirmedOverride: string | null;
    optimisticName: string;
  }
>();
const deletedWorkspaceSessionIds = new Set<string>();

interface WorkspaceOperationGuard {
  revision: number;
  expectedSessionId?: string | null;
  allowLoading?: boolean;
}

export type SessionState = WorkspaceState;

interface SessionStoreState {
  currentSessionId: string | null;
  currentWorkspaceNameOverride: string | null;
  sessions: SessionInfo[];
  loading: boolean;
  sessionsLoading: boolean;
  sessionInitialized: boolean;
  workspaceRevision: number;
  error: string | null;

  loadSessions: () => Promise<void>;
  initSession: () => Promise<boolean>;
  createSession: (name: string) => Promise<string>;
  openFolder: (folderPath: string) => Promise<string>;
  createSessionFromFolder: (folderPath: string) => Promise<string>;
  closeFolderGroup: (groupId: string) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  refreshCurrentSession: () => Promise<void>;
  saveCurrentSession: (options?: {
    revision?: number;
    allowLoading?: boolean;
    snapshot?: SessionState;
  }) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  reorderSessions: (ids: string[]) => Promise<boolean>;
  getCurrentSessionId: () => string | null;
  getWorkspaceRevision: () => number;
  setCurrentSessionId: (id: string | null) => void;
  initAutoSave: () => void;
}

/**
 * Returns whether an async workspace operation still belongs to the current
 * workspace transition. A caller may additionally require the workspace to
 * be idle before publishing a delayed write.
 */
export function isCurrentWorkspaceTransition(
  revision: number,
  expectedSessionId?: string | null,
  requireIdle = false
): boolean {
  const state = useSessionStore.getState();
  if (state.workspaceRevision !== revision) return false;
  if (expectedSessionId !== undefined && state.currentSessionId !== expectedSessionId) return false;
  return !requireIdle || !state.loading;
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

function isWorkspaceOperationCurrent(guard?: WorkspaceOperationGuard): boolean {
  if (!guard) return true;
  return isCurrentWorkspaceTransition(guard.revision, guard.expectedSessionId, !guard.allowLoading);
}

function markSessionListMutated(): void {
  sessionListMutationRevision += 1;
}

function markWorkspaceContentMutated(): void {
  workspaceContentMutationRevision += 1;
}

function clearPendingWorkspaceTransitionSave(latch: WorkspaceSaveLatch | null): void {
  if (latch && pendingWorkspaceTransitionSave === latch) {
    pendingWorkspaceTransitionSave = null;
  }
}

async function setStoredSessionId(id: string | null, guard?: WorkspaceOperationGuard): Promise<void> {
  const write = storedSessionWriteChain
    .catch(() => {})
    .then(async () => {
      if (!isWorkspaceOperationCurrent(guard)) return;
      try {
        if (id) {
          await settingsApi.set(CURRENT_SESSION_SETTING_KEY, id);
          return;
        }
        await settingsApi.delete(CURRENT_SESSION_SETTING_KEY);
      } catch {}
    });
  storedSessionWriteChain = write.catch(() => {});
  await write;
}

function createEmptySessionState(): SessionState {
  return {
    workspaceNameOverride: null,
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
  return (
    state.workspaceNameOverride != null ||
    (state.openGroups?.length ?? 0) > 0 ||
    (state.openTools?.length ?? 0) > 0 ||
    state.settingsOpen
  );
}

function normalizeWorkspaceNameOverride(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeWorkspaceRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

export function normalizeSessionWorkspaceState(state: SessionState): SessionState {
  return {
    workspaceNameOverride: normalizeWorkspaceNameOverride(state?.workspaceNameOverride),
    openGroups: Array.isArray(state?.openGroups) ? state.openGroups : [],
    openTools: Array.isArray(state?.openTools) ? state.openTools : [],
    taskbarOrder: Array.isArray(state?.taskbarOrder) ? state.taskbarOrder : [],
    terminalsByGroup: normalizeWorkspaceRecord<TerminalSession[]>(state?.terminalsByGroup),
    activeTerminalByGroup: normalizeWorkspaceRecord<string | null>(state?.activeTerminalByGroup),
    listManagerOpenByGroup: normalizeWorkspaceRecord<boolean>(state?.listManagerOpenByGroup),
    terminalLayouts: normalizeWorkspaceRecord<SessionState["terminalLayouts"][string]>(state?.terminalLayouts),
    focusedIdByGroup: normalizeWorkspaceRecord<string | null>(state?.focusedIdByGroup),
    settingsOpen: state?.settingsOpen === true,
    activeGroupId: typeof state?.activeGroupId === "string" ? state.activeGroupId : null,
    fileManagerByGroup: normalizeWorkspaceRecord<SessionState["fileManagerByGroup"][string]>(state?.fileManagerByGroup),
  };
}

function getFilesPagePath(group: { pages: GroupPage[] }): string {
  return group.pages.find((page) => page.type === "files")?.path || ".";
}

function isFolderWorkspaceGroup(group: GenericGroup): boolean {
  return group.pages.some((page) => Boolean(page.path));
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

async function syncTerminalWorkspaceStateNow(
  sessionID: string,
  state?: Pick<
    SessionState,
    "terminalsByGroup" | "activeTerminalByGroup" | "listManagerOpenByGroup" | "terminalLayouts" | "focusedIdByGroup"
  >,
  guard?: WorkspaceOperationGuard
): Promise<void> {
  if (!sessionID || deletedWorkspaceSessionIds.has(sessionID) || !isWorkspaceOperationCurrent(guard)) {
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
  if (!isWorkspaceOperationCurrent(guard)) return;
  await terminalApi.syncWorkspace(sessionID, buildTerminalWorkspaceAssignments(sanitized), sanitized);
}

export function syncTerminalWorkspaceState(
  sessionID: string,
  state?: Pick<
    SessionState,
    "terminalsByGroup" | "activeTerminalByGroup" | "listManagerOpenByGroup" | "terminalLayouts" | "focusedIdByGroup"
  >,
  guard?: WorkspaceOperationGuard
): Promise<void> {
  return enqueueWorkspaceMutation(() => syncTerminalWorkspaceStateNow(sessionID, state, guard));
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
    workspaceNameOverride: normalizeWorkspaceNameOverride(state.workspaceNameOverride),
    openGroups: state.openGroups,
    openTools: state.openTools,
    taskbarOrder: state.taskbarOrder,
    settingsOpen: state.settingsOpen,
    activeGroupId: state.activeGroupId,
    fileManagerByGroup: state.fileManagerByGroup,
  };
}

async function saveSessionStateNow(
  sessionID: string,
  state: SessionState,
  guard?: WorkspaceOperationGuard,
  ignoreGuardAfterStart = false,
  rethrowError = false
): Promise<void> {
  const shouldContinue = () => ignoreGuardAfterStart || isWorkspaceOperationCurrent(guard);
  if (!sessionID || deletedWorkspaceSessionIds.has(sessionID) || !shouldContinue()) return;

  const sessionName =
    state.workspaceNameOverride == null && state.openGroups.length > 0
      ? getAutoSessionName(state.openGroups)
      : undefined;

  try {
    if (sessionName) {
      await sessionApi.update(sessionID, { name: sessionName });
      markSessionListMutated();
      if (!shouldContinue()) return;
    }

    await sessionApi.patchWorkspace(sessionID, buildSessionWorkspacePatch(state));
    if (!shouldContinue()) return;

    await syncTerminalWorkspaceStateNow(
      sessionID,
      {
        terminalsByGroup: state.terminalsByGroup,
        activeTerminalByGroup: state.activeTerminalByGroup,
        listManagerOpenByGroup: state.listManagerOpenByGroup,
        terminalLayouts: state.terminalLayouts,
        focusedIdByGroup: state.focusedIdByGroup,
      },
      ignoreGuardAfterStart ? undefined : guard
    );
    if (!shouldContinue()) return;

    if (sessionName) {
      useSessionStore.setState((store) => ({
        sessions: updateSessionNameInList(store.sessions, sessionID, sessionName),
      }));
    }
  } catch (e) {
    if (isWorkspaceOperationCurrent(guard)) {
      useSessionStore.setState({ error: (e as Error).message });
    }
    if (rethrowError) throw e;
  }
}

function reconcileRemoteTerminals(
  localTerminalsByGroup: Record<string, TerminalSession[]>,
  remoteTerminals: Awaited<ReturnType<typeof terminalApi.list>>["terminals"],
  options?: {
    markMissingExitedIds?: ReadonlySet<string>;
    ignoredRemoteIds?: ReadonlySet<string>;
    validGroupIds?: ReadonlySet<string>;
  }
): Record<string, TerminalSession[]> {
  const result: Record<string, TerminalSession[]> = {};
  const seenRemoteIds = new Set(remoteTerminals.map((terminal) => terminal.id));

  for (const [groupId, terminals] of Object.entries(localTerminalsByGroup)) {
    if (options?.validGroupIds && !options.validGroupIds.has(groupId)) {
      continue;
    }
    result[groupId] = terminals.map((terminal) => {
      const remote = remoteTerminals.find((item) => item.id === terminal.id);
      if (remote) {
        return {
          ...terminal,
          capabilities: remote.capabilities || terminal.capabilities,
          currentCwd: remote.current_cwd || terminal.currentCwd,
          name: remote.name || terminal.name,
          tabColor: remote.tab_color ?? terminal.tabColor,
          tabIcon: remote.tab_icon ?? terminal.tabIcon,
          readonly: remote.readonly ?? terminal.readonly,
          runtimeType: remote.runtime_type || terminal.runtimeType,
          sshProfileId: remote.ssh_profile_id || terminal.sshProfileId,
          shellIntegration: remote.shell_integration ?? terminal.shellIntegration,
          shellState: remote.shell_state || terminal.shellState,
          shellType: remote.shell_type || terminal.shellType,
          lastCommand: remote.last_command || terminal.lastCommand,
          lastCommandExitCode: remote.last_command_exit_code ?? terminal.lastCommandExitCode,
          status: remote.status || terminal.status,
          parentId: remote.parent_id || undefined,
        };
      }
      if (
        (!options?.markMissingExitedIds || options.markMissingExitedIds.has(terminal.id)) &&
        (!terminal.status || terminal.status === "running")
      ) {
        return { ...terminal, status: "exited" };
      }
      return terminal;
    });
  }

  for (const remote of remoteTerminals) {
    if (
      !remote.group_id ||
      options?.ignoredRemoteIds?.has(remote.id) ||
      (options?.validGroupIds && !options.validGroupIds.has(remote.group_id))
    ) {
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
      tabColor: remote.tab_color ?? "",
      tabIcon: remote.tab_icon ?? "",
      readonly: remote.readonly,
      runtimeType: remote.runtime_type,
      sshProfileId: remote.ssh_profile_id,
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
  const validTerminalGroupIDs = getTerminalWorkspaceGroupIds(frameState.groups);
  const fileManagerByGroup: SessionState["fileManagerByGroup"] = {};

  genericGroups.forEach((group) => {
    const filesPagePath = getFilesPagePath(group);
    fileManagerByGroup[group.id] = readFileManagerSnapshot(group.id, filesPagePath);
  });

  const sanitizedTerminalState = sanitizeTerminalWorkspaceState(
    {
      terminalsByGroup: terminalState.terminalsByGroup,
      activeTerminalByGroup: terminalState.activeIdByGroup,
      listManagerOpenByGroup: terminalState.listManagerOpenByGroup,
      terminalLayouts: terminalState.terminalLayouts,
      focusedIdByGroup: terminalState.focusedIdByGroup,
    },
    validTerminalGroupIDs
  );

  return {
    workspaceNameOverride: useSessionStore.getState().currentWorkspaceNameOverride,
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
  state = normalizeSessionWorkspaceState(state);
  const frameStore = useFrameStore.getState();
  frameStore.initDefaultGroups();
  resetWorkspaceRuntimeState();
  useTerminalStore.getState().reset();
  const validTerminalGroupIDs = getTerminalWorkspaceGroupIds([
    ...state.openGroups.map((group) => ({ ...group, type: "group" })),
    ...state.openTools.map((tool) => ({ ...tool, type: "tool" })),
  ]);
  const sanitizedTerminalState = sanitizeTerminalWorkspaceState(
    {
      terminalsByGroup: state.terminalsByGroup || {},
      activeTerminalByGroup: state.activeTerminalByGroup || {},
      listManagerOpenByGroup: state.listManagerOpenByGroup || {},
      terminalLayouts: state.terminalLayouts || {},
      focusedIdByGroup: state.focusedIdByGroup || {},
    },
    validTerminalGroupIDs
  );

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

function sameSessionOrder(left: readonly SessionInfo[], right: readonly SessionInfo[]): boolean {
  return left.length === right.length && left.every((session, index) => session.id === right[index]?.id);
}

function restoreSessionOrder(current: readonly SessionInfo[], previousOrder: readonly SessionInfo[]): SessionInfo[] {
  const rank = new Map(previousOrder.map((session, index) => [session.id, index]));
  return current
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.session.id);
      const rightRank = rank.get(right.session.id);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ session }, index) => ({ ...session, position: index + 1 }));
}

function reorderSessionInventory(sessions: readonly SessionInfo[], ids: readonly string[]): SessionInfo[] | null {
  if (ids.length === 0) return null;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const ordered: SessionInfo[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) return null;
    const session = byId.get(id);
    if (!session) return null;
    seen.add(id);
    ordered.push(session);
  }
  for (const session of sessions) {
    if (!seen.has(session.id)) ordered.push(session);
  }
  return ordered.map((session, index) => ({ ...session, position: index + 1 }));
}

function applyPendingSessionMutations(
  remoteSessions: readonly SessionInfo[],
  currentSessions: readonly SessionInfo[]
): SessionInfo[] {
  let next = [...remoteSessions];
  if (sessionReorderState?.pendingCount) {
    next = restoreSessionOrder(next, currentSessions);
  }
  for (const [sessionId, state] of sessionRenameStates) {
    if (state.pendingCount > 0) {
      next = updateSessionNameInList(next, sessionId, state.optimisticName);
    }
  }
  return next;
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  currentSessionId: null,
  currentWorkspaceNameOverride: null,
  sessions: [],
  loading: false,
  sessionsLoading: false,
  sessionInitialized: false,
  workspaceRevision: 0,
  error: null,

  initAutoSave: () => {
    if (autoSaveUnsub) return;

    const scheduleAutoSave = () => {
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      const { workspaceRevision: scheduledRevision, currentSessionId: scheduledSessionId, loading } = get();
      if (!scheduledSessionId || loading) {
        autoSaveTimer = null;
        return;
      }
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        if (!isCurrentWorkspaceTransition(scheduledRevision, scheduledSessionId, true)) return;
        void get().saveCurrentSession({ revision: scheduledRevision });
      }, 1000);
    };

    const scheduleFileManagerSync = () => {
      const { workspaceRevision: scheduledRevision, currentSessionId: scheduledSessionId, loading } = get();
      if (fileManagerSyncTimer) clearTimeout(fileManagerSyncTimer);
      if (!scheduledSessionId || loading) {
        fileManagerSyncTimer = null;
        return;
      }
      fileManagerSyncTimer = setTimeout(() => {
        fileManagerSyncTimer = null;
        void enqueueWorkspaceMutation(async () => {
          if (
            deletedWorkspaceSessionIds.has(scheduledSessionId) ||
            !isCurrentWorkspaceTransition(scheduledRevision, scheduledSessionId, true)
          ) {
            return;
          }
          try {
            await sessionApi.patchWorkspace(scheduledSessionId, {
              fileManagerByGroup: buildFileManagerWorkspaceState(),
            });
          } catch (e) {
            if (isCurrentWorkspaceTransition(scheduledRevision, scheduledSessionId, true)) {
              set({ error: (e as Error).message });
            }
          }
        });
      }, 300);
    };

    const frameUnsub = useFrameStore.subscribe((state, previous) => {
      if (
        state.groups !== previous.groups ||
        state.activeGroupId !== previous.activeGroupId ||
        state.taskbarOrder !== previous.taskbarOrder
      ) {
        markWorkspaceContentMutated();
      }
      scheduleAutoSave();
    });
    const terminalUnsub = useTerminalStore.subscribe((state, previous) => {
      if (
        state.terminalsByGroup !== previous.terminalsByGroup ||
        state.activeIdByGroup !== previous.activeIdByGroup ||
        state.listManagerOpenByGroup !== previous.listManagerOpenByGroup ||
        state.terminalLayouts !== previous.terminalLayouts ||
        state.focusedIdByGroup !== previous.focusedIdByGroup
      ) {
        markWorkspaceContentMutated();
      }
      scheduleAutoSave();
    });
    const fileManagerUnsub = subscribeFileManagerStoreChanges(() => {
      markWorkspaceContentMutated();
      scheduleFileManagerSync();
    });

    autoSaveUnsub = () => {
      frameUnsub();
      terminalUnsub();
      fileManagerUnsub();
    };
  },

  loadSessions: async () => {
    const requestSequence = ++sessionListRequestSequence;
    const requestMutationRevision = sessionListMutationRevision;
    set({ sessionsLoading: true, error: null });
    try {
      const res = await sessionApi.list();
      if (requestSequence !== sessionListRequestSequence || requestMutationRevision !== sessionListMutationRevision) {
        return;
      }
      set((state) => ({
        sessions: applyPendingSessionMutations(res.sessions || [], state.sessions),
      }));
    } catch (e) {
      if (requestSequence === sessionListRequestSequence) {
        set({ error: (e as Error).message });
      }
    } finally {
      if (requestSequence === sessionListRequestSequence) {
        set({ sessionsLoading: false });
      }
    }
  },

  initSession: async () => {
    const requestRevision = get().workspaceRevision;
    set({ loading: true, sessionInitialized: false, error: null });
    get().initAutoSave();
    try {
      await get().loadSessions();
      if (!isCurrentWorkspaceTransition(requestRevision)) {
        return false;
      }
      const storedSessionId = await getStoredSessionId();
      if (!isCurrentWorkspaceTransition(requestRevision)) {
        return false;
      }
      const { sessions, switchSession } = get();
      if (storedSessionId && sessions.some((session) => session.id === storedSessionId)) {
        await switchSession(storedSessionId);
        const state = get();
        return state.currentSessionId === storedSessionId && state.sessionInitialized && !state.loading;
      }
      if (storedSessionId) {
        await setStoredSessionId(null, {
          revision: requestRevision,
          expectedSessionId: get().currentSessionId,
          allowLoading: true,
        });
      }
      if (!isCurrentWorkspaceTransition(requestRevision)) {
        return false;
      }
      set({
        currentSessionId: null,
        currentWorkspaceNameOverride: null,
        loading: false,
        sessionInitialized: true,
      });
      return false;
    } catch (e) {
      if (isCurrentWorkspaceTransition(requestRevision)) {
        set({
          currentSessionId: null,
          currentWorkspaceNameOverride: null,
          loading: false,
          sessionInitialized: true,
          error: (e as Error).message,
        });
      }
      return false;
    }
  },

  createSession: async (name: string) => {
    const requestRevision = get().workspaceRevision;
    const expectedSessionId = get().currentSessionId;
    const sessionId = await enqueueWorkspaceMutation(async () => {
      if (!isCurrentWorkspaceTransition(requestRevision, expectedSessionId, true)) return "";
      try {
        const res = await sessionApi.create(name);
        deletedWorkspaceSessionIds.delete(res.id);
        markSessionListMutated();
        if (!isCurrentWorkspaceTransition(requestRevision, expectedSessionId, true)) return res.id;
        set({ currentSessionId: res.id, currentWorkspaceNameOverride: null });
        await setStoredSessionId(res.id, {
          revision: requestRevision,
          expectedSessionId: res.id,
        });
        return res.id;
      } catch (e) {
        if (isCurrentWorkspaceTransition(requestRevision, expectedSessionId, true)) {
          set({ error: (e as Error).message });
        }
        throw e;
      }
    });
    if (sessionId) {
      await get().loadSessions();
    }
    return sessionId;
  },

  openFolder: async (folderPath: string) => {
    const requestRevision = get().workspaceRevision;
    try {
      const folder = await fileApi.list(folderPath);
      const resolvedPath = folder.path || folderPath;
      const folderName = getFolderName(resolvedPath);
      const sessionId = await enqueueWorkspaceMutation(async () => {
        if (!isCurrentWorkspaceTransition(requestRevision, undefined, true)) return "";
        const frameStore = useFrameStore.getState();
        const existingGroup = frameStore.groups.find(
          (group): group is GenericGroup =>
            group.type === "group" && isFolderWorkspaceGroup(group) && getFilesPagePath(group) === resolvedPath
        );

        if (existingGroup) {
          frameStore.setActiveGroup(existingGroup.id);
          return get().currentSessionId || "";
        }

        let sessionId = get().currentSessionId;
        if (!sessionId) {
          const created = await sessionApi.create(folderName);
          deletedWorkspaceSessionIds.delete(created.id);
          markSessionListMutated();
          if (!isCurrentWorkspaceTransition(requestRevision, undefined, true)) {
            await sessionApi.delete(created.id).catch(() => {});
            deletedWorkspaceSessionIds.add(created.id);
            markSessionListMutated();
            return "";
          }
          sessionId = created.id;
          set({ currentSessionId: sessionId, currentWorkspaceNameOverride: null });
          await setStoredSessionId(sessionId, {
            revision: requestRevision,
            expectedSessionId: sessionId,
          });
          if (!isCurrentWorkspaceTransition(requestRevision, sessionId, true)) return "";
        }

        const guard: WorkspaceOperationGuard = {
          revision: requestRevision,
          expectedSessionId: sessionId,
        };
        const groupId = frameStore.addFolderGroup(resolvedPath, folderName);
        applyFileManagerSnapshot(groupId, undefined, resolvedPath);

        const state = buildSessionState();
        const sessionName = state.workspaceNameOverride == null ? getAutoSessionName(state.openGroups) : undefined;

        if (sessionName) {
          await sessionApi.update(sessionId, { name: sessionName });
          markSessionListMutated();
          if (!isWorkspaceOperationCurrent(guard)) return sessionId;
        }
        await sessionApi.patchWorkspace(sessionId, buildSessionWorkspacePatch(state));
        if (!isWorkspaceOperationCurrent(guard)) return sessionId;

        set((store) => ({
          currentSessionId: sessionId,
          sessions: sessionName ? updateSessionNameInList(store.sessions, sessionId, sessionName) : store.sessions,
        }));
        await setStoredSessionId(sessionId, guard);
        return sessionId;
      });
      if (sessionId) {
        await get().loadSessions();
      }
      return sessionId;
    } catch (e) {
      if (isCurrentWorkspaceTransition(requestRevision, undefined, true)) {
        set({ error: (e as Error).message });
      }
      throw e;
    }
  },

  createSessionFromFolder: async (folderPath: string) => {
    return get().openFolder(folderPath);
  },

  closeFolderGroup: async (groupId: string) => {
    const operationRevision = get().workspaceRevision;
    const changed = await enqueueWorkspaceMutation(async () => {
      if (!isCurrentWorkspaceTransition(operationRevision, undefined, true)) return false;
      const frameStore = useFrameStore.getState();
      const targetGroup = frameStore.groups.find(
        (group): group is GenericGroup => group.type === "group" && group.id === groupId
      );

      if (!targetGroup) {
        frameStore.removeGroup(groupId);
        return false;
      }

      const currentSessionId = get().currentSessionId;
      const targetIsFolder = isFolderWorkspaceGroup(targetGroup);
      frameStore.removeGroup(groupId);
      clearGroupRuntimeState(groupId);

      if (!currentSessionId) return false;

      const guard: WorkspaceOperationGuard = {
        revision: operationRevision,
        expectedSessionId: currentSessionId,
      };
      const state = buildSessionState();

      try {
        if (targetIsFolder && !hasRestorableSessionContent(state)) {
          await sessionApi.delete(currentSessionId);
          deletedWorkspaceSessionIds.add(currentSessionId);
          markSessionListMutated();
          set((store) => ({
            sessions: store.sessions.filter((session) => session.id !== currentSessionId),
          }));

          const current = get();
          if (current.currentSessionId === currentSessionId && !current.loading) {
            const nextRevision = current.workspaceRevision + 1;
            set({
              currentSessionId: null,
              currentWorkspaceNameOverride: null,
              workspaceRevision: nextRevision,
              loading: true,
              sessionInitialized: false,
            });
            detachAllTerminals();
            await setStoredSessionId(null, {
              revision: nextRevision,
              expectedSessionId: null,
              allowLoading: true,
            });
            if (isCurrentWorkspaceTransition(nextRevision, null)) {
              useFrameStore.getState().initDefaultGroups();
              resetWorkspaceRuntimeState();
              set({ loading: false, sessionInitialized: true });
            }
          }
          return true;
        }

        const sessionName =
          state.workspaceNameOverride == null && state.openGroups.length > 0
            ? getAutoSessionName(state.openGroups)
            : undefined;
        if (sessionName) {
          await sessionApi.update(currentSessionId, { name: sessionName });
          markSessionListMutated();
          if (!isWorkspaceOperationCurrent(guard)) return true;
        }
        await sessionApi.patchWorkspace(currentSessionId, buildSessionWorkspacePatch(state));
        if (!isWorkspaceOperationCurrent(guard)) return true;
        await syncTerminalWorkspaceStateNow(
          currentSessionId,
          {
            terminalsByGroup: state.terminalsByGroup,
            activeTerminalByGroup: state.activeTerminalByGroup,
            listManagerOpenByGroup: state.listManagerOpenByGroup,
            terminalLayouts: state.terminalLayouts,
            focusedIdByGroup: state.focusedIdByGroup,
          },
          guard
        );
        if (sessionName && isWorkspaceOperationCurrent(guard)) {
          set((store) => ({
            sessions: updateSessionNameInList(store.sessions, currentSessionId, sessionName),
          }));
        }
        return true;
      } catch (e) {
        if (isWorkspaceOperationCurrent(guard)) {
          set({ error: (e as Error).message });
        }
        return false;
      }
    });
    if (changed) {
      await get().loadSessions();
    }
  },

  switchSession: async (id: string) => {
    get().initAutoSave();
    const initialState = get();
    const previousSessionId = initialState.currentSessionId;
    if ((!initialState.loading && previousSessionId === id) || deletedWorkspaceSessionIds.has(id)) return;

    const wasLoading = initialState.loading;
    const shouldSavePreviousWorkspace = !wasLoading && !!previousSessionId;
    let transitionSave =
      wasLoading && previousSessionId && pendingWorkspaceTransitionSave?.sessionId === previousSessionId
        ? pendingWorkspaceTransitionSave
        : null;
    const ownsTransitionSave = shouldSavePreviousWorkspace;
    if (shouldSavePreviousWorkspace && previousSessionId) {
      transitionSave = createWorkspaceSaveLatch(previousSessionId);
      pendingWorkspaceTransitionSave = transitionSave;
    }
    const revision = initialState.workspaceRevision + 1;
    const transitionGuard: WorkspaceOperationGuard = {
      revision,
      expectedSessionId: previousSessionId,
      allowLoading: true,
    };
    set({ workspaceRevision: revision, loading: true, sessionInitialized: false, error: null });
    await enqueueWorkspaceMutation(async () => {
      let workspaceDetached = false;
      try {
        // Capture only after earlier terminal mutations have finished. A newer
        // switch may supersede this one, but this idle workspace snapshot still
        // has to be saved before the newer transition restores another session.
        if (transitionSave) {
          if (ownsTransitionSave) {
            if (previousSessionId && !deletedWorkspaceSessionIds.has(previousSessionId)) {
              try {
                await saveLatestWorkspaceSnapshot(
                  () => workspaceContentMutationRevision,
                  buildSessionState,
                  (snapshot) => saveSessionStateNow(previousSessionId, snapshot, transitionGuard, true, true)
                );
                transitionSave.resolve();
              } catch (e) {
                transitionSave.reject(e);
                throw e;
              }
            } else {
              transitionSave.resolve();
            }
          } else {
            await transitionSave.promise;
          }
        }
        if (!isWorkspaceOperationCurrent(transitionGuard)) return;

        if (deletedWorkspaceSessionIds.has(id)) {
          const fallbackSessionId =
            previousSessionId && !deletedWorkspaceSessionIds.has(previousSessionId) ? previousSessionId : null;
          set({
            currentSessionId: fallbackSessionId,
            currentWorkspaceNameOverride:
              fallbackSessionId && fallbackSessionId === previousSessionId
                ? initialState.currentWorkspaceNameOverride
                : null,
            loading: false,
            sessionInitialized: true,
          });
          await setStoredSessionId(fallbackSessionId, {
            revision,
            expectedSessionId: fallbackSessionId,
          });
          if (!fallbackSessionId && isCurrentWorkspaceTransition(revision, null, true)) {
            detachAllTerminals();
            useFrameStore.getState().initDefaultGroups();
            resetWorkspaceRuntimeState();
          }
          clearPendingWorkspaceTransitionSave(transitionSave);
          return;
        }

        // Switching workspace detaches browser terminals but keeps their PTYs
        // alive. The target workspace can then reattach and replay them.
        detachAllTerminals();
        workspaceDetached = true;
        if (!isWorkspaceOperationCurrent(transitionGuard)) return;

        let remoteState: SessionState | null = null;
        try {
          const detail = await sessionApi.get(id);
          if (!isWorkspaceOperationCurrent(transitionGuard)) return;
          if (detail.workspace_state && hasRestorableSessionContent(detail.workspace_state)) {
            remoteState = normalizeSessionWorkspaceState(detail.workspace_state);
          }
        } catch {
          if (!isWorkspaceOperationCurrent(transitionGuard)) return;
          set({
            currentSessionId: null,
            currentWorkspaceNameOverride: null,
            loading: false,
            sessionInitialized: true,
          });
          await setStoredSessionId(null, { revision, expectedSessionId: null });
          if (!isCurrentWorkspaceTransition(revision, null)) return;
          useFrameStore.getState().initDefaultGroups();
          resetWorkspaceRuntimeState();
          await get().loadSessions();
          clearPendingWorkspaceTransitionSave(transitionSave);
          return;
        }

        // Fetch all remote data before mutating the local workspace. This keeps
        // a superseded transition from leaving a partially restored workspace
        // for the next queued transition to serialize.
        let terminalList: Awaited<ReturnType<typeof terminalApi.list>> | null = null;
        try {
          terminalList = await terminalApi.list({ workspace_session_id: id });
          if (!isWorkspaceOperationCurrent(transitionGuard)) return;
        } catch {
          if (!isWorkspaceOperationCurrent(transitionGuard)) return;
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
          if (!isWorkspaceOperationCurrent(transitionGuard)) return;
          try {
            restoreSessionState(candidate);
            restoredState = candidate;
            restored = true;
            break;
          } catch {}
        }

        if (!restored) {
          if (!isWorkspaceOperationCurrent(transitionGuard)) return;
          restoreSessionState(restoredState);
        }

        if (terminalList) {
          const terminalStore = useTerminalStore.getState();
          const validGroupIds = getTerminalWorkspaceGroupIds(useFrameStore.getState().groups);
          const normalized = reconcileRemoteTerminals(terminalStore.terminalsByGroup, terminalList.terminals, {
            validGroupIds,
          });
          const sanitized = sanitizeTerminalWorkspaceState(
            {
              terminalsByGroup: normalized,
              activeTerminalByGroup: terminalStore.activeIdByGroup,
              listManagerOpenByGroup: terminalStore.listManagerOpenByGroup,
              terminalLayouts: terminalStore.terminalLayouts,
              focusedIdByGroup: terminalStore.focusedIdByGroup,
            },
            validGroupIds
          );

          useTerminalStore.setState({
            terminalsByGroup: sanitized.terminalsByGroup,
            activeIdByGroup: sanitized.activeTerminalByGroup,
            listManagerOpenByGroup: sanitized.listManagerOpenByGroup,
            terminalLayouts: sanitized.terminalLayouts,
            focusedIdByGroup: sanitized.focusedIdByGroup,
          });
        }

        if (!isWorkspaceOperationCurrent(transitionGuard)) return;
        set({
          currentSessionId: id,
          currentWorkspaceNameOverride: restoredState.workspaceNameOverride ?? null,
          loading: false,
          sessionInitialized: true,
        });
        await setStoredSessionId(id, { revision, expectedSessionId: id });
        clearPendingWorkspaceTransitionSave(transitionSave);
      } catch (e) {
        if (!isWorkspaceOperationCurrent(transitionGuard)) return;
        if (!workspaceDetached) {
          set({ error: (e as Error).message, loading: false, sessionInitialized: true });
          clearPendingWorkspaceTransitionSave(transitionSave);
          return;
        }
        set({
          currentSessionId: null,
          currentWorkspaceNameOverride: null,
          error: (e as Error).message,
          loading: false,
          sessionInitialized: true,
        });
        await setStoredSessionId(null, { revision, expectedSessionId: null });
        if (!isCurrentWorkspaceTransition(revision, null)) return;
        useFrameStore.getState().initDefaultGroups();
        resetWorkspaceRuntimeState();
        clearPendingWorkspaceTransitionSave(transitionSave);
      }
    });
  },

  refreshCurrentSession: async () => {
    const { currentSessionId, workspaceRevision, loading, sessionInitialized } = get();
    if (!currentSessionId || loading || !sessionInitialized) {
      return;
    }
    const requestTerminalIds = new Set(
      Object.values(useTerminalStore.getState().terminalsByGroup).flatMap((terminals) =>
        terminals.map((terminal) => terminal.id)
      )
    );

    try {
      const terminalList = await terminalApi.list({ workspace_session_id: currentSessionId });
      if (!isCurrentWorkspaceTransition(workspaceRevision, currentSessionId, true) || !get().sessionInitialized) {
        return;
      }
      const terminalStore = useTerminalStore.getState();
      const currentTerminalIds = new Set(
        Object.values(terminalStore.terminalsByGroup).flatMap((terminals) => terminals.map((terminal) => terminal.id))
      );
      const removedDuringRequest = new Set(
        Array.from(requestTerminalIds).filter((terminalId) => !currentTerminalIds.has(terminalId))
      );
      const validGroupIds = getTerminalWorkspaceGroupIds(useFrameStore.getState().groups);
      const normalized = reconcileRemoteTerminals(terminalStore.terminalsByGroup, terminalList.terminals, {
        markMissingExitedIds: requestTerminalIds,
        ignoredRemoteIds: removedDuringRequest,
        validGroupIds,
      });
      const ordered = preservePendingTerminalReorder(currentSessionId, terminalStore.terminalsByGroup, normalized);
      const sanitized = sanitizeTerminalWorkspaceState(
        {
          terminalsByGroup: ordered,
          activeTerminalByGroup: terminalStore.activeIdByGroup,
          listManagerOpenByGroup: terminalStore.listManagerOpenByGroup,
          terminalLayouts: terminalStore.terminalLayouts,
          focusedIdByGroup: terminalStore.focusedIdByGroup,
        },
        validGroupIds
      );

      useTerminalStore.setState({
        terminalsByGroup: sanitized.terminalsByGroup,
        activeIdByGroup: sanitized.activeTerminalByGroup,
        listManagerOpenByGroup: sanitized.listManagerOpenByGroup,
        terminalLayouts: sanitized.terminalLayouts,
        focusedIdByGroup: sanitized.focusedIdByGroup,
      });
    } catch {}
  },

  saveCurrentSession: async (options) => {
    const { currentSessionId, workspaceRevision } = get();
    if (!currentSessionId) return;
    const revision = options?.revision ?? workspaceRevision;
    const expectedSessionId = currentSessionId;
    const guard: WorkspaceOperationGuard = {
      revision,
      expectedSessionId,
      allowLoading: options?.allowLoading,
    };
    await enqueueWorkspaceMutation(async () => {
      if (deletedWorkspaceSessionIds.has(expectedSessionId)) return;
      if (!options?.snapshot && !isWorkspaceOperationCurrent(guard)) return;
      const state = options?.snapshot || buildSessionState();
      await saveSessionStateNow(expectedSessionId, state, guard, !!options?.snapshot);
    });
  },

  deleteSession: async (id: string) => {
    let nextTransition: { id: string; revision: number } | null = null;
    const deleted = await enqueueWorkspaceMutation(async () => {
      try {
        await sessionApi.delete(id);
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      }

      deletedWorkspaceSessionIds.add(id);
      markSessionListMutated();
      set((store) => ({
        sessions: store.sessions.filter((session) => session.id !== id),
      }));

      const current = get();
      if (current.currentSessionId === id && !current.loading) {
        const nextSessionId = current.sessions[0]?.id || null;
        const nextRevision = current.workspaceRevision + 1;
        set({
          currentSessionId: null,
          currentWorkspaceNameOverride: null,
          workspaceRevision: nextRevision,
          loading: true,
          sessionInitialized: false,
        });
        detachAllTerminals();
        await setStoredSessionId(null, {
          revision: nextRevision,
          expectedSessionId: null,
          allowLoading: true,
        });
        if (isCurrentWorkspaceTransition(nextRevision, null)) {
          if (nextSessionId) {
            nextTransition = { id: nextSessionId, revision: nextRevision };
          } else {
            useFrameStore.getState().initDefaultGroups();
            resetWorkspaceRuntimeState();
            set({ loading: false, sessionInitialized: true });
          }
        }
      }
      return true;
    });
    const transition = nextTransition as { id: string; revision: number } | null;
    if (transition && isCurrentWorkspaceTransition(transition.revision, null)) {
      await get().switchSession(transition.id);
    }
    if (deleted) {
      await get().loadSessions();
    }
  },

  clearAllSessions: async () => {
    const deletedAny = await enqueueWorkspaceMutation(async () => {
      const initialState = get();
      const sessions = [...initialState.sessions].sort((a, b) => {
        if (a.id === initialState.currentSessionId) return -1;
        if (b.id === initialState.currentSessionId) return 1;
        return 0;
      });
      let deletedAny = false;
      let transitionRevision: number | null = null;

      for (const session of sessions) {
        try {
          await sessionApi.delete(session.id);
        } catch (e) {
          set({ error: (e as Error).message });
          break;
        }

        deletedAny = true;
        deletedWorkspaceSessionIds.add(session.id);
        markSessionListMutated();
        set((store) => ({
          sessions: store.sessions.filter((item) => item.id !== session.id),
        }));

        const current = get();
        if (current.currentSessionId === session.id && !current.loading) {
          transitionRevision = current.workspaceRevision + 1;
          set({
            currentSessionId: null,
            currentWorkspaceNameOverride: null,
            workspaceRevision: transitionRevision,
            loading: true,
            sessionInitialized: false,
          });
          detachAllTerminals();
          await setStoredSessionId(null, {
            revision: transitionRevision,
            expectedSessionId: null,
            allowLoading: true,
          });
        }
      }

      if (transitionRevision !== null && isCurrentWorkspaceTransition(transitionRevision, null)) {
        useFrameStore.getState().initDefaultGroups();
        resetWorkspaceRuntimeState();
        set({ loading: false, sessionInitialized: true });
      }
      return deletedAny;
    });
    if (deletedAny) {
      await get().loadSessions();
    }
  },

  renameSession: async (id: string, name: string) => {
    if (deletedWorkspaceSessionIds.has(id)) return;
    const normalizedName = name.trim();
    const previousState = get();
    const previousSession = previousState.sessions.find((session) => session.id === id);
    const previousOverride = previousState.currentWorkspaceNameOverride;
    const mutationVersion = (sessionRenameMutationVersions.get(id) || 0) + 1;
    let mutationState = sessionRenameStates.get(id);
    if (!mutationState || mutationState.pendingCount === 0) {
      mutationState = {
        pendingCount: 0,
        confirmedName: previousSession?.name ?? null,
        confirmedOverride: previousState.currentSessionId === id ? previousOverride : null,
        optimisticName: normalizedName,
      };
      sessionRenameStates.set(id, mutationState);
    }
    mutationState.pendingCount += 1;
    mutationState.optimisticName = normalizedName;
    sessionRenameMutationVersions.set(id, mutationVersion);
    markSessionListMutated();
    set((store) => ({
      sessions: updateSessionNameInList(store.sessions, id, normalizedName),
      currentWorkspaceNameOverride: store.currentSessionId === id ? normalizedName : store.currentWorkspaceNameOverride,
    }));

    try {
      const updated = await enqueueWorkspaceMutation(async () => {
        if (deletedWorkspaceSessionIds.has(id)) return false;
        await sessionApi.update(id, {
          name: normalizedName,
          workspaceNameOverride: normalizedName,
        });
        mutationState.confirmedName = normalizedName;
        mutationState.confirmedOverride = normalizedName;
        return true;
      });
      if (!updated) return;
    } catch (error) {
      const current = get();
      const currentSession = current.sessions.find((session) => session.id === id);
      const listStillOptimistic = !previousSession || currentSession?.name === normalizedName;
      const overrideStillOptimistic =
        current.currentSessionId !== id || current.currentWorkspaceNameOverride === normalizedName;
      if (sessionRenameMutationVersions.get(id) === mutationVersion && listStillOptimistic && overrideStillOptimistic) {
        set((store) => ({
          sessions:
            mutationState.confirmedName != null
              ? updateSessionNameInList(store.sessions, id, mutationState.confirmedName)
              : store.sessions,
          currentWorkspaceNameOverride:
            store.currentSessionId === id ? mutationState.confirmedOverride : store.currentWorkspaceNameOverride,
          error: (error as Error).message,
        }));
      }
      throw error;
    } finally {
      mutationState.pendingCount -= 1;
      markSessionListMutated();
      if (mutationState.pendingCount === 0 && sessionRenameStates.get(id) === mutationState) {
        sessionRenameStates.delete(id);
        if (sessionRenameMutationVersions.get(id) === mutationVersion) {
          sessionRenameMutationVersions.delete(id);
        }
      }
    }
  },

  reorderSessions: async (ids: string[]) => {
    const previous = get().sessions;
    const optimistic = reorderSessionInventory(previous, ids);
    if (!optimistic || sameSessionOrder(previous, optimistic)) return false;

    const mutationVersion = ++sessionReorderMutationVersion;
    if (!sessionReorderState || sessionReorderState.pendingCount === 0) {
      sessionReorderState = { pendingCount: 0, confirmedOrder: previous.map((session) => session.id) };
    }
    const mutationState = sessionReorderState;
    mutationState.pendingCount += 1;
    markSessionListMutated();
    set({ sessions: optimistic });

    try {
      await enqueueWorkspaceMutation(async () => {
        await sessionApi.reorder(optimistic.map((session) => session.id));
        mutationState.confirmedOrder = optimistic.map((session) => session.id);
      });
      return true;
    } catch (error) {
      const current = get().sessions;
      if (sessionReorderMutationVersion === mutationVersion && sameSessionOrder(current, optimistic)) {
        set((store) => ({
          sessions: restoreSessionOrder(
            store.sessions,
            mutationState.confirmedOrder.map((id) => ({ id })) as SessionInfo[]
          ),
          error: (error as Error).message,
        }));
        throw error;
      }
      return false;
    } finally {
      mutationState.pendingCount -= 1;
      markSessionListMutated();
      if (mutationState.pendingCount === 0 && sessionReorderState === mutationState) {
        sessionReorderState = null;
      }
    }
  },

  getCurrentSessionId: () => get().currentSessionId,

  getWorkspaceRevision: () => get().workspaceRevision,

  setCurrentSessionId: (id: string | null) => {
    const current = get();
    const revision = current.workspaceRevision + 1;
    set({
      currentSessionId: id,
      currentWorkspaceNameOverride: id === current.currentSessionId ? current.currentWorkspaceNameOverride : null,
      workspaceRevision: revision,
    });
    void setStoredSessionId(id, { revision, expectedSessionId: id });
  },
}));
