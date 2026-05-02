import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function PluginList({ className, ...props }: ComponentProps<"div">) {
  return <div role="list" className={cn("min-h-0 overflow-y-auto text-xs", className)} {...props} />;
}
export function PluginListItem({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="listitem"
      className={cn("flex items-center gap-2 border-b border-ide-border px-2 py-1.5", className)}
      {...props}
    />
  );
}
