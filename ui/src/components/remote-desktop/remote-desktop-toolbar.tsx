import {
  ChevronDown,
  ChevronUp,
  Clipboard,
  Eye,
  EyeOff,
  Keyboard,
  Maximize2,
  Monitor,
  MousePointer2,
  Pause,
  Pin,
  PinOff,
  Play,
  Power,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import React, { useEffect, useRef } from "react";
import type { RemoteDesktopDisplay } from "@/api/remote-desktop";
import { Slider } from "@/components/ui/slider";
import type {
  ActiveMenu,
  ConfigPatch,
  FitMode,
  KeyboardMode,
  QualityPreset,
  RemoteDesktopRuntime,
  ScrollMode,
  SpecialKey,
  ToolbarState,
} from "./types";

interface ToolbarProps {
  runtime: RemoteDesktopRuntime;
  toolbar: ToolbarState;
  activeMenu: ActiveMenu;
  t: (key: string) => string;
  onToolbarChange: (patch: Partial<ToolbarState>) => void;
  onActiveMenuChange: (menu: ActiveMenu) => void;
  onConnectToggle: () => void;
  onPauseToggle: () => void;
  onRefresh: () => void;
  onFullscreen: () => void;
  onConfigure: (patch?: ConfigPatch) => void;
  onClipboardTextChange: (value: string) => void;
  onClipboardRead: () => void;
  onClipboardWrite: () => void;
  onSpecialKey: (key: SpecialKey) => void;
}

const buttonClass =
  "h-11 w-11 shrink-0 grid place-items-center border border-ide-border bg-ide-panel text-ide-text hover:bg-ide-border/50 disabled:opacity-40 md:h-8 md:w-8";
const menuButtonClass =
  "min-h-11 px-3 flex items-center justify-center gap-1.5 border border-ide-border bg-ide-panel text-xs hover:bg-ide-border/50 md:min-h-0 md:h-8 md:px-2";

const qualityPresets: Record<QualityPreset, { fps: number; quality: number }> = {
  smooth: { fps: 20, quality: 55 },
  balanced: { fps: 12, quality: 70 },
  sharp: { fps: 8, quality: 88 },
  custom: { fps: 12, quality: 70 },
};

export const RemoteDesktopToolbar: React.FC<ToolbarProps> = ({
  runtime,
  toolbar,
  activeMenu,
  t,
  onToolbarChange,
  onActiveMenuChange,
  onConnectToggle,
  onPauseToggle,
  onRefresh,
  onFullscreen,
  onConfigure,
  onClipboardTextChange,
  onClipboardRead,
  onClipboardWrite,
  onSpecialKey,
}) => {
  const dragRef = useRef<{ startX: number; startToolbarX: number } | null>(null);
  const isLive = runtime.state === "connected" || runtime.state === "paused";

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.min(
        0.95,
        Math.max(0.05, drag.startToolbarX + (event.clientX - drag.startX) / window.innerWidth)
      );
      onToolbarChange({ x: next });
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [onToolbarChange]);

  const toggleMenu = (menu: ActiveMenu) => onActiveMenuChange(activeMenu === menu ? null : menu);
  const setFitMode = (fitMode: FitMode) => onConfigure({ fitMode });
  const setScrollMode = (scrollMode: ScrollMode) => onConfigure({ scrollMode });
  const setKeyboardMode = (keyboardMode: KeyboardMode) => onConfigure({ keyboardMode });
  const setQualityPreset = (qualityPreset: QualityPreset) => {
    const preset = qualityPresets[qualityPreset];
    onConfigure({ qualityPreset, fps: preset.fps, quality: preset.quality });
  };

  if (toolbar.hidden) {
    return (
      <button
        type="button"
        className="absolute top-0 z-40 min-h-11 px-3 border border-t-0 border-ide-border bg-ide-panel text-xs text-ide-text md:z-30 md:min-h-0 md:h-7 md:px-2"
        style={{ left: `${toolbar.x * 100}%`, transform: "translateX(-50%)" }}
        onClick={() => onToolbarChange({ hidden: false, collapsed: false })}
        aria-label={t("plugin.remoteDesktop.showToolbar")}
      >
        {t("plugin.remoteDesktop.showToolbar")}
      </button>
    );
  }

  return (
    <div
      className="absolute top-0 z-40 flex flex-col items-center md:z-30"
      style={{ left: `${toolbar.x * 100}%`, transform: "translateX(-50%)" }}
    >
      {!toolbar.collapsed && (
        <div className="mt-2 flex max-w-[calc(100vw-32px)] items-center overflow-x-auto border border-ide-border bg-ide-panel shadow-sm">
          <button
            type="button"
            className={buttonClass}
            onClick={() => onToolbarChange({ pinned: !toolbar.pinned })}
            title={t(toolbar.pinned ? "common.unpin" : "common.pin")}
            aria-label={t(toolbar.pinned ? "common.unpin" : "common.pin")}
          >
            {toolbar.pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button type="button" className={menuButtonClass} onClick={onConnectToggle}>
            <Power size={14} />
            {runtime.state === "idle" || runtime.state === "error"
              ? t("plugin.remoteDesktop.connect")
              : t("plugin.remoteDesktop.disconnect")}
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={onPauseToggle}
            disabled={!isLive}
            title={t(runtime.state === "paused" ? "plugin.remoteDesktop.resume" : "plugin.remoteDesktop.pause")}
            aria-label={t(runtime.state === "paused" ? "plugin.remoteDesktop.resume" : "plugin.remoteDesktop.pause")}
          >
            {runtime.state === "paused" ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <ToolbarMenuButton
            active={activeMenu === "display"}
            icon={<Monitor size={14} />}
            label={t("plugin.remoteDesktop.display")}
            onClick={() => toggleMenu("display")}
          />
          <ToolbarMenuButton
            active={activeMenu === "quality"}
            icon={<SlidersHorizontal size={14} />}
            label={t("plugin.remoteDesktop.quality")}
            onClick={() => toggleMenu("quality")}
          />
          <ToolbarMenuButton
            active={activeMenu === "input"}
            icon={<Keyboard size={14} />}
            label={t("plugin.remoteDesktop.input")}
            onClick={() => toggleMenu("input")}
          />
          <ToolbarMenuButton
            active={activeMenu === "clipboard"}
            icon={<Clipboard size={14} />}
            label={t("plugin.remoteDesktop.clipboard")}
            onClick={() => toggleMenu("clipboard")}
          />
          <button
            type="button"
            className={buttonClass}
            onClick={onFullscreen}
            title={t("plugin.remoteDesktop.fullscreen")}
            aria-label={t("plugin.remoteDesktop.fullscreen")}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={onRefresh}
            title={t("plugin.remoteDesktop.refresh")}
            aria-label={t("plugin.remoteDesktop.refresh")}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => onToolbarChange({ hidden: true })}
            title={t("plugin.remoteDesktop.hideToolbar")}
            aria-label={t("plugin.remoteDesktop.hideToolbar")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {activeMenu && !toolbar.collapsed && (
        <div className="mt-1 max-h-[calc(100dvh-4rem)] w-[min(520px,calc(100vw-32px))] overflow-y-auto overscroll-contain border border-ide-border bg-ide-panel p-2 text-xs text-ide-text shadow-sm">
          {activeMenu === "display" && (
            <DisplayMenu
              runtime={runtime}
              t={t}
              onConfigure={onConfigure}
              onFitMode={setFitMode}
              onScrollMode={setScrollMode}
            />
          )}
          {activeMenu === "quality" && (
            <QualityMenu runtime={runtime} t={t} onConfigure={onConfigure} onPreset={setQualityPreset} />
          )}
          {activeMenu === "input" && (
            <InputMenu
              runtime={runtime}
              t={t}
              onConfigure={onConfigure}
              onKeyboardMode={setKeyboardMode}
              onSpecialKey={onSpecialKey}
            />
          )}
          {activeMenu === "clipboard" && (
            <ClipboardMenu
              runtime={runtime}
              t={t}
              onConfigure={onConfigure}
              onTextChange={onClipboardTextChange}
              onRead={onClipboardRead}
              onWrite={onClipboardWrite}
            />
          )}
        </div>
      )}
      <button
        type="button"
        className="min-h-11 min-w-24 border border-t-0 border-ide-border bg-ide-panel text-ide-mute hover:text-ide-text md:min-h-0 md:h-6 md:min-w-20"
        onPointerDown={(event) => {
          dragRef.current = { startX: event.clientX, startToolbarX: toolbar.x };
        }}
        onDoubleClick={() => onToolbarChange({ collapsed: !toolbar.collapsed })}
      >
        <span className="inline-flex items-center gap-1">
          {toolbar.collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span className="text-[11px]">
            {toolbar.collapsed ? t("plugin.remoteDesktop.showToolbar") : t("plugin.remoteDesktop.dragToolbar")}
          </span>
        </span>
      </button>
    </div>
  );
};

const ToolbarMenuButton: React.FC<{ active: boolean; icon: React.ReactNode; label: string; onClick: () => void }> = ({
  active,
  icon,
  label,
  onClick,
}) => (
  <button
    type="button"
    className={`min-h-11 shrink-0 px-3 flex items-center gap-1.5 border-y border-r border-ide-border text-xs md:min-h-0 md:h-8 md:px-2 ${
      active ? "bg-ide-accent text-ide-on-accent" : "bg-ide-panel text-ide-text hover:bg-ide-border/50"
    }`}
    onClick={onClick}
  >
    {icon}
    {label}
  </button>
);

const DisplayMenu: React.FC<{
  runtime: RemoteDesktopRuntime;
  t: (key: string) => string;
  onConfigure: (patch?: ConfigPatch) => void;
  onFitMode: (mode: FitMode) => void;
  onScrollMode: (mode: ScrollMode) => void;
}> = ({ runtime, t, onConfigure, onFitMode, onScrollMode }) => (
  <div className="grid gap-3">
    <MonitorLayout
      displays={runtime.displays}
      current={runtime.displayId}
      onSelect={(displayId) => onConfigure({ displayId })}
    />
    <Segmented
      label={t("plugin.remoteDesktop.viewMode")}
      value={runtime.viewConfig.fitMode}
      options={[
        ["contain", t("plugin.remoteDesktop.fitContain")],
        ["original", t("plugin.remoteDesktop.fitOriginal")],
        ["custom", t("plugin.remoteDesktop.fitCustom")],
      ]}
      onChange={(value) => onFitMode(value as FitMode)}
    />
    {runtime.viewConfig.fitMode === "custom" && (
      <SliderRow
        label={t("plugin.remoteDesktop.scale")}
        value={runtime.viewConfig.scalePercent}
        min={25}
        max={300}
        suffix="%"
        onValue={(scalePercent) => onConfigure({ scalePercent })}
      />
    )}
    <Segmented
      label={t("plugin.remoteDesktop.scrollMode")}
      value={runtime.viewConfig.scrollMode}
      options={[
        ["auto", t("plugin.remoteDesktop.scrollAuto")],
        ["scrollbar", t("plugin.remoteDesktop.scrollbar")],
        ["edge", t("plugin.remoteDesktop.scrollEdge")],
      ]}
      onChange={(value) => onScrollMode(value as ScrollMode)}
    />
  </div>
);

const QualityMenu: React.FC<{
  runtime: RemoteDesktopRuntime;
  t: (key: string) => string;
  onConfigure: (patch?: ConfigPatch) => void;
  onPreset: (preset: QualityPreset) => void;
}> = ({ runtime, t, onConfigure, onPreset }) => (
  <div className="grid gap-3">
    <Segmented
      label={t("plugin.remoteDesktop.qualityPreset")}
      value={runtime.viewConfig.qualityPreset}
      options={[
        ["smooth", t("plugin.remoteDesktop.presetSmooth")],
        ["balanced", t("plugin.remoteDesktop.presetBalanced")],
        ["sharp", t("plugin.remoteDesktop.presetSharp")],
        ["custom", t("plugin.remoteDesktop.presetCustom")],
      ]}
      onChange={(value) => onPreset(value as QualityPreset)}
    />
    <SliderRow
      label="FPS"
      value={runtime.fps}
      min={runtime.status?.minFps ?? 1}
      max={runtime.status?.maxFps ?? 20}
      onValue={(fps) => onConfigure({ fps, qualityPreset: "custom" })}
    />
    <SliderRow
      label={t("plugin.remoteDesktop.quality")}
      value={runtime.quality}
      min={runtime.status?.minQuality ?? 40}
      max={runtime.status?.maxQuality ?? 90}
      onValue={(quality) => onConfigure({ quality, qualityPreset: "custom" })}
    />
  </div>
);

const InputMenu: React.FC<{
  runtime: RemoteDesktopRuntime;
  t: (key: string) => string;
  onConfigure: (patch?: ConfigPatch) => void;
  onKeyboardMode: (mode: KeyboardMode) => void;
  onSpecialKey: (key: SpecialKey) => void;
}> = ({ runtime, t, onConfigure, onKeyboardMode, onSpecialKey }) => (
  <div className="grid gap-3">
    <div className="grid grid-cols-2 gap-2">
      <ToggleButton
        active={runtime.controlEnabled}
        disabled={!runtime.status?.capabilities?.input}
        onClick={() => onConfigure({ controlEnabled: !runtime.controlEnabled })}
      >
        <MousePointer2 size={14} />
        {t("plugin.remoteDesktop.controlOn")}
      </ToggleButton>
      <ToggleButton active={!runtime.controlEnabled} onClick={() => onConfigure({ controlEnabled: false })}>
        <Eye size={14} />
        {t("plugin.remoteDesktop.viewOnly")}
      </ToggleButton>
      <ToggleButton
        active={runtime.viewConfig.showLocalCursor}
        onClick={() => onConfigure({ showLocalCursor: !runtime.viewConfig.showLocalCursor })}
      >
        {runtime.viewConfig.showLocalCursor ? <Eye size={14} /> : <EyeOff size={14} />}
        {t("plugin.remoteDesktop.localCursor")}
      </ToggleButton>
      <ToggleButton
        active={runtime.viewConfig.keyboardMode === "text"}
        onClick={() => onKeyboardMode(runtime.viewConfig.keyboardMode === "text" ? "legacy" : "text")}
      >
        <Keyboard size={14} />
        {runtime.viewConfig.keyboardMode === "text"
          ? t("plugin.remoteDesktop.keyboardText")
          : t("plugin.remoteDesktop.keyboardLegacy")}
      </ToggleButton>
    </div>
    <div className="grid grid-cols-3 gap-2">
      {[
        ["ctrlAltDel", "Ctrl Alt Del"],
        ["lock", t("plugin.remoteDesktop.lock")],
        ["esc", "Esc"],
        ["tab", "Tab"],
        ["enter", "Enter"],
        ["up", "↑"],
        ["left", "←"],
        ["down", "↓"],
        ["right", "→"],
      ].map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="min-h-11 border border-ide-border bg-ide-bg hover:bg-ide-border/50 md:min-h-0 md:h-8"
          onClick={() => onSpecialKey(key as SpecialKey)}
          aria-label={label}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
);

const ClipboardMenu: React.FC<{
  runtime: RemoteDesktopRuntime;
  t: (key: string) => string;
  onConfigure: (patch?: ConfigPatch) => void;
  onTextChange: (value: string) => void;
  onRead: () => void;
  onWrite: () => void;
}> = ({ runtime, t, onConfigure, onTextChange, onRead, onWrite }) => (
  <div className="grid gap-2">
    <textarea
      id="remote-desktop-clipboard"
      name="remote-desktop-clipboard"
      aria-label={t("plugin.remoteDesktop.clipboardPlaceholder")}
      className="h-24 resize-none border border-ide-border bg-ide-bg p-2 text-base outline-none md:text-xs"
      value={runtime.clipboardText}
      onChange={(event) => onTextChange(event.target.value)}
      placeholder={t("plugin.remoteDesktop.clipboardPlaceholder")}
    />
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={menuButtonClass} onClick={onRead}>
        {t("plugin.remoteDesktop.readClipboard")}
      </button>
      <button
        type="button"
        className={menuButtonClass}
        onClick={onWrite}
        disabled={!runtime.status?.capabilities?.clipboard}
      >
        {t("plugin.remoteDesktop.writeClipboard")}
      </button>
      <ToggleButton
        active={runtime.clipboardSync}
        disabled={!runtime.status?.capabilities?.clipboardSync}
        onClick={() => onConfigure({ clipboardSync: !runtime.clipboardSync })}
      >
        {t("plugin.remoteDesktop.sync")}
      </ToggleButton>
    </div>
  </div>
);

const MonitorLayout: React.FC<{
  displays: RemoteDesktopDisplay[];
  current: number;
  onSelect: (displayId: number) => void;
}> = ({ displays, current, onSelect }) => {
  if (displays.length === 0) return <div className="text-ide-mute">-</div>;
  const minX = Math.min(...displays.map((d) => d.x));
  const minY = Math.min(...displays.map((d) => d.y));
  const maxX = Math.max(...displays.map((d) => d.x + d.width));
  const maxY = Math.max(...displays.map((d) => d.y + d.height));
  const scale = Math.min(220 / Math.max(maxX - minX, 1), 78 / Math.max(maxY - minY, 1));
  return (
    <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
      <div className="relative h-20 w-full border border-ide-border bg-ide-bg md:w-56">
        {displays.map((display) => (
          <button
            key={display.id}
            type="button"
            className={`absolute grid place-items-center border text-[11px] ${
              display.id === current
                ? "border-ide-accent bg-ide-accent text-ide-on-accent"
                : "border-ide-border bg-ide-panel text-ide-text"
            }`}
            style={{
              left: (display.x - minX) * scale + 4,
              top: (display.y - minY) * scale + 4,
              width: Math.max(28, display.width * scale),
              height: Math.max(20, display.height * scale),
            }}
            onClick={() => onSelect(display.id)}
          >
            {display.id + 1}
          </button>
        ))}
      </div>
      <select
        id="remote-desktop-display"
        name="remote-desktop-display"
        aria-label="Display"
        className="min-h-11 min-w-0 flex-1 border border-ide-border bg-ide-bg px-2 text-base md:min-h-0 md:h-8 md:text-xs"
        value={current}
        onChange={(event) => onSelect(Number(event.target.value))}
      >
        {displays.map((display) => (
          <option key={display.id} value={display.id}>
            {display.id + 1} - {display.width}x{display.height}
          </option>
        ))}
      </select>
    </div>
  );
};

const Segmented: React.FC<{
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <label className="grid gap-1">
    <span className="text-ide-mute">{label}</span>
    <div className="grid" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          className={`min-h-11 border border-ide-border px-1 text-xs md:min-h-0 md:h-8 ${value === key ? "bg-ide-accent text-ide-on-accent" : "bg-ide-bg hover:bg-ide-border/50"}`}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  </label>
);

const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onValue: (value: number) => void;
}> = ({ label, value, min, max, suffix = "", onValue }) => (
  <label className="grid grid-cols-[72px_1fr_46px] items-center gap-2">
    <span className="text-ide-mute">{label}</span>
    <Slider
      className="h-11 md:h-auto"
      value={[value]}
      min={min}
      max={max}
      step={1}
      onValueChange={([next]) => onValue(next ?? value)}
    />
    <span className="text-right tabular-nums">
      {value}
      {suffix}
    </span>
  </label>
);

const ToggleButton: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, disabled, onClick, children }) => (
  <button
    type="button"
    className={`min-h-11 px-2 flex items-center justify-center gap-1.5 border border-ide-border text-xs disabled:opacity-40 md:min-h-0 md:h-8 ${
      active ? "bg-ide-accent text-ide-on-accent" : "bg-ide-bg hover:bg-ide-border/50"
    }`}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
);
