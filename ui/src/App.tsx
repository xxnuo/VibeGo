import React, { useEffect } from 'react';
import {
  Menu, Files, GitGraph, Terminal, Plus,
  X, FileText, LayoutTemplate, Box, FileDiff, Cpu, Wifi
} from 'lucide-react';
import { useTranslation } from '@/utils/i18n';
import {
  useAppStore, useEditorStore, useTerminalStore, useFileStore,
  AppView, type FileNode, type GitFileNode
} from '@/stores';

import CodeEditor from '@/components/CodeEditor';
import FileTree from '@/components/FileTree';
import GitView from '@/components/GitView';
import TerminalView from '@/components/TerminalView';
import ProjectMenu from '@/components/ProjectMenu';
import DiffView from '@/components/DiffView';

const MOCK_FILE_SYSTEM: FileNode[] = [
  {
    id: 'root',
    name: 'mainframe_v1',
    type: 'folder',
    children: [
      {
        id: 'src',
        name: 'kernel',
        type: 'folder',
        children: [
          { id: 'app', name: 'boot.sys', type: 'file', language: 'typescript', content: "// BOOT SEQUENCE INITIATED\nimport System from 'kernel';\n\nSystem.init({ mode: 'HACK' });" },
          { id: 'utils', name: 'decrypt.ts', type: 'file', language: 'typescript', content: "export const crack = (hash) => {\n  // BRUTE FORCE ATTACK\n  return 'p@ssword1';\n}" },
          { id: 'btn', name: 'payload.js', type: 'file', language: 'javascript', content: "const deploy = () => console.log('Payload delivered');" }
        ]
      },
      { id: 'pkg', name: 'manifest.json', type: 'file', language: 'json', content: "{\n  \"target\": \"corp_network\"\n}" },
      { id: 'readme', name: 'TARGETS.md', type: 'file', language: 'markdown', content: "# TARGET LIST\n\n1. Main Server\n2. Backup Grid" },
    ]
  }
];

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
  const { theme, locale, currentView, isMenuOpen, toggleTheme, toggleLocale, setCurrentView, setMenuOpen } = useAppStore();
  const { tabs, activeTabId, openFileTab, closeTab, setActiveTabId } = useEditorStore();
  const { terminals, activeTerminalId, setTerminals, setActiveTerminalId } = useTerminalStore();
  const { fileTree, setFileTree } = useFileStore();

  const t = useTranslation(locale);

  useEffect(() => {
    if (fileTree.length === 0) setFileTree(MOCK_FILE_SYSTEM);
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

  const handleFileClick = (node: FileNode) => {
    if (node.type === 'file') {
      openFileTab(node.id, node.name, 'code');
      setCurrentView(AppView.FILES);
    }
  };

  const handleGitFileClick = (gitFile: GitFileNode) => {
    openFileTab(gitFile.id, gitFile.name, 'diff', {
      original: gitFile.originalContent,
      modified: gitFile.modifiedContent
    });
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  const getActiveFileContent = (): string => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab) return '';
    const findContent = (nodes: FileNode[], id: string): string => {
      for (const node of nodes) {
        if (node.id === id) return node.content || '';
        if (node.children) {
          const res = findContent(node.children, id);
          if (res) return res;
        }
      }
      return '';
    };
    return findContent(fileTree, activeTab.fileId);
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  const renderTopBar = () => (
    <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 shrink-0 transition-colors duration-300">
      <div className="px-2 flex items-center justify-center text-ide-accent font-bold text-xs border-r border-ide-border mr-1 h-8">
        <span className="animate-pulse mr-1">●</span> 4492
      </div>

      {(currentView === AppView.FILES || currentView === AppView.GIT) && (
        <>
          <button
            onClick={() => setActiveTabId(null)}
            className={`shrink-0 h-8 w-8 flex items-center justify-center rounded-md border transition-all ${activeTabId === null ? 'bg-ide-accent text-ide-bg border-ide-accent shadow-glow' : 'bg-transparent text-ide-mute border-transparent hover:bg-ide-panel hover:text-ide-text'}`}
            aria-label={t('explorer')}
          >
            <LayoutTemplate size={18} />
          </button>
          <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`shrink-0 px-3 h-8 rounded-md flex items-center gap-2 text-xs border transition-all cursor-pointer ${activeTabId === tab.id
                ? 'bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm'
                : 'bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text'
                }`}
            >
              {tab.type === 'diff' ? <FileDiff size={14} /> : <FileText size={14} />}
              <span className="max-w-[100px] truncate font-medium">{tab.title}</span>
              <button onClick={(e) => handleCloseTab(e, tab.id)} className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-bg">
                <X size={12} />
              </button>
            </div>
          ))}
        </>
      )}

      {currentView === AppView.TERMINAL && (
        <>
          {terminals.map(term => (
            <button
              key={term.id}
              onClick={() => setActiveTerminalId(term.id)}
              className={`shrink-0 px-4 h-8 rounded-md flex items-center gap-2 text-xs font-mono border ${activeTerminalId === term.id
                ? 'bg-ide-panel border-ide-accent text-ide-accent shadow-glow'
                : 'bg-transparent border-transparent text-ide-mute'
                }`}
            >
              <Box size={14} />
              {term.name}
            </button>
          ))}
        </>
      )}

      <button className="shrink-0 w-8 h-8 rounded-md ml-auto text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors">
        <Plus size={18} />
      </button>
    </div>
  );

  const renderContent = () => {
    if (currentView === AppView.GIT && activeTabId === null) {
      return <GitView files={MOCK_GIT_FILES} onFileClick={handleGitFileClick} locale={locale} />;
    }

    if (currentView === AppView.TERMINAL) {
      return <TerminalView activeTerminalId={activeTerminalId || ''} terminals={terminals} />;
    }

    if (currentView === AppView.FILES && activeTabId === null) {
      return (
        <div className="h-full overflow-y-auto bg-ide-bg p-2 transition-colors duration-300">
          <div className="border border-ide-border rounded-lg p-3 mb-4 bg-ide-panel/50 shadow-sm">
            <p className="text-[10px] text-ide-accent mb-2 font-bold tracking-wider">SYSTEM_STATUS</p>
            <div className="h-1.5 w-full bg-ide-border rounded-full overflow-hidden">
              <div className="h-full bg-ide-accent w-3/4 shadow-glow"></div>
            </div>
          </div>
          <h3 className="text-[10px] font-bold text-ide-mute uppercase mb-2 px-2 tracking-widest">{t('projectRoot')}</h3>
          <FileTree nodes={fileTree} onFileClick={handleFileClick} activeFileId={activeTab?.fileId} />
        </div>
      );
    }

    if (activeTab) {
      if (activeTab.type === 'diff' && activeTab.data) {
        return <DiffView original={activeTab.data.original || ''} modified={activeTab.data.modified || ''} />;
      }
      return (
        <CodeEditor
          content={getActiveFileContent()}
          language="typescript"
          onChange={() => { }}
        />
      );
    }

    return (
      <div className="h-full flex flex-col items-center justify-center text-ide-mute gap-4 border-2 border-dashed border-ide-border m-4 rounded-xl bg-ide-panel/30">
        <LayoutTemplate size={48} className="text-ide-accent opacity-50" />
        <p className="text-sm font-bold tracking-widest text-ide-accent">WAITING_FOR_INPUT...</p>
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-ide-bg text-ide-text overflow-hidden font-mono transition-colors duration-300">
      {renderTopBar()}
      <main className="flex-1 overflow-hidden relative border-b border-ide-border">
        {renderContent()}
      </main>
      <footer className="h-14 bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)]">
        <button
          onClick={() => setMenuOpen(true)}
          className="h-full px-4 flex items-center gap-3 hover:bg-ide-bg transition-colors border-r border-ide-border group"
        >
          <div className="p-1.5 rounded-md border border-ide-border group-hover:border-ide-accent group-hover:text-ide-accent transition-colors">
            <Menu size={18} />
          </div>
          <span className="font-bold tracking-wider text-xs hidden sm:inline">MENU</span>
        </button>
        <div className="flex h-10 bg-ide-bg rounded-lg p-1 border border-ide-border gap-1">
          <button
            onClick={() => setCurrentView(AppView.FILES)}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.FILES ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <Files size={16} />
          </button>
          <button
            onClick={() => { setCurrentView(AppView.GIT); setActiveTabId(null); }}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.GIT ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <GitGraph size={16} />
          </button>
          <button
            onClick={() => setCurrentView(AppView.TERMINAL)}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.TERMINAL ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <Terminal size={16} />
          </button>
        </div>
        <div className="flex items-center gap-3 px-4 text-ide-mute text-[10px] font-bold">
          <div className="hidden sm:flex items-center gap-1">
            <Cpu size={14} />
            <span>12%</span>
          </div>
          <div className="flex items-center gap-1 text-ide-accent animate-pulse">
            <Wifi size={14} />
            <span className="hidden sm:inline">ONLINE</span>
          </div>
        </div>
      </footer>
      <ProjectMenu
        isOpen={isMenuOpen}
        onClose={() => setMenuOpen(false)}
        theme={theme}
        toggleTheme={toggleTheme}
        locale={locale}
        toggleLocale={toggleLocale}
      />
    </div>
  );
};

export default App;
