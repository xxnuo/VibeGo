import { X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { commands } from "@/framework/host/command-service";
import { contextKeys, useContextKeyStore } from "@/framework/host/context-key-service";
import { useWorkbenchRegistry } from "@/framework/workbench/registry";
import { type Locale, useTranslation } from "@/lib/i18n";
import { isPageVisibleInNewPage } from "@/lib/page-visibility";
import { useSettingsStore } from "@/lib/settings";

interface NewPageMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenDirectory: (restoreFocusTo?: HTMLElement | null) => void;
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
  const [query, setQuery] = useState("");
  const t = useTranslation(locale);
  const settings = useSettingsStore((s) => s.settings);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restorePreviousFocusRef = useRef(true);
  onCloseRef.current = onClose;
  const registry = useWorkbenchRegistry();
  useContextKeyStore((state) => state.revision);
  const items = registry
    .getMenus("new-page")
    .filter(
      (item) =>
        contextKeys.evalWhen(item.when) &&
        (!item.command.startsWith("page:") || isPageVisibleInNewPage(registry.get(item.command.slice(5))!, settings))
    );

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
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
        ref={menuRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("common.newPage")}
        className="fixed bottom-0 left-0 right-0 z-50 flex max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_0.5rem)] flex-col overflow-hidden rounded-t-xl border-t border-ide-border bg-ide-panel shadow-lg animate-in slide-in-from-bottom duration-200 md:bottom-auto md:top-1/2 md:left-1/2 md:max-h-[85dvh] md:w-[400px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:animate-in md:fade-in md:zoom-in-95 md:slide-in-from-bottom-0"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ide-border px-4 py-2">
          <span className="text-sm font-bold text-ide-text">{t("common.newPage")}</span>
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
        <div className="shrink-0 px-3 py-2 border-b border-ide-border">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("common.search")}
            placeholder={t("common.search")}
            className="w-full h-10 px-2 bg-ide-bg border border-ide-border rounded text-sm text-ide-text outline-none focus:border-ide-accent"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {(["workspace", "tool", "system"] as const).map((category) => {
            const categoryItems = items.filter((item) => {
              const page = registry.get(
                item.command === "open-folder"
                  ? "files"
                  : item.command === "new-terminal"
                    ? "terminal"
                    : item.command.slice(5)
              );
              return (
                (page?.category || "tool") === category &&
                `${getToolName({ name: item.title, nameKey: item.titleKey })} ${item.title}`
                  .toLowerCase()
                  .includes(query.trim().toLowerCase())
              );
            });
            return (
              categoryItems.length > 0 && (
                <div key={category}>
                  <div className="px-3 py-2 text-xs text-ide-mute">{t(`home.category.${category}`)}</div>
                  {categoryItems.map((item) => {
                    const Icon = item.icon;
                    const page = item.command.startsWith("page:") ? registry.get(item.command.slice(5)) : undefined;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          if (item.command === "open-folder") {
                            restorePreviousFocusRef.current = false;
                            onOpenDirectory(previousFocusRef.current);
                          } else if (item.command === "new-terminal") onNewTerminal();
                          else if (page) onNewTool(page.id);
                          else void commands.execute(item.command).catch((error) => toast.error(String(error)));
                          onClose();
                        }}
                        className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-ide-bg rounded transition-colors"
                      >
                        <div className="w-7 h-7 shrink-0 flex items-center justify-center">
                          {Icon && <Icon size={20} className="text-ide-accent" />}
                        </div>
                        <div className="min-w-0 flex-1 text-left">
                          <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-ide-text">
                            <span className="min-w-0 truncate">
                              {getToolName({ name: item.title, nameKey: item.titleKey })}
                            </span>
                            {page?.tags?.map((tag) => (
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
              )
            );
          })}
        </div>
      </div>
    </>
  );
};

export default NewPageMenu;
