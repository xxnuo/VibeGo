import React, { useState, useEffect } from 'react';
import { AppView } from './types';
import type { FileNode, TerminalSession, EditorTab, Theme, Locale, GitFileNode } from './types';
import { 
  Menu, Files, GitGraph, Terminal, Plus, 
  X, FileText, LayoutTemplate, Box, FileDiff, Cpu,
  Eye, Edit3
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
  
  // Editor State
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);

  // Terminal State
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  // Data State
  const [fileSystem, setFileSystem] = useState<FileNode[]>([]);
  const [gitFiles, setGitFiles] = useState<GitFileNode[]>([]);

  const t = useTranslation(locale);

  // --- Effects ---
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.className = '';
    body.classList.remove('scanlines');

    switch (theme) {
        case 'light': break;
        case 'dark': root.classList.add('dark'); break;
        case 'hacker': root.classList.add('dark', 'hacker'); break;
        case 'terminal': root.classList.add('dark', 'terminal'); body.classList.add('scanlines'); break;
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

  // --- Handlers ---
  const toggleTheme = () => {
    const order: Theme[] = ['light', 'dark', 'hacker', 'terminal'];
    const nextIndex = (order.indexOf(theme) + 1) % order.length;
    setTheme(order[nextIndex]);
  };
  
  const toggleLocale = () => setLocale(prev => prev === 'en' ? 'zh' : 'en');

  const handleFileClick = async (node: FileNode) => {
    if (node.type === 'file') {
      const existingTab = editorTabs.find(t => t.fileId === node.id);
      if (!existingTab) {
        let content = node.content;
        if (content === undefined) {
             try {
                 content = await api.readFile(node.id);
             } catch (e) {
                 content = "// Error loading file";
             }
        }

        setEditorTabs([...editorTabs, { 
            id: `tab-${node.id}`, 
            fileId: node.id, 
            title: node.name, 
            isDirty: false,
            type: 'code',
            data: content 
        }]);
      }
      setActiveFileId(node.id);
      setCurrentView(AppView.FILES); // Switch to files view context
    }
  };

  const handleGitFileClick = async (gitFile: GitFileNode) => {
     const tabId = `diff-${gitFile.id}`;
     const existingTab = editorTabs.find(t => t.id === tabId);
     
     if (!existingTab) {
        let diffData = { old: '', new: '' };
        try {
            diffData = await api.getGitDiff(gitFile.path);
        } catch (e) {
            console.error("Failed to fetch diff", e);
            toast.error("Failed to fetch diff");
        }

        setEditorTabs([...editorTabs, {
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
    const newTabs = editorTabs.filter(t => t.id !== tabId);
    setEditorTabs(newTabs);
    
    // Check if we closed the active tab
    const isClosingActive = editorTabs.find(t => t.id === tabId)?.fileId === activeFileId;

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
      if (!activeFileId) return;
      setEditorTabs(prev => prev.map(tab => {
          if (tab.fileId === activeFileId && tab.type === 'code') {
              return { ...tab, isDirty: true, data: newContent };
          }
          return tab;
      }));
  };

  const saveFile = async () => {
      const tab = editorTabs.find(t => t.fileId === activeFileId);
      if (!tab || tab.type !== 'code' || !activeFileId) return;

      try {
          await api.writeFile(activeFileId, tab.data);
          setEditorTabs(prev => prev.map(t => {
              if (t.id === tab.id) return { ...t, isDirty: false };
              return t;
          }));
          toast.success("File saved");
          // Trigger git refresh immediately
          loadGitStatus();
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
  }, [activeFileId, editorTabs]);

  // --- Render Helpers ---
  const activeTab = editorTabs.find(t => t.fileId === activeFileId);

  const renderTopBar = () => {
    return (
      <div className="h-10 bg-ide-bg border-b border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 flex-shrink-0 transition-colors duration-300">
        
        {/* Connection Status */}
        <div className="px-2 flex items-center justify-center text-ide-accent font-bold text-[10px] border-r border-ide-border mr-1 h-6">
            <span className="animate-pulse mr-1">●</span> ONLINE
        </div>

        {/* Tab Lists based on View */}
        {currentView === AppView.TERMINAL ? (
           // Terminal Tabs
           <>
             {terminals.map(term => (
               <button
                  key={term.id}
                  onClick={() => setActiveTerminalId(term.id)}
                  className={`flex-shrink-0 px-3 h-7 rounded-md flex items-center gap-2 text-xs font-mono border ${
                    activeTerminalId === term.id
                    ? 'bg-ide-panel border-ide-accent text-ide-accent shadow-glow' 
                    : 'bg-transparent border-transparent text-ide-mute hover:text-ide-text'
                  }`}
               >
                 <Box size={12} />
                 {term.name}
                 <span 
                    onClick={(e) => {
                        e.stopPropagation();
                        // Close terminal logic
                        api.closeTerminal(term.id).then(loadTerminals);
                    }}
                    className="ml-1 hover:text-red-500 rounded p-0.5"
                 >
                    <X size={10} />
                 </span>
               </button>
             ))}
             <button 
                className="flex-shrink-0 w-7 h-7 rounded-md text-ide-mute hover:bg-ide-panel hover:text-ide-accent flex items-center justify-center border border-transparent transition-colors"
                onClick={async () => {
                    await api.createTerminal();
                    loadTerminals();
                }}
             >
                <Plus size={14} />
             </button>
           </>
        ) : (
           // Editor Tabs (Shared for Files & Git Views)
           <>
             {editorTabs.map(tab => (
               <div 
                 key={tab.id}
                 onClick={() => setActiveFileId(tab.fileId)}
                 className={`flex-shrink-0 px-3 h-7 rounded-sm flex items-center gap-2 text-xs border-t-2 border-transparent cursor-pointer transition-all ${
                     activeFileId === tab.fileId 
                     ? 'bg-ide-panel border-t-ide-accent text-ide-text shadow-sm' 
                     : 'bg-transparent text-ide-mute hover:bg-ide-panel/50 hover:text-ide-text'
                 }`}
               >
                 {tab.type === 'diff' ? <FileDiff size={12} className="text-yellow-500" /> : <FileText size={12} className="text-blue-400" />}
                 <span className={`max-w-[120px] truncate font-medium ${tab.isDirty ? 'italic' : ''}`}>
                    {tab.title}
                    {tab.isDirty && '*'}
                 </span>
                 <button onClick={(e) => closeTab(e, tab.id)} className="ml-1 opacity-0 group-hover:opacity-100 hover:text-red-500 rounded-full p-0.5">
                   <X size={10} />
                 </button>
               </div>
             ))}
           </>
        )}

        {/* Global Actions (Right aligned) */}
        <div className="ml-auto flex items-center gap-2">
            {/* Editor Mode Toggle */}
            {(currentView === AppView.FILES || currentView === AppView.GIT) && activeTab && (
                <button 
                    onClick={() => setIsEditMode(!isEditMode)}
                    className={`flex items-center gap-1 px-2 h-7 rounded text-[10px] font-bold border ${isEditMode ? 'bg-ide-accent text-ide-bg border-ide-accent' : 'bg-transparent text-ide-mute border-ide-border'}`}
                >
                    {isEditMode ? <Edit3 size={12} /> : <Eye size={12} />}
                    {isEditMode ? 'EDIT' : 'READ'}
                </button>
            )}
        </div>
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
    // 1. Files View with Empty State
    if (currentView === AppView.FILES && activeFileId === null) {
        return (
            <div className="h-full overflow-y-auto bg-ide-bg/50 p-2 transition-colors duration-300">
                <div className="flex items-center justify-between mb-2 px-2">
                    <h3 className="text-[10px] font-bold text-ide-mute uppercase tracking-widest">{t('projectRoot')}</h3>
                    <div className="flex gap-1">
                        <button onClick={loadFileSystem} className="p-1 hover:bg-ide-panel rounded text-ide-mute"><Files size={12}/></button>
                    </div>
                </div>
                <FileTree nodes={fileSystem} onFileClick={handleFileClick} activeFileId={activeFileId || undefined} />
                
                {/* Empty State / Welcome */}
                <div className="mt-10 flex flex-col items-center opacity-30 text-ide-mute select-none">
                     <LayoutTemplate size={48} className="mb-2" />
                     <p className="text-xs uppercase font-bold tracking-widest">Select a file to open</p>
                </div>
            </div>
        );
    }

    // 2. Terminal View
    if (currentView === AppView.TERMINAL) {
        return activeTerminalId ? (
            <TerminalView activeTerminalId={activeTerminalId} terminals={terminals} />
        ) : (
            <div className="h-full flex flex-col items-center justify-center text-ide-mute">
                <p className="mb-2">No active terminals</p>
                <button 
                  onClick={async () => { await api.createTerminal(); loadTerminals(); }}
                  className="px-4 py-2 bg-ide-panel border border-ide-border rounded hover:border-ide-accent transition-colors"
                >
                    Create New Terminal
                </button>
            </div>
        );
    }

    // 3. Git View (Panel 1: List) handled by sidebar logic usually, but here main content if no file active?
    // User requested "Three main columns... not sharing tabs". 
    // If Git view is active, we usually show the list of changed files or the Diff Editor.
    // If no git file active, show GitView component (List).
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

    // 4. Active Editor (File or Diff)
    if (activeTab) {
        if (activeTab.type === 'diff' && activeTab.data) {
            return <DiffView original={activeTab.data.original} modified={activeTab.data.modified} />;
        }
        return (
            <CodeEditor 
                key={activeTab.id}
                content={activeTab.data || ''} 
                language="typescript" // Should detect from ext
                theme={theme}
                onChange={handleEditorChange} 
                readOnly={!isEditMode}
            />
        );
    }
    
    // Fallback
    return null;
  };

  return (
    <div className="h-screen flex flex-col bg-ide-bg text-ide-text overflow-hidden font-mono transition-colors duration-300">
      <Toaster position="bottom-right" theme={theme === 'light' ? 'light' : 'dark'} />
      
      {/* Top Bar (Tabs) */}
      {renderTopBar()}

      {/* Main Workspace */}
      <main className="flex-1 overflow-hidden relative border-b border-ide-border">
        {renderContent()}
      </main>

      {/* Footer / Nav */}
      <footer className="h-12 bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)]">
        
        {/* Left: Project Menu */}
        <button 
          onClick={() => setIsMenuOpen(true)}
          className="h-full px-4 flex items-center gap-2 hover:bg-ide-bg transition-colors border-r border-ide-border group"
        >
          <Menu size={16} className="text-ide-mute group-hover:text-ide-text" />
          <span className="font-bold tracking-wider text-[10px] text-ide-mute group-hover:text-ide-text hidden sm:inline">MENU</span>
        </button>

        {/* Center: View Switcher */}
        <div className="flex h-8 bg-ide-bg/50 rounded-lg p-0.5 border border-ide-border gap-1">
          <button 
            onClick={() => setCurrentView(AppView.FILES)}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.FILES ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
            title="Files"
          >
            <Files size={14} />
          </button>
          <button 
            onClick={() => {
                setCurrentView(AppView.GIT);
                setActiveFileId(null); // Reset to show list
            }}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.GIT ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
            title="Git"
          >
            <GitGraph size={14} />
          </button>
          <button 
            onClick={() => setCurrentView(AppView.TERMINAL)}
            className={`px-3 h-full rounded flex items-center gap-2 transition-all ${currentView === AppView.TERMINAL ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'}`}
            title="Terminal"
          >
            <Terminal size={14} />
          </button>
        </div>

        {/* Right: Workspace & Stats */}
        <div className="flex items-center gap-3 px-4 text-ide-mute text-[10px] font-bold">
           {/* Multi-workspace Placeholder */}
           <button className="h-6 w-6 rounded hover:bg-ide-bg flex items-center justify-center border border-transparent hover:border-ide-accent group">
             <Plus size={14} className="group-hover:text-ide-accent" />
           </button>
           
           <div className="hidden sm:flex items-center gap-1 pl-2 border-l border-ide-border/50">
             <Cpu size={12} />
             <span>12%</span>
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
