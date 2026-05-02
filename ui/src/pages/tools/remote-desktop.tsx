import {
  Clipboard,
  ClipboardPaste,
  Eye,
  EyeOff,
  Maximize2,
  MonitorUp,
  MousePointer2,
  Pause,
  Play,
  Power,
  RefreshCw,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeRemoteDesktopFrame,
  remoteDesktopApi,
  type RemoteDesktopDisplay,
  type RemoteDesktopFrameMetadata,
  type RemoteDesktopStatus,
} from "@/api/remote-desktop";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useTranslation } from "@/lib/i18n";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";
import { useAppStore } from "@/stores/app-store";

type ConnectionState = "idle" | "connecting" | "connected" | "paused" | "error";

const RemoteDesktopView: React.FC<PageViewProps> = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const keysDownRef = useRef<Set<string>>(new Set());

  const [status, setStatus] = useState<RemoteDesktopStatus | null>(null);
  const [displays, setDisplays] = useState<RemoteDesktopDisplay[]>([]);
  const [displayId, setDisplayId] = useState(0);
  const [fps, setFps] = useState(12);
  const [quality, setQuality] = useState(70);
  const [state, setState] = useState<ConnectionState>("idle");
  const [controlEnabled, setControlEnabled] = useState(true);
  const [clipboardText, setClipboardText] = useState("");
  const [message, setMessage] = useState("");
  const [frameMeta, setFrameMeta] = useState<RemoteDesktopFrameMetadata | null>(null);

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

  const configure = useCallback(
    (next?: { displayId?: number; fps?: number; quality?: number }) => {
      send({
        type: "configure",
        displayId: next?.displayId ?? displayId,
        fps: next?.fps ?? fps,
        quality: next?.quality ?? quality,
      });
    },
    [displayId, fps, quality, send]
  );

  const drawFrame = useCallback(async (eventData: Blob | ArrayBuffer) => {
    const buffer = eventData instanceof Blob ? await eventData.arrayBuffer() : eventData;
    const { metadata, blobUrl } = await decodeRemoteDesktopFrame(buffer);
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = metadata.width;
      canvas.height = metadata.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, metadata.width, metadata.height);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = blobUrl;
      setFrameMeta(metadata);
    };
    img.onerror = () => URL.revokeObjectURL(blobUrl);
    img.src = blobUrl;
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    keysDownRef.current.clear();
    setState("idle");
  }, []);

  useEffect(
    () => () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    []
  );

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
        if (msg.config) {
          setDisplayId(msg.config.DisplayID ?? msg.config.displayId ?? displayId);
          setFps(msg.config.FPS ?? msg.config.fps ?? fps);
          setQuality(msg.config.Quality ?? msg.config.quality ?? quality);
        }
      } else if (msg.type === "error") {
        setMessage(msg.message ?? "");
      } else if (msg.type === "clipboard") {
        if (typeof msg.text === "string") setClipboardText(msg.text);
      } else if (msg.type === "status") {
        if (msg.paused === true) setState("paused");
        if (msg.paused === false) setState("connected");
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
  }, [configure, disconnect, displayId, drawFrame, fps, quality, t]);

  useEffect(() => disconnect, [disconnect]);

  const canvasPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(rect.width, 1),
      y: (event.clientY - rect.top) / Math.max(rect.height, 1),
    };
  }, []);

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
      send({
        type: "pointer",
        displayId,
        x: point.x,
        y: point.y,
        button: down === undefined ? undefined : pointerButton(event.button),
        down,
      });
    },
    [canvasPoint, controlEnabled, displayId, send]
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
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (down) send({ type: "text", text: event.key });
        return;
      }
      const keyId = event.code || event.key;
      if (down && keysDownRef.current.has(keyId)) return;
      if (down) keysDownRef.current.add(keyId);
      else keysDownRef.current.delete(keyId);
      send({ type: "key", key: event.key, down, modifiers: modifierKeys(event) });
    },
    [controlEnabled, send]
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

  const readClipboard = useCallback(() => send({ type: "clipboardRead" }), [send]);
  const writeClipboard = useCallback(() => send({ type: "clipboardWrite", text: clipboardText }), [clipboardText, send]);

  return (
    <div className="h-full flex flex-col bg-ide-bg text-ide-text overflow-hidden">
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <button
          type="button"
          className="h-8 px-2 flex items-center gap-1.5 border border-ide-border bg-ide-bg hover:bg-ide-border/50 text-xs"
          onClick={state === "idle" || state === "error" ? connect : disconnect}
        >
          <Power size={14} />
          {state === "idle" || state === "error" ? t("plugin.remoteDesktop.connect") : t("plugin.remoteDesktop.disconnect")}
        </button>
        <button
          type="button"
          className="h-8 w-8 grid place-items-center border border-ide-border bg-ide-bg hover:bg-ide-border/50 disabled:opacity-50"
          onClick={togglePause}
          disabled={state !== "connected" && state !== "paused"}
          title={state === "paused" ? t("plugin.remoteDesktop.resume") : t("plugin.remoteDesktop.pause")}
        >
          {state === "paused" ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <select
          className="h-8 bg-ide-bg border border-ide-border px-2 text-xs"
          value={displayId}
          onChange={(e) => {
            const next = Number(e.target.value);
            setDisplayId(next);
            configure({ displayId: next });
          }}
        >
          {displays.map((display) => (
            <option key={display.id} value={display.id}>
              {t("plugin.remoteDesktop.display")} {display.id + 1} {display.width}x{display.height}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-ide-mute">
          FPS
          <input
            type="range"
            min={status?.minFps ?? 1}
            max={status?.maxFps ?? 20}
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            onMouseUp={() => configure()}
            onTouchEnd={() => configure()}
          />
          <span className="w-5 text-ide-text tabular-nums">{fps}</span>
        </label>
        <label className="flex items-center gap-1 text-xs text-ide-mute">
          {t("plugin.remoteDesktop.quality")}
          <input
            type="range"
            min={status?.minQuality ?? 40}
            max={status?.maxQuality ?? 90}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            onMouseUp={() => configure()}
            onTouchEnd={() => configure()}
          />
          <span className="w-6 text-ide-text tabular-nums">{quality}</span>
        </label>
        <button
          type="button"
          className="h-8 w-8 grid place-items-center border border-ide-border bg-ide-bg hover:bg-ide-border/50"
          onClick={() => setControlEnabled((v) => !v)}
          title={controlEnabled ? t("plugin.remoteDesktop.controlOn") : t("plugin.remoteDesktop.viewOnly")}
        >
          {controlEnabled ? <MousePointer2 size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          className="h-8 w-8 grid place-items-center border border-ide-border bg-ide-bg hover:bg-ide-border/50"
          onClick={() => stageRef.current?.requestFullscreen()}
          title={t("plugin.remoteDesktop.fullscreen")}
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          className="h-8 w-8 grid place-items-center border border-ide-border bg-ide-bg hover:bg-ide-border/50"
          onClick={loadState}
          title={t("plugin.remoteDesktop.refresh")}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-ide-border bg-ide-panel">
        <input
          className="h-8 min-w-0 flex-1 bg-ide-bg border border-ide-border px-2 text-xs outline-none"
          value={clipboardText}
          onChange={(e) => setClipboardText(e.target.value)}
          placeholder={t("plugin.remoteDesktop.clipboardPlaceholder")}
        />
        <button
          type="button"
          className="h-8 w-8 grid place-items-center border border-ide-border bg-ide-bg hover:bg-ide-border/50"
          onClick={readClipboard}
          title={t("plugin.remoteDesktop.readClipboard")}
        >
          <Clipboard size={14} />
        </button>
        <button
          type="button"
          className="h-8 w-8 grid place-items-center border border-ide-border bg-ide-bg hover:bg-ide-border/50"
          onClick={writeClipboard}
          title={t("plugin.remoteDesktop.writeClipboard")}
        >
          <ClipboardPaste size={14} />
        </button>
      </div>

      <div ref={stageRef} className="min-h-0 flex-1 grid place-items-center bg-black overflow-hidden">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={`max-w-full max-h-full outline-none ${controlEnabled ? "cursor-crosshair" : "cursor-default"}`}
          style={{ aspectRatio: selectedDisplay ? `${selectedDisplay.width} / ${selectedDisplay.height}` : undefined }}
          onPointerMove={(e) => handlePointer(e)}
          onPointerDown={(e) => handlePointer(e, true)}
          onPointerUp={(e) => handlePointer(e, false)}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => {
            if (!controlEnabled) return;
            e.preventDefault();
            send({ type: "wheel", deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
          }}
          onKeyDown={(e) => handleKey(e, true)}
          onKeyUp={(e) => handleKey(e, false)}
        />
      </div>

      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-t border-ide-border bg-ide-panel text-[11px] text-ide-mute">
        <div className="flex items-center gap-2 min-w-0">
          {controlEnabled ? <EyeOff size={12} /> : <Eye size={12} />}
          <span>{t(`plugin.remoteDesktop.state.${state}`)}</span>
          {status?.wayland && <span>{t("plugin.remoteDesktop.waylandLimited")}</span>}
          {message && <span className="truncate text-red-400">{message}</span>}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <MonitorUp size={12} />
          <span>{frameMeta ? `${frameMeta.width}x${frameMeta.height} #${frameMeta.seq}` : "-"}</span>
        </div>
      </div>
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
