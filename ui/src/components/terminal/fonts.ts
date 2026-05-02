import { getDefaultMonoFontFamily, resolveFontFamily } from "@/lib/fonts";

const TERMINAL_FONT_FAMILIES: Record<string, string> = {
  default: getDefaultMonoFontFamily(),
  "jetbrains-mono": '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "system-mono": "var(--font-mono)",
};

export function getResolvedTerminalFontFamily(value?: string, fallbackValue?: string): string {
  const primary =
    TERMINAL_FONT_FAMILIES[value || "default"] || resolveFontFamily(value, TERMINAL_FONT_FAMILIES.default);
  if (!fallbackValue || fallbackValue === "default") return primary;
  return resolveFontFamily(value, TERMINAL_FONT_FAMILIES.default, fallbackValue);
}
