const TERMINAL_FONT_FAMILIES: Record<string, string> = {
  default:
    "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Cascadia Code', Consolas, 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', 'Courier New', 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', 'Microsoft YaHei', monospace",
  "jetbrains-mono": '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "system-mono": "var(--font-mono)",
};

export function getTerminalFontFamily(value?: string): string {
  return TERMINAL_FONT_FAMILIES[value || "default"] || TERMINAL_FONT_FAMILIES.default;
}
