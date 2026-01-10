import React, { useState, useEffect } from 'react';
import { AppView, FileNode, TerminalSession, EditorTab, Theme, Locale, GitFileNode } from './types';
import { 
  Menu, Files, GitGraph, Terminal, Plus, 
  X, FileText, LayoutTemplate, Box, FileDiff
} from 'lucide-react';
import { useTranslation } from './utils/i18n';

import CodeEditor from './components/CodeEditor';
import FileTree from './components/FileTree';
import GitView from './components/GitView';
import TerminalView from './components/TerminalView';
import ProjectMenu from './components/ProjectMenu';
import DiffView from './components/DiffView';

const App: React.FC = () => {
  // --- State ---
  const [theme, setTheme] = useState<Theme>('dark');
  const [locale, setLocale] = useState<Locale>('zh'); 
  
  const [currentView, setCurrentView] = useState<AppView>(AppView.FILES);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeTerminalId, setActiveTerminalId] = useState<string>('term-1');

  const t = useTranslation(locale);

  // --- Effects ---
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // --- Mock Data ---
  const fileSystem: FileNode[] = [
    {
      id: 'root',
      name: 'my-project',
      type: 'folder',
      children: [
        { 
          id: 'src', 
          name: 'src', 
          type: 'folder', 
          children: [
             { id: 'app', name: 'App.tsx', type: 'file', language: 'typescript', content: "import React from 'react';\n\nconst App = () => {\n  return <h1>Hello World</h1>;\n};\n\nexport default App;" },
             { id: 'utils', name: 'utils.ts', type: 'file', language: 'typescript', content: "export const add = (a, b) => a + b;" },
             { id: 'btn', name: 'Button.tsx', type: 'file', language: 'typescript', content: "export const Button = () => <button>Click</button>;" }
          ] 
        },
        { id: 'pkg', name: 'package.json', type: 'file', language: 'json', content: "{\n  \"name\": \"demo-app\"\n}" },
        { id: 'readme', name: 'README.md', type: 'file', language: 'markdown', content: "# Demo App\n\nThis is a cool project." },
      ]
    }
  ];

  const gitFiles: GitFileNode[] = [
    { 
        id: 'git-1', name: 'Button.tsx', path: 'src/components/Button.tsx', status: 'modified',
        originalContent: "export const Button = () => <button>Click</button>;",
        modifiedContent: "export const Button = () => <button className='btn'>Click Me</button>;"
    },
    { 
        id: 'git-2', name: 'helpers.ts', path: 'src/utils/helpers.ts', status: 'added',
        originalContent: "",
        modifiedContent: "export const formatDate = (d) => d.toString();"
    },
    {
        id: 'git-3', name: 'README.old.md', path: 'README.old.md', status: 'deleted',
        originalContent: "# Old Readme\n\nDeprecated.",
        modifiedContent: ""
    }
  ];

  const [openTabs, setOpenTabs] = useState<EditorTab[]>([
    { id: 'tab-1', fileId: 'app', title: 'App.tsx', isDirty: false, type: 'code' }
  ]);
  
  const [terminals, setTerminals] = useState<TerminalSession[]>([
    { id: 'term-1', name: 'sh', history: ['npm install', 'found 0 vulnerabilities'] },
    { id: 'term-2', name: 'node', history: ['Welcome to Node.js v18.0.0'] }
  ]);

  // --- Handlers ---
  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');
  const toggleLocale = () => setLocale(prev => prev === 'en' ? 'zh' : 'en');

  const handleFileClick = (node: FileNode) => {
    if (node.type === 'file') {
      const existingTab = openTabs.find(t => t.fileId === node.id);
      if (!existingTab) {
        setOpenTabs([...openTabs, { 
            id: `tab-${node.id}`, 
            fileId: node.id, 
            title: node.name, 
            isDirty: false,
            type: 'code'
        }]);
      }
      setActiveFileId(node.id);
      setCurrentView(AppView.FILES);
    }
  };

  const handleGitFileClick = (gitFile: GitFileNode) => {
     const tabId = `diff-${gitFile.id}`;
     const existingTab = openTabs.find(t => t.id === tabId);
     
     if (!existingTab) {
        setOpenTabs([...openTabs, {
            id: tabId,
            fileId: gitFile.id,
            title: `${gitFile.name} (Diff)`,
            isDirty: false,
            type: 'diff',
            data: {
                original: gitFile.originalContent,
                modified: gitFile.modifiedContent
            }
        }]);
     }
     
     setActiveFileId(gitFile.id);
  };

  const closeTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const newTabs = openTabs.filter(t => t.id !== tabId);
    setOpenTabs(newTabs);
    
    const activeTab = openTabs.find(t => 
        (t.type === 'code' && t.fileId === activeFileId) || 
        (t.type === 'diff' && t.fileId === activeFileId)
    );

    if (activeTab && activeTab.id === tabId) {
       if (newTabs.length > 0) {
           const nextTab = newTabs[newTabs.length - 1];
           setActiveFileId(nextTab.fileId);
       } else {
         setActiveFileId(null);
       }
    }
  };

  // --- Render Helpers ---
  const getActiveFileContent = (): string => {
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
      return activeFileId ? findContent(fileSystem, activeFileId) : '';
  };

  const activeTab = openTabs.find(t => t.fileId === activeFileId);

  const renderTopBar = () => {
    return (
      <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 flex-shrink-0 transition-colors duration-200">
        
        {(currentView === AppView.FILES || currentView === AppView.GIT) && (
          <>
            <button 
                onClick={() => setActiveFileId(null)}
                className={`flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-md transition-colors ${activeFileId === null ? 'bg-ide-accent text-white font-bold' : 'bg-ide-panel text-ide-mute border border-ide-border'}`}
                aria-label={t('explorer')}
            >
                <LayoutTemplate size={20} />
            </button>
            <div className="w-px h-6 bg-ide-border mx-1 flex-shrink-0" />
            {openTabs.map(tab => (
              <div 
                key={tab.id}
                onClick={() => setActiveFileId(tab.fileId)}
                className={`flex-shrink-0 pl-3 pr-2 py-1.5 rounded-md flex items-center gap-2 text-sm border transition-all cursor-pointer ${
                    activeFileId === tab.fileId 
                    ? 'bg-ide-panel border-ide-accent text-ide-accent' 
                    : 'bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text'
                }`}
              >
                {tab.type === 'diff' ? <FileDiff size={14} /> : <FileText size={14} />}
                <span className="max-w-[100px] truncate">{tab.title}</span>
                <button onClick={(e) => closeTab(e, tab.id)} className="p-0.5 hover:bg-white/10 rounded-full transition-colors">
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
                  className={`flex-shrink-0 px-4 py-1.5 rounded-md flex items-center gap-2 text-sm font-mono border ${
                    activeTerminalId === term.id
                    ? 'bg-ide-panel border-ide-accent text-ide-accent' 
                    : 'bg-transparent border-transparent text-ide-mute'
                  }`}
               >
                 <Box size={14} />
                 {term.name}
               </button>
             ))}
          </>
        )}

         <button className="flex-shrink-0 w-8 h-8 rounded-md bg-ide-panel hover:bg-ide-accent hover:text-white text-ide-mute flex items-center justify-center ml-auto border border-ide-border transition-colors">
            <Plus size={18} />
         </button>
      </div>
    );
  };

  const renderContent = () => {
    if (currentView === AppView.GIT && activeFileId === null) {
        return <GitView files={gitFiles} onFileClick={handleGitFileClick} locale={locale} />;
    }

    if (currentView === AppView.TERMINAL) {
        return <TerminalView activeTerminalId={activeTerminalId} terminals={terminals} />;
    }

    if (currentView === AppView.FILES && activeFileId === null) {
        return (
            <div className="h-full overflow-y-auto bg-ide-bg p-2 transition-colors duration-200">
                <h3 className="text-[10px] font-bold text-ide-mute uppercase tracking-[0.1em] mb-3 px-3 mt-2">{t('projectRoot')}</h3>
                <FileTree nodes={fileSystem} onFileClick={handleFileClick} activeFileId={activeFileId || undefined} />
            </div>
        );
    }

    if (activeTab) {
        if (activeTab.type === 'diff' && activeTab.data) {
            return <DiffView original={activeTab.data.original} modified={activeTab.data.modified} />;
        }
        return (
            <CodeEditor 
                content={getActiveFileContent()} 
                language="typescript" 
                onChange={() => {}} 
            />
        );
    }
    
    return (
        <div className="h-full flex flex-col items-center justify-center text-ide-mute gap-4">
             <LayoutTemplate size={48} className="opacity-20" />
             <p className="text-sm">Select a file from the explorer</p>
        </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-ide-bg text-ide-text overflow-hidden transition-colors duration-200">
      
      {/* 1. Top Bar */}
      {renderTopBar()}

      {/* 2. Main Workspace */}
      <main className="flex-1 overflow-hidden relative">
        {renderContent()}
      </main>

      {/* 3. Bottom Bar */}
      <footer className="h-14 bg-ide-panel border-t border-ide-border flex items-center px-4 justify-between flex-shrink-0 z-20 transition-colors duration-200 shadow-lg">
        
        {/* Left: Project Menu Trigger */}
        <button 
          onClick={() => setIsMenuOpen(true)}
          className="flex items-center gap-2 group"
        >
          <div className="p-2 bg-ide-bg rounded-lg border border-ide-border group-hover:border-ide-accent transition-colors">
             <Menu size={20} className="text-ide-text group-hover:text-ide-accent" />
          </div>
          <div className="flex flex-col items-start">
             <span className="text-[9px] text-ide-mute leading-none uppercase tracking-wider">{t('project')}</span>
             <span className="text-xs font-bold leading-tight">my-project</span>
          </div>
        </button>

        {/* Center: Tabs/Mode Selection */}
        <div className="flex bg-ide-bg rounded-full p-1 border border-ide-border shadow-inner">
          <button 
            onClick={() => setCurrentView(AppView.FILES)}
            className={`p-2 rounded-full transition-all ${currentView === AppView.FILES ? 'bg-ide-accent text-white shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <Files size={20} />
          </button>
          <button 
            onClick={() => {
                setCurrentView(AppView.GIT);
                setActiveFileId(null);
            }}
            className={`p-2 rounded-full transition-all ${currentView === AppView.GIT ? 'bg-ide-accent text-white shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <GitGraph size={20} />
          </button>
          <button 
             onClick={() => setCurrentView(AppView.TERMINAL)}
             className={`p-2 rounded-full transition-all ${currentView === AppView.TERMINAL ? 'bg-ide-accent text-white shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <Terminal size={20} />
          </button>
        </div>

        {/* Right: Plus Button */}
        <button className="p-3 bg-ide-accent text-white rounded-full shadow-xl shadow-sky-500/10 active:scale-90 transition-all hover:brightness-110">
           <Plus size={20} strokeWidth={3} />
        </button>
      </footer>

      <ProjectMenu 
        isOpen={isMenuOpen} 
        onClose={() => setIsMenuOpen(false)} 
        theme={theme}
        toggleTheme={toggleTheme}
        locale={locale}
        toggleLocale={toggleLocale}
      />

    </div>
  );
};

export default App;