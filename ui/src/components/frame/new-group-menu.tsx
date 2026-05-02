import { Box, FolderOpen, X } from "lucide-react";
import React from "react";
import { type Locale, useTranslation } from "@/lib/i18n";
import { useFrameStore } from "@/stores/frame-store";
import { useSessionStore } from "@/stores/session-store";

interface NewGroupMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenDirectory: () => void;
  onNewTool: (pageId: string) => void;
  availableTools?: { id: string; name: string; icon?: React.ReactNode }[];
}

const NewGroupMenu: React.FC<NewGroupMenuProps> = ({
  isOpen,
  onClose,
  locale,
  onOpenDirectory,
  onNewTool,
  availableTools = [],
}) => {
  const t = useTranslation(locale);
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const closeFolderGroup = useSessionStore((s) => s.closeFolderGroup);
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("common.newGroup")}
        className="fixed bottom-0 left-0 right-0 md:bottom-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[400px] z-50 bg-ide-panel border-t md:border border-ide-border rounded-t-2xl md:rounded-2xl shadow-lg animate-in slide-in-from-bottom md:fade-in md:zoom-in-95 md:slide-in-from-bottom-0 duration-200"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ide-border">
          <span className="text-sm font-bold text-ide-text">{t("common.newGroup")}</span>
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
              <div className="text-xs text-ide-mute">{t("newGroup.openFolderDescription")}</div>
            </div>
          </button>
          <button
            onClick={() => {
              if (activeGroupId) {
                if (activeGroup?.type === "group" && activeGroup.pages.some((page) => page.path)) {
                  void closeFolderGroup(activeGroupId);
                } else {
                  removeGroup(activeGroupId);
                }
              }
              onClose();
            }}
            className={`w-full px-4 py-3 flex items-center gap-4 rounded-lg transition-colors ${
              activeGroupId ? "hover:bg-ide-bg" : "opacity-50 cursor-not-allowed"
            }`}
            disabled={!activeGroupId}
          >
            <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
              <X size={20} className="text-red-500" />
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-red-500">{t("contextMenu.closeGroup")}</div>
              <div className="text-xs text-ide-mute">{activeGroup?.name || t("newGroup.closeCurrentGroup")}</div>
            </div>
          </button>
          {availableTools.length > 0 && (
            <>
              <div className="h-px bg-ide-border my-2" />
              <div className="px-4 py-2">
                <span className="text-xs font-bold text-ide-mute uppercase">{t("newPage.plugins")}</span>
              </div>
              {availableTools.map((tool) => (
                <button
                  key={tool.id}
                  onClick={() => {
                    onNewTool(tool.id);
                    onClose();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-ide-accent/10 flex items-center justify-center">
                    {tool.icon || <Box size={20} className="text-ide-accent" />}
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-ide-text">{tool.name}</div>
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
