import React from "react";
import { cn } from "@/lib/utils";

export interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  badge?: string | number;
  title?: string;
}

export const ActionButton = React.forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ onClick, icon, label, destructive = false, badge, title, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        onClick={onClick}
        title={title || label}
        className={cn(
          "flex min-h-11 min-w-11 flex-col items-center gap-1.5 p-2 rounded-md transition-all group outline-none md:min-h-0 md:min-w-0",
          destructive ? "text-red-500 hover:bg-red-500/10" : "text-ide-text hover:bg-ide-bg hover:text-ide-accent",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "relative p-2 rounded-md border transition-all",
            destructive
              ? "bg-red-500/10 border-red-500/40 group-hover:border-red-500"
              : "bg-ide-bg border-ide-border group-hover:border-ide-accent group-hover:shadow-glow"
          )}
        >
          {icon}
          {badge && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
              {badge}
            </span>
          )}
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span
            className={cn(
              "text-[11px] font-bold tracking-wide",
              destructive ? "text-red-500" : "text-ide-text uppercase group-hover:text-ide-accent transition-colors"
            )}
            style={{ fontSize: title ? "13px" : "11px" }}
          >
            {label}
          </span>
          {title && <span className="text-[11px] text-ide-mute">{title}</span>}
        </div>
      </button>
    );
  }
);

ActionButton.displayName = "ActionButton";
