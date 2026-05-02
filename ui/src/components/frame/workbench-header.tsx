import { Box, FolderOpen, GitGraph, RefreshCw, Terminal } from "lucide-react";
import React, { useCallback } from "react";
import TabBar from "@/components/frame/tab-bar";
import { useWorkbenchActionStore, type WorkbenchAction } from "@/framework/workbench";
import { useDefaultPageCloseButton } from "@/hooks/use-default-page-close-button";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import { type TopBarButton, useFrameStore, type ViewType } from "@/stores/frame-store";

interface WorkbenchHeaderProps {
  onRefresh?: () => void;
  onBackToList?: () => void;
}

const VIEW_ICONS: Record<ViewType, React.ReactNode> = {
  files: <FolderOpen size={18} />,
  git: <GitGraph size={18} />,
  terminal: <Terminal size={18} />,
};

const CORNER_BUTTON_CLASS =
  "shrink-0 w-11 h-11 min-w-11 min-h-11 md:w-8 md:h-8 md:min-w-0 md:min-h-0 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors";

const ButtonComponent: React.FC<{ button: TopBarButton }> = ({ button }) => {
  const title = button.title || button.label;
  return (
    <button
      type="button"
      onClick={button.onClick}
      disabled={button.disabled}
      title={title}
      aria-label={title}
      className={`shrink-0 ${button.label ? "min-h-11 px-3 md:min-h-0 md:h-8" : "h-11 w-11 md:h-8 md:w-8"} flex items-center justify-center gap-1.5 rounded-md border transition-all text-xs ${
        button.active
          ? "bg-ide-accent text-ide-on-accent border-ide-border shadow-sm"
          : "bg-transparent text-ide-mute border-ide-border hover:bg-ide-panel hover:text-ide-text"
      } ${button.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {button.icon}
      {button.label && <span>{button.label}</span>}
    </button>
  );
};

const ActionButton: React.FC<{ action: WorkbenchAction }> = ({ action }) => (
  <button
    type="button"
    onClick={action.onClick}
    disabled={action.disabled}
    className={`${CORNER_BUTTON_CLASS} ${action.active ? "bg-ide-accent text-ide-bg border-ide-accent" : ""}${action.disabled ? " opacity-50 cursor-not-allowed" : ""}`}
    title={action.title}
    aria-label={action.ariaLabel || action.title}
  >
    {action.icon}
  </button>
);

const WorkbenchHeader: React.FC<WorkbenchHeaderProps> = ({ onRefresh, onBackToList }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const topBarConfig = useFrameStore((s) => s.topBarConfig);
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const currentView = useFrameStore((s) => s.getCurrentView());
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const defaultCloseButton = useDefaultPageCloseButton();
  const editorActions = useWorkbenchActionStore((s) => s.editorActions);
  const viewActions = useWorkbenchActionStore((s) => s.viewActions);
  const actions = [...editorActions, ...viewActions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const customHeader = Boolean(topBarConfig.show);
  const hasCustomCenter = customHeader && Boolean(topBarConfig.centerContent);
  const showTabs = !hasCustomCenter && (!customHeader || tabs.length > 0);
  const leftButtons = customHeader
    ? topBarConfig.leftButtons?.length
      ? topBarConfig.leftButtons
      : !showTabs && defaultCloseButton
        ? [defaultCloseButton]
        : []
    : [];
  const showBackButton = showTabs && leftButtons.length === 0 && (activeGroup?.type === "group" || tabs.length > 0);
  const showDefaultCloseButton = showTabs && leftButtons.length === 0 && !showBackButton && Boolean(defaultCloseButton);
  const rightButtons = customHeader ? (topBarConfig.rightButtons ?? []) : [];
  const showRefresh =
    !customHeader && actions.length === 0 && activeGroup?.type !== "home" && activeGroup?.type !== "settings";
  const showRight = !customHeader || actions.length > 0 || rightButtons.length > 0;

  const handleBackClick = useCallback(() => {
    setCurrentActiveTab(null);
    onBackToList?.();
  }, [setCurrentActiveTab, onBackToList]);
  const viewIcon =
    activeGroup?.type === "group" && currentView ? (
      VIEW_ICONS[currentView]
    ) : activeGroup?.type === "tool" ? (
      <Box size={18} />
    ) : (
      <FolderOpen size={18} />
    );

  return (
    <div className="h-[calc(3rem+env(safe-area-inset-top))] min-h-[calc(3rem+env(safe-area-inset-top))] bg-ide-bg border-b border-ide-border flex items-center px-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] gap-2 shrink-0 transition-colors duration-300 overflow-hidden md:h-12 md:min-h-0 md:px-2 md:pt-0">
      {(showBackButton || showDefaultCloseButton) && (
        <div className="flex items-center gap-2 shrink-0">
          {showBackButton ? (
            <button
              type="button"
              onClick={handleBackClick}
              className={`${CORNER_BUTTON_CLASS} ${activeTabId === null ? "bg-ide-accent text-ide-bg border-ide-accent" : ""}`}
              title={t("common.backToList")}
              aria-label={t("common.backToList")}
            >
              {viewIcon}
            </button>
          ) : (
            <button
              type="button"
              onClick={defaultCloseButton?.onClick}
              disabled={defaultCloseButton?.disabled}
              className={CORNER_BUTTON_CLASS}
              title={defaultCloseButton?.title || defaultCloseButton?.label}
              aria-label={defaultCloseButton?.title || defaultCloseButton?.label}
            >
              {defaultCloseButton?.icon}
            </button>
          )}
          {tabs.length > 0 && <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />}
        </div>
      )}
      {leftButtons.length > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          {leftButtons.map((button, index) => (
            <ButtonComponent key={index} button={button} />
          ))}
        </div>
      )}
      {leftButtons.length > 0 && hasCustomCenter && <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />}
      {hasCustomCenter ? (
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar touch-pan-x h-full">
            {typeof topBarConfig.centerContent === "string" ? (
              <span className="text-sm font-medium text-ide-text whitespace-nowrap">{topBarConfig.centerContent}</span>
            ) : (
              topBarConfig.centerContent
            )}
          </div>
        </div>
      ) : showTabs ? (
        <TabBar />
      ) : (
        <div className="flex-1" />
      )}
      {showRight && (
        <div className="flex items-center gap-2 shrink-0">
          {actions.map((action) => (
            <ActionButton key={action.id} action={action} />
          ))}
          {showRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className={CORNER_BUTTON_CLASS}
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
            >
              <RefreshCw size={18} />
            </button>
          )}
          {rightButtons.map((button, index) => (
            <ButtonComponent key={index} button={button} />
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkbenchHeader;
