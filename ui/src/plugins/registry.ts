import React from "react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface TopBarButton {
  icon: ReactNode;
  label?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface BottomBarButton {
  icon: ReactNode;
  label?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface PageMenuConfig {
  id: string;
  icon: ReactNode;
  label: string;
  badge?: string | number;
  onClick?: () => void;
}

export interface PageFrameConfig {
  topBar?: {
    leftButtons?: TopBarButton[];
    centerContent?: string | ReactNode;
    rightButtons?: TopBarButton[];
    show?: boolean;
  };
  bottomBar?: {
    menuItems?: PageMenuConfig[];
    rightButtons?: BottomBarButton[];
    show?: boolean;
  };
  tabBar?: {
    enabled?: boolean;
    actionIcon?: "plus" | "refresh";
    actionLabel?: string;
  };
}

export interface PluginContext {
  groupId: string;
  tabId: string | null;
  isActive: boolean;
}

export interface PluginViewProps {
  isActive: boolean;
  context?: PluginContext;
}

export interface Plugin {
  id: string;
  name: string;
  nameKey?: string;
  icon: LucideIcon;
  order?: number;
  view: React.ComponentType<PluginViewProps>;
  getFrameConfig?: (context: PluginContext) => PageFrameConfig;
  getMenuItems?: (context: PluginContext) => PageMenuConfig[];
}

class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private listeners: Set<() => void> = new Set();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      console.warn(`Plugin "${plugin.id}" already registered, overwriting.`);
    }
    this.plugins.set(plugin.id, plugin);
    this.notify();
  }

  unregister(id: string): void {
    this.plugins.delete(id);
    this.notify();
  }

  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  getAll(): Plugin[] {
    return Array.from(this.plugins.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const pluginRegistry = new PluginRegistry();

export function registerPlugin(plugin: Plugin): void {
  pluginRegistry.register(plugin);
}

export function unregisterPlugin(id: string): void {
  pluginRegistry.unregister(id);
}
