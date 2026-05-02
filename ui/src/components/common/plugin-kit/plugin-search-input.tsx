import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function PluginSearchInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      type="search"
      aria-label={props.placeholder || "Search"}
      className={cn(
        "min-h-11 min-w-0 flex-1 rounded border border-ide-border bg-ide-bg px-2 text-xs outline-none focus:border-ide-accent md:min-h-7",
        className
      )}
      {...props}
    />
  );
}
