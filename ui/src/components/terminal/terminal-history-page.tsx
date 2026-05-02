import { ArrowLeft, CheckSquare, RefreshCw, Square, Terminal, Trash2, X } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import type { TerminalInfo } from "@/api/terminal";
import TerminalInstance from "@/components/terminal/terminal-instance";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useTerminalDeleteBatch, useTerminalList } from "@/hooks/use-terminal";
import { getIntlLocale, useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";

interface TerminalHistoryPageProps {
  onBack: () => void;
}

const TerminalHistoryPage: React.FC<TerminalHistoryPageProps> = ({ onBack }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const { data, isLoading, refetch } = useTerminalList();
  const deleteBatchMutation = useTerminalDeleteBatch();

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [viewingTerminal, setViewingTerminal] = useState<TerminalInfo | null>(null);

  const terminals = data?.terminals || [];
  const closedTerminals = terminals.filter((t) => t.status !== "running");

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(closedTerminals.map((t) => t.id)));
  }, [closedTerminals]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleItemClick = useCallback(
    (terminal: TerminalInfo) => {
      if (selectionMode) {
        toggleSelect(terminal.id);
      } else {
        setViewingTerminal(terminal);
      }
    },
    [selectionMode, toggleSelect]
  );

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size > 0) {
      setShowDeleteConfirm(true);
    }
  }, [selectedIds.size]);

  const confirmDelete = useCallback(() => {
    deleteBatchMutation.mutate(Array.from(selectedIds), {
      onSuccess: () => {
        setSelectedIds(new Set());
        setShowDeleteConfirm(false);
        setSelectionMode(false);
        refetch();
      },
    });
  }, [deleteBatchMutation, selectedIds, refetch]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString(getIntlLocale(locale));
  };

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const viewingTopBarConfig = useMemo(() => {
    if (!viewingTerminal) return null;
    return {
      show: true,
      leftButtons: [
        {
          icon: <ArrowLeft size={18} />,
          title: t("common.backToList"),
          onClick: () => setViewingTerminal(null),
        },
      ],
      centerContent: (
        <div className="flex min-w-0 items-center gap-2 h-full">
          <Terminal size={14} className="text-ide-mute" />
          <span className="font-medium text-ide-text truncate text-sm">{viewingTerminal.name}</span>
          <span className="shrink-0 text-xs text-ide-mute">({t("terminal.readOnly")})</span>
        </div>
      ),
      rightButtons: [],
    };
  }, [viewingTerminal, t]);

  const listTopBarConfig = useMemo(() => {
    if (viewingTerminal) return null;

    if (selectionMode) {
      return {
        show: true,
        leftButtons: [
          {
            icon: <X size={18} />,
            title: t("common.cancel"),
            onClick: exitSelectionMode,
          },
        ],
        centerContent: (
          <div className="flex items-center h-full">
            <span className="text-sm text-ide-mute">
              {selectedIds.size} {t("terminal.selected")}
            </span>
          </div>
        ),
        rightButtons: [
          ...(selectedIds.size > 0
            ? [
                {
                  icon: <Trash2 size={18} className="text-red-500" />,
                  title: t("common.delete"),
                  onClick: handleDeleteSelected,
                },
              ]
            : []),
          {
            icon: <CheckSquare size={18} />,
            title: t("git.selectAll"),
            onClick: selectAll,
          },
          {
            icon: <Square size={18} />,
            title: t("git.clearSelection"),
            onClick: clearSelection,
          },
        ],
      };
    }

    return {
      show: true,
      leftButtons: [
        {
          icon: <ArrowLeft size={18} />,
          title: t("terminal.backToTerminal"),
          onClick: onBack,
        },
      ],
      centerContent: (
        <div className="flex items-center h-full">
          <span className="font-medium text-ide-text text-sm">{t("terminal.historyTitle")}</span>
        </div>
      ),
      rightButtons: [
        ...(closedTerminals.length > 0
          ? [
              {
                icon: <CheckSquare size={18} />,
                title: t("common.select"),
                onClick: () => setSelectionMode(true),
              },
            ]
          : []),
        {
          icon: <RefreshCw size={18} />,
          title: t("common.refresh"),
          onClick: handleRefresh,
        },
      ],
    };
  }, [
    viewingTerminal,
    selectionMode,
    selectedIds.size,
    closedTerminals.length,
    t,
    onBack,
    exitSelectionMode,
    selectAll,
    clearSelection,
    handleDeleteSelected,
    handleRefresh,
  ]);

  const topBarConfig = viewingTerminal ? viewingTopBarConfig : listTopBarConfig;
  usePageTopBar(topBarConfig, [topBarConfig]);

  if (viewingTerminal) {
    return (
      <div className="flex flex-col h-full bg-ide-bg">
        <div className="flex-1 relative overflow-hidden">
          <TerminalInstance
            terminalId={viewingTerminal.id}
            terminalName={viewingTerminal.name}
            isActive={true}
            isExited={true}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-ide-panel">
      <div className="flex-1 overscroll-contain overflow-auto px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-ide-mute">
            <span className="text-sm">{t("common.loading")}</span>
          </div>
        ) : closedTerminals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-ide-mute">
            <Terminal size={40} className="mb-4 opacity-50" />
            <p className="text-sm">{t("terminal.noHistory")}</p>
          </div>
        ) : (
          <div className="space-y-1">
            {closedTerminals.map((terminal) => {
              const isSelected = selectedIds.has(terminal.id);
              return (
                <div
                  key={terminal.id}
                  className={`group flex min-h-11 items-center overflow-hidden rounded-lg border transition-all ${
                    isSelected
                      ? "bg-ide-accent/10 border-ide-accent/30"
                      : "border-transparent hover:bg-ide-bg hover:border-ide-border"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleItemClick(terminal)}
                    aria-pressed={selectionMode ? isSelected : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 self-stretch p-2.5 text-left"
                  >
                    {selectionMode && (
                      <div className="p-1.5 rounded-lg flex-shrink-0 bg-ide-bg group-hover:bg-ide-panel">
                        {isSelected ? (
                          <CheckSquare size={18} className="text-ide-accent" />
                        ) : (
                          <Square size={18} className="text-ide-mute" />
                        )}
                      </div>
                    )}

                    <div className="p-1.5 rounded-lg flex-shrink-0 bg-ide-bg group-hover:bg-ide-panel">
                      <Terminal size={18} className="text-ide-mute" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate text-sm text-ide-text">{terminal.name}</span>
                      </div>
                      <div className="text-xs text-ide-mute mt-0.5 break-all">
                        {formatDate(terminal.created_at)} - {terminal.cwd}
                      </div>
                    </div>
                  </button>

                  {!selectionMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIds(new Set([terminal.id]));
                        setShowDeleteConfirm(true);
                      }}
                      title={t("common.delete")}
                      aria-label={`${t("common.delete")} ${terminal.name}`}
                      className="mr-1 flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute opacity-100 transition-opacity hover:bg-ide-bg hover:text-red-500 md:size-8 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("terminal.deleteHistoryTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("terminal.deleteHistoryConfirm").replace("{count}", String(selectedIds.size))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="w-full md:w-auto">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="w-full md:w-auto"
              onClick={confirmDelete}
              variant="destructive"
              disabled={deleteBatchMutation.isPending}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TerminalHistoryPage;
