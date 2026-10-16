import { create } from "zustand";
import { toast } from "sonner";
import { ApiError } from "@/api/request";
import { randomUUID } from "@/lib/uuid";
import {
  type ClientMutation,
  type MutationBroadcastEvent,
  workspaceApi,
  type WorkspaceSnapshot,
} from "@/api/workspace-sync";
import { useFrameStore } from "./frame-store";
import { removeFileManagerStore } from "./file-manager-store";
import { removeGitStore } from "./git-store";
import {
  diffInventory,
  frameFromInventory,
  inventoryFromFrame,
  reduceInventory,
  type MutationAction,
} from "./workspace-inventory";
import { sanitizeTerminalWorkspaceState } from "./session-workspace-guard";
import { type TerminalSession, useTerminalStore } from "./terminal-store";

const OUTBOX_KEY = "vibego:workspace-outbox:v1";
const CLIENT_KEY = "vibego:workspace-client";
const tabStorage = typeof window === "undefined" ? undefined : window.sessionStorage;
const clientId = tabStorage?.getItem(CLIENT_KEY) || randomUUID();
tabStorage?.setItem(CLIENT_KEY, clientId);
const listeners = new Set<(mutation: ClientMutation) => void>();
export function subscribeWorkspaceMutation(listener: (mutation: ClientMutation) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
let applyingRemote = 0;
let generation = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;
let initialized = false;
const ownIds = new Set<string>();
const delivered = new Map<string, number>();

function readOutbox(): ClientMutation[] {
  try {
    const items = JSON.parse(tabStorage?.getItem(OUTBOX_KEY) || "[]");
    const result = Array.isArray(items)
      ? items.filter(
          (item) =>
            item?.id &&
            item?.workspace_id &&
            typeof item?.type === "string" &&
            item.payload &&
            typeof item.payload === "object"
        )
      : [];
    for (const mutation of result) ownIds.add(mutation.id);
    return result;
  } catch {
    return [];
  }
}

interface SyncState {
  currentWorkspaceId: string | null;
  revision: number;
  snapshot: WorkspaceSnapshot | null;
  connected: boolean;
  ws: WebSocket | null;
  outbox: ClientMutation[];
  error: string | null;
  connect: (id: string, snapshot?: WorkspaceSnapshot, adoptLocal?: boolean) => Promise<void>;
  disconnect: () => void;
  dispatch: <T extends Record<string, unknown>>(type: string, payload: T) => Promise<void>;
  dispatchBatch: (actions: MutationAction[], project?: boolean) => void;
  applyRemoteMutation: (mutation: ClientMutation, revision: number) => void;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
}

function saveOutbox(outbox: ClientMutation[]) {
  // Persist before issuing HTTP: a reload or failed request must not lose an action.
  tabStorage?.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  useWorkspaceSyncStore.setState({ outbox });
}
function emit(mutation: ClientMutation) {
  for (const listener of [...listeners]) {
    try {
      void Promise.resolve(listener(mutation)).catch((error) => console.error("Workspace listener failed", error));
    } catch (error) {
      console.error("Workspace listener failed", error);
    }
  }
}
function project() {
  const state = useWorkspaceSyncStore.getState();
  if (!state.snapshot || state.snapshot.workspace.id !== state.currentWorkspaceId) return;
  const optimistic = state.outbox
    .filter((m) => m.workspace_id === state.currentWorkspaceId)
    .reduce(reduceInventory, state.snapshot);
  applyingRemote++;
  try {
    const frame = useFrameStore.getState();
    const groups = frameFromInventory(optimistic, frame.groups);
    for (const group of frame.groups)
      if (group.type === "group" && !groups.some((next) => next.id === group.id)) {
        removeFileManagerStore(group.id);
        removeGitStore(group.id);
      }
    const activeGroupId = groups.some((group) => group.id === frame.activeGroupId)
      ? frame.activeGroupId
      : groups[0]?.id || null;
    useFrameStore.setState({ groups, activeGroupId });
    if (!groups.length) useFrameStore.getState().showHomePage();
    const terminalStore = useTerminalStore.getState();
    const byGroup: Record<string, TerminalSession[]> = {};
    for (const term of optimistic.terminals) {
      if (!term.group_id || !groups.some((group) => group.id === term.group_id)) continue;
      const old = terminalStore.terminalsByGroup[term.group_id]?.find((item) => item.id === term.id);
      (byGroup[term.group_id] ||= []).push({
        ...old,
        id: term.id,
        name: term.name,
        tabColor: term.tab_color,
        tabIcon: term.tab_icon,
        status: term.status as TerminalSession["status"],
        parentId: term.parent_id || undefined,
        runtimeType: term.runtime_type,
        readonly: term.readonly,
        cwd: term.cwd,
        currentCwd: term.current_cwd,
        capabilities: term.capabilities || old?.capabilities,
      });
    }
    // Keep each device's local terminal order and focus when peers add assets.
    for (const [id, terms] of Object.entries(byGroup)) {
      const rank = new Map((terminalStore.terminalsByGroup[id] || []).map((term, index) => [term.id, index]));
      terms.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
    const sanitized = sanitizeTerminalWorkspaceState({
      terminalsByGroup: byGroup,
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
  } finally {
    applyingRemote--;
  }
}

function acceptSnapshot(snapshot: WorkspaceSnapshot) {
  useWorkspaceSyncStore.setState({ snapshot, revision: snapshot.workspace.revision, error: null });
  project();
}
function retry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void useWorkspaceSyncStore.getState().flush();
  }, 1500);
}
function initialize() {
  if (initialized) return;
  initialized = true;
  useFrameStore.subscribe((next, previous) => {
    const state = useWorkspaceSyncStore.getState();
    if (applyingRemote || !state.snapshot || !state.currentWorkspaceId || next.groups === previous.groups) return;
    state.dispatchBatch(
      diffInventory(
        inventoryFromFrame(previous.groups, state.currentWorkspaceId),
        inventoryFromFrame(next.groups, state.currentWorkspaceId)
      ),
      false
    );
  });
  window.addEventListener("online", () => {
    void useWorkspaceSyncStore.getState().refresh();
    void useWorkspaceSyncStore.getState().flush();
  });
  window.addEventListener("focus", () => {
    void useWorkspaceSyncStore.getState().refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void useWorkspaceSyncStore.getState().refresh();
  });
}

export const useWorkspaceSyncStore = create<SyncState>((set, get) => ({
  currentWorkspaceId: null,
  revision: 0,
  snapshot: null,
  connected: false,
  ws: null,
  outbox: readOutbox(),
  error: null,
  connect: async (id, initial, adoptLocal = false) => {
    initialize();
    get().disconnect();
    const epoch = generation;
    set({ currentWorkspaceId: id });
    try {
      const snapshot = initial || (await workspaceApi.getSnapshot(id));
      if (epoch !== generation) return;
      if (adoptLocal) {
        const local = inventoryFromFrame(useFrameStore.getState().groups, id);
        set({ snapshot, revision: snapshot.workspace.revision });
        get().dispatchBatch(diffInventory(snapshot, local), false);
      }
      acceptSnapshot(snapshot);
      if (!delivered.has(id)) delivered.set(id, snapshot.workspace.revision);
      openSocket(id, epoch);
      void get().flush();
    } catch (error) {
      if (epoch !== generation) return;
      set({ error: (error as Error).message });
      throw error;
    }
  },
  disconnect: () => {
    generation++;
    const socket = get().ws;
    set({ ws: null, connected: false, currentWorkspaceId: null, snapshot: null, revision: 0 });
    socket?.close();
  },
  dispatch: async (type, payload) => {
    get().dispatchBatch([{ type, payload }]);
  },
  dispatchBatch: (actions, shouldProject = true) => {
    if (!actions.length) return;
    const { currentWorkspaceId, revision, outbox } = get();
    if (!currentWorkspaceId) throw new Error("No active workspace");
    const mutations = actions.map((action) => ({
      ...action,
      id: randomUUID(),
      workspace_id: currentWorkspaceId,
      client_id: clientId,
      base_revision: revision,
      created_at: Date.now(),
    }));
    saveOutbox([...outbox, ...mutations]);
    for (const mutation of mutations) ownIds.add(mutation.id);
    while (ownIds.size > 2048) ownIds.delete(ownIds.values().next().value!);
    if (shouldProject) project();
    void get().flush();
  },
  applyRemoteMutation: (mutation, revision) => {
    const state = get();
    if (state.currentWorkspaceId !== mutation.workspace_id || !state.snapshot) return;
    if (revision > state.revision + 1) {
      state.ws?.close();
      void state.refresh();
      return;
    }
    if (revision > state.revision) {
      const snapshot = reduceInventory(state.snapshot, mutation);
      snapshot.workspace = { ...snapshot.workspace, revision };
      set({ snapshot, revision });
      project();
    }
    if (revision > (delivered.get(mutation.workspace_id) || 0)) {
      delivered.set(mutation.workspace_id, revision);
      if (!ownIds.has(mutation.id)) emit(mutation);
    }
  },
  refresh: async () => {
    const { currentWorkspaceId } = get();
    const epoch = generation;
    if (!currentWorkspaceId) return;
    try {
      const snapshot = await workspaceApi.getSnapshot(currentWorkspaceId);
      if (epoch !== generation || snapshot.workspace.revision < get().revision) return;
      acceptSnapshot(snapshot);
      if (!get().ws || get().ws?.readyState === WebSocket.CLOSED) openSocket(currentWorkspaceId, epoch);
      void get().flush();
    } catch (error) {
      if (epoch === generation) set({ error: (error as Error).message });
    }
  },
  flush: () => {
    if (flushing) return flushing;
    let failed = false;
    flushing = (async () => {
      while (get().outbox.length) {
        const mutation = get().outbox[0];
        try {
          const response = await workspaceApi.submitMutation(mutation);
          saveOutbox(get().outbox.filter((item) => item.id !== mutation.id));
          if (response.event.mutation) get().applyRemoteMutation(response.event.mutation, response.revision);
          set({ error: null });
        } catch (error) {
          set({ error: (error as Error).message });
          if (error instanceof ApiError && [400, 404, 409, 410].includes(error.status)) {
            saveOutbox(get().outbox.filter((item) => item.id !== mutation.id));
            toast.error((error as Error).message);
            await get().refresh();
            continue;
          }
          failed = true;
          retry();
          break;
        }
      }
    })().finally(() => {
      flushing = null;
      if (!get().outbox.length && retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      } else if (!failed && get().outbox.length) void get().flush();
    });
    return flushing;
  },
}));

function openSocket(id: string, epoch: number) {
  const state = useWorkspaceSyncStore.getState();
  if (epoch !== generation || (state.ws && state.ws.readyState < WebSocket.CLOSING)) return;
  const ws = new WebSocket(workspaceApi.wsUrl(id, delivered.get(id) ?? state.revision));
  useWorkspaceSyncStore.setState({ ws });
  ws.onopen = () => {
    if (epoch === generation) useWorkspaceSyncStore.setState({ connected: true });
  };
  ws.onmessage = (event) => {
    if (epoch !== generation) return;
    try {
      const message = JSON.parse(event.data) as MutationBroadcastEvent;
      if (
        message.type === "workspace:snapshot" &&
        message.snapshot &&
        message.revision >= useWorkspaceSyncStore.getState().revision
      )
        acceptSnapshot(message.snapshot);
      else if (message.type === "mutation:committed" && message.mutation)
        useWorkspaceSyncStore.getState().applyRemoteMutation(message.mutation, message.revision);
    } catch (error) {
      console.error("Invalid workspace event", error);
    }
  };
  ws.onclose = () => {
    if (epoch !== generation) return;
    useWorkspaceSyncStore.setState({ ws: null, connected: false });
    setTimeout(() => {
      if (epoch === generation) openSocket(id, epoch);
    }, 1500);
  };
  ws.onerror = () => ws.close();
}
