import React from 'react';
import { FolderOpen, Settings, Save, Download, Home, X, Sun, Moon, Globe, Terminal, Monitor } from 'lucide-react';
import type { Theme } from '@/stores';
import { useTranslation, type Locale } from '@/lib/i18n';

interface ProjectMenuProps {
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
  toggleTheme: () => void;
  locale: Locale;
  toggleLocale: () => void;
}

const ProjectMenu: React.FC<ProjectMenuProps> = ({
  isOpen, onClose, theme, toggleTheme, locale, toggleLocale
}) => {
  const t = useTranslation(locale);

  if (!isOpen) return null;

  const getThemeIcon = () => {
    switch (theme) {
      case 'light': return <Sun size={18} className="text-orange-500" />;
      case 'dark': return <Moon size={18} className="text-blue-400" />;
      case 'hacker': return <Monitor size={18} className="text-green-500" />;
      case 'terminal': return <Terminal size={18} className="text-green-400" />;
    }
  };

  const getThemeLabel = () => {
    switch (theme) {
      case 'light': return 'Light';
      case 'dark': return 'Dark';
      case 'hacker': return 'Hacker';
      case 'terminal': return 'Terminal';
    }
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
            MENU
          </h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ide-bg text-ide-text transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex gap-4 mb-6">
          <button
            onClick={toggleTheme}
            className="flex-1 flex items-center justify-center gap-3 p-4 border border-ide-border rounded-xl hover:border-ide-accent hover:bg-ide-bg transition-all text-ide-text group"
          >
            <div className="group-hover:scale-110 transition-transform">{getThemeIcon()}</div>
            <div className="flex flex-col items-start">
              <span className="text-[10px] text-ide-mute uppercase">Theme</span>
              <span className="text-sm font-bold">{getThemeLabel()}</span>
            </div>
          </button>
          <button
            onClick={toggleLocale}
            className="flex-1 flex items-center justify-center gap-3 p-4 border border-ide-border rounded-xl hover:border-ide-accent hover:bg-ide-bg transition-all text-ide-text group"
          >
            <div className="group-hover:scale-110 transition-transform"><Globe size={18} className="text-ide-accent" /></div>
            <div className="flex flex-col items-start">
              <span className="text-[10px] text-ide-mute uppercase">Locale</span>
              <span className="text-sm font-bold">{locale === 'en' ? 'ENG' : 'CHN'}</span>
            </div>
          </button>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <MenuItem icon={<Save size={20} />} label={t('common.saveAll')} />
          <MenuItem icon={<FolderOpen size={20} />} label={t('common.open')} />
          <MenuItem icon={<Download size={20} />} label={t('common.export')} />
          <MenuItem icon={<Settings size={20} />} label={t('common.settings')} />
          <MenuItem icon={<Home size={20} />} label={t('common.home')} />
        </div>

        <div className="mt-6 pt-4 border-t border-ide-border flex justify-between text-[10px] text-ide-mute">
          <span>MobIDE v0.9.0</span>
          <span>CONNECTED</span>
        </div>
      </div>
    </>
  );
};

const MenuItem: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <button className="flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-ide-bg hover:text-ide-accent transition-all text-ide-text group">
    <div className="p-3 bg-ide-bg rounded-xl border border-ide-border group-hover:border-ide-accent group-hover:shadow-glow transition-all">
      {icon}
    </div>
    <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
  </button>
);

export default ProjectMenu;