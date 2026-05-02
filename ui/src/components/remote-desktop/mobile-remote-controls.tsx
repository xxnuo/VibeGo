import { ChevronDown, ChevronUp, Hand, Keyboard, Menu, Mouse, MousePointer2, Power } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import type { ConfigPatch, MobileInputMode, RemoteDesktopRuntime, SpecialKey } from "./types";

interface MobileControlsProps {
  runtime: RemoteDesktopRuntime;
  t: (key: string) => string;
  onConnectToggle: () => void;
  onConfigure: (patch?: ConfigPatch) => void;
  onSpecialKey: (key: SpecialKey) => void;
  onWheel: (deltaY: number) => void;
  onButton: (button: "left" | "middle" | "right", down: boolean) => void;
  onKeyboardText: (text: string) => void;
  onClipboardRead: () => void;
  onClipboardWrite: () => void;
  onShowDesktopToolbar: () => void;
}

export const MobileRemoteControls: React.FC<MobileControlsProps> = ({
  runtime,
  t,
  onConnectToggle,
  onConfigure,
  onSpecialKey,
  onWheel,
  onButton,
  onKeyboardText,
  onClipboardRead,
  onClipboardWrite,
  onShowDesktopToolbar,
}) => {
  const [barVisible, setBarVisible] = useState(true);
  const [panel, setPanel] = useState<"gesture" | "keyboard" | "more" | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (panel === "keyboard") inputRef.current?.focus();
  }, [panel]);

  return (
    <div className="md:hidden">
      {runtime.viewConfig.showVirtualMouse && (
        <VirtualMouse
          scale={runtime.viewConfig.virtualMouseScale}
          mode={runtime.viewConfig.mobileInputMode}
          t={t}
          onWheel={onWheel}
          onButton={onButton}
        />
      )}
      {panel && (
        <div className="absolute inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 max-h-[min(62dvh,28rem)] overflow-y-auto border-y border-ide-border bg-ide-panel p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-xs text-ide-text shadow-sm">
          {panel === "gesture" && <GesturePanel runtime={runtime} t={t} onConfigure={onConfigure} />}
          {panel === "keyboard" && (
            <div className="grid gap-2">
              <textarea
                ref={inputRef}
                id="remote-desktop-mobile-keyboard"
                name="remote-desktop-mobile-keyboard"
                aria-label={t("plugin.remoteDesktop.mobileKeyboardPlaceholder")}
                className="h-20 resize-none border border-ide-border bg-ide-bg p-2 outline-none"
                placeholder={t("plugin.remoteDesktop.mobileKeyboardPlaceholder")}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value) onKeyboardText(value);
                  event.target.value = "";
                }}
              />
              <div className="grid grid-cols-5 gap-2">
                {(["esc", "tab", "enter", "left", "right"] as SpecialKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="min-h-11 border border-ide-border bg-ide-bg"
                    onClick={() => onSpecialKey(key)}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
          )}
          {panel === "more" && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="min-h-11 border border-ide-border bg-ide-bg px-2"
                onClick={onClipboardRead}
              >
                {t("plugin.remoteDesktop.readClipboard")}
              </button>
              <button
                type="button"
                className="min-h-11 border border-ide-border bg-ide-bg px-2"
                onClick={onClipboardWrite}
              >
                {t("plugin.remoteDesktop.writeClipboard")}
              </button>
              <button
                type="button"
                className="min-h-11 border border-ide-border bg-ide-bg px-2"
                onClick={() => onSpecialKey("ctrlAltDel")}
              >
                Ctrl Alt Del
              </button>
              <button
                type="button"
                className="min-h-11 border border-ide-border bg-ide-bg px-2"
                onClick={() => onSpecialKey("lock")}
              >
                {t("plugin.remoteDesktop.lock")}
              </button>
              <button
                type="button"
                className="min-h-11 border border-ide-border bg-ide-bg px-2"
                onClick={() => {
                  setPanel(null);
                  onShowDesktopToolbar();
                }}
              >
                {t("plugin.remoteDesktop.desktopToolbar")}
              </button>
              <button
                type="button"
                className="min-h-11 border border-ide-border bg-ide-bg px-2"
                onClick={() => setPanel(null)}
              >
                {t("plugin.remoteDesktop.closePanel")}
              </button>
            </div>
          )}
        </div>
      )}
      {barVisible ? (
        <div className="absolute inset-x-0 bottom-0 z-50 flex h-[calc(3.5rem+env(safe-area-inset-bottom))] min-h-[calc(3.5rem+env(safe-area-inset-bottom))] items-center justify-between border-t border-ide-border bg-ide-accent pb-[env(safe-area-inset-bottom)] text-ide-on-accent">
          <IconButton
            label={
              runtime.state === "idle" || runtime.state === "error"
                ? t("plugin.remoteDesktop.connect")
                : t("plugin.remoteDesktop.disconnect")
            }
            onClick={onConnectToggle}
          >
            <Power size={18} />
          </IconButton>
          <IconButton
            label={t("plugin.remoteDesktop.input")}
            onClick={() => setPanel(panel === "gesture" ? null : "gesture")}
          >
            {runtime.viewConfig.mobileInputMode === "touch" ? <Hand size={18} /> : <Mouse size={18} />}
          </IconButton>
          <IconButton
            label={t("plugin.remoteDesktop.keyboardText")}
            onClick={() => setPanel(panel === "keyboard" ? null : "keyboard")}
          >
            <Keyboard size={18} />
          </IconButton>
          <IconButton
            label={t("plugin.remoteDesktop.showVirtualMouse")}
            onClick={() => onConfigure({ showVirtualMouse: !runtime.viewConfig.showVirtualMouse })}
          >
            <MousePointer2 size={18} />
          </IconButton>
          <IconButton label={t("common.moreActions")} onClick={() => setPanel(panel === "more" ? null : "more")}>
            <Menu size={18} />
          </IconButton>
          <IconButton label={t("plugin.remoteDesktop.hideToolbar")} onClick={() => setBarVisible(false)}>
            <ChevronDown size={18} />
          </IconButton>
        </div>
      ) : (
        <button
          type="button"
          className="absolute right-3 z-50 grid size-11 place-items-center border border-ide-border bg-ide-accent text-ide-on-accent shadow-sm"
          style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          onClick={() => setBarVisible(true)}
          aria-label={t("plugin.remoteDesktop.showToolbar")}
          title={t("plugin.remoteDesktop.showToolbar")}
        >
          <ChevronUp size={18} />
        </button>
      )}
    </div>
  );
};

