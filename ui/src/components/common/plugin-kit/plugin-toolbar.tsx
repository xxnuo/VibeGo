import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function PluginToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-ide-border bg-ide-panel px-3 py-2 text-xs",
        className
      )}
      {...props}
    />
  );
}
