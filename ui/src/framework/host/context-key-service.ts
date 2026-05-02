import { create } from "zustand";
export const useContextKeyStore = create<{ values: Record<string, unknown>; revision: number }>(() => ({
  values: {},
  revision: 0,
}));

// Parse a small expression grammar; plugin expressions are never evaluated as JavaScript.
export function evaluateWhen(clause: string | undefined, values: Record<string, unknown>): boolean {
  if (!clause?.trim()) return true;
  const tokens =
    clause.match(/\s+|&&|\|\||===|!==|==|!=|>=|<=|[!()<>]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w.$-]+/g) || [];
  if (tokens.join("") !== clause) return false;
  const input = tokens.filter((token) => !/^\s+$/.test(token));
  let cursor = 0;
  const take = () => input[cursor++];
  const literal = (token: string): unknown => {
    if (token.startsWith('"')) return JSON.parse(token);
    if (token.startsWith("'")) return token.slice(1, -1).replace(/\\(['\\])/g, "$1");
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    return token;
  };
  const atom = (): unknown => {
    const token = take();
    if (!token) throw new Error("Missing operand");
    if (token === "(") {
      const value = or();
      if (take() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    if (!/^[\w.$-]+$/.test(token) && !/^["']/.test(token)) throw new Error("Invalid operand");
    return /^(true|false|null|-?\d+(\.\d+)?)$/.test(token) || /^["']/.test(token)
      ? literal(token)
      : Object.hasOwn(values, token)
        ? values[token]
        : undefined;
  };
  const unary = (): unknown => {
    if (input[cursor] === "!") {
      take();
      return !unary();
    }
    return atom();
  };
  const compare = (): unknown => {
    const value = unary();
    const op = input[cursor];
    if (["==", "===", "!=", "!==", ">", "<", ">=", "<="].includes(op)) {
      take();
      const right = take();
      if (!right || /^[!()<>=&|]/.test(right)) throw new Error("Missing value");
      const expected = literal(right);
      if (op === "==" || op === "===") return value === expected;
      if (op === "!=" || op === "!==") return value !== expected;
      if (typeof value !== "number" || typeof expected !== "number") return false;
      return op === ">"
        ? value > expected
        : op === "<"
          ? value < expected
          : op === ">="
            ? value >= expected
            : value <= expected;
    }
    return value;
  };
  const and = (): unknown => {
    let value = compare();
    while (input[cursor] === "&&") {
      take();
      const next = compare();
      value = Boolean(value) && Boolean(next);
    }
    return value;
  };
  const or = (): unknown => {
    let value = and();
    while (input[cursor] === "||") {
      take();
      const next = and();
      value = Boolean(value) || Boolean(next);
    }
    return value;
  };
  try {
    const result = or();
    return cursor === input.length && Boolean(result);
  } catch {
    return false;
  }
}
export const contextKeys = {
  set(key: string, value: unknown) {
    if (Object.is(useContextKeyStore.getState().values[key], value)) return;
    useContextKeyStore.setState((state) => ({
      values: { ...state.values, [key]: value },
      revision: state.revision + 1,
    }));
  },
  get<T>(key: string): T | undefined {
    const values = useContextKeyStore.getState().values;
    return Object.hasOwn(values, key) ? (values[key] as T) : undefined;
  },
  evalWhen(clause?: string) {
    return evaluateWhen(clause, useContextKeyStore.getState().values);
  },
};
