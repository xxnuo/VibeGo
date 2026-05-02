import type { BlockTermBookmark, BlockTermBookmarkInput } from "@/api/blockterm";

export const BLOCKTERM_BOOKMARK_TITLE_MAX_BYTES = 256;
export const BLOCKTERM_BOOKMARK_DESCRIPTION_MAX_BYTES = 4 * 1024;
export const BLOCKTERM_BOOKMARK_COMMAND_MAX_BYTES = 16 * 1024;

export type BlockTermBookmarkDraftError = "commandRequired" | "titleTooLong" | "descriptionTooLong" | "commandTooLong";

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function createBlockTermBookmarkDraft(
  bookmark?: Pick<BlockTermBookmark, "title" | "description" | "command"> | null,
  command = ""
): BlockTermBookmarkInput {
  return {
    title: bookmark?.title || "",
    description: bookmark?.description || "",
    command: bookmark?.command ?? command,
  };
}

export function validateBlockTermBookmarkDraft(draft: BlockTermBookmarkInput): BlockTermBookmarkDraftError | null {
  if (!draft.command.trim()) return "commandRequired";
  if (utf8ByteLength(draft.title) > BLOCKTERM_BOOKMARK_TITLE_MAX_BYTES) return "titleTooLong";
  if (utf8ByteLength(draft.description) > BLOCKTERM_BOOKMARK_DESCRIPTION_MAX_BYTES) return "descriptionTooLong";
  if (utf8ByteLength(draft.command) > BLOCKTERM_BOOKMARK_COMMAND_MAX_BYTES) return "commandTooLong";
  return null;
}

export function getBlockTermBookmarkDisplayTitle(bookmark: Pick<BlockTermBookmark, "title" | "command">): string {
  const title = bookmark.title.trim();
  if (title) return title;
  return (
    bookmark.command
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || bookmark.command.trim()
  );
}

export function upsertBlockTermBookmark(
  bookmarks: readonly BlockTermBookmark[],
  bookmark: BlockTermBookmark
): BlockTermBookmark[] {
  return [...bookmarks.filter((item) => item.id !== bookmark.id), bookmark].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
  );
}

export function getBlockTermBookmarkSelectionAfterDelete(
  bookmarks: readonly Pick<BlockTermBookmark, "id">[],
  deletedId: string
): string | null {
  const index = bookmarks.findIndex((bookmark) => bookmark.id === deletedId);
  const remaining = bookmarks.filter((bookmark) => bookmark.id !== deletedId);
  if (remaining.length === 0) return null;
  if (index < 0) return remaining[0].id;
  return remaining[Math.min(index, remaining.length - 1)].id;
}
