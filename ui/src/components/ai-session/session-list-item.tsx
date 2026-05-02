import { Check } from "lucide-react";
import { formatCount, formatRelativeTime, providerLabels, renderHighlightedText } from "@/components/ai-session/utils";
import { cn } from "@/lib/utils";
import type { AIProviderId, AISessionMeta } from "@/types/ai-session";

interface SessionListItemProps {
  active: boolean;
  canDelete: boolean;
  isChecked: boolean;
  locale: "en" | "zh";
  query: string;
  selectionMode: boolean;
  session: AISessionMeta;
  t: (key: string) => string;
  onSelect: (session: AISessionMeta) => void;
  onToggleChecked: (checked: boolean) => void;
}

const SessionListItem: React.FC<SessionListItemProps> = ({
  active,
  canDelete,
  isChecked,
  locale,
  query,
  selectionMode,
  session,
  t,
  onSelect,
  onToggleChecked,
}) => {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border bg-ide-panel p-3 transition-colors",
        active
          ? "border-ide-accent/50 bg-ide-accent/10"
          : "border-ide-border hover:border-ide-accent/40 hover:bg-ide-bg"
      )}
    >
      {selectionMode ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={isChecked}
          aria-label={`${t("common.select")}: ${session.title || session.sessionId}`}
          disabled={!canDelete}
          onClick={() => onToggleChecked(!isChecked)}
          className="flex size-11 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50 md:size-4 md:mt-0.5"
        >
          <span
            className={cn(
              "grid size-4 place-content-center rounded-[4px] border border-input shadow-xs",
              isChecked ? "border-primary bg-primary text-primary-foreground" : "bg-input/30"
            )}
          >
            {isChecked ? <Check className="size-3.5" /> : null}
          </span>
        </button>
      ) : null}
      <button
        type="button"
        data-ai-session-source-path={session.sourcePath}
        onClick={() => onSelect(session)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-ide-border px-1.5 py-0.5 text-[11px] text-ide-mute">
                {providerLabels[session.providerId as AIProviderId] || session.providerId}
              </span>
              {session.parseError ? (
                <span className="rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-400">
                  {t("plugin.aiSessionManager.parseError")}
                </span>
              ) : null}
            </div>
            <div className="mt-2 line-clamp-2 text-sm font-medium text-ide-text">
              {renderHighlightedText(session.title || session.sessionId, query)}
            </div>
          </div>
          <div className="text-xs text-ide-mute">
            {formatRelativeTime(session.lastActiveAt || session.createdAt, locale, t)}
          </div>
        </div>
        <div className="mt-2 line-clamp-2 text-xs leading-5 text-ide-mute">
          {renderHighlightedText(session.summary || t("plugin.aiSessionManager.noSummary"), query)}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-ide-mute">
          <div className="min-w-0 truncate">
            {renderHighlightedText(session.projectDir || t("plugin.aiSessionManager.unknownProject"), query)}
          </div>
          <div className="shrink-0">
            {formatCount(t("plugin.aiSessionManager.messageCount"), session.messageCount || 0)}
          </div>
        </div>
      </button>
    </div>
  );
};

export default SessionListItem;
