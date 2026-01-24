import { create } from "zustand";

export interface TerminalSession {
  id: string;
  name: string;
  pinned?: boolean;
}

interface TerminalState {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  isListManagerOpen: boolean;

  setTerminals: (terminals: TerminalSession[]) => void;
  addTerminal: (terminal: TerminalSession) => void;
  removeTerminal: (id: string) => void;
  clearAllTerminals: () => void;
  setActiveTerminalId: (id: string | null) => void;
  updateTerminal: (id: string, updates: Partial<TerminalSession>) => void;
  renameTerminal: (id: string, name: string) => void;
  pinTerminal: (id: string) => void;
  setListManagerOpen: (open: boolean) => void;
  createTerminal: (name?: string) => TerminalSession;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: null,
  isListManagerOpen: false,

  setTerminals: (terminals) => set({ terminals }),

  addTerminal: (terminal) =>
    set((s) => ({
      terminals: [...s.terminals, terminal],
      activeTerminalId: terminal.id,
      isListManagerOpen: false,
    })),

  removeTerminal: (id) =>
    set((s) => {
      const removeIndex = s.terminals.findIndex((t) => t.id === id);
      const terminals = s.terminals.filter((t) => t.id !== id);
      let activeTerminalId = s.activeTerminalId;
      if (s.activeTerminalId === id) {
        if (terminals.length > 0) {
          activeTerminalId = terminals[Math.min(removeIndex, terminals.length - 1)].id;
        } else {
          activeTerminalId = null;
        }
      }
      return { terminals, activeTerminalId };
    }),

  clearAllTerminals: () =>
    set({ terminals: [], activeTerminalId: null }),

  setActiveTerminalId: (id) =>
    set({ activeTerminalId: id, isListManagerOpen: false }),

  updateTerminal: (id, updates) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, ...updates } : t,
      ),
    })),

  renameTerminal: (id, name) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, name } : t,
      ),
    })),

  pinTerminal: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, pinned: true } : t,
      ),
    })),

  setListManagerOpen: (open) => set({ isListManagerOpen: open }),

  createTerminal: (name) => {
    const { terminals } = get();
    const id = `term-${Date.now()}`;
    const terminalName = name || `Terminal ${terminals.length + 1}`;
    const terminal: TerminalSession = { id, name: terminalName };
    set((s) => ({
      terminals: [...s.terminals, terminal],
      activeTerminalId: id,
      isListManagerOpen: false,
    }));
    return terminal;
  },
}));
