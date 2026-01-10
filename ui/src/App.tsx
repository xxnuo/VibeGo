import React, { useEffect, useCallback, useState } from 'react';
import {
  useAppStore, useTerminalStore, usePreviewStore,
  useFileManagerStore, useFrameStore,
  type GitFileNode, type FileItem, type Theme, type Locale
} from '@/stores';

import { AppFrame, NewGroupMenu } from '@/components/frame';
import FileManager from '@/components/FileManager';
import GitView from '@/components/GitView';
import TerminalView from '@/components/TerminalView';
import ProjectMenu from '@/components/ProjectMenu';
import DiffView from '@/components/DiffView';
import { FilePreview } from '@/components/preview';
import SettingsPage from '@/components/SettingsPage';
import { fileApi } from '@/api/file';
import { useSettingsStore } from '@/lib/settings';

const MOCK_GIT_FILES: GitFileNode[] = [
  {
    id: 'git-1', name: 'payload.js', path: 'src/kernel/payload.js', status: 'modified',
    originalContent: "const deploy = () => console.log('Waiting...');",
    modifiedContent: "const deploy = () => console.log('Payload delivered');"
  },
  {
    id: 'git-2', name: 'decrypt.ts', path: 'src/kernel/decrypt.ts', status: 'added',
    originalContent: "",
    modifiedContent: "export const crack = (hash) => { ... }"
  },
  {
    id: 'git-3', name: 'logs.txt', path: 'logs.txt', status: 'deleted',
    originalContent: "ACCESS GRANTED",
    modifiedContent: ""
  }
];

const MOCK_TERMINALS = [
  { id: 'term-1', name: 'root@proxynode', history: ['> connecting to 192.168.0.1...', '> secure handshake... OK'] },
  { id: 'term-2', name: 'net_watch', history: ['scanning ports...'] }
];

