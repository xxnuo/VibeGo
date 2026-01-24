import { create } from "zustand";

export interface TerminalSession {
  id: string;
  name: string;
  pinned?: boolean;
}

interface TerminalState {
  terminalsByGroup: Record<string, TerminalSession[]>;
  activeIdByGroup: Record<string, string | null>;
  listManagerOpenByGroup: Record<string, boolean>;

  getTerminals: (groupId: string) => TerminalSession[];
  addTerminal: (groupId: string, terminal: TerminalSession) => void;
  removeTerminal: (groupId: string, terminalId: string) => void;
  clearAllTerminals: (groupId: string) => void;
  getActiveId: (groupId: string) => string | null;
  setActiveId: (groupId: string, terminalId: string | null) => void;
  updateTerminal: (groupId: string, id: string, updates: Partial<TerminalSession>) => void;
  renameTerminal: (groupId: string, id: string, name: string) => void;
  pinTerminal: (groupId: string, id: string) => void;
  isListManagerOpen: (groupId: string) => boolean;
  setListManagerOpen: (groupId: string, open: boolean) => void;
  reset: () => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminalsByGroup: {},
  activeIdByGroup: {},
  listManagerOpenByGroup: {},

  getTerminals: (groupId) => {
    return get().terminalsByGroup[groupId] || [];
  },

  addTerminal: (groupId, terminal) =>
    set((s) => {
      const isRestoring = s.terminalsByGroup[groupId]?.length > 0;
      return {
        terminalsByGroup: {
          ...s.terminalsByGroup,
          [groupId]: [...(s.terminalsByGroup[groupId] || []), terminal],
        },
        activeIdByGroup: isRestoring
          ? s.activeIdByGroup
          : {
            ...s.activeIdByGroup,
            [groupId]: terminal.id,
          },
        listManagerOpenByGroup: isRestoring
          ? s.listManagerOpenByGroup
          : {
            ...s.listManagerOpenByGroup,
            [groupId]: false,
          },
      };
    }),

  removeTerminal: (groupId, terminalId) =>
    set((s) => {
      const terminals = s.terminalsByGroup[groupId] || [];
      const removeIndex = terminals.findIndex((t) => t.id === terminalId);
      const newTerminals = terminals.filter((t) => t.id !== terminalId);

      let activeId = s.activeIdByGroup[groupId];
      if (activeId === terminalId) {
        if (newTerminals.length > 0) {
          activeId = newTerminals[Math.min(removeIndex, newTerminals.length - 1)].id;
        } else {
          activeId = null;
        }
      }

      return {
        terminalsByGroup: {
          ...s.terminalsByGroup,
          [groupId]: newTerminals,
        },
        activeIdByGroup: {
          ...s.activeIdByGroup,
          [groupId]: activeId,
        },
      };
    }),

  clearAllTerminals: (groupId) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: [],
      },
      activeIdByGroup: {
        ...s.activeIdByGroup,
        [groupId]: null,
      },
    })),

  getActiveId: (groupId) => {
    return get().activeIdByGroup[groupId] || null;
  },

  setActiveId: (groupId, terminalId) =>
    set((s) => ({
      activeIdByGroup: {
        ...s.activeIdByGroup,
        [groupId]: terminalId,
      },
      listManagerOpenByGroup: {
        ...s.listManagerOpenByGroup,
        [groupId]: false,
      },
    })),

  updateTerminal: (groupId, id, updates) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) =>
          t.id === id ? { ...t, ...updates } : t,
        ),
      },
    })),

  renameTerminal: (groupId, id, name) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) =>
          t.id === id ? { ...t, name } : t,
        ),
      },
    })),

  pinTerminal: (groupId, id) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) =>
          t.id === id ? { ...t, pinned: true } : t,
        ),
      },
    })),

  isListManagerOpen: (groupId) => {
    const state = get().listManagerOpenByGroup[groupId];
    return state === undefined ? true : state;
  },

  setListManagerOpen: (groupId, open) =>
    set((s) => ({
      listManagerOpenByGroup: {
        ...s.listManagerOpenByGroup,
        [groupId]: open,
      },
    })),

  reset: () =>
    set({
      terminalsByGroup: {},
      activeIdByGroup: {},
      listManagerOpenByGroup: {},
    }),
}));
