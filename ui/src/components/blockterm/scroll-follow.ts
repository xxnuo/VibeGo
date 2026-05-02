// Output growth is not user navigation. Keep follow intent separate from geometry.
export function isScrollNavigationKey(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">
) {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey) return false;
  if (event.ctrlKey && event.key !== "Home" && event.key !== "End") return false;
  return ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
}

export class ScrollFollow {
  following = true;
  private top = 0;

  observe(top: number, maximum: number, userNavigation = true) {
    if (top >= maximum - 2) this.following = true;
    else if (userNavigation && top < this.top - 0.5) this.following = false;
    this.top = top;
  }

  target(maximum: number): number | null {
    if (!this.following) return null;
    this.top = Math.max(0, maximum);
    return this.top;
  }

  applied(top: number) {
    // Virtualized layout may clamp a requested position. Compare later scroll
    // events against the position the browser accepted, not the requested one.
    this.top = top;
  }

  resume() {
    this.following = true;
  }
}
