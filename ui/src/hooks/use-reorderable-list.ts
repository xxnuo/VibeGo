import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Axis = "x" | "y";

interface DragState {
  id: string;
  overId: string | null;
}

interface PendingState {
  id: string;
  pointerId: number;
  isTouch: boolean;
  startX: number;
  startY: number;
  element: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  captured: boolean;
}

interface UseReorderableListOptions {
  ids: string[];
  axis: Axis;
  onReorder: (fromId: string, toId: string) => void;
  longPressDelay?: number;
  dragScale?: number;
  disabled?: boolean;
}

const MOVE_THRESHOLD = 6;

export function useReorderableList({
  ids,
  axis,
  onReorder,
  longPressDelay = 260,
  dragScale = 1.04,
  disabled = false,
}: UseReorderableListOptions) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const pendingRef = useRef<PendingState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragElementRef = useRef<HTMLElement | null>(null);
  const startPointRef = useRef({ x: 0, y: 0 });
  const currentPointRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  const previousTouchActionRef = useRef<string>("");
  const suppressClickRef = useRef(false);
  const idsRef = useRef(ids);
  const onReorderRef = useRef(onReorder);

  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  useEffect(() => {
    onReorderRef.current = onReorder;
  }, [onReorder]);

  const clearPending = useCallback(() => {
    const pending = pendingRef.current;
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    pendingRef.current = null;
  }, []);

  const findOverId = useCallback((clientX: number, clientY: number, activeId: string) => {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
      const target = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-reorder-id]") : null;
      const id = target?.dataset.reorderId;
      if (id && id !== activeId && idsRef.current.includes(id)) {
        return id;
      }
    }
    return null;
  }, []);

  const startDrag = useCallback((pending: PendingState, clientX: number, clientY: number) => {
    const next: DragState = {
      id: pending.id,
      overId: null,
    };
    if (!pending.captured) {
      pending.element.setPointerCapture?.(pending.pointerId);
      pending.captured = true;
    }
    previousTouchActionRef.current = pending.element.style.touchAction;
    pending.element.style.touchAction = "none";
    pending.element.style.willChange = "transform";
    pending.element.style.zIndex = "60";
    pending.element.style.position = "relative";
    startPointRef.current = { x: pending.startX, y: pending.startY };
    currentPointRef.current = { x: clientX, y: clientY };
    dragElementRef.current = pending.element;
    suppressClickRef.current = true;
    dragRef.current = next;
    setDragState(next);
  }, []);

  const applyDragTransform = useCallback(() => {
    frameRef.current = null;
    const element = dragElementRef.current;
    if (!element) return;
    const dx = axis === "x" ? currentPointRef.current.x - startPointRef.current.x : 0;
    const dy = axis === "y" ? currentPointRef.current.y - startPointRef.current.y : 0;
    element.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${dragScale})`;
  }, [axis, dragScale]);

  const scheduleDragTransform = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(applyDragTransform);
  }, [applyDragTransform]);

  const resetDragElement = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const element = dragElementRef.current;
    if (element) {
      element.style.transform = "";
      element.style.willChange = "";
      element.style.zIndex = "";
      element.style.position = "";
      element.style.touchAction = previousTouchActionRef.current;
    }
    dragElementRef.current = null;
  }, []);

  useEffect(() => {
    if (disabled) {
      clearPending();
      dragRef.current = null;
      resetDragElement();
      setDragState(null);
    }
  }, [clearPending, disabled, resetDragElement]);

  const bindItem = useCallback(
    (id: string) => ({
      "data-reorder-id": id,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        const target = event.target instanceof HTMLElement ? event.target.closest("[data-drag-ignore]") : null;
        if (disabled || event.button !== 0 || target) {
          return;
        }
        const element = event.currentTarget;
        const isTouch = event.pointerType === "touch";
        const pending: PendingState = {
          id,
          pointerId: event.pointerId,
          isTouch,
          startX: event.clientX,
          startY: event.clientY,
          element,
          timer: null,
          captured: false,
        };
        pendingRef.current = pending;
        if (!isTouch) return;
        pending.timer = setTimeout(() => {
          if (pendingRef.current === pending) {
            startDrag(pending, pending.startX, pending.startY);
          }
        }, longPressDelay);
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const pending = pendingRef.current;
        const active = dragRef.current;
        if (pending && pending.pointerId !== event.pointerId) {
          return;
        }
        if (pending && !active) {
          const moved = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
          if (moved > MOVE_THRESHOLD) {
            if (!pending.isTouch) {
              startDrag(pending, event.clientX, event.clientY);
              return;
            }
            clearPending();
          }
          return;
        }
        if (!active || active.id !== id) {
          return;
        }
        event.preventDefault();
        currentPointRef.current = { x: event.clientX, y: event.clientY };
        scheduleDragTransform();
        const overId = findOverId(event.clientX, event.clientY, active.id);
        if (overId !== active.overId) {
          const next = { ...active, overId };
          dragRef.current = next;
          setDragState(next);
        }
      },
      onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
        const active = dragRef.current;
        clearPending();
        if (active) {
          const overId = active.overId || findOverId(event.clientX, event.clientY, active.id);
          if (overId && overId !== active.id) {
            onReorderRef.current(active.id, overId);
          }
        }
        dragRef.current = null;
        resetDragElement();
        setDragState(null);
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      },
      onPointerCancel: () => {
        clearPending();
        dragRef.current = null;
        resetDragElement();
        setDragState(null);
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      },
      onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClickRef.current = false;
        }
      },
    }),
    [clearPending, disabled, findOverId, longPressDelay, resetDragElement, scheduleDragTransform, startDrag]
  );

  const getItemStyle = useCallback(
    (id: string): React.CSSProperties | undefined => {
      if (!dragState || dragState.id !== id) {
        return undefined;
      }
      return {
        zIndex: 60,
        touchAction: "none",
        willChange: "transform",
      };
    },
    [dragState]
  );

  return useMemo(
    () => ({
      activeId: dragState?.id || null,
      overId: dragState?.overId || null,
      isDragging: !!dragState,
      bindItem,
      getItemStyle,
    }),
    [bindItem, dragState, getItemStyle]
  );
}