const GesturePanel: React.FC<{
  runtime: RemoteDesktopRuntime;
  t: (key: string) => string;
  onConfigure: (patch?: ConfigPatch) => void;
}> = ({ runtime, t, onConfigure }) => {
  const setMode = (mobileInputMode: MobileInputMode) => onConfigure({ mobileInputMode });
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`min-h-11 border border-ide-border ${runtime.viewConfig.mobileInputMode === "mouse" ? "bg-ide-accent text-ide-on-accent" : "bg-ide-bg"}`}
          onClick={() => setMode("mouse")}
        >
          {t("plugin.remoteDesktop.mouseMode")}
        </button>
        <button
          type="button"
          className={`min-h-11 border border-ide-border ${runtime.viewConfig.mobileInputMode === "touch" ? "bg-ide-accent text-ide-on-accent" : "bg-ide-bg"}`}
          onClick={() => setMode("touch")}
        >
          {t("plugin.remoteDesktop.touchMode")}
        </button>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span>{t("plugin.remoteDesktop.showVirtualMouse")}</span>
        <button
          type="button"
          className={`min-h-11 min-w-16 border border-ide-border ${runtime.viewConfig.showVirtualMouse ? "bg-ide-accent text-ide-on-accent" : "bg-ide-bg"}`}
          onClick={() => onConfigure({ showVirtualMouse: !runtime.viewConfig.showVirtualMouse })}
        >
          {runtime.viewConfig.showVirtualMouse ? "ON" : "OFF"}
        </button>
      </label>
      <label className="grid grid-cols-[80px_1fr_42px] items-center gap-2">
        <span className="text-ide-mute">{t("plugin.remoteDesktop.virtualMouseSize")}</span>
        <Slider
          value={[runtime.viewConfig.virtualMouseScale]}
          min={80}
          max={180}
          step={5}
          onValueChange={([value]) => onConfigure({ virtualMouseScale: value ?? runtime.viewConfig.virtualMouseScale })}
        />
        <span className="text-right">{runtime.viewConfig.virtualMouseScale}%</span>
      </label>
      <div className="grid gap-1 text-ide-mute">
        <span>{t("plugin.remoteDesktop.gestureTap")}</span>
        <span>{t("plugin.remoteDesktop.gestureDrag")}</span>
        <span>{t("plugin.remoteDesktop.gesturePinch")}</span>
      </div>
    </div>
  );
};

