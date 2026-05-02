import { MonitorUp } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeRemoteDesktopFrame,
  type RemoteDesktopConfig,
  type RemoteDesktopDisplay,
  type RemoteDesktopFrameMetadata,
  type RemoteDesktopQos,
  type RemoteDesktopStatus,
  remoteDesktopApi,
} from "@/api/remote-desktop";
import { MobileRemoteControls } from "@/components/remote-desktop/mobile-remote-controls";
import { RemoteDesktopStage } from "@/components/remote-desktop/remote-desktop-stage";
import { RemoteDesktopToolbar } from "@/components/remote-desktop/remote-desktop-toolbar";
import type {
  ActiveMenu,
  ConfigPatch,
  ConnectionState,
  KeyboardMode,
  QualityPreset,
  RemoteDesktopViewConfig,
  SpecialKey,
  ToolbarState,
} from "@/components/remote-desktop/types";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useTranslation } from "@/lib/i18n";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";
import { useAppStore } from "@/stores/app-store";

const toolbarStorageKey = "vibego_remote_desktop_toolbar";
const viewStorageKey = "vibego_remote_desktop_view";
const mouseModeCursorStep = 1.15;
const mouseModeMoveThreshold = 0.002;

const defaultToolbar: ToolbarState = {
  pinned: false,
  collapsed: false,
  hidden: false,
  x: 0.5,
};

const defaultViewConfig: RemoteDesktopViewConfig = {
  fitMode: "contain",
  scalePercent: 100,
  scrollMode: "auto",
  qualityPreset: "balanced",
  keyboardMode: "legacy",
  showLocalCursor: true,
  mobileInputMode: "touch",
  showVirtualMouse: true,
  virtualMouseScale: 100,
};

const readStored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};

