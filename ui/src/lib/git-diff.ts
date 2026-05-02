import { DefaultLinesDiffComputer } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";

export type GitSelectionType = "all" | "partial" | "none";
export type GitDiffRowType = "hunk" | "context" | "added" | "removed";

export interface GitDiffRow {
  id: string;
  type: GitDiffRowType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  selectable: boolean;
}

export interface GitDiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  rows: GitDiffRow[];
  selectableRowIds: string[];
}

export interface GitParsedDiff {
  oldLines: string[];
  newLines: string[];
  oldHasTrailingNewline: boolean;
  newHasTrailingNewline: boolean;
  hunks: GitDiffHunk[];
  selectableRowIds: string[];
}

interface ParsedText {
  lines: string[];
  hasTrailingNewline: boolean;
}

interface ChangeRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

const diffComputer = new DefaultLinesDiffComputer();
const contextSize = 3;

const normalizeText = (value: string) => value.replace(/\r\n/g, "\n");

const parseText = (value: string): ParsedText => {
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }
  const hasTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  return { lines, hasTrailingNewline };
};

const formatRange = (startIndex: number, count: number) => {
  const lineNumber = count === 0 ? startIndex : startIndex + 1;
  return `${lineNumber},${count}`;
};

const createRowId = (
  hunkIndex: number,
  rowIndex: number,
  type: GitDiffRowType,
  oldLineNumber: number | null,
  newLineNumber: number | null
) => `${hunkIndex}:${rowIndex}:${type}:${oldLineNumber ?? "n"}:${newLineNumber ?? "n"}`;

const getChangeRanges = (oldLines: string[], newLines: string[]): ChangeRange[] => {
  if (oldLines.length === 0) {
    return newLines.length === 0 ? [] : [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: newLines.length }];
  }

  if (newLines.length === 0) {
    return [{ oldStart: 0, oldEnd: oldLines.length, newStart: 0, newEnd: 0 }];
  }

  try {
    const result = diffComputer.computeDiff(oldLines, newLines, {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 0,
      computeMoves: false,
      extendToSubwords: false,
    });

    return result.changes.map((change: any) => ({
      oldStart: change.original.startLineNumber - 1,
      oldEnd: change.original.endLineNumberExclusive - 1,
      newStart: change.modified.startLineNumber - 1,
      newEnd: change.modified.endLineNumberExclusive - 1,
    }));
  } catch {
    return [{ oldStart: 0, oldEnd: oldLines.length, newStart: 0, newEnd: newLines.length }];
  }
};

const groupChanges = (changes: ChangeRange[]) => {
  const groups: ChangeRange[][] = [];
  for (const change of changes) {
    const currentGroup = groups.at(-1);
    if (!currentGroup) {
      groups.push([change]);
      continue;
    }
    const previous = currentGroup[currentGroup.length - 1];
    const oldGap = change.oldStart - previous.oldEnd;
    const newGap = change.newStart - previous.newEnd;
    if (oldGap <= contextSize * 2 && newGap <= contextSize * 2) {
      currentGroup.push(change);
      continue;
    }
    groups.push([change]);
  }
  return groups;
};

