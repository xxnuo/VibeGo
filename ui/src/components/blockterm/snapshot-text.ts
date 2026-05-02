// Snapshots own immutable row chunks. Avoid retaining a second, joined copy
// until a consumer actually needs whole-output text (search/copy/export).
export function lazySnapshotText(chunks: string[]): () => string {
  let text: string | undefined;
  return () => (text ??= chunks.join(""));
}

type TextSnapshot = { textChunks: readonly string[] };
const nonemptySnapshots = new WeakMap<TextSnapshot, boolean>();

export function hasSnapshotText<T extends TextSnapshot>(snapshot: T | null | undefined): snapshot is T {
  if (!snapshot) return false;
  const cached = nonemptySnapshots.get(snapshot);
  if (cached !== undefined) return cached;
  const nonempty = snapshot.textChunks.some((chunk) => /\S/u.test(chunk));
  nonemptySnapshots.set(snapshot, nonempty);
  return nonempty;
}
