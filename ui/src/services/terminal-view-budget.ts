import { useEffect, useRef, useSyncExternalStore } from "react";

const entries = new Map<symbol, { visible: boolean; touched: number }>();
const listeners = new Set<() => void>();
let clock = 0;
let retained = new Set<symbol>();
function update() {
  const hidden = [...entries]
    .filter(([, value]) => !value.visible)
    .sort((a, b) => b[1].touched - a[1].touched)
    .slice(0, 2);
  retained = new Set(
    [...entries]
      .filter(([, value]) => value.visible)
      .map(([key]) => key)
      .concat(hidden.map(([key]) => key))
  );
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useTerminalViewBudget(visible: boolean, enabled: boolean) {
  const key = useRef(Symbol("terminal-view")).current;
  useEffect(() => {
    if (!enabled) return;
    entries.set(key, { visible, touched: ++clock });
    update();
    return () => {
      entries.delete(key);
      update();
    };
  }, [key, enabled]);
  useEffect(() => {
    const entry = entries.get(key);
    if (entry) {
      entry.visible = visible;
      if (visible) entry.touched = ++clock;
      update();
    }
  }, [key, visible]);
  return useSyncExternalStore(
    subscribe,
    () => !enabled || visible || retained.has(key),
    () => true
  );
}