export const parseGitDiff = (original: string, modified: string): GitParsedDiff => {
  const parsedOriginal = parseText(original);
  const parsedModified = parseText(modified);
  const changes = getChangeRanges(parsedOriginal.lines, parsedModified.lines);

  if (changes.length === 0) {
    return {
      oldLines: parsedOriginal.lines,
      newLines: parsedModified.lines,
      oldHasTrailingNewline: parsedOriginal.hasTrailingNewline,
      newHasTrailingNewline: parsedModified.hasTrailingNewline,
      hunks: [],
      selectableRowIds: [],
    };
  }

  const hunks = groupChanges(changes).map((group, hunkIndex) => {
    const first = group[0];
    const last = group[group.length - 1];
    const oldStart = Math.max(0, first.oldStart - contextSize);
    const oldEnd = Math.min(parsedOriginal.lines.length, last.oldEnd + contextSize);
    const newStart = Math.max(0, first.newStart - contextSize);
    const newEnd = Math.min(parsedModified.lines.length, last.newEnd + contextSize);
    const rows: GitDiffRow[] = [];
    const selectableRowIds: string[] = [];
    let oldCursor = oldStart;
    let newCursor = newStart;
    let rowIndex = 0;

    const pushRow = (row: Omit<GitDiffRow, "id">) => {
      const id = createRowId(hunkIndex, rowIndex, row.type, row.oldLineNumber, row.newLineNumber);
      rowIndex += 1;
      const nextRow: GitDiffRow = { ...row, id };
      rows.push(nextRow);
      if (row.selectable) {
        selectableRowIds.push(id);
      }
    };

    pushRow({
      type: "hunk",
      content: `@@ -${formatRange(oldStart, oldEnd - oldStart)} +${formatRange(newStart, newEnd - newStart)} @@`,
      oldLineNumber: null,
      newLineNumber: null,
      selectable: false,
    });

    for (const change of group) {
      while (oldCursor < change.oldStart && newCursor < change.newStart) {
        pushRow({
          type: "context",
          content: parsedOriginal.lines[oldCursor],
          oldLineNumber: oldCursor + 1,
          newLineNumber: newCursor + 1,
          selectable: false,
        });
        oldCursor += 1;
        newCursor += 1;
      }

      for (let oldIndex = change.oldStart; oldIndex < change.oldEnd; oldIndex += 1) {
        pushRow({
          type: "removed",
          content: parsedOriginal.lines[oldIndex],
          oldLineNumber: oldIndex + 1,
          newLineNumber: null,
          selectable: true,
        });
      }

      for (let newIndex = change.newStart; newIndex < change.newEnd; newIndex += 1) {
        pushRow({
          type: "added",
          content: parsedModified.lines[newIndex],
          oldLineNumber: null,
          newLineNumber: newIndex + 1,
          selectable: true,
        });
      }

      oldCursor = change.oldEnd;
      newCursor = change.newEnd;
    }

    while (oldCursor < oldEnd && newCursor < newEnd) {
      pushRow({
        type: "context",
        content: parsedOriginal.lines[oldCursor],
        oldLineNumber: oldCursor + 1,
        newLineNumber: newCursor + 1,
        selectable: false,
      });
      oldCursor += 1;
      newCursor += 1;
    }

    return {
      id: `hunk-${hunkIndex}`,
      header: rows[0]?.content ?? "",
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      rows,
      selectableRowIds,
    };
  });

  return {
    oldLines: parsedOriginal.lines,
    newLines: parsedModified.lines,
    oldHasTrailingNewline: parsedOriginal.hasTrailingNewline,
    newHasTrailingNewline: parsedModified.hasTrailingNewline,
    hunks,
    selectableRowIds: hunks.flatMap((hunk) => hunk.selectableRowIds),
  };
};

export const buildPatchFromSelection = (
  filePath: string,
  original: string,
  modified: string,
  selectedRowIds: string[]
) => {
  const parsed = parseGitDiff(original, modified);
  const allowedRowIds = new Set(parsed.selectableRowIds);
  const selectedSet = new Set(selectedRowIds.filter((rowId) => allowedRowIds.has(rowId)));

  if (selectedSet.size === 0) {
    return null;
  }

  const isNewFile = parsed.oldLines.length === 0;
  const hunks: string[] = [];
  let delta = 0;

  for (const hunk of parsed.hunks) {
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let hasSelectedChange = false;

    for (const row of hunk.rows) {
      if (row.type === "hunk") {
        continue;
      }

      if (row.type === "context") {
        lines.push(` ${row.content}`);
        oldCount += 1;
        newCount += 1;
        continue;
      }

      const isSelected = selectedSet.has(row.id);

      if (row.type === "removed") {
        if (isSelected) {
          lines.push(`-${row.content}`);
          oldCount += 1;
          hasSelectedChange = true;
        } else {
          lines.push(` ${row.content}`);
          oldCount += 1;
          newCount += 1;
        }
        continue;
      }

      if (isSelected) {
        lines.push(`+${row.content}`);
        newCount += 1;
        hasSelectedChange = true;
      } else if (!isNewFile) {
      }
    }

    if (!hasSelectedChange) {
      continue;
    }

    hunks.push(
      `${`@@ -${formatRange(hunk.oldStart, oldCount)} +${formatRange(hunk.oldStart + delta, newCount)} @@`}\n${lines.join("\n")}`
    );
    delta += newCount - oldCount;
  }

  if (hunks.length === 0) {
    return null;
  }

  const beforePath = isNewFile ? "/dev/null" : `a/${filePath}`;
  return `--- ${beforePath}\n+++ b/${filePath}\n${hunks.join("\n")}\n`;
};
