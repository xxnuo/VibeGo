import type { ReactNode } from "react";
export function PluginEmptyState({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-4 text-xs text-ide-mute">{children}</div>;
}
