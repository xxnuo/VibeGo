export type BlockNavigation = "previous" | "next" | "first" | "last";

export function navigateBlock(ids: string[], current: string | null, action: BlockNavigation): string | null {
  if (!ids.length) return null;
  if (action === "first") return ids[0];
  if (action === "last") return ids[ids.length - 1];
  const index = current === null ? -1 : ids.indexOf(current);
  if (index < 0) return action === "previous" ? ids[ids.length - 1] : ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, index + (action === "previous" ? -1 : 1)))];
}

export function blockNavigationKey(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">,
  blockFocused = false
): BlockNavigation | null {
  if ((!event.altKey && !blockFocused) || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
    return null;
  switch (event.key) {
    case "ArrowUp":
      return "previous";
    case "ArrowDown":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}
