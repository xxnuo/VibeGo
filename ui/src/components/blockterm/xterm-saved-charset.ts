import type { Terminal } from "@xterm/xterm";

type Charset = Record<string, string> | undefined;
type State = { sets: Charset[]; level: number; single: number };
type Handler = {
  _activeBuffer: object;
  saveCursor(params?: unknown): boolean;
  restoreCursor(params?: unknown): boolean;
  softReset(params?: unknown): boolean;
  reset(): void;
  print(data: Uint32Array, start: number, end: number): void;
};

// Restore all four designations and the active GL selection, not just xterm's
// effective `charset` pointer (which would be lost at the next SI/SO).
export function installSavedCursorCharset(terminal: Terminal) {
  const core = (
    terminal as unknown as {
      _core?: {
        _inputHandler?: Handler;
        _charsetService?: {
          _charsets: Charset[];
          glevel: number;
          charset: Charset;
          setgCharset(index: number, charset: Charset): void;
          setgLevel(level: number): void;
        };
      };
    }
  )._core;
  const handler = core?._inputHandler,
    charset = core?._charsetService;
  if (
    typeof handler?.saveCursor !== "function" ||
    typeof handler.restoreCursor !== "function" ||
    typeof handler.softReset !== "function" ||
    typeof handler.reset !== "function" ||
    typeof handler.print !== "function" ||
    !handler._activeBuffer ||
    !Array.isArray(charset?._charsets) ||
    !Number.isInteger(charset.glevel) ||
    typeof charset.setgCharset !== "function" ||
    typeof charset.setgLevel !== "function"
  )
    throw new Error("终端保存字符集与当前解析器不兼容");
  const saved = new WeakMap<object, State>();
  let single = 0;
  const save = handler.saveCursor,
    restore = handler.restoreCursor,
    reset = handler.softReset,
    hardReset = handler.reset,
    print = handler.print;
  const copy = (set: Charset): Charset => set && { ...set };
  const saveState = (params?: unknown) => {
    const result = save.call(handler, params);
    saved.set(handler._activeBuffer, {
      level: charset.glevel,
      single,
      sets: Array.from({ length: 4 }, (_, i) => copy(charset._charsets[i])),
    });
    return result;
  };
  const restoreState = (params?: unknown) => {
    const result = restore.call(handler, params);
    const state = saved.get(handler._activeBuffer);
    for (let i = 0; i < 4; i++) charset.setgCharset(i, copy(state?.sets[i]));
    charset.setgLevel(state?.level ?? 0);
    single = state?.single ?? 0;
    return result;
  };
  const resetState = (params?: unknown) => {
    const result = reset.call(handler, params);
    saved.delete(handler._activeBuffer);
    single = 0;
    return result;
  };
  handler.saveCursor = saveState;
  handler.restoreCursor = restoreState;
  handler.softReset = resetState;
  const resetAll = () => {
    hardReset.call(handler);
    single = 0;
  };
  const printShifted = (data: Uint32Array, start: number, end: number) => {
    if (!single || start >= end) return print.call(handler, data, start, end);
    const current = charset.charset;
    charset.charset = charset._charsets[single];
    single = 0;
    try {
      print.call(handler, data, start, start + 1);
    } finally {
      charset.charset = current;
    }
    if (start + 1 < end) print.call(handler, data, start + 1, end);
  };
  handler.reset = resetAll;
  handler.print = printShifted;
  const shifts = [2, 3].map((level) =>
    terminal.parser.registerEscHandler({ final: level === 2 ? "N" : "O" }, () => {
      single = level;
      return true;
    })
  );
  return {
    dispose() {
      for (const shift of shifts) shift.dispose();
      if (handler.reset === resetAll) handler.reset = hardReset;
      if (handler.print === printShifted) handler.print = print;
      if (handler.saveCursor === saveState) handler.saveCursor = save;
      if (handler.restoreCursor === restoreState) handler.restoreCursor = restore;
      if (handler.softReset === resetState) handler.softReset = reset;
    },
  };
}
