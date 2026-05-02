import { Columns, Maximize2, Minimize2, Rows, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalInstanceHandle, TerminalInstanceStateUpdate } from "@/components/terminal/terminal-instance";
import TerminalInstance from "@/components/terminal/terminal-instance";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import {
  clampSplitRatio,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type TerminalDividerRect,
  terminalLayoutRects,
} from "@/stores/terminal-layout";
import type { LayoutNode, SplitDirection, TerminalSession } from "@/stores/terminal-store";

interface TerminalSplitViewProps {
  layout: LayoutNode;
  groupId: string;
  focusedId: string | null;
  terminals: TerminalSession[];
  onFocus: (terminalId: string) => void;
  onExited: (terminalId: string) => void;
  onStateChange: (terminalId: string, state: TerminalInstanceStateUpdate) => void;
  onRatioChange: (path: number[], ratio: number) => void;
  onSplit: (direction: SplitDirection, terminalId: string) => void;
  onClose: (terminalId: string) => void;
  busy?: boolean;
  setTerminalRef?: (id: string) => (ref: TerminalInstanceHandle | null) => void;
}

// Keep each PTY view under the same keyed parent while the layout tree changes.
const TerminalSplitView: React.FC<TerminalSplitViewProps> = ({
  layout,
  focusedId,
  terminals,
  onFocus,
  onExited,
  onStateChange,
  onRatioChange,
  onSplit,
  onClose,
  busy,
  setTerminalRef,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const { panes, dividers } = useMemo(() => terminalLayoutRects(layout, isMobile), [layout, isMobile]);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const maximized = panes.some((pane) => pane.terminalId === maximizedId) ? maximizedId : null;
  useEffect(() => {
    if (!panes.some((pane) => pane.terminalId === maximizedId)) setMaximizedId(null);
  }, [panes, maximizedId]);
  const hasSplit = panes.length > 1;
  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      data-terminal-layout="true"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && maximized) {
          event.preventDefault();
          event.stopPropagation();
          setMaximizedId(null);
          return;
        }
        if (
          !event.altKey ||
          !event.shiftKey ||
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
        )
          return;
        const current = panes.find((pane) => pane.terminalId === focusedId);
        if (!current) return;
        const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
        const sign = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const center = (pane: typeof current) => (horizontal ? pane.x + pane.width / 2 : pane.y + pane.height / 2);
        const perpendicular = (pane: typeof current) =>
          horizontal ? pane.y + pane.height / 2 : pane.x + pane.width / 2;
        const next = panes
          .filter((pane) => pane !== current && (center(pane) - center(current)) * sign > 0.001)
          .sort(
            (a, b) =>
              Math.abs(center(a) - center(current)) +
              2 * Math.abs(perpendicular(a) - perpendicular(current)) -
              Math.abs(center(b) - center(current)) -
              2 * Math.abs(perpendicular(b) - perpendicular(current))
          )[0];
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          setMaximizedId(null);
          onFocus(next.terminalId);
        }
      }}
    >
      {panes.map((pane) => {
        const terminal = terminals.find((item) => item.id === pane.terminalId);
        if (!terminal) return null;
        const focused = pane.terminalId === focusedId;
        const rect = maximized === pane.terminalId ? { x: 0, y: 0, width: 1, height: 1 } : pane;
        const hidden = !!maximized && maximized !== pane.terminalId;
        const buttonClass =
          "flex h-11 w-11 shrink-0 md:h-7 md:w-7 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-40";
        return (
          <div
            key={pane.terminalId}
            data-pane-id={pane.terminalId}
            data-focused={focused}
            hidden={hidden}
            className={`absolute flex min-h-0 min-w-0 flex-col overflow-hidden ${hasSplit && focused ? "ring-1 ring-inset ring-ide-accent" : ""}`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              padding: hasSplit && !maximized ? 2 : 0,
            }}
            onPointerDownCapture={(event) => {
              if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-pane-toolbar]"))
                onFocus(pane.terminalId);
            }}
            onFocusCapture={(event) => {
              if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-pane-toolbar]"))
                onFocus(pane.terminalId);
            }}
          >
            {hasSplit && (
              <div
                className="flex h-11 shrink-0 items-center md:h-8 gap-1 border-b border-ide-border bg-ide-panel px-1"
                data-pane-toolbar={pane.terminalId}
              >
                <span
                  className={`min-w-0 flex-1 truncate px-1 text-xs ${focused ? "text-ide-text" : "text-ide-mute"}`}
                  title={terminal.currentCwd || terminal.cwd}
                >
                  {terminal.name}
                </span>
                {!isMobile && (
                  <button
                    type="button"
                    className={buttonClass}
                    title={t("terminal.splitRight")}
                    aria-label={t("terminal.splitRight")}
                    disabled={busy || terminal.status === "exited"}
                    onClick={() => onSplit("horizontal", pane.terminalId)}
                  >
                    <Columns size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  title={t("terminal.splitDown")}
                  aria-label={t("terminal.splitDown")}
                  disabled={busy || terminal.status === "exited"}
                  onClick={() => onSplit("vertical", pane.terminalId)}
                >
                  <Rows size={13} />
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  title={t(maximized ? "terminal.restorePane" : "terminal.maximizePane")}
                  aria-label={t(maximized ? "terminal.restorePane" : "terminal.maximizePane")}
                  onClick={() => {
                    onFocus(pane.terminalId);
                    setMaximizedId(maximized ? null : pane.terminalId);
                  }}
                >
                  {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
                <button
                  type="button"
                  className={`${buttonClass} hover:text-red-500`}
                  title={t("terminal.closeSplit")}
                  aria-label={t("terminal.closeSplit")}
                  disabled={busy}
                  onClick={() => onClose(pane.terminalId)}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <TerminalInstance
                ref={setTerminalRef?.(pane.terminalId)}
                terminalId={pane.terminalId}
                terminalName={terminal.name}
                isActive={!hidden}
                isFocused={focused && !hidden}
                isExited={terminal.status !== "running"}
                initialCwd={terminal.currentCwd || terminal.cwd}
                onExited={() => onExited(pane.terminalId)}
                onStateChange={(state) => onStateChange(pane.terminalId, state)}
              />
            </div>
          </div>
        );
      })}
      {!maximized &&
        dividers.map((divider) => (
          <TerminalDivider
            key={divider.path.join(".")}
            divider={divider}
            containerRef={containerRef}
            label={t("terminal.resizePanes")}
            onRatioChange={(ratio) => onRatioChange(divider.path, ratio)}
          />
        ))}
    </div>
  );
};

