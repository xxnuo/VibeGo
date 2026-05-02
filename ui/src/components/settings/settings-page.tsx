import {
  AlignLeft,
  Bell,
  Check,
  CloudDownload,
  Download,
  Eye,
  EyeOff,
  Grid,
  List,
  Mail,
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  Trash2,
  Type,
  User,
  Vibrate,
  Volume2,
  WrapText,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { deleteSpeechModelAssets, preloadSpeechModel, speechAssetStates } from "@/components/keyboard/core/sherpa-asr";
import { useFrameController } from "@/framework/frame/controller";
import {
  customFontFamily,
  detectCandidateFontFamilies,
  type FontOption,
  recommendedFontOptions,
  resolveFontFamily,
  scanLocalFontFamilies,
  supportsLocalFontScan,
  toFontOptions,
} from "@/lib/fonts";
import { type Locale, useTranslation } from "@/lib/i18n";
import { getNewPageVisibilitySettingKey, isPageVisibleInNewPage } from "@/lib/page-visibility";
import {
  getSettingsByCategory,
  SETTING_CATEGORIES,
  SETTINGS_SCHEMA,
  type SettingSchema,
  useSettingsStore,
} from "@/lib/settings";
import { pageRegistry } from "@/pages/registry";
import type { PageDefinition } from "@/pages/types";
import { requestTerminalNotificationPermission } from "@/services/terminal-notification-service";
import { useFrameStore } from "@/stores/frame-store";

const FONT_SAMPLE = {
  ui: "VibeGo 设置 0123",
  terminal: "$ pnpm dev --host 0.0.0.0",
};

const FONT_SOURCE_LABELS: Record<FontOption["source"], string> = {
  recommended: "推荐",
  installed: "本机",
  candidate: "候选",
};

function mergeFontOptions(options: FontOption[]) {
  const seen = new Set<string>();
  const result: FontOption[] = [];
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    result.push(option);
  }
  return result;
}

