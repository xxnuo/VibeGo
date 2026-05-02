import React from "react";
import { useDefaultPageCloseButton } from "@/hooks/use-default-page-close-button";
import { type TopBarButton, useFrameStore } from "@/stores/frame-store";

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

const TopBar: React.FC = () => {
  const topBarConfig = useFrameStore((s) => s.topBarConfig);
  const defaultCloseButton = useDefaultPageCloseButton();

  if (!topBarConfig.show) {
    return null;
  }

  const leftButtons = topBarConfig.leftButtons?.length
    ? topBarConfig.leftButtons
    : defaultCloseButton
      ? [defaultCloseButton]
      : [];
  const hasLeftButtons = leftButtons.length > 0;
  const hasRightButtons = topBarConfig.rightButtons && topBarConfig.rightButtons.length > 0;
  const hasCenter = topBarConfig.centerContent;

  return (
    <div className="h-[calc(3rem+env(safe-area-inset-top))] min-h-[calc(3rem+env(safe-area-inset-top))] bg-ide-bg border-b border-ide-border flex items-center px-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] gap-2 shrink-0 transition-colors duration-300 overflow-hidden md:h-12 md:min-h-0 md:px-2 md:pt-0">
      {hasLeftButtons && (
        <div className="flex items-center gap-2 shrink-0">
          {leftButtons.map((button, index) => (
            <ButtonComponent key={index} button={button} />
          ))}
        </div>
      )}

      {hasLeftButtons && hasCenter && <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />}

      {hasCenter && (
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar touch-pan-x h-full">
            {typeof topBarConfig.centerContent === "string" ? (
              <span className="text-sm font-medium text-ide-text whitespace-nowrap">{topBarConfig.centerContent}</span>
            ) : (
              topBarConfig.centerContent
            )}
          </div>
        </div>
      )}

      {!hasCenter && <div className="flex-1" />}

      {hasRightButtons && (
        <div className="flex items-center gap-2 shrink-0">
          {topBarConfig.rightButtons!.map((button, index) => (
            <ButtonComponent key={index} button={button} />
          ))}
        </div>
      )}
    </div>
  );
};

export default TopBar;
