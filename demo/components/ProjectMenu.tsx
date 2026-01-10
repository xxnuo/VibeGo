import React from 'react';
import { FolderOpen, Settings, Save, Download, Home, X, Sun, Moon, Globe } from 'lucide-react';
import { Locale, Theme } from '../types';
import { useTranslation } from '../utils/i18n';

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

  return (
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Drawer */}
      <div className="fixed bottom-16 left-4 right-4 bg-ide-panel border border-ide-border rounded-xl shadow-2xl z-50 p-4 transform transition-transform duration-300 ease-out origin-bottom">
        <div className="flex justify-between items-center mb-4 pb-2 border-b border-ide-border">
          <h3 className="font-bold text-ide-text">{t('project')}</h3>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-ide-border">
            <X size={20} className="text-ide-mute" />
          </button>
        </div>

        {/* Toggles */}
        <div className="flex gap-3 mb-4">
             <button 
                onClick={toggleTheme}
                className="flex-1 flex items-center justify-center gap-2 p-3 bg-ide-bg border border-ide-border rounded-lg text-ide-text hover:bg-ide-border transition-colors"
             >
                {theme === 'light' ? <Sun size={18} className="text-orange-500" /> : <Moon size={18} className="text-purple-400" />}
                <span className="text-sm font-medium">{theme === 'light' ? 'Light' : 'Dark'}</span>
             </button>
             <button 
                onClick={toggleLocale}
                className="flex-1 flex items-center justify-center gap-2 p-3 bg-ide-bg border border-ide-border rounded-lg text-ide-text hover:bg-ide-border transition-colors"
             >
                <Globe size={18} className="text-blue-500" />
                <span className="text-sm font-medium">{locale === 'en' ? 'English' : '中文'}</span>
             </button>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <MenuItem icon={<Save size={24} />} label={t('saveAll')} />
          <MenuItem icon={<FolderOpen size={24} />} label={t('open')} />
          <MenuItem icon={<Download size={24} />} label={t('export')} />
          <MenuItem icon={<Settings size={24} />} label={t('settings')} />
          <MenuItem icon={<Home size={24} />} label={t('home')} />
        </div>
        
        <div className="mt-4 pt-4 border-t border-ide-border">
           <p className="text-xs text-ide-mute text-center">MobIDE v0.2.0-beta</p>
        </div>
      </div>
    </>
  );
};

const MenuItem: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <button className="flex flex-col items-center gap-2 p-2 rounded-lg hover:bg-ide-border active:scale-95 transition-all text-ide-text">
    <div className="p-3 bg-ide-bg rounded-full text-ide-accent border border-ide-border">
      {icon}
    </div>
    <span className="text-xs font-medium">{label}</span>
  </button>
);

export default ProjectMenu;