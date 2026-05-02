// Freeze candidates during one traversal so asynchronous history updates cannot move selection.
interface InputSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

export class InputHistory {
  private entries: string[] = [];
  private original = "";
  private index: number | null = null;
  private originalSelection: InputSelection | null = null;

  reset() {
    this.index = null;
    this.entries = [];
    this.original = "";
    this.originalSelection = null;
  }

  moveWithSelection(direction: -1 | 1, draft: string, candidates: string[], selection: InputSelection) {
    if (this.index === null) this.originalSelection = { ...selection };
    const originalSelection = this.originalSelection ?? selection;
    const text = this.move(direction, draft, candidates);
    return {
      text,
      selection:
        this.index === null ? originalSelection : { start: text.length, end: text.length, direction: "none" as const },
    };
  }

  move(direction: -1 | 1, draft: string, candidates: string[]): string {
    if (this.index === null) {
      if (direction === -1 || candidates.length === 0) return draft;
      this.original = draft;
      this.entries = [...new Set(candidates)];
      this.index = -1;
    }
    this.index = Math.min(this.entries.length - 1, Math.max(-1, this.index + direction));
    if (this.index < 0) {
      const original = this.original;
      this.reset();
      return original;
    }
    return this.entries[this.index];
  }
}

export function canNavigateHistory(value: string, start: number, end: number, direction: -1 | 1): boolean {
  if (start !== end) return false;
  return direction === 1 ? !value.slice(0, start).includes("\n") : !value.slice(end).includes("\n");
}
