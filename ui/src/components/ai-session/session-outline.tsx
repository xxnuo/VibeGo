import { ListTree } from "lucide-react";
import type { SessionOutlineItem } from "@/components/ai-session/utils";
import { roleLabel, roleLabelTone } from "@/components/ai-session/utils";
import { cn } from "@/lib/utils";

interface SessionOutlineProps {
  compact: boolean;
  items: SessionOutlineItem[];
  t: (key: string) => string;
  onSelect: (index: number) => void;
}

const SessionOutline: React.FC<SessionOutlineProps> = ({ compact, items, t, onSelect }) => {
  return (
    <div
      className={cn("space-y-2 bg-ide-bg", compact ? "p-4" : "min-h-0 overflow-y-auto border-l border-ide-border p-4")}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-ide-text">
        <ListTree size={16} />
        <span>{t("plugin.aiSessionManager.outline")}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="rounded-md border border-ide-border bg-ide-panel px-3 py-4 text-xs text-ide-mute">
            {t("plugin.aiSessionManager.noOutline")}
          </div>
        ) : (
          items.map((item, index) => (
            <button
              key={`${item.index}-${index}`}
              type="button"
              onClick={() => onSelect(item.index)}
              className={cn(
                "min-h-11 w-full rounded-md border border-ide-border bg-ide-panel py-2 pr-3 text-left text-xs text-ide-mute transition-colors hover:border-ide-accent/40 hover:bg-ide-bg hover:text-ide-text md:min-h-0",
                item.level <= 0 ? "pl-3" : item.level === 1 ? "pl-5" : "pl-7"
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded border px-1 py-0 text-[10px] leading-4",
                    roleLabelTone(item.role)
                  )}
                >
                  {roleLabel(item.role, t)}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1">{item.content}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

export default SessionOutline;
