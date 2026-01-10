import React from "react";
import { FolderOpen, Terminal, Box, X } from "lucide-react";
import { useFrameStore } from "@/stores/frameStore";

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
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-ide-panel border-t border-ide-border rounded-t-2xl shadow-lg animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-ide-border">
          <span className="text-sm font-bold text-ide-text">New Group</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-ide-mute hover:text-ide-text hover:bg-ide-bg"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-2 pb-safe max-h-[60vh] overflow-y-auto">
          <button
            onClick={() => {
              onOpenDirectory();
              onClose();
            }}
            className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-ide-accent/10 flex items-center justify-center">
              <FolderOpen size={20} className="text-ide-accent" />
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-ide-text">
                Open Directory
              </div>
              <div className="text-xs text-ide-mute">
                Browse and open a folder
              </div>
            </div>
          </button>
          <button
            onClick={() => {
              onNewTerminal();
              onClose();
            }}
            className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-ide-accent/10 flex items-center justify-center">
              <Terminal size={20} className="text-ide-accent" />
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-ide-text">
                New Terminal
              </div>
              <div className="text-xs text-ide-mute">
                Open a terminal session
              </div>
            </div>
          </button>
          <button
            onClick={() => {
              if (activeGroupId) removeGroup(activeGroupId);
              onClose();
            }}
            className={`w-full px-4 py-3 flex items-center gap-4 rounded-lg transition-colors ${
              activeGroupId
                ? "hover:bg-ide-bg"
                : "opacity-50 cursor-not-allowed"
            }`}
            disabled={!activeGroupId}
          >
            <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
              <X size={20} className="text-red-500" />
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-red-500">
                Close Group
              </div>
              <div className="text-xs text-ide-mute">
                {activeGroup?.name || "Close current group"}
              </div>
            </div>
          </button>
          {availablePlugins.length > 0 && (
            <>
              <div className="h-px bg-ide-border my-2" />
              <div className="px-4 py-2">
                <span className="text-xs font-bold text-ide-mute uppercase">
                  Plugins
                </span>
              </div>
              {availablePlugins.map((plugin) => (
                <button
                  key={plugin.id}
                  onClick={() => {
                    onNewPlugin(plugin.id);
                    onClose();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-ide-accent/10 flex items-center justify-center">
                    {plugin.icon || (
                      <Box size={20} className="text-ide-accent" />
                    )}
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-ide-text">
                      {plugin.name}
                    </div>
                  </div>
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
