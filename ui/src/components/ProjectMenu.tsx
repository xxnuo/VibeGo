import React from "react";
import {
  Settings,
  Home,
  X,
  Sun,
  Moon,
  Monitor,
  Terminal,
  Globe,
  XCircle,
  FilePlus,
  Save,
  Undo2,
  Redo2,
  Search,
  Replace,
} from "lucide-react";
import { useTranslation, type Locale } from "@/lib/i18n";
import { useSettingsStore, getSettingSchema } from "@/lib/settings";
import { useFrameStore, useWorkspaceStore, usePreviewStore } from "@/stores";
import { fileApi } from "@/api/file";

interface ProjectMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenSettings: () => void;
  onShowHomePage: () => void;
  onNewPage: () => void;
}

const ProjectMenu: React.FC<ProjectMenuProps> = ({
  isOpen,
  onClose,
  locale,
  onOpenSettings,
  onShowHomePage,
  onNewPage,
}) => {
  const t = useTranslation(locale);
  const settings = useSettingsStore((s) => s.settings);
  const setSetting = useSettingsStore((s) => s.set);
  const themeSchema = getSettingSchema("theme");
  const localeSchema = getSettingSchema("locale");
  const themeValue = settings.theme || themeSchema?.defaultValue || "light";
  const localeValue = settings.locale || localeSchema?.defaultValue || "zh";
  const themeOrder = themeSchema?.options?.map((opt) => opt.value) || [
    "light",
    "dark",
    "hacker",
    "terminal",
  ];
  const localeOrder = localeSchema?.options?.map((opt) => opt.value) || [
    "zh",
    "en",
  ];
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const pageMenuItems = useFrameStore((s) => s.pageMenuItems);
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);

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

  const handleThemeToggle = () => {
    const currentIndex = themeOrder.indexOf(themeValue);
    const nextValue =
      themeOrder[(currentIndex + 1) % themeOrder.length] || themeOrder[0];
    setSetting("theme", nextValue);
  };

  const handleLocaleToggle = () => {
    const currentIndex = localeOrder.indexOf(localeValue);
    const nextValue =
      localeOrder[(currentIndex + 1) % localeOrder.length] || localeOrder[0];
    setSetting("locale", nextValue);
  };

  const handleCloseWorkspace = () => {
    if (activeGroup?.type === "workspace") {
      closeWorkspace(activeGroup.id);
      removeGroup(activeGroup.id);
    }
    onClose();
  };

  const handleClosePage = () => {
    if (activeGroup && activeGroup.type !== "home") {
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
      usePreviewStore
        .getState()
        .setError(e instanceof Error ? e.message : "Failed to save");
    }
    onClose();
  };

  const handleSaveAs = async () => {
    if (!file) return;
    const newPath = prompt(t("common.saveAs"), file.path);
    if (newPath && newPath !== file.path) {
      try {
        await fileApi.write(newPath, content);
      } catch (e) {
        usePreviewStore
          .getState()
          .setError(e instanceof Error ? e.message : "Failed to save");
      }
    }
    onClose();
  };

  const triggerEditorAction = (action: string) => {
    const event = new CustomEvent("editor-action", { detail: { action } });
    window.dispatchEvent(event);
    onClose();
  };

  const themeIcon =
    themeValue === "light" ? (
      <Sun size={18} />
    ) : themeValue === "dark" ? (
      <Moon size={18} />
    ) : themeValue === "hacker" ? (
      <Monitor size={18} />
    ) : (
      <Terminal size={18} />
    );

  const themeLabel =
    themeSchema?.options?.find((opt) => opt.value === themeValue)?.label ||
    themeValue;

  const localeLabel =
    localeSchema?.options?.find((opt) => opt.value === localeValue)?.label ||
    localeValue;

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
      title: themeLabel,
    },
    {
      id: "language",
      icon: <Globe size={20} />,
      label: t("common.language"),
      onClick: handleLocaleToggle,
      title: localeLabel,
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

  if (activeGroup?.type === "workspace") {
    contextItems.push({
      id: "close-workspace",
      icon: <XCircle size={20} />,
      label: t("common.closeWorkspace"),
      onClick: handleCloseWorkspace,
    });
  } else if (
    activeGroup &&
    activeGroup.type !== "home" &&
    activeGroup.type !== "settings"
  ) {
    contextItems.push({
      id: "close-page",
      icon: <XCircle size={20} />,
      label: t("common.closePage"),
      onClick: handleClosePage,
    });
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

  if (editMode && activeGroup?.type === "workspace") {
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
      },
    );
  }

  const sections = [
    { id: "builtIn", title: t("menu.builtIn"), items: builtInItems },
    ...(editorItems.length > 0
      ? [{ id: "editor", title: t("menu.editor"), items: editorItems }]
      : []),
    { id: "context", title: t("menu.context"), items: contextItems },
  ].filter((section) => section.items.length > 0);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div className="fixed bottom-0 left-0 right-0 sm:bottom-16 sm:left-4 sm:right-4 bg-ide-panel border-t sm:border border-ide-border sm:rounded-2xl shadow-2xl z-50 p-5 font-mono transform transition-transform duration-300">
        <div className="flex justify-between items-center mb-6 pb-2 border-b border-ide-border">
          <h3 className="font-bold text-ide-text flex items-center gap-2">
            <span className="bg-ide-accent text-ide-bg p-1 rounded-md">
              <Terminal size={16} />
            </span>
            VibeGo
          </h3>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-ide-bg text-ide-text transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {sections.map((section, index) => (
          <div
            key={section.id}
            className={
              index === sections.length - 1
                ? "mb-6"
                : "mb-4 pb-4 border-b border-ide-border"
            }
          >
            <div className="text-[10px] text-ide-mute uppercase font-bold mb-3">
              {section.title}
            </div>
            <div className="grid grid-cols-4 gap-4">
              {section.items.map((item) => (
                <MenuItem
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
          <span>VibeGo v0.9.0</span>
          <span>CONNECTED</span>
        </div>
      </div>
    </>
  );
};

const MenuItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  badge?: string | number;
  title?: string;
}> = ({ icon, label, onClick, badge, title }) => (
  <button
    onClick={onClick}
    title={title || label}
    className="flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-ide-bg hover:text-ide-accent transition-all text-ide-text group"
  >
    <div className="relative p-3 bg-ide-bg rounded-xl border border-ide-border group-hover:border-ide-accent group-hover:shadow-glow transition-all">
      {icon}
      {badge && (
        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
          {badge}
        </span>
      )}
    </div>
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wide">
        {label}
      </span>
      {title && <span className="text-[9px] text-ide-mute">{title}</span>}
    </div>
  </button>
);

export default ProjectMenu;
