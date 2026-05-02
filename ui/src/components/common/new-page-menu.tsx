import { FolderOpen, Terminal, X } from "lucide-react";
import React from "react";
import { type Locale, useTranslation } from "@/lib/i18n";
import { isPageVisibleInNewPage } from "@/lib/page-visibility";
import { useSettingsStore } from "@/lib/settings";
import { pageRegistry } from "@/pages/registry";

interface NewPageMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenDirectory: () => void;
  onNewTerminal: () => void;
  onNewTool: (pageId: string) => void;
}

const NewPageMenu: React.FC<NewPageMenuProps> = ({
  isOpen,
  onClose,
  locale,
  onOpenDirectory,
  onNewTerminal,
  onNewTool,
}) => {
  const t = useTranslation(locale);
  const settings = useSettingsStore((s) => s.settings);
  const tools = pageRegistry.getAll().filter((p) => p.category === "tool" && isPageVisibleInNewPage(p, settings));

  if (!isOpen) return null;

  const getToolName = (tool: { name: string; nameKey?: string }) => {
    if (tool.nameKey) {
      const translated = t(tool.nameKey);
      if (translated !== tool.nameKey) return translated;
    }
    return tool.name;
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("common.newPage")}
        className="fixed bottom-0 left-0 right-0 md:bottom-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[400px] z-50 bg-ide-panel border-t md:border border-ide-border rounded-t-2xl md:rounded-2xl shadow-lg animate-in slide-in-from-bottom md:fade-in md:zoom-in-95 md:slide-in-from-bottom-0 duration-200"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ide-border">
          <span className="text-sm font-bold text-ide-text">{t("common.newPage")}</span>
          <button onClick={onClose} className="p-1.5 rounded-md text-ide-mute hover:text-ide-text hover:bg-ide-bg">
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
              <div className="text-sm font-medium text-ide-text">{t("common.openFolder")}</div>
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
              <div className="text-sm font-medium text-ide-text">{t("sidebar.terminal")}</div>
            </div>
          </button>
          {tools.map((tool) => {
            const IconComponent = tool.icon;
            return (
              <button
                key={tool.id}
                onClick={() => {
                  onNewTool(tool.id);
                  onClose();
                }}
                className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
              >
                <div className="w-10 h-10 rounded-full bg-ide-accent/10 flex items-center justify-center">
                  <IconComponent size={20} className="text-ide-accent" />
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-2 text-sm font-medium text-ide-text">
                    <span>{getToolName(tool)}</span>
                    {tool.tags?.map((tag) => (
                      <span
                        key={tag.labelKey}
                        className="px-1.5 py-0.5 text-[10px] leading-none border border-ide-border text-ide-mute bg-ide-bg rounded"
                      >
                        {t(tag.labelKey)}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
};

export default NewPageMenu;
