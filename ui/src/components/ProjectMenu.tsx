import React from "react";
import {
  FolderOpen,
  Settings,
  Home,
  X,
  Terminal,
  Sun,
  Moon,
  Monitor,
  Globe,
} from "lucide-react";
import { useTranslation, type Locale } from "@/lib/i18n";
import { useSettingsStore, getSettingSchema } from "@/lib/settings";
import { useFrameStore } from "@/stores";

interface ProjectMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenSettings: () => void;
  onOpenDirectory: () => void;
  onNewTerminal: () => void;
}

const ProjectMenu: React.FC<ProjectMenuProps> = ({
  isOpen,
  onClose,
  locale,
  onOpenSettings,
  onOpenDirectory,
  onNewTerminal,
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
  const groups = useFrameStore((s) => s.groups);
  const setActiveGroup = useFrameStore((s) => s.setActiveGroup);
  const bottomBarConfig = useFrameStore((s) => s.bottomBarConfig);

  if (!isOpen) return null;

  const handleSettings = () => {
    onOpenSettings();
    onClose();
  };

  const handleOpenDirectory = () => {
    onOpenDirectory();
    onClose();
  };

  const handleNewTerminal = () => {
    onNewTerminal();
    onClose();
  };

  const handleHome = () => {
    const workspaceGroup = groups.find((group) => group.type === "workspace");
    const targetGroup = workspaceGroup || groups[0];
    if (targetGroup) {
      setActiveGroup(targetGroup.id);
    }
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
      title:
        themeSchema?.options?.find((opt) => opt.value === themeValue)?.label ||
        themeValue,
    },
    {
      id: "language",
      icon: <Globe size={20} />,
      label: t("common.language"),
      onClick: handleLocaleToggle,
      title:
        localeSchema?.options?.find((opt) => opt.value === localeValue)
          ?.label || localeValue,
    },
  ];
  const groupItems: Array<{
    id: string;
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    badge?: string | number;
    title?: string;
  }> = [
    {
      id: "open-folder",
      icon: <FolderOpen size={20} />,
      label: t("common.openFolder"),
      onClick: handleOpenDirectory,
    },
    {
      id: "new-terminal",
      icon: <Terminal size={20} />,
      label: t("common.newTerminal"),
      onClick: handleNewTerminal,
    },
  ];
  const pageMenuItems = (bottomBarConfig.customItems || []).map((item) => ({
    id: item.id,
    icon: item.icon,
    label: item.label,
    onClick: item.onClick,
    badge: item.badge,
  }));
  const sections = [
    { id: "builtIn", title: t("menu.builtIn"), items: builtInItems },
    { id: "group", title: t("menu.group"), items: groupItems },
    { id: "page", title: t("menu.page"), items: pageMenuItems },
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
    <span className="text-[10px] font-bold uppercase tracking-wide">
      {label}
    </span>
  </button>
);

export default ProjectMenu;
