export interface FontOption {
  value: string;
  label: string;
  family: string;
  source: "recommended" | "installed" | "candidate";
}

interface LocalFontData {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

const DEFAULT_MONO_FAMILY =
  "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Cascadia Code', Consolas, 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', 'Courier New', 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', 'Microsoft YaHei', monospace";

const JETBRAINS_MONO_FAMILY =
  "'JetBrains Mono Variable', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', Consolas, 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', 'Microsoft YaHei', monospace";

const TERMINAL_SYSTEM_FAMILY = "var(--font-mono)";

const FONT_CANDIDATES = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Lucida Console",
  "Roboto Mono",
  "Droid Sans Mono",
  "Noto Sans Mono",
  "Noto Sans Mono CJK SC",
  "Noto Sans CJK SC",
  "Source Code Pro",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  "Fira Code",
  "Iosevka",
  "Hack",
  "JetBrains Mono",
  "Courier New",
];

const MONO_HINTS = [
  "mono",
  "code",
  "console",
  "courier",
  "iosevka",
  "hack",
  "source code",
  "cascadia",
  "consolas",
  "menlo",
  "monaco",
];

export function getDefaultMonoFontFamily() {
  return DEFAULT_MONO_FAMILY;
}

export function getJetBrainsMonoFontFamily() {
  return JETBRAINS_MONO_FAMILY;
}

export function getTerminalSystemFontFamily() {
  return TERMINAL_SYSTEM_FAMILY;
}

export function quoteFontFamily(family: string) {
  return family.includes(" ") ? `'${family.replaceAll("'", "\\'")}'` : family;
}

export function customFontValue(family: string) {
  return `custom:${family}`;
}

export function isCustomFontValue(value?: string) {
  return Boolean(value?.startsWith("custom:"));
}

export function customFontFamily(value: string) {
  return value.replace(/^custom:/, "");
}

export function resolveSingleFontFamily(value?: string) {
  if (!value || value === "default") return DEFAULT_MONO_FAMILY;
  if (value === "jetbrains-mono") return JETBRAINS_MONO_FAMILY;
  if (value === "system-mono") return TERMINAL_SYSTEM_FAMILY;
  if (isCustomFontValue(value)) return quoteFontFamily(customFontFamily(value));
  return value;
}

export function resolveFontFamily(value?: string, fallback = DEFAULT_MONO_FAMILY, fallbackValue?: string) {
  const hasFallback = fallbackValue && fallbackValue !== "default";
  const primary = hasFallback ? resolvePrimaryFontFamily(value) : resolveSingleFontFamily(value);
  const extraFallback = hasFallback ? resolvePrimaryFontFamily(fallbackValue) : "";
  const stack = [primary, extraFallback, fallback].filter(Boolean);
  return stack.filter((font, index) => stack.indexOf(font) === index).join(", ");
}

function resolvePrimaryFontFamily(value?: string) {
  if (!value || value === "default") return DEFAULT_MONO_FAMILY;
  if (value === "jetbrains-mono") return "'JetBrains Mono Variable'";
  if (value === "system-mono") return TERMINAL_SYSTEM_FAMILY;
  if (isCustomFontValue(value)) return quoteFontFamily(customFontFamily(value));
  return value;
}

export function recommendedFontOptions(includeTerminalSystem = false): FontOption[] {
  const options: FontOption[] = [
    { value: "default", label: "默认", family: DEFAULT_MONO_FAMILY, source: "recommended" },
    { value: "jetbrains-mono", label: "JetBrains Mono", family: JETBRAINS_MONO_FAMILY, source: "recommended" },
  ];
  if (includeTerminalSystem) {
    options.push({ value: "system-mono", label: "跟随界面", family: TERMINAL_SYSTEM_FAMILY, source: "recommended" });
  }
  return options;
}

export function supportsLocalFontScan() {
  return typeof window !== "undefined" && typeof window.queryLocalFonts === "function";
}

export async function scanLocalFontFamilies() {
  if (!window.queryLocalFonts) return [];
  const fonts = await window.queryLocalFonts();
  return uniqueFontFamilies(fonts.map((font) => font.family));
}

export async function detectCandidateFontFamilies() {
  if (typeof document === "undefined") return [];
  await document.fonts?.ready;
  return uniqueFontFamilies(FONT_CANDIDATES.filter((font) => isFontAvailable(font)));
}

export function toFontOptions(families: string[], source: FontOption["source"]) {
  return uniqueFontFamilies(families)
    .filter((family) => family.trim())
    .sort((a, b) => {
      const aMono = isLikelyMonoFont(a) ? 0 : 1;
      const bMono = isLikelyMonoFont(b) ? 0 : 1;
      if (aMono !== bMono) return aMono - bMono;
      return a.localeCompare(b);
    })
    .map((family) => ({
      value: customFontValue(family),
      label: family,
      family: `${quoteFontFamily(family)}, ${DEFAULT_MONO_FAMILY}`,
      source,
    }));
}

function uniqueFontFamilies(families: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const family of families) {
    const normalized = family.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isLikelyMonoFont(family: string) {
  const name = family.toLowerCase();
  return MONO_HINTS.some((hint) => name.includes(hint));
}

function isFontAvailable(family: string) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;

  const sample = "mmmmmmmmmmiiiiiiiiiiWWWWWWWWWW中文字体0123456789";
  const font = quoteFontFamily(family);
  const fallbacks = ["monospace", "sans-serif", "serif"];

  return fallbacks.some((fallback) => {
    context.font = `72px ${fallback}`;
    const fallbackWidth = context.measureText(sample).width;
    context.font = `72px ${font}, ${fallback}`;
    return context.measureText(sample).width !== fallbackWidth;
  });
}
