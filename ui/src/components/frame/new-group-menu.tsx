import { Box, FolderOpen, X } from "lucide-react";
import React, { useEffect, useRef } from "react";
import { type Locale, useTranslation } from "@/lib/i18n";
import { useFrameStore } from "@/stores/frame-store";
import { useSessionStore } from "@/stores/session-store";

interface NewGroupMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenDirectory: (restoreFocusTo?: HTMLElement | null) => void;
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restorePreviousFocusRef = useRef(true);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    restorePreviousFocusRef.current = true;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[data-slot="dialog-content"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const menu = menuRef.current;
      if (!menu) return;
      const focusable = Array.from(
        menu.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        event.preventDefault();
        menu.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!menu.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      const previousFocus = previousFocusRef.current;
      if (restorePreviousFocusRef.current && previousFocus?.isConnected) {
        window.requestAnimationFrame(() => previousFocus.focus());
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div
        ref={menuRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("common.newGroup")}
        className="fixed bottom-0 left-0 right-0 z-50 flex max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_0.5rem)] flex-col overflow-hidden rounded-t-xl border-t border-ide-border bg-ide-panel shadow-lg animate-in slide-in-from-bottom duration-200 md:bottom-auto md:top-1/2 md:left-1/2 md:max-h-[85dvh] md:w-[400px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:animate-in md:fade-in md:zoom-in-95 md:slide-in-from-bottom-0"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ide-border px-4 py-2">
          <span className="text-sm font-bold text-ide-text">{t("common.newGroup")}</span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-9 md:w-9"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => {
              restorePreviousFocusRef.current = false;
              onOpenDirectory(previousFocusRef.current);
              onClose();
            }}
            className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
          >
            <div className="w-10 h-10 shrink-0 rounded-full bg-ide-accent/10 flex items-center justify-center">
              <FolderOpen size={20} className="text-ide-accent" />
            </div>
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium text-ide-text">{t("common.openFolder")}</div>
              <div className="break-words text-xs text-ide-mute">{t("newGroup.openFolderDescription")}</div>
            </div>
          </button>
          <button
            type="button"
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
            <div className="w-10 h-10 shrink-0 rounded-full bg-red-500/10 flex items-center justify-center">
              <X size={20} className="text-red-500" />
            </div>
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium text-red-500">{t("contextMenu.closeGroup")}</div>
              <div className="truncate text-xs text-ide-mute">
                {activeGroup?.name || t("newGroup.closeCurrentGroup")}
              </div>
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
                  type="button"
                  onClick={() => {
                    onNewTool(tool.id);
                    onClose();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-4 hover:bg-ide-bg rounded-lg transition-colors"
                >
                  <div className="w-10 h-10 shrink-0 rounded-full bg-ide-accent/10 flex items-center justify-center">
                    {tool.icon || <Box size={20} className="text-ide-accent" />}
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate text-sm font-medium text-ide-text">{tool.name}</div>
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
