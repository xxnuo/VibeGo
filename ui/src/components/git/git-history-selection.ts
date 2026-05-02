import type { GitCommit } from "@/api/git";

/** Returns selected commit indexes in newest-first history, or null if an item is not loaded. */
export const getHistoryCommitSelectionIndexes = (
  history: readonly GitCommit[],
  selected: readonly GitCommit[]
): number[] | null => {
  const uniqueSelectedHashes = Array.from(new Set(selected.map((commit) => commit.hash)));

  const indexByHash = new Map<string, number>();
  history.forEach((commit, index) => {
    if (!indexByHash.has(commit.hash)) indexByHash.set(commit.hash, index);
  });

  const selectedIndexes = uniqueSelectedHashes.map((hash) => indexByHash.get(hash));
  if (selectedIndexes.some((index) => index === undefined)) return null;

  return selectedIndexes as number[];
};

/**
 * Returns whether selected commits form one contiguous range in newest-first history.
 * Duplicate selected hashes are ignored; commits not in the loaded history are rejected.
 */
export const areHistoryCommitsContiguous = (history: readonly GitCommit[], selected: readonly GitCommit[]): boolean => {
  const selectedIndexes = getHistoryCommitSelectionIndexes(history, selected);
  if (!selectedIndexes) return false;
  if (selectedIndexes.length <= 1) return true;

  selectedIndexes.sort((left, right) => left! - right!);
  return selectedIndexes.every((index, offset) => offset === 0 || index === selectedIndexes[offset - 1]! + 1);
};