function TerminalDivider({
  divider,
  containerRef,
  label,
  onRatioChange,
}: {
  divider: TerminalDividerRect;
  containerRef: React.RefObject<HTMLDivElement | null>;
  label: string;
  onRatioChange: (ratio: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; start: number; size: number } | null>(null);
  const { vertical, ratio, x, y, width, height } = divider;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-valuemin={MIN_SPLIT_RATIO * 100}
      aria-valuemax={MAX_SPLIT_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      className={`absolute z-10 touch-none select-none ${dragging ? "bg-ide-accent/30" : "hover:bg-ide-accent/20"}`}
      style={
        vertical
          ? {
              left: `${x * 100}%`,
              top: `${(y + height * ratio) * 100}%`,
              width: `${width * 100}%`,
              height: 16,
              transform: "translateY(-50%)",
              cursor: "row-resize",
              zIndex: 20 - divider.path.length,
            }
          : {
              left: `${(x + width * ratio) * 100}%`,
              top: `${y * 100}%`,
              width: 16,
              height: `${height * 100}%`,
              transform: "translateX(-50%)",
              cursor: "col-resize",
              zIndex: 20 - divider.path.length,
            }
      }
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const bounds = containerRef.current?.getBoundingClientRect();
        if (!bounds) return;
        const size = vertical ? bounds.height * height : bounds.width * width;
        if (size <= 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          start: vertical ? bounds.top + bounds.height * y : bounds.left + bounds.width * x,
          size,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        onRatioChange(
          clampSplitRatio(((vertical ? event.clientY : event.clientX) - drag.current.start) / drag.current.size)
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) {
          drag.current = null;
          setDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => onRatioChange(0.5)}
      onKeyDown={(event) => {
        const negative = vertical ? "ArrowUp" : "ArrowLeft";
        const positive = vertical ? "ArrowDown" : "ArrowRight";
        if (![negative, positive, "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? MIN_SPLIT_RATIO
            : event.key === "End"
              ? MAX_SPLIT_RATIO
              : event.key === "Enter"
                ? 0.5
                : ratio + (event.key === negative ? -0.02 : 0.02);
        onRatioChange(clampSplitRatio(next));
      }}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bg-ide-border ${dragging ? "bg-ide-accent" : ""}`}
        style={vertical ? { left: 0, right: 0, top: 6, height: 4 } : { top: 0, bottom: 0, left: 6, width: 4 }}
      />
    </div>
  );
}

export default TerminalSplitView;
