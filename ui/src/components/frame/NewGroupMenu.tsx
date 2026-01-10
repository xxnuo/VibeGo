import React from 'react';
import { FolderOpen, Terminal, Box, X } from 'lucide-react';

interface NewGroupMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenDirectory: () => void;
  onNewTerminal: () => void;
  onNewPlugin: (pluginId: string) => void;
  availablePlugins?: { id: string; name: string; icon?: React.ReactNode }[];
}

const NewGroupMenu: React.FC<NewGroupMenuProps> = ({
  isOpen,
  onClose,
  onOpenDirectory,
  onNewTerminal,
  onNewPlugin,
  availablePlugins = [],
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed bottom-16 right-4 z-50 bg-ide-panel border border-ide-border rounded-lg shadow-lg overflow-hidden min-w-[200px]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-ide-border">
          <span className="text-xs font-bold text-ide-mute">NEW GROUP</span>
          <button onClick={onClose} className="text-ide-mute hover:text-ide-text">
            <X size={14} />
          </button>
        </div>
        <div className="py-1">
          <button
            onClick={() => { onOpenDirectory(); onClose(); }}
            className="w-full px-3 py-2 flex items-center gap-3 hover:bg-ide-bg transition-colors text-left"
          >
            <FolderOpen size={16} className="text-ide-accent" />
            <span className="text-sm">Open Directory</span>
          </button>
          <button
            onClick={() => { onNewTerminal(); onClose(); }}
            className="w-full px-3 py-2 flex items-center gap-3 hover:bg-ide-bg transition-colors text-left"
          >
            <Terminal size={16} className="text-ide-accent" />
            <span className="text-sm">New Terminal</span>
          </button>
          {availablePlugins.length > 0 && (
            <>
              <div className="h-px bg-ide-border my-1" />
              <div className="px-3 py-1">
                <span className="text-[10px] font-bold text-ide-mute">PLUGINS</span>
              </div>
              {availablePlugins.map((plugin) => (
                <button
                  key={plugin.id}
                  onClick={() => { onNewPlugin(plugin.id); onClose(); }}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-ide-bg transition-colors text-left"
                >
                  {plugin.icon || <Box size={16} className="text-ide-accent" />}
                  <span className="text-sm">{plugin.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default NewGroupMenu;
