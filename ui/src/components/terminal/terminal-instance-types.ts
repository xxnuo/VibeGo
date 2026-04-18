import type { TerminalCapabilities } from "@/api/terminal";

export interface TerminalInstanceHandle {
  sendInput: (data: string) => void;
  getSelection: () => string;
  paste: (text: string) => void;
  clearSelection: () => void;
  selectAll: () => void;
  focus: () => void;
}

export interface TerminalInstanceStateUpdate {
  capabilities?: TerminalCapabilities;
  currentCwd?: string;
  lastCommand?: string;
  lastCommandExitCode?: number | null;
  readonly?: boolean;
  runtimeType?: string;
  shellIntegration?: boolean;
  shellState?: string;
  shellType?: string;
  status?: string;
}

export interface TerminalInstanceProps {
  terminalId: string;
  terminalName: string;
  isActive: boolean;
  isFocused?: boolean;
  isExited?: boolean;
  onExited?: () => void;
  onStateChange?: (state: TerminalInstanceStateUpdate) => void;
}
