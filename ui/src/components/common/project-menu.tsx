import {
  FilePlus,
  FolderOpen,
  Globe,
  Home,
  Monitor,
  Moon,
  Redo2,
  Replace,
  Save,
  Search,
  Settings,
  Snowflake,
  Sun,
  Sunset,
  Terminal,
  Undo2,
  Waves,
  X,
  XCircle,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { fileApi } from "@/api/file";
import { useDialog } from "@/components/common";
import { ActionButton } from "@/components/common/action-button";
import { type Locale, useTranslation } from "@/lib/i18n";
import { getSettingSchema, useSettingsStore } from "@/lib/settings";
import { useFrameStore, usePreviewStore } from "@/stores";
import { useSessionStore } from "@/stores/session-store";

interface ProjectMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenSettings: () => void;
  onOpenDirectory: (restoreFocusTo?: HTMLElement | null) => void;
  onShowHomePage: () => void;
  onNewPage: () => void;
}

const ProjectMenu: React.FC<ProjectMenuProps> = ({
  isOpen,
  onClose,
  locale,
  onOpenSettings,
  onOpenDirectory,
  onShowHomePage,
  onNewPage,
}) => {
  const t = useTranslation(locale);
  const [serverVersion, setServerVersion] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    fetch("/version")
      .then((r) => r.json())
      .then((d) => setServerVersion(d.version || ""))
      .catch(() => {});
  }, [isOpen]);
  const dialog = useDialog();
  const settings = useSettingsStore((s) => s.settings);
  const setSetting = useSettingsStore((s) => s.set);
  const themeSchema = getSettingSchema("theme");
  const localeSchema = getSettingSchema("locale");
  const themeValue = settings.theme || themeSchema?.defaultValue || "light";
  const localeValue = settings.locale || localeSchema?.defaultValue || "zh";
  const themeOrder = themeSchema?.options?.map((opt) => opt.value) || ["light", "dark", "hacker", "terminal"];
  const localeOrder = localeSchema?.options?.map((opt) => opt.value) || ["zh", "en"];
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const groups = useFrameStore((s) => s.groups);
  const pageMenuItems = useFrameStore((s) => s.pageMenuItems);
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const closeFolderGroup = useSessionStore((s) => s.closeFolderGroup);
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

  const editMode = usePreviewStore((s) => s.editMode);
  const isDirty = usePreviewStore((s) => s.isDirty);
  const file = usePreviewStore((s) => s.file);
  const content = usePreviewStore((s) => s.content);

  if (!isOpen) return null;

  const handleSettings = () => {
    onOpenSettings();
    onClose();
  };

  const handleHome = () => {
    onShowHomePage();
    onClose();
  };

  const handleNewPage = () => {
    onNewPage();
    onClose();
  };

  const handleOpenFolder = () => {
    restorePreviousFocusRef.current = false;
    onOpenDirectory(previousFocusRef.current);
    onClose();
  };

  const handleThemeToggle = () => {
    const currentIndex = themeOrder.indexOf(themeValue);
    const nextValue = themeOrder[(currentIndex + 1) % themeOrder.length] || themeOrder[0];
    setSetting("theme", nextValue);
  };

  const handleLocaleToggle = () => {
    const currentIndex = localeOrder.indexOf(localeValue);
    const nextValue = localeOrder[(currentIndex + 1) % localeOrder.length] || localeOrder[0];
    setSetting("locale", nextValue);
  };

  const handleCloseFolder = async () => {
    if (activeGroup?.type === "group") {
      await closeFolderGroup(activeGroup.id);
    }
    onClose();
  };

  const handleClosePage = () => {
    if (activeGroup) {
      removeGroup(activeGroup.id);
    }
    onClose();
  };

  const handleSave = async () => {
    if (!file || !isDirty) return;
    try {
      await fileApi.write(file.path, content);
      usePreviewStore.getState().setOriginalContent(content);
      usePreviewStore.getState().setIsDirty(false);
    } catch (e) {
      usePreviewStore.getState().setError(e instanceof Error ? e.message : t("common.saveFailed"));
    }
    onClose();
  };

  const handleSaveAs = async () => {
    if (!file) return;
    const newPath = await dialog.prompt(t("common.saveAs"), { defaultValue: file.path });
    if (newPath && newPath !== file.path) {
      try {
        await fileApi.write(newPath, content);
      } catch (e) {
        usePreviewStore.getState().setError(e instanceof Error ? e.message : t("common.saveFailed"));
      }
    }
    onClose();
  };

  const triggerEditorAction = (action: string) => {
    const event = new CustomEvent("editor-action", { detail: { action } });
    window.dispatchEvent(event);
    onClose();
  };

  const themeIconMap: Record<string, React.ReactNode> = {
    light: <Sun size={18} />,
    dark: <Moon size={18} />,
    hacker: <Monitor size={18} />,
    terminal: <Terminal size={18} />,
    ocean: <Waves size={18} />,
    sunset: <Sunset size={18} />,
    nord: <Snowflake size={18} />,
    solarized: <Sun size={18} />,
  };
  const themeIcon = themeIconMap[themeValue] || <Sun size={18} />;

  const translateOptionLabel = (label: string) => (label.startsWith("settings.") ? t(label) : label);
  const themeLabel = themeSchema?.options?.find((opt) => opt.value === themeValue)?.label || themeValue;
  const localeLabel = localeSchema?.options?.find((opt) => opt.value === localeValue)?.label || localeValue;

  const builtInItems: Array<{
    id: string;
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    badge?: string | number;
    title?: string;
  }> = [
    {
      id: "home",
      icon: <Home size={20} />,
      label: t("common.home"),
      onClick: handleHome,
    },
    {
      id: "new-page",
      icon: <FilePlus size={20} />,
      label: t("common.newPage"),
      onClick: handleNewPage,
    },
    {
      id: "open-folder",
      icon: <FolderOpen size={20} />,
      label: t("common.openFolder"),
      onClick: handleOpenFolder,
    },
    {
      id: "settings",
      icon: <Settings size={20} />,
      label: t("common.settings"),
      onClick: handleSettings,
    },
    {
      id: "theme",
      icon: themeIcon,
      label: t("common.theme"),
      onClick: handleThemeToggle,
      title: translateOptionLabel(themeLabel),
    },
    {
      id: "language",
      icon: <Globe size={20} />,
      label: t("common.language"),
      onClick: handleLocaleToggle,
      title: translateOptionLabel(localeLabel),
    },
  ];

  const contextItems: Array<{
    id: string;
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    badge?: string | number;
    title?: string;
  }> = [];

  if (activeGroup?.type === "group" && activeGroup.pages.some((p) => p.path)) {
    contextItems.push({
      id: "close-folder",
      icon: <XCircle size={20} />,
      label: t("common.closeFolder"),
      onClick: handleCloseFolder,
    });
  } else if (activeGroup && activeGroup.type !== "home") {
    contextItems.push({
      id: "close-page",
      icon: <XCircle size={20} />,
      label: t("common.closePage"),
      onClick: handleClosePage,
    });
  }

  const hasNonHomeGroups = groups.filter((g) => g.type !== "home").length > 0;
  if (activeGroup?.type === "home") {
    if (hasNonHomeGroups) {
      contextItems.push({
        id: "close-home",
        icon: <XCircle size={20} />,
        label: t("common.closePage"),
        onClick: handleClosePage,
      });
    }
  }

  pageMenuItems.forEach((item) => {
    contextItems.push({
      id: item.id,
      icon: item.icon,
      label: item.label,
      onClick: () => {
        item.onClick?.();
        onClose();
      },
      badge: item.badge,
      title: undefined,
    });
  });

  const editorItems: Array<{
    id: string;
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    badge?: string | number;
    title?: string;
  }> = [];

  if (editMode && activeGroup?.type === "group") {
    editorItems.push(
      {
        id: "save",
        icon: <Save size={20} />,
        label: t("common.save"),
        onClick: handleSave,
      },
      {
        id: "save-as",
        icon: <Save size={20} />,
        label: t("common.saveAs"),
        onClick: handleSaveAs,
      },
      {
        id: "undo",
        icon: <Undo2 size={20} />,
        label: t("common.undo"),
        onClick: () => triggerEditorAction("undo"),
      },
      {
        id: "redo",
        icon: <Redo2 size={20} />,
        label: t("common.redo"),
        onClick: () => triggerEditorAction("redo"),
      },
      {
        id: "find",
        icon: <Search size={20} />,
        label: t("common.find"),
        onClick: () => triggerEditorAction("find"),
      },
      {
        id: "replace",
        icon: <Replace size={20} />,
        label: t("common.replace"),
        onClick: () => triggerEditorAction("replace"),
      }
    );
  }

  const sections = [
    { id: "builtIn", title: t("menu.builtIn"), items: builtInItems },
    ...(editorItems.length > 0 ? [{ id: "editor", title: t("menu.editor"), items: editorItems }] : []),
    { id: "context", title: t("menu.context"), items: contextItems },
  ].filter((section) => section.items.length > 0);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm transition-opacity" onClick={onClose} />

      <div
        ref={menuRef}
        role="dialog"
        aria-modal="true"
        aria-label="VibeGo"
        className="fixed bottom-0 left-0 right-0 z-50 flex max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_0.5rem)] flex-col overflow-hidden rounded-t-xl border-t border-ide-border bg-ide-panel px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] font-mono shadow-2xl transition-transform duration-300 md:bottom-auto md:top-1/2 md:left-1/2 md:max-h-[min(85dvh,44rem)] md:w-[480px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:p-5"
      >
        <div className="mb-3 flex shrink-0 items-center justify-between border-b border-ide-border pb-2 md:mb-6">
          <h3 className="font-bold text-ide-text flex items-center gap-2">
            <span className="bg-ide-accent text-ide-bg p-1 rounded-md">
              <Terminal size={18} />
            </span>
            VibeGo
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ide-text transition-colors hover:bg-ide-bg md:h-9 md:w-9"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {sections.map((section, index) => (
            <div
              key={section.id}
              className={index === sections.length - 1 ? "mb-3" : "mb-4 pb-4 border-b border-ide-border"}
            >
              <div className="text-[10px] text-ide-mute uppercase font-bold mb-3">{section.title}</div>
              <div className="grid grid-cols-3 gap-1 min-[360px]:grid-cols-4">
                {section.items.map((item) => (
                  <ActionButton
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    onClick={item.onClick}
                    badge={item.badge}
                    title={item.title}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex shrink-0 items-center justify-between border-t border-ide-border pt-2 text-[10px] text-ide-mute md:mt-6 md:pt-4">
          <a
            href="https://github.com/xxnuo/VibeGo"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center underline transition-colors hover:text-ide-accent md:min-h-0"
          >
            VibeGo{serverVersion ? ` ${serverVersion}` : ""}
          </a>
          <span>{t("common.connected")}</span>
        </div>
      </div>
    </>
  );
};

export default ProjectMenu;
