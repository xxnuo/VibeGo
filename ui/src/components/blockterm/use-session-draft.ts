import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Drafts } from "./drafts";

const drafts = new Drafts();

export function useSessionDraft(group: string, session: string) {
  const key = JSON.stringify([group, session]);
  const subscribe = useCallback((listener: () => void) => drafts.subscribe(key, listener), [key]);
  const snapshot = useCallback(() => drafts.get(key), [key]);
  const value = useSyncExternalStore(subscribe, snapshot, () => "");
  const setValue = useCallback((update: string | ((previous: string) => string)) => drafts.update(key, update), [key]);
  const acknowledge = useCallback((expected: string) => drafts.clearOnAcknowledgement(key, expected), [key]);
  const saveSelection = useCallback(
    (node: HTMLTextAreaElement) => {
      drafts.select(key, node.value, node.selectionStart, node.selectionEnd, node.selectionDirection);
    },
    [key]
  );
  const restoreSelection = useCallback(
    (node: HTMLTextAreaElement) => {
      const selection = drafts.selection(key);
      node.setSelectionRange(selection.start, selection.end, selection.direction);
    },
    [key]
  );
  const travel = useCallback((redo = false) => drafts.travel(key, redo), [key]);
  const beginGroup = useCallback(() => drafts.beginGroup(key), [key]);
  const endGroup = useCallback(() => drafts.endGroup(key), [key]);
  const editInput = useCallback(
    (node: HTMLTextAreaElement, type: string) => {
      drafts.update(key, node.value, { type, time: performance.now(), cursor: node.selectionStart });
      drafts.select(key, node.value, node.selectionStart, node.selectionEnd, node.selectionDirection);
    },
    [key]
  );
  useEffect(() => endGroup, [endGroup]);
  return [
    value,
    setValue,
    acknowledge,
    saveSelection,
    restoreSelection,
    travel,
    beginGroup,
    endGroup,
    editInput,
  ] as const;
}
