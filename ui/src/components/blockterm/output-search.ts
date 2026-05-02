import { chunkMatches } from "./chunk-search.ts";

export type OutputSearchEntry = { block: string; screen: "command" | "normal" | "alternate"; count: number };
export type OutputSearchTarget = Omit<OutputSearchEntry, "count"> & { index: number };

type SearchSource = { text: string; textChunks?: readonly string[] } | { command: string };
const counts = new WeakMap<SearchSource, { query: string; count: number }>();

export function hasOutputMatch(chunks: readonly string[], query: string): boolean {
  return !chunkMatches(chunks, query).next().done;
}

export function countOutputMatches(snapshot: SearchSource, query: string): number {
  if (!query) return 0;
  const cached = counts.get(snapshot);
  if (cached?.query === query) return cached.count;
  const chunks = "text" in snapshot ? (snapshot.textChunks ?? [snapshot.text]) : [snapshot.command];
  let count = 0;
  for (const _ of chunkMatches(chunks, query)) count++;
  counts.set(snapshot, { query, count });
  return count;
}

export function outputMatchOrdinal(entries: OutputSearchEntry[], target: OutputSearchTarget | null): number {
  let offset = 0;
  for (const entry of entries) {
    if (target?.block === entry.block && target.screen === entry.screen)
      return target.index >= 0 && target.index < entry.count ? offset + target.index : -1;
    offset += entry.count;
  }
  return -1;
}

export function nextOutputMatch(
  entries: OutputSearchEntry[],
  target: OutputSearchTarget | null,
  direction: 1 | -1
): OutputSearchTarget | null {
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (!total) return null;
  const current = outputMatchOrdinal(entries, target);
  let index = current < 0 ? (direction > 0 ? 0 : total - 1) : (current + direction + total) % total;
  for (const entry of entries) {
    if (index < entry.count) return { block: entry.block, screen: entry.screen, index };
    index -= entry.count;
  }
  return null;
}
