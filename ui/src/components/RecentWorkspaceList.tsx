import React, { useEffect } from "react";
import { Folder, Clock, Pin, Trash2, ChevronRight } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { WorkspaceInfo } from "@/api/workspace";
import { useTranslation, type Locale } from "@/lib/i18n";

interface RecentWorkspaceListProps {
  onSelect: (workspace: WorkspaceInfo) => void;
  locale: Locale;
}

const RecentWorkspaceList: React.FC<RecentWorkspaceListProps> = ({
  onSelect,
  locale,
}) => {
  const t = useTranslation(locale);
  const { recentWorkspaces, loading, fetchRecent, togglePin, deleteWorkspace } =
    useWorkspaceStore();

  useEffect(() => {
    fetchRecent(10);
  }, [fetchRecent]);

  if (loading && recentWorkspaces.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-ide-mute text-sm">
        {t("common.loading")}
      </div>
    );
  }

  if (recentWorkspaces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 sm:py-12 text-ide-mute">
        <Folder size={40} className="mb-4 opacity-50 sm:hidden" />
        <Folder size={48} className="mb-4 opacity-50 hidden sm:block" />
        <p className="text-sm">{t("home.noRecentWorkspaces")}</p>
      </div>
    );
  }

  const pinnedWorkspaces = recentWorkspaces.filter((w) => w.is_pinned);
  const unpinnedWorkspaces = recentWorkspaces.filter((w) => !w.is_pinned);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        const minutes = Math.floor(diff / (1000 * 60));
        return `${minutes}m`;
      }
      return `${hours}h`;
    }
    if (days === 1) return "1d";
    if (days < 7) return `${days}d`;
    return date.toLocaleDateString();
  };

  const handlePin = (e: React.MouseEvent, workspace: WorkspaceInfo) => {
    e.stopPropagation();
    togglePin(workspace.id, !workspace.is_pinned);
  };

  const handleDelete = (e: React.MouseEvent, workspace: WorkspaceInfo) => {
    e.stopPropagation();
    if (confirm(t("home.removeConfirm").replace("{name}", workspace.name))) {
      deleteWorkspace(workspace.id);
    }
  };

  const renderWorkspaceItem = (workspace: WorkspaceInfo) => (
    <div
      key={workspace.id}
      onClick={() => onSelect(workspace)}
      className="group flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg hover:bg-ide-bg cursor-pointer border border-transparent hover:border-ide-border transition-all"
    >
      <div className="p-1.5 sm:p-2 bg-ide-bg rounded-lg group-hover:bg-ide-panel flex-shrink-0">
        <Folder size={18} className="text-ide-accent sm:hidden" />
        <Folder size={20} className="text-ide-accent hidden sm:block" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-ide-text truncate text-sm">
            {workspace.name}
          </span>
          {workspace.is_pinned && (
            <Pin size={10} className="text-ide-accent flex-shrink-0 sm:hidden" />
          )}
          {workspace.is_pinned && (
            <Pin size={12} className="text-ide-accent flex-shrink-0 hidden sm:block" />
          )}
        </div>
        <div className="text-xs text-ide-mute truncate hidden sm:block">
          {workspace.path}
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => handlePin(e, workspace)}
          className="p-1.5 rounded hover:bg-ide-bg-hover text-ide-mute hover:text-ide-accent"
          title={workspace.is_pinned ? t("common.unpin") : t("common.pin")}
        >
          <Pin size={14} className={workspace.is_pinned ? "fill-current" : ""} />
        </button>
        <button
          onClick={(e) => handleDelete(e, workspace)}
          className="p-1.5 rounded hover:bg-ide-bg-hover text-ide-mute hover:text-red-500"
          title={t("common.remove")}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 text-xs text-ide-mute flex-shrink-0">
        <Clock size={12} className="hidden sm:block" />
        <span>{formatTime(workspace.last_open_at)}</span>
        <ChevronRight size={14} />
      </div>
    </div>
  );

  return (
    <div className="space-y-3 sm:space-y-4">
      {pinnedWorkspaces.length > 0 && (
        <div>
          <div className="text-xs text-ide-mute uppercase font-bold mb-2 flex items-center gap-1">
            <Pin size={12} /> {t("home.pinned")}
          </div>
          <div className="space-y-1">
            {pinnedWorkspaces.map(renderWorkspaceItem)}
          </div>
        </div>
      )}
      {unpinnedWorkspaces.length > 0 && (
        <div>
          <div className="text-xs text-ide-mute uppercase font-bold mb-2 flex items-center gap-1">
            <Clock size={12} /> {t("home.recent")}
          </div>
          <div className="space-y-1">
            {unpinnedWorkspaces.map(renderWorkspaceItem)}
          </div>
        </div>
      )}
    </div>
  );
};

export default RecentWorkspaceList;
