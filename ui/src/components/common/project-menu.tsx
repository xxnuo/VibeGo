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
import React, { useEffect, useState } from "react";
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
  onOpenDirectory: () => void;
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
    onOpenDirectory();
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
        role="dialog"
        aria-modal="true"
        aria-label="VibeGo"
        className="fixed bottom-0 left-0 right-0 md:bottom-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[480px] bg-ide-panel border-t md:border border-ide-border md:rounded-2xl shadow-2xl z-50 p-5 font-mono transform transition-transform duration-300"
      >
        <div className="flex justify-between items-center mb-6 pb-2 border-b border-ide-border">
          <h3 className="font-bold text-ide-text flex items-center gap-2">
            <span className="bg-ide-accent text-ide-bg p-1 rounded-md">
              <Terminal size={18} />
            </span>
            VibeGo
          </h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ide-bg text-ide-text transition-colors">
            <X size={20} />
          </button>
        </div>

        {sections.map((section, index) => (
          <div
            key={section.id}
            className={index === sections.length - 1 ? "mb-6" : "mb-4 pb-4 border-b border-ide-border"}
          >
            <div className="text-[10px] text-ide-mute uppercase font-bold mb-3">{section.title}</div>
            <div className="grid grid-cols-4 gap-1">
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

        <div className="mt-6 pt-4 border-t border-ide-border flex justify-between text-[10px] text-ide-mute">
          <a
            href="https://github.com/xxnuo/VibeGo"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ide-accent transition-colors underline"
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
