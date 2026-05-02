import { Activity, Loader2 } from "lucide-react";
import { useState } from "react";
import { useStatusBarStore } from "@/framework/host/status-bar-service";
import { useAppStore } from "@/stores/app-store";
import { useFrameStore } from "@/stores/frame-store";
export default function StatusBar() {
  const entries = useStatusBarStore((state) => state.items);
  const groupId = useFrameStore((state) => state.activeGroupId);
  const [expanded, setExpanded] = useState(false);
  const locale = useAppStore((state) => state.locale);
  const items = entries
    .filter((item) => item.visible && (!item.groupId || item.groupId === groupId))
    .sort((a, b) => b.priority - a.priority);
  if (!items.length) return null;
  const running = items.some((item) => item.id.startsWith("tasks:"));
  const Indicator = running ? Loader2 : Activity;
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={locale === "en" ? "Status" : "状态"}
        aria-expanded={expanded}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setExpanded(!expanded)}
        className="absolute bottom-14 right-2 z-20 flex min-h-11 min-w-11 items-center justify-center rounded border border-ide-border bg-ide-panel md:hidden"
      >
        <Indicator size={16} className={running ? "animate-spin" : undefined} />
      </button>
      <div
        role="status"
        className={`${expanded ? "flex" : "hidden"} absolute bottom-28 right-2 z-20 max-w-[80vw] flex-col border border-ide-border bg-ide-panel text-[11px] text-ide-mute md:static md:flex md:h-6 md:max-w-none md:flex-row md:items-center md:border-x-0 md:border-b-0`}
      >
        {(["left", "right"] as const).map((alignment) => (
          <div key={alignment} className={`flex items-center gap-2 px-2 ${alignment === "right" ? "md:ml-auto" : ""}`}>
            {items
              .filter((item) => item.alignment === alignment)
              .map((item) => {
                const Icon = item.icon || (item.id.startsWith("tasks:") ? Loader2 : undefined);
                return (
                  <button
                    type="button"
                    key={item.id}
                    title={item.tooltip}
                    onClick={item.onClick}
                    style={{ color: item.color }}
                    className="flex min-h-11 items-center gap-1 truncate md:min-h-0"
                    disabled={!item.onClick}
                  >
                    {Icon && <Icon size={12} className={item.id.startsWith("tasks:") ? "animate-spin" : ""} />}
                    {item.text}
                  </button>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
