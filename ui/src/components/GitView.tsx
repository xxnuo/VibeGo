import React from 'react';
import { GitBranch, RotateCw, Play } from 'lucide-react';
import type { GitFileNode, Locale } from '@/stores';

interface GitViewProps {
  files: GitFileNode[];
  onFileClick: (file: GitFileNode) => void;
  locale: Locale;
}

const GitView: React.FC<GitViewProps> = ({ files, onFileClick }) => {

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'modified': return 'text-yellow-500';
      case 'added': return 'text-green-500';
      case 'deleted': return 'text-red-500';
      default: return 'text-ide-mute';
    }
  };

  return (
    <div className="flex flex-col h-full bg-ide-bg p-4 text-ide-text overflow-y-auto font-mono">
      <div className="flex items-center justify-between mb-6 shrink-0 border-b border-ide-accent pb-2">
        <h2 className="text-lg font-bold flex items-center gap-2 text-ide-accent">
          <GitBranch size={18} />
          VCS_CONTROL
        </h2>
        <button className="p-1 hover:text-ide-accent animate-spin-slow">
          <RotateCw size={16} />
        </button>
      </div>

      <div className="space-y-4 flex-1">
        <div className="border border-ide-border bg-ide-panel/30">
          <div className="flex justify-between items-center p-2 border-b border-ide-border bg-ide-panel">
            <span className="text-xs font-bold text-ide-accent uppercase">STAGED_CHANGES</span>
            <span className="text-xs bg-ide-accent text-black px-1 font-bold">{files.length}</span>
          </div>
          <div className="divide-y divide-ide-border">
            {files.map((file) => (
              <button
                key={file.id}
                onClick={() => onFileClick(file)}
                className="w-full flex items-center gap-3 p-2 hover:bg-ide-accent/10 transition-colors text-left group"
              >
                <div className={`w-4 text-center font-bold text-xs ${getStatusColor(file.status)}`}>
                  {file.status[0].toUpperCase()}
                </div>
                <div className="flex flex-col overflow-hidden">
                  <span className="text-xs font-bold text-ide-text group-hover:text-ide-accent truncate">{file.name}</span>
                  <span className="text-[9px] text-ide-mute truncate">{file.path}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border border-ide-border bg-ide-panel/30 p-2">
          <textarea
            placeholder="> enter_commit_msg"
            className="w-full bg-black border border-ide-border p-2 text-xs text-ide-accent focus:outline-none focus:border-ide-accent min-h-[60px] placeholder-ide-mute/50"
          />
          <button className="w-full mt-2 bg-ide-accent text-black font-bold py-2 text-xs flex items-center justify-center gap-2 hover:bg-ide-accent/80">
            <Play size={12} fill="currentColor" />
            EXECUTE_COMMIT
          </button>
        </div>
      </div>
    </div>
  );
};

export default GitView;