const RemoteDesktopView: React.FC<PageViewProps> = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const isMobile = useIsMobile();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const keysDownRef = useRef<Set<string>>(new Set());
  const lastFrameSeqRef = useRef(0);
  const pointerThrottleRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);
  const touchRef = useRef<{ lastX: number; lastY: number; lastDistance: number; moved: boolean } | null>(null);
  const remoteCursorRef = useRef<{ x: number; y: number } | null>(null);

  const [status, setStatus] = useState<RemoteDesktopStatus | null>(null);
  const [displays, setDisplays] = useState<RemoteDesktopDisplay[]>([]);
  const [displayId, setDisplayId] = useState(0);
  const [fps, setFps] = useState(12);
  const [quality, setQuality] = useState(70);
  const [state, setState] = useState<ConnectionState>("idle");
  const [controlEnabled, setControlEnabled] = useState(true);
  const [clipboardSync, setClipboardSync] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const [message, setMessage] = useState("");
  const [frameMeta, setFrameMeta] = useState<RemoteDesktopFrameMetadata | null>(null);
  const [qos, setQos] = useState<RemoteDesktopQos | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [viewConfig, setViewConfig] = useState<RemoteDesktopViewConfig>(() => readStored(viewStorageKey, defaultViewConfig));
  const [remoteCursor, setRemoteCursor] = useState<{ x: number; y: number } | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState>(() => readStored(toolbarStorageKey, defaultToolbar));
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);

  const selectedDisplay = useMemo(
    () => displays.find((display) => display.id === displayId) ?? displays[0],
    [displayId, displays]
  );

  usePageTopBar(
    {
      show: true,
      centerContent: t("plugin.remoteDesktop.title"),
    },
    [t]
  );

  useEffect(() => {
    localStorage.setItem(toolbarStorageKey, JSON.stringify(toolbar));
  }, [toolbar]);

  useEffect(() => {
    localStorage.setItem(viewStorageKey, JSON.stringify(viewConfig));
  }, [viewConfig]);

  const loadState = useCallback(async () => {
    try {
      const [nextStatus, displayResult] = await Promise.all([remoteDesktopApi.status(), remoteDesktopApi.displays()]);
      setStatus(nextStatus);
      setDisplays(displayResult.displays);
      const first = displayResult.displays[0];
      if (first) setDisplayId((prev) => (displayResult.displays.some((d) => d.id === prev) ? prev : first.id));
      setFps(nextStatus.defaultFps);
      setQuality(nextStatus.defaultQuality);
      setMessage(nextStatus.warnings?.[0] ?? "");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const setRemoteCursorPoint = useCallback((point: { x: number; y: number } | null) => {
    remoteCursorRef.current = point;
    setRemoteCursor(point);
  }, []);

  const configure = useCallback(
    (next?: ConfigPatch) => {
      const nextControlEnabled = next?.controlEnabled ?? controlEnabled;
      const nextClipboardSync = next?.clipboardSync ?? clipboardSync;
      const nextViewConfig: RemoteDesktopViewConfig = {
        ...viewConfig,
        fitMode: (next?.fitMode as RemoteDesktopViewConfig["fitMode"]) ?? viewConfig.fitMode,
        scalePercent: next?.scalePercent ?? viewConfig.scalePercent,
        scrollMode: (next?.scrollMode as RemoteDesktopViewConfig["scrollMode"]) ?? viewConfig.scrollMode,
        qualityPreset: (next?.qualityPreset as QualityPreset) ?? viewConfig.qualityPreset,
        keyboardMode: (next?.keyboardMode as KeyboardMode) ?? viewConfig.keyboardMode,
        showLocalCursor: next?.showLocalCursor ?? viewConfig.showLocalCursor,
        mobileInputMode: next?.mobileInputMode ?? viewConfig.mobileInputMode,
        showVirtualMouse: next?.showVirtualMouse ?? viewConfig.showVirtualMouse,
        virtualMouseScale: next?.virtualMouseScale ?? viewConfig.virtualMouseScale,
      };
      const nextFps = next?.fps ?? fps;
      const nextQuality = next?.quality ?? quality;
      if (next?.displayId != null) setDisplayId(next.displayId);
      if (next?.fps != null) setFps(next.fps);
      if (next?.quality != null) setQuality(next.quality);
      if (next?.controlEnabled != null) setControlEnabled(next.controlEnabled);
      if (next?.clipboardSync != null) setClipboardSync(next.clipboardSync);
      setViewConfig(nextViewConfig);
      send({
        type: "configure",
        version: 2,
        displayId: next?.displayId ?? displayId,
        fps: nextFps,
        quality: nextQuality,
        fitMode: nextViewConfig.fitMode,
        scalePercent: nextViewConfig.scalePercent,
        scrollMode: nextViewConfig.scrollMode,
        qualityPreset: nextViewConfig.qualityPreset,
        controlMode: nextControlEnabled ? "control" : "view",
        keyboardMode: nextViewConfig.keyboardMode,
        showLocalCursor: nextViewConfig.showLocalCursor,
        clipboardSync: nextClipboardSync,
      });
    },
    [clipboardSync, controlEnabled, displayId, fps, quality, send, viewConfig]
  );

  const applyConfig = useCallback((config: Partial<RemoteDesktopConfig> & Record<string, unknown>) => {
    const nextDisplayId = Number(config.displayId ?? config.DisplayID);
    const nextFps = Number(config.fps ?? config.FPS);
    const nextQuality = Number(config.quality ?? config.Quality);
    if (Number.isFinite(nextDisplayId)) setDisplayId(nextDisplayId);
    if (Number.isFinite(nextFps)) setFps(nextFps);
    if (Number.isFinite(nextQuality)) setQuality(nextQuality);
    if (typeof config.controlMode === "string") setControlEnabled(config.controlMode !== "view");
    if (typeof config.clipboardSync === "boolean") setClipboardSync(config.clipboardSync);
    setViewConfig((prev) => ({
      ...prev,
      fitMode: typeof config.fitMode === "string" ? (config.fitMode as RemoteDesktopViewConfig["fitMode"]) : prev.fitMode,
      scalePercent: Number.isFinite(Number(config.scalePercent)) ? Number(config.scalePercent) : prev.scalePercent,
      scrollMode: typeof config.scrollMode === "string" ? (config.scrollMode as RemoteDesktopViewConfig["scrollMode"]) : prev.scrollMode,
      qualityPreset: typeof config.qualityPreset === "string" ? (config.qualityPreset as QualityPreset) : prev.qualityPreset,
      keyboardMode: typeof config.keyboardMode === "string" ? (config.keyboardMode as KeyboardMode) : prev.keyboardMode,
      showLocalCursor: typeof config.showLocalCursor === "boolean" ? config.showLocalCursor : prev.showLocalCursor,
    }));
  }, []);

  const drawFrame = useCallback(
    async (eventData: Blob | ArrayBuffer) => {
      const startedAt = performance.now();
      const buffer = eventData instanceof Blob ? await eventData.arrayBuffer() : eventData;
      const { metadata, jpegBlob } = await decodeRemoteDesktopFrame(buffer);
      if (metadata.seq <= lastFrameSeqRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if ("createImageBitmap" in window) {
        const bitmap = await createImageBitmap(jpegBlob);
        canvas.width = metadata.width;
        canvas.height = metadata.height;
        ctx.drawImage(bitmap, 0, 0, metadata.width, metadata.height);
        bitmap.close();
      } else {
        await new Promise<void>((resolve, reject) => {
          const url = URL.createObjectURL(jpegBlob);
          const img = new Image();
          img.onload = () => {
            canvas.width = metadata.width;
            canvas.height = metadata.height;
            ctx.drawImage(img, 0, 0, metadata.width, metadata.height);
            URL.revokeObjectURL(url);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image decode failed"));
          };
          img.src = url;
        });
      }
      lastFrameSeqRef.current = metadata.seq;
      setFrameMeta(metadata);
      if (isMobile && viewConfig.mobileInputMode === "mouse" && !remoteCursorRef.current) {
        setRemoteCursorPoint({ x: 0.5, y: 0.5 });
        send({ type: "pointer", version: 2, displayId: metadata.displayId, x: 0.5, y: 0.5, move: true });
      }
      const now = Date.now();
      if (metadata.sentAt > 0) setLatencyMs(Math.max(0, now - metadata.sentAt));
      send({
        type: "frameAck",
        version: 2,
        seq: metadata.seq,
        renderMs: Math.round(performance.now() - startedAt),
        receivedAt: now,
      });
    },
    [isMobile, send, setRemoteCursorPoint, viewConfig.mobileInputMode]
  );

  const releaseInput = useCallback(() => {
    keysDownRef.current.clear();
    send({ type: "releaseInput" });
  }, [send]);

  const disconnect = useCallback(() => {
    releaseInput();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    lastFrameSeqRef.current = 0;
    setFrameMeta(null);
    setRemoteCursorPoint(null);
    setState("idle");
  }, [releaseInput, setRemoteCursorPoint]);

  const connect = useCallback(() => {
    disconnect();
    setState("connecting");
    setMessage("");
    const ws = new WebSocket(remoteDesktopApi.wsUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => {
      setState("connected");
      configure();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        void drawFrame(event.data);
        return;
      }
      const msg = JSON.parse(event.data);
      if (msg.type === "hello") {
        if (Array.isArray(msg.displays)) setDisplays(msg.displays);
        if (msg.status) setStatus(msg.status);
        if (msg.config) applyConfig(msg.config);
        if (msg.qos) setQos(msg.qos);
      } else if (msg.type === "error") {
        setMessage(msg.message ?? "");
      } else if (msg.type === "clipboard") {
        if (typeof msg.text === "string") setClipboardText(msg.text);
        if (msg.sync === true) setMessage(t("plugin.remoteDesktop.clipboardSynced"));
      } else if (msg.type === "status") {
        if (msg.paused === true) setState("paused");
        if (msg.paused === false) setState("connected");
        if (msg.config) applyConfig(msg.config);
        if (msg.qos) setQos(msg.qos);
      } else if (msg.type === "qos") {
        if (msg.qos) setQos(msg.qos);
      } else if (msg.type === "displays") {
        if (Array.isArray(msg.displays)) setDisplays(msg.displays);
        if (msg.config) applyConfig(msg.config);
      }
    };
    ws.onerror = () => {
      setState("error");
      setMessage(t("plugin.remoteDesktop.connectionError"));
    };
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        setState((prev) => (prev === "error" ? "error" : "idle"));
      }
    };
  }, [applyConfig, configure, disconnect, drawFrame, t]);

  useEffect(() => disconnect, [disconnect]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) releaseInput();
    };
    window.addEventListener("blur", releaseInput);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", releaseInput);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [releaseInput]);

  const canvasPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(rect.width, 1),
      y: (event.clientY - rect.top) / Math.max(rect.height, 1),
    };
  }, []);

  const canvasTouchPoint = useCallback((touch: React.Touch, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (touch.clientX - rect.left) / Math.max(rect.width, 1),
      y: (touch.clientY - rect.top) / Math.max(rect.height, 1),
    };
  }, []);

  const clampPoint = (point: { x: number; y: number }) => ({
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  });

  const moveRemoteCursor = useCallback(
    (dx: number, dy: number) => {
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return;
      const current = remoteCursorRef.current ?? { x: 0.5, y: 0.5 };
      const next = clampPoint({
        x: current.x + dx / Math.max(rect.width, 1) * mouseModeCursorStep,
        y: current.y + dy / Math.max(rect.height, 1) * mouseModeCursorStep,
      });
      if (Math.abs(next.x - current.x) < mouseModeMoveThreshold && Math.abs(next.y - current.y) < mouseModeMoveThreshold) return;
      setRemoteCursorPoint(next);
      send({ type: "pointer", version: 2, displayId, x: next.x, y: next.y, move: true });
      const stage = stageRef.current;
      if (!stage || !canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const cursorClientX = canvasRect.left + next.x * canvasRect.width;
      const cursorClientY = canvasRect.top + next.y * canvasRect.height;
      const stageRect = stage.getBoundingClientRect();
      const edge = 36;
      const scrollX = cursorClientX < stageRect.left + edge ? -18 : cursorClientX > stageRect.right - edge ? 18 : 0;
      const scrollY = cursorClientY < stageRect.top + edge ? -18 : cursorClientY > stageRect.bottom - edge ? 18 : 0;
      if (scrollX || scrollY) stage.scrollBy({ left: scrollX, top: scrollY });
    },
    [displayId, send, setRemoteCursorPoint]
  );

  const pointerButton = (button: number) => {
    if (button === 1) return "middle";
    if (button === 2) return "right";
    return "left";
  };

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, down?: boolean) => {
      if (!controlEnabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      const point = canvasPoint(event);
      if (down === undefined) {
        pendingPointerRef.current = point;
        if (pointerThrottleRef.current != null) return;
        pointerThrottleRef.current = window.setTimeout(() => {
          pointerThrottleRef.current = null;
          const pending = pendingPointerRef.current;
          pendingPointerRef.current = null;
          if (pending) send({ type: "pointer", version: 2, displayId, x: pending.x, y: pending.y });
        }, 16);
        return;
      }
      send({
        type: "pointer",
        version: 2,
        displayId,
        x: point.x,
        y: point.y,
        button: pointerButton(event.button),
        down,
      });
    },
    [canvasPoint, controlEnabled, displayId, send]
  );

  const sendButton = useCallback(
    (button: "left" | "middle" | "right", down: boolean) => {
      send({ type: "pointer", version: 2, displayId, button, down, move: false });
    },
    [displayId, send]
  );

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (!isMobile || !controlEnabled) return;
      const first = event.touches[0];
      if (!first) return;
      event.preventDefault();
      if (event.touches.length === 2) {
        const second = event.touches[1];
        const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
        touchRef.current = { lastX: first.clientX, lastY: first.clientY, lastDistance: distance, moved: false };
        return;
      }
      touchRef.current = { lastX: first.clientX, lastY: first.clientY, lastDistance: 0, moved: false };
      if (viewConfig.mobileInputMode === "touch") {
        const point = canvasTouchPoint(first, event.currentTarget);
        send({
          type: "pointer",
          version: 2,
          displayId,
          x: point.x,
          y: point.y,
        });
      } else if (!remoteCursorRef.current) {
        setRemoteCursorPoint(canvasTouchPoint(first, event.currentTarget));
      }
    },
    [canvasTouchPoint, controlEnabled, displayId, isMobile, send, setRemoteCursorPoint, viewConfig.mobileInputMode]
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (!isMobile || !controlEnabled || !touchRef.current) return;
      const first = event.touches[0];
      if (!first) return;
      event.preventDefault();
      if (event.touches.length === 2) {
        const second = event.touches[1];
        const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
        if (touchRef.current.lastDistance > 0) {
          const delta = distance - touchRef.current.lastDistance;
          if (Math.abs(delta) > 4) {
            const nextScale = Math.min(300, Math.max(25, viewConfig.scalePercent + Math.round(delta / 3)));
            configure({ fitMode: "custom", scalePercent: nextScale });
          }
        }
        touchRef.current.lastDistance = distance;
        touchRef.current.moved = true;
        return;
      }
      const dx = first.clientX - touchRef.current.lastX;
      const dy = first.clientY - touchRef.current.lastY;
      touchRef.current.lastX = first.clientX;
      touchRef.current.lastY = first.clientY;
      touchRef.current.moved = true;
      if (viewConfig.mobileInputMode === "mouse") {
        moveRemoteCursor(dx, dy);
        return;
      }
      const point = canvasTouchPoint(first, event.currentTarget);
      send({
        type: "pointer",
        version: 2,
        displayId,
        x: point.x,
        y: point.y,
      });
    },
    [canvasTouchPoint, configure, controlEnabled, displayId, isMobile, moveRemoteCursor, send, viewConfig.mobileInputMode, viewConfig.scalePercent]
  );

  const handleTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (!isMobile || !controlEnabled) return;
      event.preventDefault();
      const last = touchRef.current;
      touchRef.current = null;
      if (last && !last.moved) {
        send({ type: "pointer", version: 2, displayId, button: "left", down: true, move: false });
        window.setTimeout(() => send({ type: "pointer", version: 2, displayId, button: "left", down: false, move: false }), 35);
      }
    },
    [controlEnabled, displayId, isMobile, send]
  );

  const modifierKeys = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const mods: string[] = [];
    if (event.altKey) mods.push("alt");
    if (event.ctrlKey) mods.push("ctrl");
    if (event.metaKey) mods.push("cmd");
    if (event.shiftKey) mods.push("shift");
    return mods;
  };

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>, down: boolean) => {
      if (!controlEnabled) return;
      event.preventDefault();
      if (viewConfig.keyboardMode === "text" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (down) send({ type: "text", text: event.key });
        return;
      }
      const keyId = event.code || event.key;
      if (down && keysDownRef.current.has(keyId)) return;
      if (down) keysDownRef.current.add(keyId);
      else keysDownRef.current.delete(keyId);
      send({ type: "key", version: 2, key: event.key, down, modifiers: modifierKeys(event) });
    },
    [controlEnabled, send, viewConfig.keyboardMode]
  );

  const togglePause = useCallback(() => {
    if (state === "paused") {
      send({ type: "resume" });
      setState("connected");
    } else {
      send({ type: "pause" });
      setState("paused");
    }
  }, [send, state]);

  const runtime = {
    status,
    displays,
    selectedDisplay,
    displayId,
    fps,
    quality,
    state,
    controlEnabled,
    clipboardSync,
    clipboardText,
    message,
    frameMeta,
    qos,
    latencyMs,
    viewConfig,
    remoteCursor,
  };

  return (
    <div className="relative h-full overflow-hidden bg-ide-bg text-ide-text">
      <RemoteDesktopStage
        runtime={runtime}
        canvasRef={canvasRef}
        stageRef={stageRef}
        t={t}
        onPointerMove={(event) => handlePointer(event)}
        onPointerDown={(event) => handlePointer(event, true)}
        onPointerUp={(event) => handlePointer(event, false)}
        onWheel={(event) => {
          if (!controlEnabled) return;
          event.preventDefault();
          send({ type: "wheel", deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
        }}
        onKeyDown={(event) => handleKey(event, true)}
        onKeyUp={(event) => handleKey(event, false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onReleaseInput={releaseInput}
      />
      <div className={isMobile ? "hidden md:block" : ""}>
        <RemoteDesktopToolbar
          runtime={runtime}
          toolbar={toolbar}
          activeMenu={activeMenu}
          t={t}
          onToolbarChange={(patch) => setToolbar((prev) => ({ ...prev, ...patch }))}
          onActiveMenuChange={setActiveMenu}
          onConnectToggle={state === "idle" || state === "error" ? connect : disconnect}
          onPauseToggle={togglePause}
          onRefresh={loadState}
          onFullscreen={() => stageRef.current?.requestFullscreen()}
          onConfigure={configure}
          onClipboardTextChange={setClipboardText}
          onClipboardRead={() => send({ type: "clipboardRead" })}
          onClipboardWrite={() => send({ type: "clipboardWrite", text: clipboardText })}
          onSpecialKey={(specialKey: SpecialKey) => send({ type: "specialKey", specialKey })}
        />
      </div>
      <MobileRemoteControls
        runtime={runtime}
        t={t}
        onConnectToggle={state === "idle" || state === "error" ? connect : disconnect}
        onConfigure={configure}
        onSpecialKey={(specialKey) => send({ type: "specialKey", specialKey })}
        onWheel={(deltaY) => send({ type: "wheel", deltaX: 0, deltaY })}
        onButton={sendButton}
        onKeyboardText={(text) => send({ type: "text", text })}
        onClipboardRead={() => send({ type: "clipboardRead" })}
        onClipboardWrite={() => send({ type: "clipboardWrite", text: clipboardText })}
        onShowDesktopToolbar={() => {
          setToolbar((prev) => ({ ...prev, hidden: false, collapsed: false }));
          setActiveMenu("display");
        }}
      />
    </div>
  );
};

registerPage({
  id: "remote-desktop",
  name: "Remote Desktop",
  nameKey: "plugin.remoteDesktop.name",
  descriptionKey: "plugin.remoteDesktop.description",
  icon: MonitorUp,
  order: 16,
  category: "tool",
  singleton: true,
  View: RemoteDesktopView,
});

export default RemoteDesktopView;
