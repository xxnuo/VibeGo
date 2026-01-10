import React from 'react';
import { FolderOpen, Settings, Save, Download, Home, X, Terminal } from 'lucide-react';
import { useTranslation, type Locale } from '@/lib/i18n';
import { useSettingsStore, getSettingSchema } from '@/lib/settings';

interface ProjectMenuProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  onOpenSettings: () => void;
  onOpenDirectory: () => void;
  onNewTerminal: () => void;
}

const ProjectMenu: React.FC<ProjectMenuProps> = ({
  isOpen, onClose, locale,
  onOpenSettings, onOpenDirectory, onNewTerminal,
}) => {
  const t = useTranslation(locale);
  const settings = useSettingsStore((s) => s.settings);
  const setSetting = useSettingsStore((s) => s.set);
  const themeSchema = getSettingSchema('theme');
  const localeSchema = getSettingSchema('locale');
  const themeValue = settings.theme || themeSchema?.defaultValue || 'light';
  const localeValue = settings.locale || localeSchema?.defaultValue || 'zh';

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

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div className="fixed bottom-0 left-0 right-0 sm:bottom-16 sm:left-4 sm:right-4 bg-ide-panel border-t sm:border border-ide-border sm:rounded-2xl shadow-2xl z-50 p-5 font-mono transform transition-transform duration-300">
        <div className="flex justify-between items-center mb-6 pb-2 border-b border-ide-border">
          <h3 className="font-bold text-ide-text flex items-center gap-2">
            <span className="bg-ide-accent text-ide-bg p-1 rounded-md"><Terminal size={16} /></span>
            VibeGo
          </h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ide-bg text-ide-text transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="mb-4 pb-4 border-b border-ide-border">
          <div className="text-[10px] text-ide-mute uppercase font-bold mb-3">{t('common.newGroup')}</div>
          <div className="flex gap-2">
            <button
              onClick={handleOpenDirectory}
              className="flex-1 flex items-center gap-2 p-3 border border-ide-border rounded-lg hover:border-ide-accent hover:bg-ide-bg transition-all text-ide-text"
            >
              <FolderOpen size={18} className="text-ide-accent" />
              <span className="text-xs font-medium">{t('common.openFolder')}</span>
            </button>
            <button
              onClick={handleNewTerminal}
              className="flex-1 flex items-center gap-2 p-3 border border-ide-border rounded-lg hover:border-ide-accent hover:bg-ide-bg transition-all text-ide-text"
            >
              <Terminal size={18} className="text-ide-accent" />
              <span className="text-xs font-medium">{t('common.newTerminal')}</span>
            </button>
          </div>
        </div>

        <div className="mb-4 pb-4 border-b border-ide-border">
          <div className="text-[10px] text-ide-mute uppercase font-bold mb-3">{t('common.theme')}</div>
          <div className="flex flex-wrap gap-2">
            {themeSchema?.options?.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSetting('theme', opt.value)}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide rounded-md border transition-all ${
                  themeValue === opt.value
                    ? 'bg-ide-accent text-ide-bg border-ide-accent'
                    : 'bg-ide-bg text-ide-text border-ide-border hover:border-ide-accent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 pb-4 border-b border-ide-border">
          <div className="text-[10px] text-ide-mute uppercase font-bold mb-3">{t('common.language')}</div>
          <div className="flex flex-wrap gap-2">
            {localeSchema?.options?.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSetting('locale', opt.value)}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide rounded-md border transition-all ${
                  localeValue === opt.value
                    ? 'bg-ide-accent text-ide-bg border-ide-accent'
                    : 'bg-ide-bg text-ide-text border-ide-border hover:border-ide-accent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <MenuItem icon={<Save size={20} />} label={t('common.saveAll')} />
          <MenuItem icon={<Download size={20} />} label={t('common.export')} />
          <MenuItem icon={<Settings size={20} />} label={t('common.settings')} onClick={handleSettings} />
          <MenuItem icon={<Home size={20} />} label={t('common.home')} />
        </div>

        <div className="mt-6 pt-4 border-t border-ide-border flex justify-between text-[10px] text-ide-mute">
          <span>VibeGo v0.9.0</span>
          <span>CONNECTED</span>
        </div>
      </div>
    </>
  );
};

const MenuItem: React.FC<{ icon: React.ReactNode; label: string; onClick?: () => void }> = ({ icon, label, onClick }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-ide-bg hover:text-ide-accent transition-all text-ide-text group">
    <div className="p-3 bg-ide-bg rounded-xl border border-ide-border group-hover:border-ide-accent group-hover:shadow-glow transition-all">
      {icon}
    </div>
    <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
  </button>
);

export default ProjectMenu;
