import type { Terminal } from "@xterm/xterm";

export function bindTerminalMousePaste(container: HTMLElement, terminal: Terminal, paste: () => void): () => void {
  let interceptedButtons = 0;
  const buttonMask = (button: number) => (button === 1 ? 4 : button === 2 ? 2 : 0);
  const hasModifier = (event: MouseEvent) => event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

  const mouseDown = (event: MouseEvent) => {
    const mask = buttonMask(event.button);
    if (!mask || hasModifier(event)) return;
    interceptedButtons |= mask;
    event.stopPropagation();
    if (event.button === 2) {
      event.preventDefault();
      terminal.focus();
      return;
    }

    // Keep Chrome/X11's native PRIMARY paste; do not cancel the browser default.
    const textarea = terminal.textarea;
    const screen = container.querySelector(".xterm-screen");
    if (textarea && screen) {
      const bounds = screen.getBoundingClientRect();
      Object.assign(textarea.style, {
        width: "20px",
        height: "20px",
        left: `${event.clientX - bounds.left - 10}px`,
        top: `${event.clientY - bounds.top - 10}px`,
        zIndex: "1000",
      });
    }
    terminal.focus();
  };
  const mouseMove = (event: MouseEvent) => {
    if (event.buttons & interceptedButtons) event.stopPropagation();
  };
  const mouseUp = (event: MouseEvent) => {
    const mask = buttonMask(event.button);
    if (!(interceptedButtons & mask)) return;
    interceptedButtons &= ~mask;
    event.stopPropagation();
  };
  const contextMenu = (event: MouseEvent) => {
    if (hasModifier(event)) return;
    event.preventDefault();
    event.stopPropagation();
    terminal.focus();
    paste();
  };

  const document = container.ownerDocument;
  container.addEventListener("mousedown", mouseDown, true);
  container.addEventListener("contextmenu", contextMenu, true);
  document.addEventListener("mousemove", mouseMove, true);
  document.addEventListener("mouseup", mouseUp, true);
  return () => {
    container.removeEventListener("mousedown", mouseDown, true);
    container.removeEventListener("contextmenu", contextMenu, true);
    document.removeEventListener("mousemove", mouseMove, true);
    document.removeEventListener("mouseup", mouseUp, true);
  };
}
