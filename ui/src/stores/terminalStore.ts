import { create } from 'zustand';

export interface TerminalSession {
  id: string;
  name: string;
  history: string[];
}

interface TerminalState {
  terminals: TerminalSession[];
  activeTerminalId: string | null;

  setTerminals: (terminals: TerminalSession[]) => void;
  addTerminal: (terminal: TerminalSession) => void;
  removeTerminal: (id: string) => void;
  setActiveTerminalId: (id: string | null) => void;
  updateTerminal: (id: string, updates: Partial<TerminalSession>) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  terminals: [],
  activeTerminalId: null,

  setTerminals: (terminals) => set({ terminals }),
  addTerminal: (terminal) =>
    set((s) => ({
      terminals: [...s.terminals, terminal],
      activeTerminalId: terminal.id,
    })),
  removeTerminal: (id) =>
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id);
      const activeTerminalId =
        s.activeTerminalId === id
          ? terminals.length > 0
            ? terminals[terminals.length - 1].id
            : null
          : s.activeTerminalId;
      return { terminals, activeTerminalId };
    }),
  setActiveTerminalId: (id) => set({ activeTerminalId: id }),
  updateTerminal: (id, updates) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
}));