const App: React.FC = () => {
  const { theme, locale, isMenuOpen, setMenuOpen, setTheme, setLocale } = useAppStore();
  const { terminals, activeTerminalId, setTerminals, addTerminal } = useTerminalStore();
  const resetPreview = usePreviewStore((s) => s.reset);
  const { rootPath, goToPath, currentPath } = useFileManagerStore();
  const initSettings = useSettingsStore((s) => s.init);
  const themeSetting = useSettingsStore((s) => s.settings.theme);
  const localeSetting = useSettingsStore((s) => s.settings.locale);

  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const currentView = useFrameStore((s) => s.getCurrentView());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const addCurrentTab = useFrameStore((s) => s.addCurrentTab);
  const openPreviewTab = useFrameStore((s) => s.openPreviewTab);
  const addWorkspaceGroup = useFrameStore((s) => s.addWorkspaceGroup);
  const addTerminalGroup = useFrameStore((s) => s.addTerminalGroup);
  const addPluginGroup = useFrameStore((s) => s.addPluginGroup);
  const addSettingsGroup = useFrameStore((s) => s.addSettingsGroup);

  const [isNewGroupMenuOpen, setNewGroupMenuOpen] = useState(false);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  useEffect(() => {
    if (themeSetting) setTheme(themeSetting as Theme);
  }, [themeSetting, setTheme]);

  useEffect(() => {
    if (localeSetting) setLocale(localeSetting as Locale);
  }, [localeSetting, setLocale]);

  useEffect(() => {
    if (terminals.length === 0) setTerminals(MOCK_TERMINALS);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.className = '';
    body.classList.remove('scanlines');
    switch (theme) {
      case 'dark':
        root.classList.add('dark');
        break;
      case 'hacker':
        root.classList.add('dark', 'hacker');
        break;
      case 'terminal':
        root.classList.add('dark', 'terminal');
        body.classList.add('scanlines');
        break;
    }
  }, [theme]);

  const handleGitFileClick = useCallback((gitFile: GitFileNode) => {
    addCurrentTab({
      id: `diff-${gitFile.id}`,
      title: `${gitFile.name} [DIFF]`,
      data: {
        type: 'diff',
        original: gitFile.originalContent,
        modified: gitFile.modifiedContent
      }
    });
  }, [addCurrentTab]);

  const handleFileOpen = useCallback((file: FileItem) => {
    openPreviewTab({
      id: `tab-${file.path}`,
      title: file.name,
      data: { type: 'code', path: file.path }
    });
  }, [openPreviewTab]);

  const handleBackToList = useCallback(() => {
    resetPreview();
    if (currentView === 'files') {
      goToPath(rootPath);
    }
  }, [resetPreview, currentView, goToPath, rootPath]);

  const handleTabAction = useCallback(async () => {
    if (!activeGroup) return;

    if (activeGroup.type === 'workspace') {
      switch (currentView) {
        case 'files':
          if (activeTabId === null) {
            useFileManagerStore.getState().setLoading(true);
            const path = useFileManagerStore.getState().currentPath;
            try {
              const res = await fileApi.list(path);
              const files = res.files.map((f) => ({
                path: f.path,
                name: f.name,
                size: f.size,
                isDir: f.isDir,
                isSymlink: f.isSymlink,
                isHidden: f.isHidden,
                mode: f.mode,
                mimeType: f.mimeType,
                modTime: f.modTime,
                extension: f.extension,
              }));
              useFileManagerStore.getState().setFiles(files);
            } finally {
              useFileManagerStore.getState().setLoading(false);
            }
          } else {
            const newPath = prompt('New file name:');
            if (newPath) {
              await fileApi.create({ path: `${currentPath}/${newPath}`, isDir: false });
            }
          }
          break;
        case 'terminal':
          addTerminal({ id: `term-${Date.now()}`, name: `shell-${terminals.length + 1}`, history: [] });
          break;
        case 'git':
          break;
      }
    } else if (activeGroup.type === 'terminal') {
      addCurrentTab({
        id: `term-${Date.now()}`,
        title: `Terminal ${tabs.length + 1}`,
        data: { type: 'terminal' }
      });
    } else if (activeGroup.type === 'plugin') {
      addCurrentTab({
        id: `plugin-tab-${Date.now()}`,
        title: `${activeGroup.name} ${tabs.length + 1}`,
        data: { type: 'plugin', pluginId: activeGroup.pluginId }
      });
    }
  }, [activeGroup, currentView, currentPath, terminals.length, addTerminal, addCurrentTab, tabs.length, activeTabId]);

  const handleOpenDirectory = useCallback(() => {
    const path = prompt('Enter directory path:');
    if (path) {
      addWorkspaceGroup(path);
    }
  }, [addWorkspaceGroup]);

  const handleNewTerminal = useCallback(() => {
    addTerminalGroup();
  }, [addTerminalGroup]);

  const handleNewPlugin = useCallback((pluginId: string) => {
    addPluginGroup(pluginId, pluginId);
  }, [addPluginGroup]);

  const activeTab = tabs.find(t => t.id === activeTabId);

  const renderContent = () => {
    if (!activeGroup) return null;

    if (activeGroup.type === 'settings') {
      return <SettingsPage />;
    }

    if (activeGroup.type === 'terminal') {
      return <TerminalView activeTerminalId={activeTerminalId || ''} terminals={terminals} />;
    }

    if (activeGroup.type === 'plugin') {
      return (
        <div className="h-full flex items-center justify-center text-ide-mute">
          Plugin: {activeGroup.pluginId}
        </div>
      );
    }

    if (activeGroup.type === 'workspace') {
      if (currentView === 'git') {
        if (activeTabId === null) {
          return <GitView files={MOCK_GIT_FILES} onFileClick={handleGitFileClick} locale={locale} />;
        }
        if (activeTab?.data?.type === 'diff') {
          return <DiffView original={(activeTab.data.original as string) || ''} modified={(activeTab.data.modified as string) || ''} />;
        }
      }

      if (currentView === 'terminal') {
        return <TerminalView activeTerminalId={activeTerminalId || ''} terminals={terminals} />;
      }

      if (currentView === 'files') {
        if (activeTabId !== null && activeTab) {
          return (
            <FilePreview
              file={{
                path: (activeTab.data?.path as string) || activeTab.id,
                name: activeTab.title,
                size: 0,
                isDir: false,
                isSymlink: false,
                isHidden: false,
                mode: '',
                modTime: '',
                extension: activeTab.title.includes('.') ? '.' + activeTab.title.split('.').pop() : '',
              }}
            />
          );
        }
        return (
          <FileManager
            initialPath={activeGroup.path}
            onFileOpen={handleFileOpen}
          />
        );
      }
    }

    return null;
  };

  return (
    <>
      <AppFrame
        onMenuOpen={() => setMenuOpen(true)}
        onTabAction={handleTabAction}
        onBackToList={handleBackToList}
      >
        {renderContent()}
      </AppFrame>
      <ProjectMenu
        isOpen={isMenuOpen}
        onClose={() => setMenuOpen(false)}
        locale={locale}
        onOpenSettings={addSettingsGroup}
        onOpenDirectory={handleOpenDirectory}
        onNewTerminal={handleNewTerminal}
      />
      <NewGroupMenu
        isOpen={isNewGroupMenuOpen}
        onClose={() => setNewGroupMenuOpen(false)}
        onOpenDirectory={handleOpenDirectory}
        onNewTerminal={handleNewTerminal}
        onNewPlugin={handleNewPlugin}
        availablePlugins={[
          { id: 'claude-code', name: 'Claude Code' },
          { id: 'gemini-cli', name: 'Gemini CLI' },
        ]}
      />
    </>
  );
};

export default App;