const VirtualMouse: React.FC<{
  scale: number;
  mode: MobileInputMode;
  t: (key: string) => string;
  onWheel: (deltaY: number) => void;
  onButton: (button: "left" | "middle" | "right", down: boolean) => void;
}> = ({ scale, mode, t, onWheel, onButton }) => {
  const factor = scale / 100;
  const wheelWidth = Math.max(44, 48 * factor);
  const wheelHeight = Math.max(132, 150 * factor);
  const buttonBarWidth = Math.max(150, 150 * factor);
  const buttonBarHeight = Math.max(46, 46 * factor);
  return (
    <>
      <div
        className="absolute right-4 top-1/2 z-30 grid -translate-y-1/2 overflow-hidden border border-white/70 bg-black/40 text-white"
        style={{ width: wheelWidth, height: wheelHeight }}
      >
        <HoldButton label={t("plugin.remoteDesktop.scrollUp")} onHold={() => onWheel(-80)}>
          ▲
        </HoldButton>
        <HoldButton
          label={t("plugin.remoteDesktop.middleButton")}
          onDown={() => onButton("middle", true)}
          onUp={() => onButton("middle", false)}
        >
          •
        </HoldButton>
        <HoldButton label={t("plugin.remoteDesktop.scrollDown")} onHold={() => onWheel(80)}>
          ▼
        </HoldButton>
      </div>
      <div
        className="absolute left-1/2 z-30 grid -translate-x-1/2 grid-cols-2 overflow-hidden border border-white/70 bg-black/40 text-white"
        style={{
          bottom: "calc(3.5rem + env(safe-area-inset-bottom) + 0.75rem)",
          width: buttonBarWidth,
          height: buttonBarHeight,
        }}
      >
        <HoldButton
          label={t("plugin.remoteDesktop.leftButton")}
          onDown={() => onButton("left", true)}
          onUp={() => onButton("left", false)}
        >
          L
        </HoldButton>
        <HoldButton
          label={t("plugin.remoteDesktop.rightButton")}
          onDown={() => onButton("right", true)}
          onUp={() => onButton("right", false)}
        >
          R
        </HoldButton>
      </div>
      {mode === "mouse" && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 grid -translate-x-1/2 -translate-y-1/2 place-items-center border border-white/60 bg-black/20 text-white/80"
          style={{ width: 92 * factor, height: 92 * factor }}
        >
          <MousePointer2 size={26 * factor} />
        </div>
      )}
    </>
  );
};

const HoldButton: React.FC<{
  children: React.ReactNode;
  label: string;
  onHold?: () => void;
  onDown?: () => void;
  onUp?: () => void;
}> = ({ children, label, onHold, onDown, onUp }) => {
  const timerRef = useRef<number | null>(null);
  const clear = () => {
    if (timerRef.current != null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    onUp?.();
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid place-items-center border border-white/40 active:bg-ide-accent"
      onPointerDown={() => {
        onDown?.();
        onHold?.();
        if (onHold) timerRef.current = window.setInterval(onHold, 110);
      }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      {children}
    </button>
  );
};

const IconButton: React.FC<{ children: React.ReactNode; label: string; onClick: () => void }> = ({
  children,
  label,
  onClick,
}) => (
  <button
    type="button"
    className="grid h-14 min-w-11 flex-1 place-items-center hover:bg-black/10"
    onClick={onClick}
    title={label}
    aria-label={label}
  >
    {children}
  </button>
);
