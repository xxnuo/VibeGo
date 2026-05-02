import { create } from "zustand";
import type { TerminalInfo } from "@/api/terminal";
import { useTerminalStore } from "@/stores/terminal-store";
import { notifyTerminal } from "./terminal-notification-service";

export const useTerminalEventSupport = create<{ supported: boolean }>(() => ({ supported: false }));
export const focusedTerminalViews = new Set<string>();
export interface TerminalRuntimeEvent {
  type: "terminal:notification" | "terminal:runtime";
  terminal_id: string;
  workspace_id: string;
  cursor: number;
  title?: string;
  body?: string;
  terminal?: TerminalInfo;
}
export function receiveTerminalEvent(event: TerminalRuntimeEvent) {
  if (event.type === "terminal:notification" && event.title && event.body) {
    notifyTerminal({
      terminalId: event.terminal_id,
      title: event.title,
      body: event.body,
      isActive: focusedTerminalViews.has(event.terminal_id),
    });
  } else if (event.type === "terminal:runtime" && event.terminal) {
    const state = useTerminalStore.getState();
    const info = event.terminal;
    for (const [group, terminals] of Object.entries(state.terminalsByGroup)) {
      if (terminals.some((terminal) => terminal.id === info.id))
        state.updateTerminal(group, info.id, {
          currentCwd: info.current_cwd,
          shellType: info.shell_type,
          shellState: info.shell_state,
          shellIntegration: info.shell_integration,
          lastCommand: info.last_command,
          lastCommandExitCode: info.last_command_exit_code,
        });
    }
  }
}