const FontSettingItem: React.FC<{
  schema: SettingSchema;
  value: string;
  fallbackSchema?: SettingSchema;
  fallbackValue?: string;
  onChange: (value: string) => void;
  onFallbackChange?: (value: string) => void;
  t: (key: string) => string;
}> = ({ schema, value, fallbackSchema, fallbackValue = "default", onChange, onFallbackChange, t }) => {
  const [fontOptions, setFontOptions] = useState<FontOption[]>([]);
  const [fontScanBusy, setFontScanBusy] = useState(false);
  const [fontScanDone, setFontScanDone] = useState(false);
  const [fontSearch, setFontSearch] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fallbackSearch, setFallbackSearch] = useState("");
  const isTerminalFont = schema.key === "terminalFontFamily";
  const scanSupported = supportsLocalFontScan();
  const recommendedOptions = recommendedFontOptions(isTerminalFont).map((opt) => ({
    ...opt,
    label: schema.options?.find((item) => item.value === opt.value)?.label || opt.label,
  }));
  const selectedCustomOption =
    value.startsWith("custom:") && !fontOptions.some((opt) => opt.value === value)
      ? [
          {
            value,
            label: customFontFamily(value),
            family: resolveFontFamily(value),
            source: "installed" as const,
          },
        ]
      : [];
  const allFontOptions = mergeFontOptions([...recommendedOptions, ...selectedCustomOption, ...fontOptions]);
  const selectedFontOption = allFontOptions.find((opt) => opt.value === value) || allFontOptions[0];
  const selectedFallbackOption =
    allFontOptions.find((opt) => opt.value === fallbackValue) ||
    (fallbackValue.startsWith("custom:")
      ? {
          value: fallbackValue,
          label: customFontFamily(fallbackValue),
          family: resolveFontFamily(fallbackValue),
          source: "installed" as const,
        }
      : allFontOptions[0]);
  const normalizedSearch = fontSearch.trim().toLowerCase();
  const filteredFontOptions = normalizedSearch
    ? allFontOptions.filter((opt) => opt.label.toLowerCase().includes(normalizedSearch))
    : allFontOptions;
  const normalizedFallbackSearch = fallbackSearch.trim().toLowerCase();
  const fallbackOptions = allFontOptions.filter((opt) => opt.value !== value);
  const filteredFallbackOptions = normalizedFallbackSearch
    ? fallbackOptions.filter((opt) => opt.label.toLowerCase().includes(normalizedFallbackSearch))
    : fallbackOptions;
  const sample = isTerminalFont ? FONT_SAMPLE.terminal : FONT_SAMPLE.ui;
  const combinedPreviewFamily = resolveFontFamily(value, undefined, fallbackValue);
  const canResetPrimary = value !== (schema.defaultValue || "default");
  const canResetFallback = fallbackSchema && fallbackValue !== (fallbackSchema.defaultValue || "default");

  const scanFonts = async () => {
    if (fontScanBusy) return;
    setFontScanBusy(true);
    try {
      const families = scanSupported ? await scanLocalFontFamilies() : await detectCandidateFontFamilies();
      setFontOptions(toFontOptions(families, scanSupported ? "installed" : "candidate"));
      setFontScanDone(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "无法读取本机字体");
    } finally {
      setFontScanBusy(false);
    }
  };

  useEffect(() => {
    if (!scanSupported) void scanFonts();
  }, [scanSupported]);

  return (
    <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-ide-mute">
            <Type size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onChange(schema.defaultValue || "default")}
            disabled={!canResetPrimary}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border transition-all bg-ide-panel text-ide-text border-ide-border hover:border-ide-accent disabled:opacity-50 disabled:hover:border-ide-border"
          >
            恢复默认
          </button>
          <button
            type="button"
            onClick={() => void scanFonts()}
            disabled={fontScanBusy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border transition-all bg-ide-panel text-ide-text border-ide-border hover:border-ide-accent disabled:opacity-60"
          >
            <RefreshCw size={13} className={fontScanBusy ? "animate-spin" : ""} />
            {scanSupported ? "扫描本机" : "检测候选"}
          </button>
        </div>
      </div>
      {selectedFontOption && (
        <div className="mb-3 p-3 bg-ide-panel border border-ide-border rounded-md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ide-text truncate">
                {selectedFontOption.label.startsWith("settings.")
                  ? t(selectedFontOption.label)
                  : selectedFontOption.label}
              </div>
              <div className="text-[11px] leading-4 text-ide-mute">{FONT_SOURCE_LABELS[selectedFontOption.source]}</div>
            </div>
            <span className="shrink-0 text-[11px] text-ide-accent">当前</span>
          </div>
          <div
            className="mt-2 truncate text-base leading-6 text-ide-text"
            style={{ fontFamily: combinedPreviewFamily }}
          >
            {sample}
          </div>
          <div
            className="mt-1 truncate text-[11px] leading-4 text-ide-mute"
            style={{ fontFamily: combinedPreviewFamily }}
          >
            Aa Bb Cc 中文 1234567890
          </div>
        </div>
      )}
      <div className="mb-2 flex items-center gap-2 rounded-md border border-ide-border bg-ide-panel px-2.5 py-1.5 focus-within:border-ide-accent">
        <Search size={14} className="shrink-0 text-ide-mute" />
        <input
          type="search"
          value={fontSearch}
          onChange={(e) => setFontSearch(e.target.value)}
          placeholder="搜索字体"
          className="min-w-0 flex-1 bg-transparent text-xs text-ide-text outline-none placeholder:text-ide-mute"
        />
        <span className="shrink-0 text-[11px] text-ide-mute">{filteredFontOptions.length}</span>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border border-ide-border bg-ide-panel custom-scrollbar">
        {filteredFontOptions.map((opt) => {
          const label = opt.label.startsWith("settings.") ? t(opt.label) : opt.label;
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex w-full min-w-0 items-center gap-3 border-b border-ide-border px-3 py-2 text-left transition-all last:border-b-0 ${
                selected ? "bg-ide-accent/10 text-ide-text" : "bg-transparent text-ide-text hover:bg-ide-bg"
              }`}
            >
              <span
                className={`h-5 w-5 shrink-0 inline-flex items-center justify-center rounded border ${
                  selected ? "border-ide-accent bg-ide-accent text-ide-on-accent" : "border-ide-border text-transparent"
                }`}
              >
                <Check size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-xs font-medium">{label}</span>
                  <span className="shrink-0 text-[10px] leading-4 text-ide-mute">{FONT_SOURCE_LABELS[opt.source]}</span>
                </div>
                <div className="truncate text-[11px] leading-4 text-ide-mute" style={{ fontFamily: opt.family }}>
                  Aa Bb Cc 中文 1234567890
                </div>
              </div>
              <div
                className="hidden min-w-0 flex-[0.8] truncate text-xs leading-5 text-ide-text sm:block"
                style={{ fontFamily: opt.family }}
              >
                {sample}
              </div>
            </button>
          );
        })}
        {filteredFontOptions.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-ide-mute">没有匹配的字体</div>
        )}
      </div>
      {fontScanDone && fontOptions.length === 0 && (
        <div className="mt-3 text-xs leading-5 text-ide-mute">没有读取到可用字体，当前浏览器可能限制字体访问。</div>
      )}
      {fallbackSchema && onFallbackChange && (
        <div className="mt-3 border-t border-ide-border pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 text-left text-xs text-ide-text"
          >
            <span className="font-medium">高级设置</span>
            <span className="text-ide-mute">{advancedOpen ? "收起" : "展开"}</span>
          </button>
          {advancedOpen && (
            <div className="mt-3">
              <div className="mb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium text-ide-text">{t(fallbackSchema.labelKey)}</div>
                  <button
                    type="button"
                    onClick={() => onFallbackChange(fallbackSchema.defaultValue || "default")}
                    disabled={!canResetFallback}
                    className="shrink-0 text-[11px] text-ide-mute hover:text-ide-text disabled:opacity-50 disabled:hover:text-ide-mute"
                  >
                    恢复默认
                  </button>
                </div>
                {fallbackSchema.descriptionKey && (
                  <div className="mt-1 text-[11px] leading-4 text-ide-mute">{t(fallbackSchema.descriptionKey)}</div>
                )}
              </div>
              {selectedFallbackOption && fallbackValue !== "default" && (
                <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-ide-border bg-ide-panel px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs text-ide-text">
                      {selectedFallbackOption.label.startsWith("settings.")
                        ? t(selectedFallbackOption.label)
                        : selectedFallbackOption.label}
                    </div>
                    <div
                      className="truncate text-[11px] leading-4 text-ide-mute"
                      style={{ fontFamily: selectedFallbackOption.family }}
                    >
                      Aa Bb Cc 中文 1234567890
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onFallbackChange("default")}
                    className="shrink-0 text-[11px] text-ide-mute hover:text-ide-text"
                  >
                    清除
                  </button>
                </div>
              )}
              <div className="mb-2 flex items-center gap-2 rounded-md border border-ide-border bg-ide-panel px-2.5 py-1.5 focus-within:border-ide-accent">
                <Search size={14} className="shrink-0 text-ide-mute" />
                <input
                  type="search"
                  value={fallbackSearch}
                  onChange={(e) => setFallbackSearch(e.target.value)}
                  placeholder="搜索备选字体"
                  className="min-w-0 flex-1 bg-transparent text-xs text-ide-text outline-none placeholder:text-ide-mute"
                />
                <span className="shrink-0 text-[11px] text-ide-mute">{filteredFallbackOptions.length}</span>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-ide-border bg-ide-panel custom-scrollbar">
                {filteredFallbackOptions.map((opt) => {
                  const label = opt.label.startsWith("settings.") ? t(opt.label) : opt.label;
                  const selected = fallbackValue === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => onFallbackChange(opt.value)}
                      className={`flex w-full min-w-0 items-center gap-3 border-b border-ide-border px-3 py-2 text-left transition-all last:border-b-0 ${
                        selected ? "bg-ide-accent/10 text-ide-text" : "bg-transparent text-ide-text hover:bg-ide-bg"
                      }`}
                    >
                      <span
                        className={`h-5 w-5 shrink-0 inline-flex items-center justify-center rounded border ${
                          selected
                            ? "border-ide-accent bg-ide-accent text-ide-on-accent"
                            : "border-ide-border text-transparent"
                        }`}
                      >
                        <Check size={13} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 truncate text-xs font-medium">{label}</span>
                          <span className="shrink-0 text-[10px] leading-4 text-ide-mute">
                            {FONT_SOURCE_LABELS[opt.source]}
                          </span>
                        </div>
                        <div
                          className="truncate text-[11px] leading-4 text-ide-mute"
                          style={{ fontFamily: opt.family }}
                        >
                          Aa Bb Cc 中文 1234567890
                        </div>
                      </div>
                    </button>
                  );
                })}
                {filteredFallbackOptions.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-ide-mute">没有匹配的字体</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const SettingItem: React.FC<{
  schema: SettingSchema;
  value: string;
  settings?: Record<string, string>;
  schemas?: SettingSchema[];
  onChange: (value: string) => void;
  onSettingChange?: (key: string, value: string) => void;
  t: (key: string) => string;
  onDeleteSpeechAssets?: () => void;
}> = ({ schema, value, settings, schemas, onChange, onSettingChange, t, onDeleteSpeechAssets }) => {
  const getIcon = () => {
    switch (schema.key) {
      case "showHiddenFiles":
        return value === "true" ? <Eye size={18} /> : <EyeOff size={18} />;
      case "defaultViewMode":
        return value === "list" ? <List size={18} /> : <Grid size={18} />;
      case "editorWordWrap":
        return value === "true" ? <WrapText size={18} /> : <AlignLeft size={18} />;
      case "terminalFontFamily":
        return <Type size={18} />;
      case "terminalDesktopNotifications":
        return <Bell size={18} />;
      case "gitUserName":
        return <User size={18} />;
      case "gitUserEmail":
        return <Mail size={18} />;
      case "gitDefaultCommitMessage":
        return <AlignLeft size={18} />;
      case "useNativeKeyboard":
        return <Smartphone size={18} />;
      case "keyboardHaptic":
        return <Vibrate size={18} />;
      case "keyboardSound":
        return <Volume2 size={18} />;
      case "speechAssets":
        return <CloudDownload size={18} />;
      default:
        return <Settings size={18} />;
    }
  };

  if (schema.type === "toggle") {
    const enabled = value === "true";

    return (
      <div className="flex items-center justify-between gap-4 p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`shrink-0 transition-colors ${enabled ? "text-ide-accent" : "text-ide-mute"}`}>
            {getIcon()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && <div className="text-xs leading-5 text-ide-mute">{t(schema.descriptionKey)}</div>}
          </div>
        </div>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => onChange(enabled ? "false" : "true")}
          className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors duration-200 focus:outline-none focus:border-ide-accent ${enabled ? "border-ide-accent bg-ide-accent/12" : "border-ide-border bg-ide-panel hover:border-ide-mute/40"}`}
        >
          <span
            className={`absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border shadow-sm transition-all duration-200 ${enabled ? "translate-x-5 border-ide-accent bg-ide-accent" : "translate-x-0 border-ide-border bg-white"}`}
          />
        </button>
      </div>
    );
  }

  if (
    schema.type === "select" &&
    schema.options &&
    (schema.key === "fontFamily" || schema.key === "terminalFontFamily")
  ) {
    const fallbackKey = schema.key === "fontFamily" ? "fontFallbackFamily" : "terminalFontFallbackFamily";
    const fallbackSchema = schemas?.find((item) => item.key === fallbackKey);
    return (
      <FontSettingItem
        schema={schema}
        value={value}
        fallbackSchema={fallbackSchema}
        fallbackValue={settings?.[fallbackKey] || fallbackSchema?.defaultValue}
        onChange={onChange}
        onFallbackChange={onSettingChange ? (nextValue) => onSettingChange(fallbackKey, nextValue) : undefined}
        t={t}
      />
    );
  }

  if (schema.type === "select" && schema.options) {
    return (
      <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3 mb-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {schema.options.map((opt) => {
            const label = opt.label.startsWith("settings.") ? t(opt.label) : opt.label;
            return (
              <button
                key={opt.value}
                onClick={() => onChange(opt.value)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-all ${
                  value === opt.value
                    ? "bg-ide-accent text-ide-bg border-ide-accent"
                    : "bg-ide-panel text-ide-text border-ide-border hover:border-ide-accent"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (schema.type === "number") {
    return (
      <div className="flex items-center justify-between p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>}
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

  if (schema.type === "text") {
    return (
      <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3 mb-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>}
          </div>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t(schema.labelKey)}
          className="w-full px-3 py-1.5 text-sm bg-ide-panel border border-ide-border rounded text-ide-text placeholder:text-ide-mute"
        />
      </div>
    );
  }

  if (schema.type === "action") {
    return (
      <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3 mb-3">
          <div className="text-ide-mute">{getIcon()}</div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t(schema.labelKey)}</div>
            {schema.descriptionKey && <div className="text-xs text-ide-mute">{t(schema.descriptionKey)}</div>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onChange("run")}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs border rounded-md transition-all bg-ide-panel text-ide-text border-ide-border hover:border-ide-accent"
          >
            <Download size={14} />
            {t("settings.speechAssets.button")}
          </button>
          {schema.key === "speechAssets" && onDeleteSpeechAssets && (
            <button
              type="button"
              onClick={onDeleteSpeechAssets}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs border rounded-md transition-all bg-ide-panel text-red-500 border-ide-border hover:border-red-500"
            >
              <Trash2 size={14} />
              {t("settings.speechAssets.deleteButton")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
};

const SettingsPage: React.FC = () => {
  const settings = useSettingsStore((s) => s.settings);
  const loading = useSettingsStore((s) => s.loading);
  const initSettings = useSettingsStore((s) => s.init);
  const updateSetting = useSettingsStore((s) => s.set);
  const locale = (settings.locale || "zh") as Locale;
  const t = useTranslation(locale);
  const { setTopBarConfig } = useFrameController();
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const settingsGroup = useFrameStore((s) => s.groups.find((group) => group.type === "settings"));
  const setSettingsActiveCategory = useFrameStore((s) => s.setSettingsActiveCategory);

  const [speechAssetState, setSpeechAssetState] = useState<Record<string, boolean>>({});
  const [speechAssetBusy, setSpeechAssetBusy] = useState<Record<string, boolean>>({});
  const activeTab = settingsGroup?.activeCategory || SETTING_CATEGORIES[0].key;
  const toolPages = useMemo(() => pageRegistry.getAll().filter((page) => page.category === "tool"), []);
  const speechModelSchema = useMemo(
    () => getSettingsByCategory("keyboard").find((schema) => schema.key === "speechModel"),
    []
  );
  const speechSource = settings.speechAssetSource === "china" ? "china" : "official";

  const handleSettingChange = async (key: string, value: string) => {
    if (key === "terminalDesktopNotifications" && value === "true") {
      void requestTerminalNotificationPermission();
    }
    void updateSetting(key, value);
  };

  const refreshSpeechAssetState = async () => {
    try {
      setSpeechAssetState(await speechAssetStates(speechSource));
    } catch {
      setSpeechAssetState({});
    }
  };

  const handleDownloadSpeechModel = async (model: string) => {
    if (speechAssetBusy[model]) return;
    setSpeechAssetBusy((state) => ({ ...state, [model]: true }));
    const toastID = `speech-assets-download-${model}`;
    toast.loading(t("settings.speechAssets.downloading"), { id: toastID });
    try {
      await preloadSpeechModel(model, speechSource, (status, progress) => {
        if (status === "loading") {
          toast.loading(progress || t("settings.speechAssets.downloading"), { id: toastID });
        }
      });
      toast.success(t("settings.speechAssets.downloaded"), { id: toastID });
      await refreshSpeechAssetState();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("settings.speechAssets.downloadFailed"), {
        id: toastID,
      });
    } finally {
      setSpeechAssetBusy((state) => ({ ...state, [model]: false }));
    }
  };

  const handleDeleteSpeechModel = async (model: string) => {
    if (speechAssetBusy[model]) return;
    setSpeechAssetBusy((state) => ({ ...state, [model]: true }));
    try {
      await deleteSpeechModelAssets(model, speechSource);
      toast.success(t("settings.speechAssets.deleted"));
      await refreshSpeechAssetState();
    } catch {
      toast.error(t("settings.speechAssets.deleteFailed"));
    } finally {
      setSpeechAssetBusy((state) => ({ ...state, [model]: false }));
    }
  };

  const handleTestNotification = () => {
    toast.info(t("settings.notificationTest.toastTitle"), {
      description: t("settings.notificationTest.toastDescription"),
    });
  };

  const getPageName = (page: PageDefinition) => {
    if (page.nameKey) {
      const translated = t(page.nameKey);
      if (translated !== page.nameKey) return translated;
    }
    return page.name;
  };

  const getPageDescription = (page: PageDefinition) => {
    if (!page.descriptionKey) return "";
    const translated = t(page.descriptionKey);
    return translated === page.descriptionKey ? "" : translated;
  };

  useEffect(() => {
    void initSettings();
  }, [initSettings]);

  useEffect(() => {
    if (!loading) void refreshSpeechAssetState();
  }, [loading, speechSource]);

  const topBarCenterContent = useMemo(
    () => (
      <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar touch-pan-x h-full">
        {SETTING_CATEGORIES.map((cat) => (
          <div
            key={cat.key}
            onClick={() => setSettingsActiveCategory(cat.key)}
            className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
              activeTab === cat.key
                ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            }`}
          >
            <span className="font-medium">{t(cat.labelKey)}</span>
          </div>
        ))}
      </div>
    ),
    [activeTab, setSettingsActiveCategory, t]
  );

  useEffect(() => {
    setTopBarConfig({
      show: true,
      leftButtons: [{ icon: <X size={18} />, onClick: () => removeGroup("settings") }],
      centerContent: topBarCenterContent,
      rightButtons: [
        {
          icon: <RefreshCw size={18} />,
          onClick: () => void initSettings(),
        },
      ],
    });
  }, [initSettings, removeGroup, setTopBarConfig, topBarCenterContent]);

  useEffect(() => {
    return () => setTopBarConfig({ show: false });
  }, [setTopBarConfig]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-ide-mute">{t("common.loading")}</div>
      </div>
    );
  }

  const categorySettings = getSettingsByCategory(activeTab).filter(
    (schema) =>
      schema.key !== "speechAssets" &&
      schema.key !== "fontFallbackFamily" &&
      schema.key !== "terminalFontFallbackFamily"
  );
  const renderSpeechModelCard = () => {
    if (!speechModelSchema?.options) return null;
    const selectedModel = settings.speechModel || speechModelSchema.defaultValue;
    return (
      <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
        <div className="flex items-center gap-3 mb-3">
          <div className="text-ide-mute">
            <CloudDownload size={18} />
          </div>
          <div>
            <div className="text-sm font-medium text-ide-text">{t("settings.speechModel.label")}</div>
            <div className="text-xs text-ide-mute">{t("settings.speechModel.description")}</div>
          </div>
        </div>
        <div className="space-y-2">
          {speechModelSchema.options.map((opt) => {
            const downloaded = Boolean(speechAssetState[opt.value]);
            const busy = Boolean(speechAssetBusy[opt.value]);
            const selected = selectedModel === opt.value;
            return (
              <div
                key={opt.value}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-md border transition-all ${
                  selected ? "border-ide-accent bg-ide-accent/10" : "border-ide-border bg-ide-panel/60"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handleSettingChange("speechModel", opt.value)}
                  className="min-w-0 flex-1 text-left text-xs text-ide-text"
                >
                  <span className="block truncate">{opt.label}</span>
                  {opt.description && (
                    <span className="block text-[11px] leading-4 text-ide-mute">{opt.description}</span>
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    downloaded ? void handleDeleteSpeechModel(opt.value) : void handleDownloadSpeechModel(opt.value)
                  }
                  className={`h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md border transition-all ${
                    downloaded
                      ? "text-red-500 border-ide-border hover:border-red-500 bg-ide-bg"
                      : "text-ide-text border-ide-border hover:border-ide-accent bg-ide-bg"
                  } disabled:opacity-60`}
                  title={downloaded ? t("settings.speechAssets.deleteButton") : t("settings.speechAssets.button")}
                >
                  {downloaded ? <Trash2 size={14} /> : <Download size={14} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };
  const renderNotificationTab = () => (
    <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-ide-mute">
          <Bell size={18} />
        </div>
        <div>
          <div className="text-sm font-medium text-ide-text">{t("settings.notificationTest.label")}</div>
          <div className="text-xs text-ide-mute">{t("settings.notificationTest.description")}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={handleTestNotification}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs border rounded-md transition-all bg-ide-panel text-ide-text border-ide-border hover:border-ide-accent"
      >
        <Bell size={14} />
        {t("settings.notificationTest.button")}
      </button>
    </div>
  );

  const renderPageTab = () => (
    <div className="p-4 bg-ide-bg rounded-lg border border-ide-border">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-ide-mute">
          <Settings size={18} />
        </div>
        <div>
          <div className="text-sm font-medium text-ide-text">{t("settings.pageVisibility.label")}</div>
          <div className="text-xs text-ide-mute">{t("settings.pageVisibility.description")}</div>
        </div>
      </div>
      <div className="space-y-2">
        {toolPages.map((page) => {
          const enabled = isPageVisibleInNewPage(page, settings);
          const IconComponent = page.icon;
          const description = getPageDescription(page);
          return (
            <div
              key={page.id}
              className="flex items-center justify-between gap-4 p-3 bg-ide-panel/60 rounded-md border border-ide-border"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className={`shrink-0 transition-colors ${enabled ? "text-ide-accent" : "text-ide-mute"}`}>
                  <IconComponent size={18} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-ide-text">
                    <span>{getPageName(page)}</span>
                    {page.tags?.map((tag) => (
                      <span
                        key={tag.labelKey}
                        className="px-1.5 py-0.5 text-[10px] leading-none border border-ide-border text-ide-mute bg-ide-bg rounded"
                      >
                        {t(tag.labelKey)}
                      </span>
                    ))}
                  </div>
                  {description && <div className="text-xs leading-5 text-ide-mute">{description}</div>}
                </div>
              </div>
              <button
                type="button"
                aria-pressed={enabled}
                onClick={() =>
                  void handleSettingChange(getNewPageVisibilitySettingKey(page), enabled ? "false" : "true")
                }
                className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors duration-200 focus:outline-none focus:border-ide-accent ${enabled ? "border-ide-accent bg-ide-accent/12" : "border-ide-border bg-ide-bg hover:border-ide-mute/40"}`}
              >
                <span
                  className={`absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border shadow-sm transition-all duration-200 ${enabled ? "translate-x-5 border-ide-accent bg-ide-accent" : "translate-x-0 border-ide-border bg-white"}`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-ide-bg">
      <div className="max-w-2xl mx-auto p-4">
        <div className="space-y-2">
          {activeTab === "notification"
            ? renderNotificationTab()
            : activeTab === "page"
              ? renderPageTab()
              : categorySettings.map((schema) =>
                  schema.key === "speechModel" ? (
                    <React.Fragment key={schema.key}>{renderSpeechModelCard()}</React.Fragment>
                  ) : (
                    <SettingItem
                      key={schema.key}
                      schema={schema}
                      value={settings[schema.key] || schema.defaultValue}
                      settings={settings}
                      schemas={SETTINGS_SCHEMA}
                      onChange={(v) => void handleSettingChange(schema.key, v)}
                      onSettingChange={(key, v) => void handleSettingChange(key, v)}
                      t={t}
                    />
                  )
                )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
