import { request } from "@/api/request";

export interface RemoteDesktopDisplay {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export interface RemoteDesktopStatus {
  os: string;
  platform: string;
  sessionType: string;
  available: boolean;
  captureAvailable: boolean;
  inputAvailable: boolean;
  clipboardAvailable: boolean;
  inputBackend: string;
  inputBackends: string[];
  inputSetupRequired: boolean;
  inputSetupState: string;
  inputError: string;
  capabilities: {
    capture: boolean;
    input: boolean;
    clipboard: boolean;
    displayWatch: boolean;
    qos: boolean;
    clipboardSync: boolean;
  };
  wayland: boolean;
  warnings: string[];
  defaultFps: number;
  defaultQuality: number;
  minFps: number;
  maxFps: number;
  minQuality: number;
  maxQuality: number;
}

export interface RemoteDesktopFrameMetadata {
  type: "frame";
  seq: number;
  displayId: number;
  width: number;
  height: number;
  format: "jpeg";
  quality: number;
  capturedAt: number;
  sentAt: number;
  captureMs: number;
  encodeMs: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface RemoteDesktopConfig {
  displayId: number;
  fps: number;
  quality: number;
  fitMode: "contain" | "original" | "custom" | string;
  scalePercent: number;
  scrollMode: "auto" | "scrollbar" | "edge" | string;
  qualityPreset: "smooth" | "balanced" | "sharp" | "custom" | string;
  controlMode: "control" | "view" | string;
  keyboardMode: "legacy" | "text" | string;
  showLocalCursor: boolean;
  mobileInputMode?: "touch" | "mouse" | string;
  showVirtualMouse?: boolean;
  virtualMouseScale?: number;
  clipboardSync: boolean;
}

export interface RemoteDesktopQos {
  targetFps: number;
  targetQuality: number;
  effectiveFps: number;
  effectiveQuality: number;
  lastAckSeq: number;
  pendingFrames: number;
}

export const remoteDesktopApi = {
  status: () => request<RemoteDesktopStatus>("/remote-desktop/status"),
  displays: () => request<{ displays: RemoteDesktopDisplay[] }>("/remote-desktop/displays"),
  getClipboard: () => request<{ text: string }>("/remote-desktop/clipboard"),
  setClipboard: (text: string) =>
    request<{ ok: boolean }>("/remote-desktop/clipboard", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  installInputHelper: () =>
    request<{ ok: boolean; status: RemoteDesktopStatus; error?: string }>("/remote-desktop/input-helper/install", {
      method: "POST",
    }),
  wsUrl: () => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const key = localStorage.getItem("vibego_auth_key");
    const params = new URLSearchParams();
    if (key) params.set("key", key);
    const qs = params.toString();
    return `${proto}//${window.location.host}/api/remote-desktop/ws${qs ? `?${qs}` : ""}`;
  },
};

export async function decodeRemoteDesktopFrame(data: ArrayBuffer): Promise<{
  metadata: RemoteDesktopFrameMetadata;
  jpegBlob: Blob;
}> {
  const view = new DataView(data);
  if (view.byteLength < 4) throw new Error("Invalid frame");
  const metaLength = view.getUint32(0);
  if (metaLength <= 0 || 4 + metaLength > view.byteLength) throw new Error("Invalid frame metadata");
  const metaBytes = new Uint8Array(data, 4, metaLength);
  const metadata = JSON.parse(new TextDecoder().decode(metaBytes)) as RemoteDesktopFrameMetadata;
  const jpegBytes = data.slice(4 + metaLength);
  return { metadata, jpegBlob: new Blob([jpegBytes], { type: "image/jpeg" }) };
}
