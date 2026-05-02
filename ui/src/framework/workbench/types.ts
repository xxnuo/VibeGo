import type React from "react";
import type { PageDefinition } from "@/pages/types";

export type WorkbenchLocation = "header-left" | "header-right" | "editor-title";

export interface WorkbenchAction {
  id: string;
  icon: React.ReactNode;
  title: string;
  ariaLabel?: string;
  onClick: () => void | Promise<void>;
  active?: boolean;
  disabled?: boolean;
  when?: string;
  order?: number;
}

export type WorkbenchPageDefinition = PageDefinition;

export type { PageCategory, PageContext, PageId, PageViewProps } from "@/pages/types";
export type { TabItem } from "@/stores/frame-store";

export interface CustomEditorDefinition {
  id: string;
  name?: string;
  fileExtensions: string[];
  priority?: number;
  Component: React.ComponentType<{ file: import("@/stores/file-manager-store").FileItem }>;
}
export interface PluginConfigurationProperty {
  type: "string" | "number" | "boolean";
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  secret?: boolean;
  scope?: "global" | "workspace";
}
export interface PluginConfiguration {
  title?: string;
  properties: Record<string, PluginConfigurationProperty>;
}
export type MenuLocation = "new-page" | "project" | "file-context";
export interface MenuContribution {
  id: string;
  location: MenuLocation;
  title: string;
  titleKey?: string;
  icon?: import("lucide-react").LucideIcon;
  command: string;
  when?: string;
  order?: number;
  section?: "builtIn" | "editor" | "context";
}
export interface CommandContribution {
  id: string;
  title: string;
  when?: string;
  handler: (...args: any[]) => any;
}
export interface KeybindingContribution {
  command: string;
  key: string;
  when?: string;
}
export interface QuickOpenItem {
  id: string;
  label: string;
  description?: string;
  icon?: import("lucide-react").LucideIcon;
  run: () => void | Promise<void>;
}
export interface QuickOpenProvider {
  id: string;
  prefix?: string;
  search: (query: string, signal: AbortSignal) => Promise<QuickOpenItem[]> | QuickOpenItem[];
}
export interface PluginManifest {
  id: string;
  name: string;
  exports?: unknown;
  contributions?: {
    workspaceViews?: WorkbenchPageDefinition[];
    pages?: WorkbenchPageDefinition[];
    customEditors?: CustomEditorDefinition[];
    menu?: MenuContribution[];
    menus?: MenuContribution[];
    configuration?: PluginConfiguration;
    commands?: CommandContribution[];
    keybindings?: KeybindingContribution[];
    quickOpenProviders?: QuickOpenProvider[];
  };
}
