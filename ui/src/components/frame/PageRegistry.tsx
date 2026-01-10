import React from 'react';
import { Files, GitGraph, Terminal, Box } from 'lucide-react';
import { AppView } from '@/stores/appStore';

export interface PageConfig {
  id: string;
  viewType: AppView;
  icon: React.ReactNode;
  label: string;
  component: React.ComponentType<PageComponentProps>;
  tabBarConfig?: {
    showBackButton?: boolean;
    actionIcon?: 'plus' | 'refresh';
    actionLabel?: string;
  };
}

export interface PageComponentProps {
  onOpenTab?: (tab: { id: string; title: string; data?: Record<string, unknown> }) => void;
}

const pageRegistry = new Map<string, PageConfig>();

export const registerPage = (config: PageConfig) => {
  pageRegistry.set(config.id, config);
};

export const unregisterPage = (id: string) => {
  pageRegistry.delete(id);
};

export const getPage = (id: string): PageConfig | undefined => {
  return pageRegistry.get(id);
};

export const getPageByViewType = (viewType: AppView): PageConfig | undefined => {
  for (const config of pageRegistry.values()) {
    if (config.viewType === viewType) return config;
  }
  return undefined;
};

export const getAllPages = (): PageConfig[] => {
  return Array.from(pageRegistry.values());
};

export const DEFAULT_PAGE_CONFIGS: Omit<PageConfig, 'component'>[] = [
  {
    id: 'files',
    viewType: AppView.FILES,
    icon: <Files size={16} />,
    label: 'Files',
    tabBarConfig: {
      showBackButton: true,
      actionIcon: 'plus',
      actionLabel: 'New File',
    },
  },
  {
    id: 'git',
    viewType: AppView.GIT,
    icon: <GitGraph size={16} />,
    label: 'Git',
    tabBarConfig: {
      showBackButton: true,
      actionIcon: 'refresh',
      actionLabel: 'Refresh',
    },
  },
  {
    id: 'terminal',
    viewType: AppView.TERMINAL,
    icon: <Terminal size={16} />,
    label: 'Terminal',
    tabBarConfig: {
      showBackButton: false,
      actionIcon: 'plus',
      actionLabel: 'New Terminal',
    },
  },
  {
    id: 'plugin',
    viewType: AppView.PLUGIN,
    icon: <Box size={16} />,
    label: 'Plugin',
    tabBarConfig: {
      showBackButton: true,
      actionIcon: 'plus',
      actionLabel: 'New',
    },
  },
];

export default pageRegistry;
