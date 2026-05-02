import { Eye, EyeOff, MonitorUp, Power } from "lucide-react";
import React, { useEffect, useMemo, useRef } from "react";
import type { RemoteDesktopRuntime } from "./types";

interface StageProps {
  runtime: RemoteDesktopRuntime;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  t: (key: string) => string;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLCanvasElement>) => void;
  onKeyUp: (event: React.KeyboardEvent<HTMLCanvasElement>) => void;
  onTouchStart?: (event: React.TouchEvent<HTMLCanvasElement>) => void;
  onTouchMove?: (event: React.TouchEvent<HTMLCanvasElement>) => void;
  onTouchEnd?: (event: React.TouchEvent<HTMLCanvasElement>) => void;
  onReleaseInput: () => void;
}

export const RemoteDesktopStage: React.FC<StageProps> = ({
  runtime,
  canvasRef,
  stageRef,
  t,
  onPointerMove,
  onPointerDown,
  onPointerUp,
  onWheel,
  onKeyDown,
  onKeyUp,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onReleaseInput,
}) => {
  const edgeTimerRef = useRef<number | null>(null);
  const size = useMemo(() => {
    const display = runtime.selectedDisplay;
    const width = runtime.frameMeta?.width ?? display?.width ?? 16;
    const height = runtime.frameMeta?.height ?? display?.height ?? 9;
    return { width, height };
  }, [runtime.frameMeta, runtime.selectedDisplay]);

  const canvasStyle = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      aspectRatio: `${size.width} / ${size.height}`,
    };
    if (runtime.viewConfig.fitMode === "original") {
      base.width = `${size.width}px`;
      base.height = `${size.height}px`;
      base.maxWidth = "none";
      base.maxHeight = "none";
    } else if (runtime.viewConfig.fitMode === "custom") {
      base.width = `${Math.round(size.width * runtime.viewConfig.scalePercent / 100)}px`;
      base.height = `${Math.round(size.height * runtime.viewConfig.scalePercent / 100)}px`;
      base.maxWidth = "none";
      base.maxHeight = "none";
    } else {
      base.maxWidth = "100%";
      base.maxHeight = "100%";
    }
    return base;
  }, [runtime.viewConfig.fitMode, runtime.viewConfig.scalePercent, size.height, size.width]);

  useEffect(() => {
    return () => {
      if (edgeTimerRef.current != null) window.clearInterval(edgeTimerRef.current);
    };
  }, []);

  const overlayText = (() => {
    if (runtime.state === "idle") return "";
    if (runtime.state === "connecting") return t("plugin.remoteDesktop.connectingOverlay");
    if (runtime.state === "connected" && !runtime.frameMeta) return t("plugin.remoteDesktop.waitingFrame");
    if (runtime.state === "paused") return t("plugin.remoteDesktop.pausedOverlay");
    if (runtime.state === "error") return runtime.message || t("plugin.remoteDesktop.connectionError");
    if (!runtime.status?.captureAvailable && runtime.status) return runtime.status.warnings?.[0] || t("plugin.remoteDesktop.captureUnavailable");
    return "";
  })();

  const remoteCursor = runtime.controlEnabled && runtime.viewConfig.mobileInputMode === "mouse" && runtime.frameMeta ? runtime.remoteCursor : null;

  const handleEdgeMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    onPointerMove(event);
    if (runtime.viewConfig.scrollMode !== "edge") return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const edge = 28;
    const dx = event.clientX < rect.left + edge ? -18 : event.clientX > rect.right - edge ? 18 : 0;
    const dy = event.clientY < rect.top + edge ? -18 : event.clientY > rect.bottom - edge ? 18 : 0;
    if (!dx && !dy) {
      if (edgeTimerRef.current != null) window.clearInterval(edgeTimerRef.current);
      edgeTimerRef.current = null;
      return;
    }
    if (edgeTimerRef.current != null) return;
    edgeTimerRef.current = window.setInterval(() => {
      stage.scrollBy({ left: dx, top: dy });
    }, 32);
  };

  return (
    <div
      ref={stageRef}
      className={`relative min-h-0 flex-1 ${
        runtime.frameMeta ? "bg-black" : "bg-ide-bg"
      } ${runtime.viewConfig.scrollMode === "scrollbar" || runtime.viewConfig.fitMode !== "contain" ? "overflow-auto" : "overflow-hidden"
      }`}
      onPointerLeave={() => {
        onReleaseInput();
        if (edgeTimerRef.current != null) window.clearInterval(edgeTimerRef.current);
        edgeTimerRef.current = null;
      }}
    >
      {runtime.state === "idle" ? (
        <div className="grid min-h-full min-w-full place-items-center p-4 pb-12">
          <div className="flex flex-col items-center gap-3 text-xs text-ide-mute">
            <div className="grid h-16 w-16 place-items-center border border-ide-border bg-ide-panel text-ide-mute">
              <Power size={22} />
            </div>
            <span>{t("plugin.remoteDesktop.idleHint")}</span>
          </div>
        </div>
      ) : (
        <div className="grid min-h-full min-w-full place-items-center p-0">
          <div className="relative inline-block leading-none">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              className={`block outline-none ${runtime.controlEnabled ? "cursor-crosshair" : "cursor-default"} ${
                runtime.viewConfig.showLocalCursor ? "" : "cursor-none"
              }`}
              style={canvasStyle}
              onPointerMove={handleEdgeMove}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onContextMenu={(event) => event.preventDefault()}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onBlur={onReleaseInput}
            />
            {remoteCursor && (
              <div
                className="pointer-events-none absolute z-10 h-6 w-6 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
                style={{
                  left: `calc(${remoteCursor.x * 100}% - 2px)`,
                  top: `calc(${remoteCursor.y * 100}% - 2px)`,
                }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M5 3l14 9-6.2 1.2 3.8 6.1-2.7 1.7-3.7-6-4.2 4V3z" />
                </svg>
              </div>
            )}
          </div>
        </div>
      )}
      {overlayText && (
        <div className="absolute inset-0 grid place-items-center bg-black/45 text-sm text-white">
          <div className="border border-white/20 bg-black/70 px-4 py-2">{overlayText}</div>
        </div>
      )}
      <QosOverlay runtime={runtime} t={t} />
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 border-t border-ide-border bg-ide-panel/95 px-3 py-1.5 text-[11px] text-ide-mute">
        <div className="flex min-w-0 items-center gap-2">
          {runtime.controlEnabled ? <EyeOff size={12} /> : <Eye size={12} />}
          <span>{t(`plugin.remoteDesktop.state.${runtime.state}`)}</span>
          {runtime.status?.wayland && <span>{t("plugin.remoteDesktop.waylandLimited")}</span>}
          {runtime.message && <span className="truncate text-red-400">{runtime.message}</span>}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <MonitorUp size={12} />
          <span>{runtime.frameMeta ? `${runtime.frameMeta.width}x${runtime.frameMeta.height} #${runtime.frameMeta.seq}` : "-"}</span>
        </div>
      </div>
    </div>
  );
};

const QosOverlay: React.FC<{ runtime: RemoteDesktopRuntime; t: (key: string) => string }> = ({ runtime, t }) => {
  if (!runtime.qos && !runtime.frameMeta && runtime.latencyMs == null) return null;
  return (
    <div className="absolute right-3 top-3 border border-ide-border bg-ide-panel/95 px-2 py-1 text-[11px] text-ide-text shadow-sm">
      <div className="flex items-center gap-2">
        <span>{runtime.qos ? `${runtime.qos.effectiveFps}fps` : "-"}</span>
        <span>{runtime.qos ? `q${runtime.qos.effectiveQuality}` : "-"}</span>
        <span>{runtime.latencyMs != null ? `${runtime.latencyMs}ms` : "-"}</span>
      </div>
      <div className="mt-0.5 text-ide-mute">
        {runtime.qos ? `${t("plugin.remoteDesktop.pending")}: ${runtime.qos.pendingFrames}` : ""}
      </div>
    </div>
  );
};
