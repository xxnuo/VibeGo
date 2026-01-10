import React from "react";
import { useFrameStore, type TopBarButton } from "@/stores/frameStore";

const ButtonComponent: React.FC<{ button: TopBarButton }> = ({ button }) => {
  return (
    <button
      onClick={button.onClick}
      disabled={button.disabled}
      className={`shrink-0 h-8 ${button.label ? "px-3" : "w-8"} flex items-center justify-center gap-1.5 rounded-md border transition-all text-xs ${
        button.active
          ? "bg-ide-accent text-ide-bg border-ide-accent shadow-glow"
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

  if (!topBarConfig.show) {
    return null;
  }

  const hasLeftButtons =
    topBarConfig.leftButtons && topBarConfig.leftButtons.length > 0;
  const hasRightButtons =
    topBarConfig.rightButtons && topBarConfig.rightButtons.length > 0;
  const hasCenter = topBarConfig.centerContent;

  return (
    <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center px-2 gap-2 shrink-0 transition-colors duration-300 overflow-hidden">
      {hasLeftButtons && (
        <div className="flex items-center gap-2 shrink-0">
          {topBarConfig.leftButtons!.map((button, index) => (
            <ButtonComponent key={index} button={button} />
          ))}
        </div>
      )}

      {hasCenter && (
        <div className="flex-1 min-w-0 px-2">
          <div className="flex items-center justify-center overflow-x-auto no-scrollbar">
            {typeof topBarConfig.centerContent === "string" ? (
              <span className="text-sm font-medium text-ide-text whitespace-nowrap">
                {topBarConfig.centerContent}
              </span>
            ) : (
              <div className="flex items-center min-w-max">
                {topBarConfig.centerContent}
              </div>
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
