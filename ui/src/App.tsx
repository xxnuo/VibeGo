import React, { useState, useEffect } from 'react';
import { AppView } from './types';
import type { FileNode, TerminalSession, EditorTab, Theme, Locale, GitFileNode } from './types';
import { 
  Menu, Files, GitGraph, Terminal, Plus, 
  X, FileText, LayoutTemplate, Box, FileDiff, Cpu, Wifi
} from 'lucide-react';
import { useTranslation } from './utils/i18n';

import CodeEditor from './components/CodeEditor';
import FileTree from './components/FileTree';
import GitView from './components/GitView';
import TerminalView from './components/TerminalView';
import ProjectMenu from './components/ProjectMenu';
import DiffView from './components/DiffView';
import { Toaster, toast } from 'sonner';

import * as api from './services/api';

const App: React.FC = () => {
  // --- State ---
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
  });
  
  const [locale, setLocale] = useState<Locale>(() => {
      if (typeof navigator !== 'undefined' && navigator.language.startsWith('zh')) {
          return 'zh';
      }
      return 'en';
  });
  
  const [currentView, setCurrentView] = useState<AppView>(AppView.FILES);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  const [fileSystem, setFileSystem] = useState<FileNode[]>([]);
  const [gitFiles, setGitFiles] = useState<GitFileNode[]>([]);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);

  const t = useTranslation(locale);

  // --- Effects ---
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    
    // Reset classes
    root.className = '';
    body.classList.remove('scanlines');

    // Apply classes based on theme
    switch (theme) {
        case 'light':
            // Default, no class needed on root
            break;
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

  // Load Data
  useEffect(() => {
    loadFileSystem();
    loadGitStatus();
    loadTerminals();
  }, []);

  const loadFileSystem = async () => {
      try {
          const tree = await api.getFileTree('.'); // Start from root
          setFileSystem(tree);
      } catch (e) {
          console.error("Failed to load file tree", e);
      }
  };

  const loadGitStatus = async () => {
      try {
          const files = await api.getGitStatus();
          setGitFiles(files);
      } catch (e) {
          console.error("Failed to load git status", e);
      }
  };

  const loadTerminals = async () => {
      try {
          const terms = await api.getTerminals();
          setTerminals(terms);
          if (terms.length > 0 && !activeTerminalId) {
              setActiveTerminalId(terms[0].id);
          }
      } catch (e) {
          console.error("Failed to load terminals", e);
      }
  };

  const [openTabs, setOpenTabs] = useState<EditorTab[]>([]);
  
  // --- Handlers ---
  const toggleTheme = () => {
    const order: Theme[] = ['light', 'dark', 'hacker', 'terminal'];
    const nextIndex = (order.indexOf(theme) + 1) % order.length;
    setTheme(order[nextIndex]);
  };
  
  const toggleLocale = () => setLocale(prev => prev === 'en' ? 'zh' : 'en');

  const handleFileClick = async (node: FileNode) => {
    if (node.type === 'file') {
      const existingTab = openTabs.find(t => t.fileId === node.id);
      if (!existingTab) {
        // Fetch content if needed
        // We use node.id as path (from api.ts)
        let content = node.content;
        if (content === undefined) {
             try {
                 content = await api.readFile(node.id);
                 // optimize: update fileSystem cache?
             } catch (e) {
                 content = "// Error loading file";
             }
        }

        setOpenTabs([...openTabs, { 
            id: `tab-${node.id}`, 
            fileId: node.id, 
            title: node.name, 
            isDirty: false,
            type: 'code',
            data: content // Cache content in tab
        }]);
      }
      setActiveFileId(node.id);
      setCurrentView(AppView.FILES);
    }
  };

  const handleGitFileClick = async (gitFile: GitFileNode) => {
     const tabId = `diff-${gitFile.id}`;
     const existingTab = openTabs.find(t => t.id === tabId);
     
     if (!existingTab) {
        let diffData = { old: '', new: '' };
        try {
            diffData = await api.getGitDiff(gitFile.path);
        } catch (e) {
            console.error("Failed to fetch diff", e);
            toast.error("Failed to fetch diff");
        }

        setOpenTabs([...openTabs, {
            id: tabId,
            fileId: gitFile.id,
            title: `${gitFile.name} [DIFF]`,
            isDirty: false,
            type: 'diff',
            data: {
                original: diffData.old || '// Empty',
                modified: diffData.new || '// Empty'
            }
        }]);
     }
     
     setActiveFileId(gitFile.id);
  };

  const closeTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const newTabs = openTabs.filter(t => t.id !== tabId);
    setOpenTabs(newTabs);
    
    // Check if we closed the active tab
    // const activeTab = openTabs.find(t =>
    //     (t.type === 'code' && t.fileId === activeFileId) || 
    //     (t.type === 'diff' && t.fileId === activeFileId) ||
    //     (t.id === tabId && t.fileId === activeFileId) // safety check
    // );

    // If the active tab was closed (or we can't find it anymore in the new list logic needs care)
    // Simpler: if the currently active file ID corresponds to the closed tab
    // We need to switch to another tab
    
    // Using tab ID is safer.
    // Ensure we are comparing correctly.
    const isClosingActive = openTabs.find(t => t.id === tabId)?.fileId === activeFileId;

    if (isClosingActive) {
       if (newTabs.length > 0) {
           const nextTab = newTabs[newTabs.length - 1];
           setActiveFileId(nextTab.fileId);
       } else {
         setActiveFileId(null);
       }
    }
  };

  const handleEditorChange = (newContent: string) => {
      // Find active tab and update dirty state
      if (!activeFileId) return;

      setOpenTabs(prev => prev.map(tab => {
          if (tab.fileId === activeFileId && tab.type === 'code') {
              return { ...tab, isDirty: true, data: newContent };
          }
          return tab;
      }));
  };

  const saveFile = async () => {
      const tab = openTabs.find(t => t.fileId === activeFileId);
      if (!tab || tab.type !== 'code' || !activeFileId) return;

      try {
          // activeFileId is the path (from node.id)
          await api.writeFile(activeFileId, tab.data);
          setOpenTabs(prev => prev.map(t => {
              if (t.id === tab.id) return { ...t, isDirty: false };
              return t;
          }));
          toast.success("File saved");
          setTimeout(() => loadGitStatus(), 500); // Delay to ensure FS sync
      } catch (e) {
          console.error("Failed to save", e);
          toast.error("Failed to save file");
      }
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFileId, openTabs]);

  // --- Render Helpers ---
  const activeTab = openTabs.find(t => t.fileId === activeFileId);

  const renderTopBar = () => {
    return (
      <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 flex-shrink-0 transition-colors duration-300">
        
        {/* System ID / Icon */}
        <div className="px-2 flex items-center justify-center text-ide-accent font-bold text-xs border-r border-ide-border mr-1 h-8">
            <span className="animate-pulse mr-1">●</span> ONLINE
        </div>

        {(currentView === AppView.FILES || currentView === AppView.GIT) && (
          <>
            <button 
                onClick={() => setActiveFileId(null)}
                className={`flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-md border transition-all ${activeFileId === null ? 'bg-ide-accent text-ide-bg border-ide-accent shadow-glow' : 'bg-transparent text-ide-mute border-transparent hover:bg-ide-panel hover:text-ide-text'}`}
                aria-label={t('explorer')}
            >
                <LayoutTemplate size={18} />
            </button>
            <div className="w-px h-5 bg-ide-border mx-1 flex-shrink-0" />
            {openTabs.map(tab => (
              <div 
                key={tab.id}
                onClick={() => setActiveFileId(tab.fileId)}
                className={`flex-shrink-0 px-3 h-8 rounded-md flex items-center gap-2 text-xs border transition-all cursor-pointer ${
                    activeFileId === tab.fileId 
                    ? 'bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm' 
                    : 'bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text'
                }`}
              >
                {tab.type === 'diff' ? <FileDiff size={14} /> : <FileText size={14} />}
                <span className="max-w-[100px] truncate font-medium">{tab.title}</span>
                <button onClick={(e) => closeTab(e, tab.id)} className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-bg">
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
                  className={`flex-shrink-0 px-4 h-8 rounded-md flex items-center gap-2 text-xs font-mono border ${
                    activeTerminalId === term.id
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

         <button 
            className="flex-shrink-0 w-8 h-8 rounded-md ml-auto text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors"
            onClick={async () => {
                if (currentView === AppView.TERMINAL) {
                    await api.createTerminal();
                    loadTerminals();
                } else {
                    // Create new file?
                }
            }}
         >
            <Plus size={18} />
         </button>
      </div>
    );
  };

  const handleCommit = async (message: string) => {
      try {
          const filesToStage = gitFiles.map(f => f.path);
          if (filesToStage.length === 0) {
              toast.info("No changes to commit");
              return;
          }
          await api.stageFile(filesToStage);
          await api.commitChanges(message);
          toast.success("Committed successfully");
          loadGitStatus();
      } catch (e) {
          console.error("Commit failed", e);
          toast.error("Commit failed");
      }
  };

  const renderContent = () => {
    if (currentView === AppView.GIT && activeFileId === null) {
        return (
            <GitView 
                files={gitFiles} 
                onFileClick={handleGitFileClick} 
                onCommit={handleCommit}
                onRefresh={loadGitStatus}
                locale={locale} 
            />
        );
    }

    if (currentView === AppView.TERMINAL) {
        return activeTerminalId ? (
            <TerminalView activeTerminalId={activeTerminalId} terminals={terminals} />
        ) : <div className="p-4 text-ide-mute">No terminals</div>;
    }

    if (currentView === AppView.FILES && activeFileId === null) {
        return (
            <div className="h-full overflow-y-auto bg-ide-bg p-2 transition-colors duration-300">
                <div className="border border-ide-border rounded-lg p-3 mb-4 bg-ide-panel/50 shadow-sm">
                    <p className="text-[10px] text-ide-accent mb-2 font-bold tracking-wider">SYSTEM_STATUS</p>
                    <div className="h-1.5 w-full bg-ide-border rounded-full overflow-hidden">
                        <div className="h-full bg-ide-accent w-3/4 shadow-glow"></div>
                    </div>
                </div>
                <h3 className="text-[10px] font-bold text-ide-mute uppercase mb-2 px-2 tracking-widest">{t('projectRoot')}</h3>
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
                key={activeTab.id}
                content={activeTab.data || ''} 
                language="typescript" // Detect from tab.title?
                theme={theme}
                onChange={handleEditorChange} 
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
      <Toaster position="bottom-right" theme={theme === 'light' ? 'light' : 'dark'} />
      
      {/* 1. Top Bar */}
      {renderTopBar()}

      {/* 2. Main Workspace */}
      <main className="flex-1 overflow-hidden relative border-b border-ide-border">
        {renderContent()}
      </main>

      {/* 3. Footer / Nav */}
      <footer className="h-14 bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)]">
        
        {/* Left: Project Menu Trigger */}
        <button 
          onClick={() => setIsMenuOpen(true)}
          className="h-full px-4 flex items-center gap-3 hover:bg-ide-bg transition-colors border-r border-ide-border group"
        >
          <div className="p-1.5 rounded-md border border-ide-border group-hover:border-ide-accent group-hover:text-ide-accent transition-colors">
            <Menu size={18} />
          </div>
          <span className="font-bold tracking-wider text-xs hidden sm:inline">MENU</span>
        </button>

        {/* Center: Mode Toggles */}
        <div className="flex h-10 bg-ide-bg rounded-lg p-1 border border-ide-border gap-1">
          <button 
            onClick={() => setCurrentView(AppView.FILES)}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.FILES ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
          >
            <Files size={16} />
          </button>
          <button 
            onClick={() => {
                setCurrentView(AppView.GIT);
                setActiveFileId(null);
            }}
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

        {/* Right: Stats */}
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
