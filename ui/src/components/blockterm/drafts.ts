// Unsubmitted commands may contain secrets: retain only in this page's memory, not web storage.
type DraftSelection = { start: number; end: number; direction: "forward" | "backward" | "none" };
type DraftSnapshot = { text: string; selection: DraftSelection };
type DraftHistory = { undo: DraftSnapshot[]; redo: DraftSnapshot[] };
type NativeEdit = { type: string; time: number; cursor: number };
type EditBatch = NativeEdit & { snapshot: DraftSnapshot };

export class Drafts {
  private selections = new Map<string, DraftSelection>();
  private values = new Map<string, { text: string }>();
  private listeners = new Map<string, Set<() => void>>();
  private histories = new Map<string, DraftHistory>();
  private groups = new Map<string, boolean>();
  private batches = new Map<string, EditBatch>();

  beginGroup(key: string) {
    this.batches.delete(key);
    if (!this.groups.has(key)) this.groups.set(key, false);
  }

  endGroup(key: string) {
    this.batches.delete(key);
    const changed = this.groups.get(key);
    this.groups.delete(key);
    if (!changed) return;
    const history = this.histories.get(key);
    if (!history) return;
    if (history.undo.at(-1)?.text === this.get(key)) history.undo.pop();
    else history.redo = [];
  }

  get(key: string) {
    return this.values.get(key)?.text ?? "";
  }

  update(key: string, update: string | ((previous: string) => string), edit?: NativeEdit) {
    const previous = this.get(key);
    const value = typeof update === "function" ? update(previous) : update;
    const batch = this.batches.get(key);
    this.batches.delete(key);
    if (previous === value) return;
    const history = this.histories.get(key) ?? { undo: [], redo: [] };
    const selection = this.selection(key);
    const cursor = selection.start;
    const native =
      edit &&
      !this.groups.has(key) &&
      selection.start === selection.end &&
      ((edit.type === "insertText" &&
        edit.cursor > cursor &&
        value.slice(0, cursor) === previous.slice(0, cursor) &&
        value.slice(edit.cursor) === previous.slice(cursor)) ||
        (edit.type === "deleteContentBackward" &&
          edit.cursor < cursor &&
          value === previous.slice(0, edit.cursor) + previous.slice(cursor)));
    const merge =
      native &&
      batch &&
      batch.type === edit.type &&
      batch.cursor === cursor &&
      edit.time >= batch.time &&
      edit.time - batch.time <= 500 &&
      history.undo.at(-1) === batch.snapshot;
    if (!this.groups.get(key) && !merge) history.undo.push({ text: previous, selection: { ...selection } });
    if (this.groups.has(key)) this.groups.set(key, true);
    if (!this.groups.has(key)) history.redo = [];
    this.trim(history);
    this.histories.set(key, history);
    const snapshot = history.undo.at(-1);
    if (native && snapshot) this.batches.set(key, { ...edit, snapshot });
    this.apply(key, value);
  }

  private apply(key: string, value: string, selection?: DraftSelection) {
    this.selections.delete(key);
    if (value) this.values.set(key, { text: value });
    else this.values.delete(key);
    if (value && selection) this.selections.set(key, selection);
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private trim(history: DraftHistory) {
    const size = () => [...history.undo, ...history.redo].reduce((sum, item) => sum + item.text.length * 2, 0);
    while (history.undo.length + history.redo.length > 100 || size() > 2 * 1024 * 1024) {
      if (history.undo.length) history.undo.shift();
      else history.redo.shift();
    }
  }

  travel(key: string, redo = false) {
    this.endGroup(key);
    const history = this.histories.get(key);
    const target = (redo ? history?.redo : history?.undo)?.pop();
    if (!history || !target) return false;
    (redo ? history.undo : history.redo).push({ text: this.get(key), selection: { ...this.selection(key) } });
    this.trim(history);
    this.apply(key, target.text, target.selection);
    return true;
  }

  selection(key: string) {
    return (
      this.selections.get(key) ?? { start: this.get(key).length, end: this.get(key).length, direction: "none" as const }
    );
  }

  select(key: string, text: string, start: number, end: number, direction: "forward" | "backward" | "none") {
    if (text !== this.get(key)) return;
    const batch = this.batches.get(key);
    if (batch && (start !== batch.cursor || end !== batch.cursor)) this.batches.delete(key);
    if (!text) {
      this.selections.delete(key);
      return;
    }
    this.selections.set(key, {
      start: Math.max(0, Math.min(start, text.length)),
      end: Math.max(0, Math.min(end, text.length)),
      direction,
    });
  }

  clearOnAcknowledgement(key: string, expected: string) {
    const version = this.values.get(key);
    return () => {
      if (version?.text === expected && this.values.get(key) === version) {
        this.histories.delete(key);
        this.endGroup(key);
        this.apply(key, "");
      }
    };
  }

  subscribe(key: string, listener: () => void) {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
}
