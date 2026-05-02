import type { Terminal } from "@xterm/xterm";

type Line = {
  getWidth(index: number): number;
  getString(index: number): string;
  addCodepointToCell(index: number, code: number, width: number): void;
};

// Instance-local compatibility boundary for xterm 6's input handler. Reject
// oversized joins before it changes width/wrap state, not after rendering.
export function installGraphemeLimit(terminal: Terminal, onLimit?: () => void) {
  const core = (
    terminal as unknown as {
      _core?: {
        unicodeService?: { charProperties(code: number, previous: number): number };
        _inputHandler?: { print(data: Uint32Array, start: number, end: number): void };
        _bufferService?: {
          buffer: { x: number; y: number; ybase: number; lines: { get(row: number): Line | undefined } };
        };
      };
    }
  )._core;
  const unicode = core?.unicodeService;
  const handler = core?._inputHandler;
  const buffers = core?._bufferService;
  if (typeof unicode?.charProperties !== "function" || typeof handler?.print !== "function" || !buffers)
    throw new Error("终端字形保护与当前解析器不兼容");
  const properties = unicode.charProperties;
  const print = handler.print;
  const encoder = new TextEncoder();
  let printing = false;
  let reported = false;
  let restorePending: (() => void) | null = null;
  const guardedProperties = (code: number, previous: number) => {
    const result = properties.call(unicode, code, previous);
    if (!printing || !(result & 1)) return result;
    const buffer = buffers.buffer;
    const line = buffer.lines.get(buffer.ybase + buffer.y);
    if (!line || !buffer.x) return result;
    const index = buffer.x - (line.getWidth(buffer.x - 1) ? 1 : 2);
    const bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (encoder.encode(line.getString(index)).length + bytes <= 256) return result;
    if (!reported) {
      reported = true;
      onLimit?.();
    }
    const add = line.addCodepointToCell;
    const skip = (target: number, value: number, width: number) => {
      restorePending?.();
      if (target !== index || value !== code) add.call(line, target, value, width);
    };
    restorePending = () => {
      if (line.addCodepointToCell === skip) line.addCodepointToCell = add;
      restorePending = null;
    };
    line.addCodepointToCell = skip;
    // Preserve the preceding glyph's width and segmentation state; force a
    // zero-growth join so InputHandler does not wrap or advance for the drop.
    return previous | 1;
  };
  const guardedPrint = (data: Uint32Array, start: number, end: number) => {
    printing = true;
    try {
      print.call(handler, data, start, end);
    } finally {
      printing = false;
      restorePending?.();
    }
  };
  unicode.charProperties = guardedProperties;
  handler.print = guardedPrint;
  return {
    dispose() {
      restorePending?.();
      if (unicode.charProperties === guardedProperties) unicode.charProperties = properties;
      if (handler.print === guardedPrint) handler.print = print;
    },
  };
}
