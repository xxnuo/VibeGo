import { create } from 'zustand';
import { settingsApi } from '@/api/settings';
import { getDefaultSettings, SETTINGS_SCHEMA } from './schema';
import type { Theme, Locale } from '@/stores/appStore';

interface SettingsState {
  settings: Record<string, string>;
  loading: boolean;
  initialized: boolean;

  init: () => Promise<void>;
  get: (key: string) => string;
  set: (key: string, value: string) => Promise<void>;
  reset: () => Promise<void>;

  getTheme: () => Theme;
  getLocale: () => Locale;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: getDefaultSettings(),
  loading: false,
  initialized: false,

  init: async () => {
    if (get().initialized) return;
    set({ loading: true });
    try {
      const remote = await settingsApi.list();
      const merged = { ...getDefaultSettings(), ...remote };
      set({ settings: merged, initialized: true });
    } catch {
      set({ settings: getDefaultSettings(), initialized: true });
    } finally {
      set({ loading: false });
    }
  },

  get: (key: string) => {
    const { settings } = get();
    const schema = SETTINGS_SCHEMA.find((s) => s.key === key);
    return settings[key] ?? schema?.defaultValue ?? '';
  },

  set: async (key: string, value: string) => {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    try {
      await settingsApi.set(key, value);
    } catch (e) {
      console.error('Failed to save setting:', e);
    }
  },

  reset: async () => {
    const defaults = getDefaultSettings();
    set({ settings: defaults });
    try {
      await settingsApi.reset();
    } catch (e) {
      console.error('Failed to reset settings:', e);
    }
  },

  getTheme: () => get().settings.theme as Theme || 'light',
  getLocale: () => get().settings.locale as Locale || 'zh',
}));
