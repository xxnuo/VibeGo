import { Check, ChevronRight, Clock, Edit2, Layers, Trash2, X } from "lucide-react";
import React from "react";
import { useDialog } from "@/components/common";
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
  const switchSession = useSessionStore((s) => s.switchSession);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");

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
    await renameSession(sessionId, editName.trim());
    setEditingId(null);
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
            onClick={handleClearAll}
            disabled={workspaceLoading}
            className="text-xs text-ide-mute hover:text-red-500 flex items-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={t("session.clearAll")}
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
                onClick={() => handleSwitch(session.id)}
                className={`group flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg border transition-all ${
                  isCurrent
                    ? "bg-ide-accent/10 border-ide-accent/30 cursor-default"
                    : "border-transparent hover:bg-ide-bg cursor-pointer hover:border-ide-border"
                }`}
              >
                <div
                  className={`p-1.5 sm:p-2 rounded-lg flex-shrink-0 ${isCurrent ? "bg-ide-accent/20" : "bg-ide-bg group-hover:bg-ide-panel"}`}
                >
                  <Layers size={18} className={`sm:hidden ${isCurrent ? "text-ide-accent" : "text-ide-mute"}`} />
                  <Layers size={20} className={`hidden sm:block ${isCurrent ? "text-ide-accent" : "text-ide-mute"}`} />
                </div>

                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 px-2 py-0.5 bg-ide-bg border border-ide-accent rounded text-sm text-ide-text outline-none"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(session.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <button
                        onClick={() => handleRename(session.id)}
                        className="p-1 text-green-500 hover:bg-ide-panel rounded"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="p-1 text-red-500 hover:bg-ide-panel rounded"
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
                      onClick={(e) => startEditing(e, session)}
                      className="p-1.5 rounded hover:bg-ide-bg-hover text-ide-mute hover:text-ide-accent opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block"
                      title={t("session.rename")}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, session.id)}
                      disabled={workspaceLoading}
                      className="p-1.5 rounded hover:bg-ide-bg-hover text-ide-mute hover:text-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={t("session.delete")}
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
