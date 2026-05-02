import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function PluginScaffold({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden bg-ide-bg text-ide-text", className)}
      {...props}
    />
  );
}
