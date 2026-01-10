import React from 'react';
import { GitBranch, GitCommit, GitPullRequest, RotateCw, FileDiff, Plus, Trash2 } from 'lucide-react';
import { GitFileNode, Locale } from '../types';
import { useTranslation } from '../utils/i18n';

interface GitViewProps {
  files: GitFileNode[];
  onFileClick: (file: GitFileNode) => void;
  locale: Locale;
}

const GitView: React.FC<GitViewProps> = ({ files, onFileClick, locale }) => {
  const t = useTranslation(locale);

  const getIcon = (status: string) => {
    switch (status) {
      case 'modified': return <span className="text-yellow-500 font-mono font-bold">M</span>;
      case 'added': return <span className="text-green-500 font-mono font-bold">A</span>;
      case 'deleted': return <span className="text-red-500 font-mono font-bold">D</span>;
      default: return null;
    }
  };

  return (
    <div className="flex flex-col h-full bg-ide-bg p-4 text-ide-text overflow-y-auto">
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <GitBranch className="text-ide-accent" />
          {t('sourceControl')}
        </h2>
        <button className="p-2 bg-ide-panel rounded-full hover:bg-ide-border transition-colors border border-ide-border">
          <RotateCw size={18} />
        </button>
      </div>

      <div className="space-y-4 flex-1">
        {/* Change List */}
        <div className="bg-ide-panel rounded-lg border border-ide-border overflow-hidden">
          <div className="flex justify-between items-center p-3 border-b border-ide-border bg-ide-bg/50">
            <span className="text-sm font-semibold uppercase text-ide-mute">{t('changes')}</span>
            <span className="text-xs bg-ide-accent text-ide-bg px-2 py-0.5 rounded-full font-bold">{files.length}</span>
          </div>
          <div className="divide-y divide-ide-border">
            {files.map((file) => (
              <button
                key={file.id}
                onClick={() => onFileClick(file)}
                className="w-full flex items-center gap-3 p-3 hover:bg-ide-bg/50 transition-colors text-left"
              >
                <div className="w-6 flex justify-center">
                    {getIcon(file.status)}
                </div>
                <div className="flex flex-col overflow-hidden">
                    <span className="text-sm truncate font-medium text-ide-text">{file.name}</span>
                    <span className="text-[10px] text-ide-mute truncate">{file.path}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Commit Box */}
        <div className="bg-ide-panel rounded-lg p-3 border border-ide-border shadow-sm">
           <textarea 
            placeholder={t('commitMessage')}
            className="w-full bg-ide-bg rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-ide-accent min-h-[80px] border border-ide-border text-ide-text placeholder-ide-mute"
           />
           <button className="w-full mt-3 bg-ide-accent text-ide-bg font-bold py-2 rounded flex items-center justify-center gap-2 hover:opacity-90 transition-opacity">
             <GitCommit size={16} />
             {t('commit')}
           </button>
        </div>

        {/* PR Placeholder */}
        <div className="bg-ide-panel rounded-lg p-4 border border-ide-border opacity-60">
           <div className="flex items-center gap-2 mb-2 text-ide-mute">
             <GitPullRequest size={16} />
             <span className="text-sm font-bold">{t('pullRequest')}</span>
           </div>
           <p className="text-xs text-ide-mute">{t('configureUpstream')}</p>
        </div>
      </div>
    </div>
  );
};

export default GitView;