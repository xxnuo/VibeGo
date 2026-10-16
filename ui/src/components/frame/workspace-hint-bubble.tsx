import { type CSSProperties, type FC, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageGroup } from "@/stores/frame-store";

export type WorkspaceHintPlacement = "right" | "top";

const VIEWPORT_PADDING = 12;
const BUBBLE_GAP = 8;
const ARROW_PADDING = 12;

interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WorkspaceHintState {
  name: string;
  path: string;
  anchor: AnchorRect;
  placement: WorkspaceHintPlacement;
}

interface WorkspaceHintLayout {
  left: number;
  top: number;
  arrowX: number;
  arrowY: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getViewportSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function getBubbleMaxWidth(): number {
  return Math.max(0, Math.min(320, getViewportSize().width - VIEWPORT_PADDING * 2));
}

function clampArrow(value: number, size: number): number {
  const padding = Math.min(ARROW_PADDING, size / 2);
  return clamp(value, padding, size - padding);
}

export function getWorkspacePath(group: PageGroup): string {
  if (group.type === "group") return group.pages.find((page) => page.path)?.path || "";
  if (group.type !== "tool") return "";
  const path =
    (group.pageId === "terminal" ? group.data?.cwd : group.pageId === "git" ? group.data?.repoPath : undefined) ??
    group.data?.path;
  return typeof path === "string" ? path : "";
}

export function getWorkspaceGroupTitle(group: PageGroup): string {
  const path = getWorkspacePath(group);
  return path ? `${group.name} - ${path}` : group.name;
}

function compactPath(path: string): string {
  if (!path) return "";
  const normalized = path.replace(/[\\/]+$/, "") || path;
  if (normalized === "/" || normalized === "\\") return normalized;
  const separator = normalized.includes("\\") ? "\\" : "/";
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 4) return normalized;
  const prefix = normalized.startsWith(separator) ? separator : "";
  return `${prefix}${parts[0]}${separator}...${separator}${parts.slice(-2).join(separator)}`;
}

export function useWorkspaceHint(placement: WorkspaceHintPlacement) {
  const [hint, setHint] = useState<WorkspaceHintState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showWorkspaceHint = useCallback(
    (group: PageGroup, target: HTMLElement) => {
      const path = getWorkspacePath(group);
      if (!path) return;
      const rect = target.getBoundingClientRect();
      if (timerRef.current) clearTimeout(timerRef.current);
      setHint({
        name: group.name,
        path,
        anchor: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        placement,
      });
      timerRef.current = setTimeout(() => setHint(null), 1500);
    },
    [placement]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { hint, showWorkspaceHint };
}

const WorkspaceHintBubble: FC<{ hint: WorkspaceHintState | null }> = ({ hint }) => {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<WorkspaceHintLayout | null>(null);

  const updateLayout = useCallback(() => {
    if (!hint || !bubbleRef.current) return;
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const bubbleRect = bubbleRef.current.getBoundingClientRect();
    const bubbleWidth = bubbleRect.width;
    const bubbleHeight = bubbleRect.height;
    const centerX = hint.anchor.left + hint.anchor.width / 2;
    const centerY = hint.anchor.top + hint.anchor.height / 2;
    const maxLeft = viewportWidth - VIEWPORT_PADDING - bubbleWidth;
    const maxTop = viewportHeight - VIEWPORT_PADDING - bubbleHeight;

    if (hint.placement === "top") {
      const left = clamp(centerX - bubbleWidth / 2, VIEWPORT_PADDING, maxLeft);
      const top = clamp(hint.anchor.top - BUBBLE_GAP - bubbleHeight, VIEWPORT_PADDING, maxTop);
      setLayout({
        left,
        top,
        arrowX: clampArrow(centerX - left, bubbleWidth),
        arrowY: bubbleHeight / 2,
      });
      return;
    }

    const left = clamp(hint.anchor.left + hint.anchor.width + BUBBLE_GAP, VIEWPORT_PADDING, maxLeft);
    const top = clamp(centerY - bubbleHeight / 2, VIEWPORT_PADDING, maxTop);
    setLayout({
      left,
      top,
      arrowX: bubbleWidth / 2,
      arrowY: clampArrow(centerY - top, bubbleHeight),
    });
  }, [hint]);

  useLayoutEffect(() => {
    setLayout(null);
    updateLayout();
  }, [updateLayout]);

  useEffect(() => {
    if (!hint) return;
    window.addEventListener("resize", updateLayout);
    window.visualViewport?.addEventListener("resize", updateLayout);
    window.visualViewport?.addEventListener("scroll", updateLayout);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.visualViewport?.removeEventListener("resize", updateLayout);
      window.visualViewport?.removeEventListener("scroll", updateLayout);
    };
  }, [hint, updateLayout]);

  if (!hint) return null;

  const isTop = hint.placement === "top";
  const bubbleStyle: CSSProperties = {
    left: layout?.left ?? 0,
    top: layout?.top ?? 0,
    maxWidth: getBubbleMaxWidth(),
    visibility: layout ? "visible" : "hidden",
  };
  const arrowStyle: CSSProperties = isTop
    ? {
        left: layout?.arrowX ?? "50%",
      }
    : {
        top: layout?.arrowY ?? "50%",
      };

  return (
    <div
      ref={bubbleRef}
      className="pointer-events-none fixed z-50 w-max rounded-md border border-ide-border bg-ide-panel/95 px-2.5 py-2 text-left shadow-lg backdrop-blur-sm"
      style={bubbleStyle}
    >
      <span
        className={`absolute h-2 w-2 rotate-45 border-ide-border bg-ide-panel/95 ${
          isTop
            ? "bottom-[-5px] left-1/2 -translate-x-1/2 border-b border-r"
            : "left-[-5px] top-1/2 -translate-y-1/2 border-b border-l"
        }`}
        style={arrowStyle}
      />
      <div className="relative min-w-0 max-w-full">
        <div className="truncate text-xs font-medium text-ide-text">{hint.name}</div>
        <div className="truncate text-[10px] text-ide-mute" title={hint.path}>
          {compactPath(hint.path)}
        </div>
      </div>
    </div>
  );
};

export default WorkspaceHintBubble;
