import React, { useEffect } from 'react';
import { Settings, Sun, Moon, Monitor, Terminal, Globe, Eye, EyeOff, List, Grid, AlignLeft, WrapText, X } from 'lucide-react';
import { useSettingsStore, SETTING_CATEGORIES, getSettingsByCategory, type SettingSchema } from '@/lib/settings';
import { useTranslation, type Locale } from '@/lib/i18n';
import { useFrameStore } from '@/stores/frameStore';

const SettingItem: React.FC<{
  schema: SettingSchema;
  value: string;
  onChange: (value: string) => void;
  t: (key: string) => string;
}> = ({ schema, value, onChange, t }) => {
  const getIcon = () => {
    switch (schema.key) {
      case 'theme':
        if (value === 'light') return <Sun size={18} className="text-orange-500" />;
        if (value === 'dark') return <Moon size={18} className="text-blue-400" />;
        if (value === 'hacker') return <Monitor size={18} className="text-green-500" />;
        return <Terminal size={18} className="text-green-400" />;
      case 'locale':
        return <Globe size={18} className="text-ide-accent" />;
      case 'showHiddenFiles':
        return value === 'true' ? <Eye size={18} /> : <EyeOff size={18} />;
      case 'defaultViewMode':
        return value === 'list' ? <List size={18} /> : <Grid size={18} />;
      case 'editorWordWrap':
        return value === 'true' ? <WrapText size={18} /> : <AlignLeft size={18} />;
      default:
        return <Settings size={18} />;
    }
  };

  if (schema.type === 'toggle') {
    return (
      <div className="flex items-center justify-between p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && (
              <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>
            )}
          </div>
        </div>
        <button
          onClick={() => onChange(value === 'true' ? 'false' : 'true')}
          className={`w-12 h-6 rounded-full transition-colors ${
            value === 'true' ? 'bg-ide-accent' : 'bg-ide-border'
          }`}
        >
          <div
            className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${
              value === 'true' ? 'translate-x-6' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    );
  }

  if (schema.type === 'select' && schema.options) {
    return (
      <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3 mb-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && (
              <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {schema.options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={`px-3 py-1.5 text-xs rounded-md border transition-all ${
                value === opt.value
                  ? 'bg-ide-accent text-ide-bg border-ide-accent'
                  : 'bg-ide-panel text-ide-text border-ide-border hover:border-ide-accent'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (schema.type === 'number') {
    return (
      <div className="flex items-center justify-between p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && (
              <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>
            )}
          </div>
        </div>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={schema.min}
          max={schema.max}
          className="w-20 px-2 py-1 text-sm bg-ide-panel border border-ide-border rounded text-ide-text text-center"
        />
      </div>
    );
  }

  return null;
};

const SettingsPage: React.FC = () => {
  const { settings, init, set, loading } = useSettingsStore();
  const locale = (settings.locale || 'zh') as Locale;
  const t = useTranslation(locale);
  const setHeaderConfig = useFrameStore((s) => s.setHeaderConfig);
  const removeGroup = useFrameStore((s) => s.removeGroup);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    setHeaderConfig({
      leftButton: { icon: <Settings size={18} />, variant: 'accent' },
      title: t('common.settings'),
      rightButton: {
        icon: <X size={18} />,
        onClick: () => removeGroup('settings'),
        variant: 'ghost',
      },
      showTabs: false,
    });
    return () => setHeaderConfig(null);
  }, [t, setHeaderConfig, removeGroup]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-ide-mute">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-ide-bg">
      <div className="max-w-2xl mx-auto p-4">
        {SETTING_CATEGORIES.map((category) => {
          const categorySettings = getSettingsByCategory(category.key);
          if (categorySettings.length === 0) return null;

          return (
            <div key={category.key} className="mb-6">
              <h2 className="text-xs font-bold text-ide-mute uppercase tracking-wider mb-3">
                {t(category.labelKey)}
              </h2>
              <div className="space-y-2">
                {categorySettings.map((schema) => (
                  <SettingItem
                    key={schema.key}
                    schema={schema}
                    value={settings[schema.key] || schema.defaultValue}
                    onChange={(v) => set(schema.key, v)}
                    t={t}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SettingsPage;
