export type SettingType = "select" | "toggle" | "text" | "number" | "action";

export interface SettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingSchema {
  key: string;
  type: SettingType;
  category: string;
  labelKey: string;
  descriptionKey?: string;
  defaultValue: string;
  options?: SettingOption[];
  min?: number;
  max?: number;
}

export const SETTINGS_SCHEMA: SettingSchema[] = [
  {
    key: "theme",
    type: "select",
    category: "appearance",
    labelKey: "settings.theme.label",
    descriptionKey: "settings.theme.description",
    defaultValue: "light",
    options: [
      { value: "light", label: "settings.theme.optionLight" },
      { value: "dark", label: "settings.theme.optionDark" },
      { value: "hacker", label: "settings.theme.optionHacker" },
      { value: "terminal", label: "settings.theme.optionTerminal" },
      { value: "ocean", label: "settings.theme.optionOcean" },
      { value: "sunset", label: "settings.theme.optionSunset" },
      { value: "nord", label: "settings.theme.optionNord" },
      { value: "solarized", label: "settings.theme.optionSolarized" },
    ],
  },
  {
    key: "locale",
    type: "select",
    category: "appearance",
    labelKey: "settings.locale.label",
    descriptionKey: "settings.locale.description",
    defaultValue: "zh",
    options: [
      { value: "en", label: "settings.locale.optionEnglish" },
      { value: "zh", label: "settings.locale.optionChinese" },
    ],
  },
  {
    key: "fontFamily",
    type: "select",
    category: "appearance",
    labelKey: "settings.fontFamily.label",
    descriptionKey: "settings.fontFamily.description",
    defaultValue: "default",
    options: [
      { value: "default", label: "settings.fontFamily.optionDefault" },
      { value: "jetbrains-mono", label: "JetBrains Mono" },
    ],
  },
  {
    key: "fontFallbackFamily",
    type: "select",
    category: "appearance",
    labelKey: "settings.fontFallbackFamily.label",
    descriptionKey: "settings.fontFallbackFamily.description",
    defaultValue: "default",
    options: [{ value: "default", label: "settings.fontFallbackFamily.optionDefault" }],
  },
  {
    key: "showHiddenFiles",
    type: "toggle",
    category: "fileManager",
    labelKey: "settings.showHiddenFiles.label",
    descriptionKey: "settings.showHiddenFiles.description",
    defaultValue: "false",
  },
  {
    key: "defaultViewMode",
    type: "select",
    category: "fileManager",
    labelKey: "settings.defaultViewMode.label",
    descriptionKey: "settings.defaultViewMode.description",
    defaultValue: "list",
    options: [
      { value: "list", label: "settings.defaultViewMode.optionList" },
      { value: "grid", label: "settings.defaultViewMode.optionGrid" },
    ],
  },
  {
    key: "editorFontSize",
    type: "number",
    category: "editor",
    labelKey: "settings.editorFontSize.label",
    descriptionKey: "settings.editorFontSize.description",
    defaultValue: "14",
    min: 10,
    max: 24,
  },
  {
    key: "editorTabSize",
    type: "select",
    category: "editor",
    labelKey: "settings.editorTabSize.label",
    descriptionKey: "settings.editorTabSize.description",
    defaultValue: "2",
    options: [
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "8", label: "8" },
    ],
  },
  {
    key: "editorWordWrap",
    type: "toggle",
    category: "editor",
    labelKey: "settings.editorWordWrap.label",
    descriptionKey: "settings.editorWordWrap.description",
    defaultValue: "false",
  },
  {
    key: "terminalFontFamily",
    type: "select",
    category: "terminal",
    labelKey: "settings.terminalFontFamily.label",
    descriptionKey: "settings.terminalFontFamily.description",
    defaultValue: "default",
    options: [
      { value: "default", label: "settings.terminalFontFamily.optionDefault" },
      { value: "jetbrains-mono", label: "JetBrains Mono" },
      { value: "system-mono", label: "settings.terminalFontFamily.optionSystemMono" },
    ],
  },
  {
    key: "terminalFontFallbackFamily",
    type: "select",
    category: "terminal",
    labelKey: "settings.terminalFontFallbackFamily.label",
    descriptionKey: "settings.terminalFontFallbackFamily.description",
    defaultValue: "default",
    options: [{ value: "default", label: "settings.terminalFontFallbackFamily.optionDefault" }],
  },
  {
    key: "terminalDesktopNotifications",
    type: "toggle",
    category: "terminal",
    labelKey: "settings.terminalDesktopNotifications.label",
    descriptionKey: "settings.terminalDesktopNotifications.description",
    defaultValue: "true",
  },
  {
    key: "gitUserName",
    type: "text",
    category: "git",
    labelKey: "settings.gitUserName.label",
    descriptionKey: "settings.gitUserName.description",
    defaultValue: "VibeGo User",
  },
  {
    key: "gitUserEmail",
    type: "text",
    category: "git",
    labelKey: "settings.gitUserEmail.label",
    descriptionKey: "settings.gitUserEmail.description",
    defaultValue: "user@vibego.local",
  },
  {
    key: "gitDefaultCommitMessage",
    type: "text",
    category: "git",
    labelKey: "settings.gitDefaultCommitMessage.label",
    descriptionKey: "settings.gitDefaultCommitMessage.description",
    defaultValue: "",
  },
  {
    key: "useNativeKeyboard",
    type: "toggle",
    category: "keyboard",
    labelKey: "settings.useNativeKeyboard.label",
    descriptionKey: "settings.useNativeKeyboard.description",
    defaultValue: "false",
  },
  {
    key: "keyboardHaptic",
    type: "toggle",
    category: "keyboard",
    labelKey: "settings.keyboardHaptic.label",
    descriptionKey: "settings.keyboardHaptic.description",
    defaultValue: "true",
  },
  {
    key: "keyboardSound",
    type: "toggle",
    category: "keyboard",
    labelKey: "settings.keyboardSound.label",
    descriptionKey: "settings.keyboardSound.description",
    defaultValue: "true",
  },
  {
    key: "speechAssetSource",
    type: "select",
    category: "keyboard",
    labelKey: "settings.speechAssetSource.label",
    descriptionKey: "settings.speechAssetSource.description",
    defaultValue: "official",
    options: [
      { value: "official", label: "settings.speechAssetSource.optionOfficial" },
      { value: "china", label: "settings.speechAssetSource.optionChina" },
    ],
  },
  {
    key: "speechModel",
    type: "select",
    category: "keyboard",
    labelKey: "settings.speechModel.label",
    descriptionKey: "settings.speechModel.description",
    defaultValue: "sense-voice",
    options: [
      { value: "sense-voice", label: "sense-voice-zh-en-ja-ko-yue-2024-07-17", description: "230 MB" },
      { value: "paraformer-zh-en", label: "paraformer-zh-2023-09-14", description: "233 MB" },
      { value: "paraformer-zh-en-small", label: "paraformer-zh-small-2024-03-09", description: "79 MB" },
    ],
  },
  {
    key: "speechAssets",
    type: "action",
    category: "keyboard",
    labelKey: "settings.speechAssets.label",
    descriptionKey: "settings.speechAssets.description",
    defaultValue: "",
  },
];

export const SETTING_CATEGORIES = [
  { key: "appearance", labelKey: "settings.category.appearance" },
  { key: "fileManager", labelKey: "settings.category.fileManager" },
  { key: "editor", labelKey: "settings.category.editor" },
  { key: "terminal", labelKey: "settings.category.terminal" },
  { key: "notification", labelKey: "settings.category.notification" },
  { key: "page", labelKey: "settings.category.page" },
  { key: "keyboard", labelKey: "settings.category.keyboard" },
  { key: "git", labelKey: "settings.category.git" },
];

export function getSettingsByCategory(category: string): SettingSchema[] {
  return SETTINGS_SCHEMA.filter((s) => s.category === category);
}

export function getSettingSchema(key: string): SettingSchema | undefined {
  return SETTINGS_SCHEMA.find((s) => s.key === key);
}

export function getDefaultSettings(): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const schema of SETTINGS_SCHEMA) {
    defaults[schema.key] = schema.defaultValue;
  }
  return defaults;
}
