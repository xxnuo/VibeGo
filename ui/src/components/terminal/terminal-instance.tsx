import React from "react";
import { useSettingsStore } from "@/lib/settings";
import TerminalInstanceWTerm from "@/components/terminal/terminal-instance-wterm";
import TerminalInstanceXterm from "@/components/terminal/terminal-instance-xterm";
import type { TerminalInstanceHandle, TerminalInstanceProps, TerminalInstanceStateUpdate } from "@/components/terminal/terminal-instance-types";

export type { TerminalInstanceHandle, TerminalInstanceProps, TerminalInstanceStateUpdate };

const TerminalInstance = React.forwardRef<TerminalInstanceHandle, TerminalInstanceProps>((props, ref) => {
  const terminalFrontend = useSettingsStore((s) => s.settings.terminalFrontend || "xterm");

  if (terminalFrontend === "wterm") {
    return <TerminalInstanceWTerm ref={ref} {...props} />;
  }

  return <TerminalInstanceXterm ref={ref} {...props} />;
});

TerminalInstance.displayName = "TerminalInstance";

export default TerminalInstance;
