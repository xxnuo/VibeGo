import React, { useState, useCallback } from "react";
import { FolderOpen, Terminal } from "lucide-react";
import RecentFolderList from "./RecentFolderList";
import DirectoryPicker from "./DirectoryPicker";
import { useTranslation, type Locale } from "@/lib/i18n";

interface HomePageProps {
  onOpenFolder: (path: string) => void;
  locale: Locale;
}

const HomePage: React.FC<HomePageProps> = ({ onOpenFolder, locale }) => {
  const t = useTranslation(locale);
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");

  const handleSelectRecent = useCallback(
    (path: string) => {
      onOpenFolder(path);
    },
    [onOpenFolder],
  );

  const handlePickerSelect = useCallback(
    (path: string) => {
      onOpenFolder(path);
      setPickerOpen(false);
    },
    [onOpenFolder],
  );

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      onOpenFolder(pathInput.trim());
      setPathInput("");
    }
  };

  return (
    <div className="h-full flex flex-col bg-ide-bg overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="w-full max-w-2xl mx-auto px-4 py-6 space-y-6">
          <div className="text-center py-6 sm:py-8">
            <div className="inline-flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 bg-ide-panel border border-ide-border rounded-2xl mb-3 sm:mb-4">
              <Terminal size={28} className="text-ide-accent sm:hidden" />
              <Terminal size={32} className="text-ide-accent hidden sm:block" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-ide-text mb-2">
              VibeGo
            </h1>
            <p className="text-sm sm:text-base text-ide-mute">
              {t("home.welcome")}
            </p>
          </div>

          <div className="space-y-3">
            <div className="text-xs text-ide-mute uppercase font-bold">
              {t("home.openDirectory")}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
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
                  className="flex-1 min-w-0 px-3 sm:px-4 py-2 bg-ide-panel border border-ide-border rounded-lg text-ide-text placeholder-ide-mute focus:outline-none focus:border-ide-accent text-sm"
                  placeholder={t("home.enterPath")}
                />
                <button
                  type="submit"
                  disabled={!pathInput.trim()}
                  className="px-3 sm:px-4 py-2 bg-ide-panel border border-ide-border rounded-lg text-ide-text hover:bg-ide-bg disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {t("common.open")}
                </button>
              </form>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-xs text-ide-mute uppercase font-bold">
              {t("home.recentFolders")}
            </div>
            <div className="bg-ide-panel border border-ide-border rounded-xl p-3 sm:p-4">
              <RecentFolderList onSelect={handleSelectRecent} locale={locale} />
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
