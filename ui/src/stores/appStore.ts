import { create } from "zustand";

export type Theme = "light" | "dark" | "hacker" | "terminal";
export type Locale = "en" | "zh";

export enum AppView {
  FILES = "FILES",
  GIT = "GIT",
  TERMINAL = "TERMINAL",
  PLUGIN = "PLUGIN",
}

interface AppState {
  theme: Theme;
  locale: Locale;
  currentView: AppView;
  isMenuOpen: boolean;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setCurrentView: (view: AppView) => void;
  setMenuOpen: (open: boolean) => void;
}

const THEME_ORDER: Theme[] = ["light", "dark", "hacker", "terminal"];

export const useAppStore = create<AppState>((set, get) => ({
  theme: "light",
  locale: "zh",
  currentView: AppView.FILES,
  isMenuOpen: false,

  setTheme: (theme) => set({ theme }),
  toggleTheme: () => {
    const { theme } = get();
    const nextIndex = (THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length;
    set({ theme: THEME_ORDER[nextIndex] });
  },
  setLocale: (locale) => set({ locale }),
  toggleLocale: () => set((s) => ({ locale: s.locale === "en" ? "zh" : "en" })),
  setCurrentView: (view) => set({ currentView: view }),
  setMenuOpen: (open) => set({ isMenuOpen: open }),
}));
