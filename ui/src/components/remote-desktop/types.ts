import type {
  RemoteDesktopConfig,
  RemoteDesktopDisplay,
  RemoteDesktopFrameMetadata,
  RemoteDesktopQos,
  RemoteDesktopStatus,
} from "@/api/remote-desktop";

export type ConnectionState = "idle" | "connecting" | "connected" | "paused" | "error";
export type FitMode = "contain" | "original" | "custom";
export type ScrollMode = "auto" | "scrollbar" | "edge";
export type QualityPreset = "smooth" | "balanced" | "sharp" | "custom";
export type KeyboardMode = "legacy" | "text";
export type MobileInputMode = "touch" | "mouse";
export type ActiveMenu = "display" | "input" | "clipboard" | "quality" | null;
export type SpecialKey = "ctrlAltDel" | "lock" | "esc" | "tab" | "enter" | "up" | "down" | "left" | "right";

export interface RemoteDesktopViewConfig {
  fitMode: FitMode;
  scalePercent: number;
  scrollMode: ScrollMode;
  qualityPreset: QualityPreset;
  keyboardMode: KeyboardMode;
  showLocalCursor: boolean;
  mobileInputMode: MobileInputMode;
  showVirtualMouse: boolean;
  virtualMouseScale: number;
}

export interface ToolbarState {
  pinned: boolean;
  collapsed: boolean;
  hidden: boolean;
  x: number;
}

export interface RemoteDesktopRuntime {
  status: RemoteDesktopStatus | null;
  displays: RemoteDesktopDisplay[];
  selectedDisplay: RemoteDesktopDisplay | undefined;
  displayId: number;
  fps: number;
  quality: number;
  state: ConnectionState;
  controlEnabled: boolean;
  clipboardSync: boolean;
  clipboardText: string;
  message: string;
  frameMeta: RemoteDesktopFrameMetadata | null;
  qos: RemoteDesktopQos | null;
  latencyMs: number | null;
  viewConfig: RemoteDesktopViewConfig;
  remoteCursor: { x: number; y: number } | null;
  installingHelper?: boolean;
  installInputHelper?: () => void;
}

export type ConfigPatch = Partial<RemoteDesktopConfig & RemoteDesktopViewConfig> & {
  controlEnabled?: boolean;
  clipboardSync?: boolean;
};
