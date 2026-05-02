import type { Terminal } from "@xterm/xterm";

type Finish = (success: boolean, result?: boolean) => undefined | Promise<boolean>;
type StringParser = {
  put(data: Uint32Array, start: number, end: number): void;
  reset(): void;
  end?: Finish;
  unhook?: Finish;
};

const MAX_CONTROL_BYTES = 4 << 20;

// xterm 6's OSC put includes the command identifier; DCS put contains only its
// payload. This matches the backend's valid UTF-8 control-string byte budget.
export function installControlStringLimit(terminal: Terminal, onLimit?: () => void) {
  const parser = (
    terminal as unknown as {
      _core?: { _inputHandler?: { _parser?: { _oscParser: StringParser; _dcsParser: StringParser } } };
    }
  )._core?._inputHandler?._parser;
  const targets = [
    [parser?._oscParser, "end"],
    [parser?._dcsParser, "unhook"],
  ] as const;
  for (const [target, finish] of targets) {
    if (typeof target?.put !== "function" || typeof target.reset !== "function" || typeof target[finish] !== "function")
      throw new Error("终端控制字符串保护与当前解析器不兼容");
  }
  let reported = false;
  const restore = targets.map(([candidate, finish]) => {
    const target = candidate!;
    const put = target.put;
    const reset = target.reset;
    const end = target[finish]!;
    let bytes = 0;
    let overflow = false;
    const guardedPut = (data: Uint32Array, start: number, stop: number) => {
      if (overflow) return;
      for (let index = start; index < stop; index++) {
        const code = data[index];
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        if (bytes > MAX_CONTROL_BYTES) {
          overflow = true;
          // Abort accumulated handler data immediately, but keep ignoring this
          // sequence until the outer parser reaches its terminator/new start.
          reset.call(target);
          if (!reported) {
            reported = true;
            onLimit?.();
          }
          return;
        }
      }
      put.call(target, data, start, stop);
    };
    const guardedReset = () => {
      bytes = 0;
      overflow = false;
      reset.call(target);
    };
    const guardedEnd: Finish = (success, result) => {
      if (!overflow) return end.call(target, success, result);
    };
    target.put = guardedPut;
    target.reset = guardedReset;
    target[finish] = guardedEnd;
    return () => {
      if (target.put === guardedPut) target.put = put;
      if (target.reset === guardedReset) target.reset = reset;
      if (target[finish] === guardedEnd) target[finish] = end;
    };
  });
  return { dispose: () => restore.forEach((callback) => callback()) };
}
