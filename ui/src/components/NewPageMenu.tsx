import React from "react";
import { FolderOpen, Terminal, X } from "lucide-react";
import { useTranslation, type Locale } from "@/lib/i18n";
import { pluginRegistry } from "@/plugins/registry";

interface NewPageMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenDirectory: () => void;
  onNewTerminal: () => void;
  onNewPlugin: (pluginId: string) => void;
}

const NewPageMenu: React.FC<NewPageMenuProps> = ({
  isOpen,
  onClose,
  locale,
  onOpenDirectory,
  onNewTerminal,
  onNewPlugin,
}) => {
  const t = useTranslation(locale);
  const plugins = pluginRegistry.getAll();

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-ide-panel border-t border-ide-border rounded-t-2xl shadow-lg animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-ide-border">
          <span className="text-sm font-bold text-ide-text">
            {t("common.newPage")}
          </span>
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
                {t("common.openFolder")}
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
                {t("common.newTerminal")}
              </div>
            </div>
          </button>
          {plugins.length > 0 && (
            <>
              <div className="h-px bg-ide-border my-2" />
              <div className="px-4 py-2">
                <span className="text-xs font-bold text-ide-mute uppercase">
                  Plugins
                </span>
              </div>
              {plugins.map((plugin) => {
                const IconComponent = plugin.icon;
                return (
                  <button
                    key={plugin.id}
                    onClick={() => {
                      onNewPlugin(plugin.id);
                      onClose();
                    }}
                    className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-ide-accent/10 flex items-center justify-center">
                      <IconComponent size={20} className="text-ide-accent" />
                    </div>
                    <div className="text-left">
                      <div className="text-sm font-medium text-ide-text">
                        {plugin.name}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default NewPageMenu;
