import { Check, ChevronRight, Clock, Edit2, GripVertical, Layers, Trash2, X } from "lucide-react";
import React from "react";
import { toast } from "sonner";
import { useDialog } from "@/components/common";
import { reorderBlockTermItems } from "@/components/terminal/blockterm-session-settings";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { getIntlLocale, type Locale, useTranslation } from "@/lib/i18n";
import { useSessionStore } from "@/stores/session-store";

interface RecentSessionListProps {
  onSwitchSession: (sessionId: string) => void;
  locale: Locale;
}

const RecentSessionList: React.FC<RecentSessionListProps> = ({ onSwitchSession, locale }) => {
  const t = useTranslation(locale);
  const dialog = useDialog();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessionsLoading = useSessionStore((s) => s.sessionsLoading);
  const workspaceLoading = useSessionStore((s) => s.loading);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const clearAllSessions = useSessionStore((s) => s.clearAllSessions);
  const renameSession = useSessionStore((s) => s.renameSession);
  const reorderSessions = useSessionStore((s) => s.reorderSessions);
  const switchSession = useSessionStore((s) => s.switchSession);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");

  const handleReorder = React.useCallback(
    (fromId: string, toId: string) => {
      const next = reorderBlockTermItems(sessions, fromId, toId);
      if (next.every((session, index) => session.id === sessions[index]?.id)) return;
      void reorderSessions(next.map((session) => session.id)).catch((error) => {
        toast.error(error instanceof Error ? error.message : t("common.saveFailed"));
      });
    },
    [reorderSessions, sessions, t]
  );
  const sessionReorder = useReorderableList({
    ids: sessions.map((session) => session.id),
    axis: "y",
    onReorder: handleReorder,
    disabled: sessionsLoading || workspaceLoading || editingId !== null,
  });

  React.useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (workspaceLoading) return;
    const session = sessions.find((s) => s.id === sessionId);
    const confirmed = await dialog.confirm(
      t("session.deleteConfirm").replace("{name}", session?.name || ""),
      undefined,
      { confirmVariant: "danger", confirmText: t("common.delete") }
    );
    if (!confirmed || useSessionStore.getState().loading) return;
    await deleteSession(sessionId);
  };

  const handleClearAll = async () => {
    if (workspaceLoading) return;
    const confirmed = await dialog.confirm(t("session.clearAllConfirm"), undefined, {
      confirmVariant: "danger",
      confirmText: t("session.clearAll"),
    });
    if (!confirmed || useSessionStore.getState().loading) return;
    await clearAllSessions();
  };

  const handleRename = async (sessionId: string) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await renameSession(sessionId, editName.trim());
      setEditingId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.saveFailed"));
    }
  };

  const handleSwitch = async (sessionId: string) => {
    if (!workspaceLoading && sessionId === currentSessionId) return;
    await switchSession(sessionId);
    const state = useSessionStore.getState();
    if (state.currentSessionId === sessionId && !state.loading) {
      onSwitchSession(sessionId);
    }
  };

  const startEditing = (e: React.MouseEvent, session: { id: string; name: string }) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditName(session.name);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        const minutes = Math.floor(diff / (1000 * 60));
        if (minutes <= 0) return t("time.now");
        return t("time.minutesAgoShort").replace("{count}", String(minutes));
      }
      return t("time.hoursAgoShort").replace("{count}", String(hours));
    }
    if (days < 7) return t("time.daysAgoShort").replace("{count}", String(days));
    return date.toLocaleDateString(getIntlLocale(locale));
  };

  if (sessionsLoading && sessions.length === 0) {
    return <div className="flex items-center justify-center py-8 text-ide-mute text-sm">{t("common.loading")}</div>;
  }

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-ide-mute uppercase font-bold flex items-center gap-1">
          <Layers size={12} /> {t("session.sessions")}
        </div>
        {sessions.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            disabled={workspaceLoading}
            className="flex min-h-11 min-w-11 items-center justify-center gap-1 text-xs text-ide-mute transition-colors hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:min-w-0"
            title={t("session.clearAll")}
            aria-label={t("session.clearAll")}
          >
            <Trash2 size={12} />
            <span className="hidden sm:inline">{t("session.clearAll")}</span>
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-ide-mute">
          <Layers size={40} className="mb-4 opacity-50" />
          <p className="text-sm">{t("session.noSessions")}</p>
          <p className="mt-2 text-xs">{t("session.openFolderHint")}</p>
        </div>
      ) : (
        <div className="space-y-1">
          {sessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            const isEditing = editingId === session.id;

            return (
              <div
                key={session.id}
                {...sessionReorder.bindItem(session.id)}
                style={sessionReorder.getItemStyle(session.id)}
                data-blockterm-workspace-session-id={session.id}
                onClick={() => handleSwitch(session.id)}
                className={`group relative flex items-center gap-2 rounded-lg border p-2.5 transition-all sm:gap-3 sm:p-3 ${
                  isCurrent
                    ? "bg-ide-accent/10 border-ide-accent/30 cursor-default"
                    : "border-transparent hover:bg-ide-bg cursor-pointer hover:border-ide-border"
                } ${sessionReorder.activeId === session.id ? "z-10 cursor-grabbing opacity-95 shadow-sm" : ""} ${
                  sessionReorder.overId === session.id ? "ring-1 ring-ide-accent" : ""
                }`}
              >
                <GripVertical size={14} className="shrink-0 cursor-grab text-ide-mute" aria-hidden="true" />
                <div
                  className={`p-1.5 sm:p-2 rounded-lg flex-shrink-0 ${isCurrent ? "bg-ide-accent/20" : "bg-ide-bg group-hover:bg-ide-panel"}`}
                >
                  <Layers size={18} className={`sm:hidden ${isCurrent ? "text-ide-accent" : "text-ide-mute"}`} />
                  <Layers size={20} className={`hidden sm:block ${isCurrent ? "text-ide-accent" : "text-ide-mute"}`} />
                </div>

                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-1" data-drag-ignore onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        name={`session-name-${session.id}`}
                        aria-label={t("session.rename")}
                        className="h-11 min-h-11 flex-1 px-2 bg-ide-bg border border-ide-accent rounded text-sm text-ide-text outline-none sm:h-auto sm:min-h-0 sm:py-0.5"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(session.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void handleRename(session.id)}
                        className="flex h-11 w-11 items-center justify-center rounded text-green-500 hover:bg-ide-panel sm:h-auto sm:w-auto sm:p-1"
                        aria-label={t("dialog.confirm")}
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="flex h-11 w-11 items-center justify-center rounded text-red-500 hover:bg-ide-panel sm:h-auto sm:w-auto sm:p-1"
                        aria-label={t("common.cancel")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-medium truncate text-sm ${isCurrent ? "text-ide-accent" : "text-ide-text"}`}
                      >
                        {session.name}
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] bg-ide-accent text-ide-bg px-1.5 py-0.5 rounded font-bold">
                          {t("session.current")}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {!isEditing && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-drag-ignore
                      onClick={(e) => startEditing(e, session)}
                      className="hidden h-11 w-11 items-center justify-center rounded text-ide-mute opacity-0 transition-opacity hover:bg-ide-bg-hover hover:text-ide-accent sm:flex sm:h-auto sm:w-auto sm:p-1.5 sm:group-hover:opacity-100"
                      title={t("session.rename")}
                      aria-label={t("session.rename")}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      type="button"
                      data-drag-ignore
                      onClick={(e) => handleDelete(e, session.id)}
                      disabled={workspaceLoading}
                      className="flex h-11 w-11 items-center justify-center rounded text-ide-mute hover:bg-ide-bg-hover hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 sm:h-auto sm:w-auto sm:p-1.5"
                      title={t("session.delete")}
                      aria-label={t("session.delete")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-1.5 sm:gap-2 text-xs text-ide-mute flex-shrink-0">
                  <Clock size={12} className="hidden sm:block" />
                  <span>{formatTime(session.updated_at)}</span>
                  {!isCurrent && <ChevronRight size={14} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RecentSessionList;
