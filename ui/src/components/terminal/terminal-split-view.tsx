import React, { useCallback, useEffect, useRef, useState } from "react";
import TerminalInstance from "@/components/terminal/terminal-instance";
import type { TerminalInstanceStateUpdate } from "@/components/terminal/terminal-instance-types";
import type { LayoutNode } from "@/stores/terminal-store";

interface TerminalSplitViewProps {
  layout: LayoutNode;
  groupId: string;
  focusedId: string | null;
  terminals: Array<{ id: string; name: string; status?: string }>;
  onFocus: (terminalId: string) => void;
  onExited: (terminalId: string) => void;
  onStateChange: (terminalId: string, state: TerminalInstanceStateUpdate) => void;
  onRatioChange: (path: number[], ratio: number) => void;
  path?: number[];
}

const DIVIDER_SIZE = 4;
const MIN_PANE_RATIO = 0.1;
const MAX_PANE_RATIO = 0.9;

const TerminalSplitView: React.FC<TerminalSplitViewProps> = ({
  layout,
  groupId,
  focusedId,
  terminals,
  onFocus,
  onExited,
  onStateChange,
  onRatioChange,
  path = [],
}) => {
  if (layout.type === "terminal") {
    const terminal = terminals.find((t) => t.id === layout.terminalId);
    const isFocused = focusedId === layout.terminalId;
    const handleExited = () => onExited(layout.terminalId);
    const handleStateChange = (state: TerminalInstanceStateUpdate) => onStateChange(layout.terminalId, state);
    return (
      <div
        className={`relative h-full w-full ${isFocused ? "ring-1 ring-ide-accent ring-inset" : ""}`}
        onClick={() => onFocus(layout.terminalId)}
      >
        <TerminalInstance
          terminalId={layout.terminalId}
          terminalName={terminal?.name || "Terminal"}
          isActive={true}
          isFocused={isFocused}
          isExited={terminal?.status !== "running"}
          onExited={handleExited}
          onStateChange={handleStateChange}
        />
      </div>
    );
  }

  return (
    <SplitContainer
      direction={layout.direction}
      ratio={layout.ratio}
      onRatioChange={(ratio) => onRatioChange(path, ratio)}
    >
      <TerminalSplitView
        layout={layout.first}
        groupId={groupId}
        focusedId={focusedId}
        terminals={terminals}
        onFocus={onFocus}
        onExited={onExited}
        onStateChange={onStateChange}
        onRatioChange={onRatioChange}
        path={[...path, 0]}
      />
      <TerminalSplitView
        layout={layout.second}
        groupId={groupId}
        focusedId={focusedId}
        terminals={terminals}
        onFocus={onFocus}
        onExited={onExited}
        onStateChange={onStateChange}
        onRatioChange={onRatioChange}
        path={[...path, 1]}
      />
    </SplitContainer>
  );
};

interface SplitContainerProps {
  direction: "horizontal" | "vertical";
  ratio: number;
  onRatioChange: (ratio: number) => void;
  children: [React.ReactNode, React.ReactNode];
}

const SplitContainer: React.FC<SplitContainerProps> = ({ direction, ratio, onRatioChange, children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const isVertical = direction === "vertical";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const totalSize = isVertical ? rect.height : rect.width;
      const startPos = isVertical ? rect.top : rect.left;

      const onMouseMove = (ev: MouseEvent) => {
        const currentPos = isVertical ? ev.clientY : ev.clientX;
        let newRatio = (currentPos - startPos) / totalSize;
        newRatio = Math.max(MIN_PANE_RATIO, Math.min(MAX_PANE_RATIO, newRatio));
        onRatioChange(newRatio);
      };

      const onMouseUp = () => {
        setDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [isVertical, onRatioChange]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      setDragging(true);

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const totalSize = isVertical ? rect.height : rect.width;
      const startPos = isVertical ? rect.top : rect.left;

      const onTouchMove = (ev: TouchEvent) => {
        const touch = ev.touches[0];
        if (!touch) return;
        const currentPos = isVertical ? touch.clientY : touch.clientX;
        let newRatio = (currentPos - startPos) / totalSize;
        newRatio = Math.max(MIN_PANE_RATIO, Math.min(MAX_PANE_RATIO, newRatio));
        onRatioChange(newRatio);
      };

      const onTouchEnd = () => {
        setDragging(false);
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
      };

      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
    },
    [isVertical, onRatioChange]
  );

  useEffect(() => {
    if (dragging) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
    } else {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging, isVertical]);

  const pctFirst = `${ratio * 100}%`;
  const pctSecond = `${(1 - ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      style={{
        display: "flex",
        flexDirection: isVertical ? "column" : "row",
      }}
    >
      <div
        style={{
          [isVertical ? "height" : "width"]: `calc(${pctFirst} - ${DIVIDER_SIZE / 2}px)`,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {children[0]}
      </div>
      <div
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className={`shrink-0 bg-ide-border hover:bg-ide-accent transition-colors z-10 ${dragging ? "bg-ide-accent" : ""}`}
        style={{
          [isVertical ? "height" : "width"]: `${DIVIDER_SIZE}px`,
          cursor: isVertical ? "row-resize" : "col-resize",
        }}
      />
      <div
        style={{
          [isVertical ? "height" : "width"]: `calc(${pctSecond} - ${DIVIDER_SIZE / 2}px)`,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {children[1]}
      </div>
    </div>
  );
};

export default TerminalSplitView;
