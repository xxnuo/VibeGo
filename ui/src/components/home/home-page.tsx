import { pageRegistry, useWorkbenchRegistry } from "@/framework/workbench/registry";
import NavIcon from "@/components/frame/nav-icon";
import { getWorkspacePath } from "@/components/frame/workspace-hint-bubble";
import { Bot, GitGraph, FolderOpen, Terminal } from "lucide-react";
import React, { useCallback, useState } from "react";
import DirectoryPicker from "@/components/common/directory-picker";
import RecentSessionList from "@/components/home/recent-session-list";
import { type Locale, useTranslation } from "@/lib/i18n";
import { useFrameStore } from "@/stores/frame-store";

interface HomePageProps {
  onOpenFolder: (path: string) => void;
  locale: Locale;
}

const HomePage: React.FC<HomePageProps> = ({ onOpenFolder, locale }) => {
  useWorkbenchRegistry();
  const groups = useFrameStore((s) => s.groups);
  let recentFolders: string[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem("vibego:recent-folders") || "[]");
    if (Array.isArray(saved)) recentFolders = saved.filter((path) => typeof path === "string");
  } catch {}
  const tasks = groups.filter((group) => group.type === "group" || group.type === "tool");
  const t = useTranslation(locale);
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");

  const handleSwitchSession = useCallback(() => {
    const frame = useFrameStore.getState();
    const target = frame.groups.find((group) => group.type === "group" || group.type === "tool");
    if (target) frame.setActiveGroup(target.id);
  }, []);

  const handlePickerSelect = useCallback(
    async (path: string) => {
      await onOpenFolder(path);
      setPickerOpen(false);
    },
    [onOpenFolder]
  );

  const handlePathSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      await onOpenFolder(pathInput.trim());
      setPathInput("");
    }
  };

  return (
    <div className="h-full flex flex-col bg-ide-bg overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="w-full max-w-2xl mx-auto px-4 py-6 space-y-6">
          <div className="flex items-center justify-between border-b border-ide-border pb-3">
            <h1 className="text-sm font-semibold text-ide-text">VibeGo</h1>
            <span className="text-xs text-ide-mute">{t("home.quickActions")}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: t("sidebar.files"), icon: FolderOpen, run: () => setPickerOpen(true) },
              { label: t("sidebar.terminal"), icon: Terminal, run: () => useFrameStore.getState().addTerminalGroup() },
              { label: t("sidebar.git"), icon: GitGraph, run: () => useFrameStore.getState().addGitGroup() },
              {
                label: t("plugin.aiSessionManager.name"),
                icon: Bot,
                run: () => useFrameStore.getState().addToolGroup("ai-session-manager"),
              },
            ].map(({ label, icon: Icon, run }) => (
              <button
                key={label}
                type="button"
                onClick={run}
                className="flex min-h-11 items-center gap-2 px-3 py-2 rounded border border-ide-border bg-ide-panel text-sm text-ide-text hover:border-ide-accent"
              >
                <Icon size={18} className="shrink-0 text-ide-mute" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
          <div className="space-y-3">
            <div className="text-xs text-ide-mute uppercase font-bold">{t("home.openDirectory")}</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex items-center justify-center gap-2 px-4 py-3 bg-ide-accent text-ide-bg rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                <FolderOpen size={18} />
                {t("common.browse")}
              </button>
              <form onSubmit={handlePathSubmit} className="flex-1 flex gap-2">
                <input
                  type="text"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  name="directory-path"
                  aria-label={t("home.enterPath")}
                  className="flex-1 min-w-0 min-h-11 px-3 sm:px-4 py-2 bg-ide-panel border border-ide-border rounded-lg text-base sm:text-sm text-ide-text placeholder-ide-mute focus:outline-none focus:border-ide-accent"
                  placeholder={t("home.enterPath")}
                />
                <button
                  type="submit"
                  disabled={!pathInput.trim()}
                  className="min-h-11 px-3 sm:px-4 py-2 bg-ide-panel border border-ide-border rounded-lg text-ide-text hover:bg-ide-bg disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {t("common.open")}
                </button>
              </form>
            </div>
          </div>

          {recentFolders.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-ide-mute">{t("home.recentFolders")}</div>
              <div className="divide-y divide-ide-border border-y border-ide-border">
                {recentFolders.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => void onOpenFolder(path)}
                    className="flex w-full min-h-11 items-center gap-3 px-2 py-2 text-left hover:bg-ide-panel"
                  >
                    <FolderOpen size={18} className="shrink-0 text-ide-mute" />
                    <span className="min-w-0 truncate font-mono text-xs text-ide-text">{path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {tasks.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-ide-mute">{t("home.activeTasks")}</div>
              <div className="divide-y divide-ide-border border-y border-ide-border">
                {tasks.map((task) => {
                  const page = pageRegistry.get(task.type === "tool" ? task.pageId : task.pages[0]?.type || "files");
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => useFrameStore.getState().setActiveGroup(task.id)}
                      className="flex w-full min-h-11 items-center gap-3 px-2 py-2 text-left hover:bg-ide-panel"
                    >
                      <NavIcon icon={page?.icon} size={18} />
                      <span className="min-w-0 flex-1 truncate text-sm text-ide-text">
                        {page?.nameKey ? t(page.nameKey) : task.name}
                      </span>
                      <span className="max-w-[55%] truncate text-xs font-mono text-ide-mute">
                        {getWorkspacePath(task)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="space-y-3">
            <div className="bg-ide-panel border border-ide-border rounded p-3 sm:p-4">
              <RecentSessionList onSwitchSession={handleSwitchSession} locale={locale} />
            </div>
          </div>
        </div>
      </div>

      <DirectoryPicker
        isOpen={isPickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePickerSelect}
        initialPath="."
        locale={locale}
      />
    </div>
  );
};

export default HomePage;
