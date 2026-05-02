import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function CompletionOverlay({
  anchor,
  bounds,
  children,
}: {
  anchor: RefObject<HTMLTextAreaElement | null>;
  bounds: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const position = () => {
      const node = menu.current;
      const editor = anchor.current;
      const container = bounds.current;
      if (!node || !editor || !container) return;
      const rect = (editor.closest("[data-terminal-input-area]") ?? editor).getBoundingClientRect();
      const frame = container.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = Math.max(frame.top, viewport?.offsetTop ?? 0) + 4;
      const bottom = Math.min(frame.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)) - 4;
      const above = Math.max(0, rect.top - top - 4);
      const below = Math.max(0, bottom - rect.bottom - 4);
      const downward = below >= Math.min(280, above);
      const height = Math.min(360, downward ? below : above);
      const width = Math.min(560, frame.width - 8, innerWidth - 8);
      Object.assign(node.style, {
        width: `${width}px`,
        maxHeight: `${height}px`,
        left: `${Math.max(4, Math.min(rect.left, frame.right - width - 4, innerWidth - width - 4))}px`,
        top: `${downward ? rect.bottom + 4 : rect.top - 4}px`,
        transform: downward ? "none" : "translateY(-100%)",
      });
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchor.current) observer.observe(anchor.current);
    if (bounds.current) observer.observe(bounds.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [anchor, bounds]);
  return createPortal(
    <div
      ref={menu}
      data-completion-overlay
      className="fixed z-50 flex min-h-0 flex-col overflow-auto rounded-sm border bg-background shadow-sm"
    >
      {children}
    </div>,
    document.body
  );
}
