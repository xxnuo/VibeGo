import { z } from "zod";

const maxBytes = 8 << 20;
const maxCells = 1 << 16;
const encoder = new TextEncoder();
const integer = (max: number, min = 0) => z.number().int().min(min).max(max);
// Reject lone UTF-16 surrogates rather than silently replacing persisted text.
const text = z
  .string()
  .refine((s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s));
const grapheme = text.refine((s) => encoder.encode(s).length <= 256);
const color = z
  .strictObject({
    Kind: z.enum(["basic", "indexed", "true", "rgb", "rgba16"]),
    Value: z.array(integer(0xffffffff)).length(4),
  })
  .refine(({ Kind, Value: v }) => {
    if (Kind === "rgba16") return v.every((n) => n <= 65535);
    if (Kind === "rgb") return v.slice(0, 3).every((n) => n <= 255) && v[3] === 0;
    return v.slice(1).every((n) => n === 0) && v[0] <= { basic: 15, indexed: 255, true: 0xffffff }[Kind];
  })
  .nullable();
const style = z.strictObject({
  Fg: color,
  Bg: color,
  UnderlineColor: color,
  Underline: integer(5),
  Attrs: integer(255),
});
const link = z.strictObject({ URL: text, Params: text });
const cursor = z.strictObject({
  X: integer(4095),
  Y: integer(4095),
  Pen: style,
  Link: link,
  Style: integer(2),
  Steady: z.boolean(),
  Hidden: z.boolean(),
});
const cell = z.strictObject({ Content: grapheme, Width: integer(2), Style: style, Link: link });
const point = z.strictObject({ X: integer(4096), Y: integer(4096) });
const lines = z.array(z.array(cell).max(4096)).max(maxCells);
const screen = z.strictObject({
  Cursor: cursor,
  Saved: cursor,
  SavedPhantom: z.boolean(),
  Scroll: z.strictObject({ Min: point, Max: point }),
  Rows: lines,
  History: lines.nullable().transform((v) => v ?? []),
  HistoryLimit: integer(maxCells),
});
const charset = z
  .record(
    z
      .string()
      .regex(/^(0|[1-9][0-9]{0,2})$/)
      .refine((s) => Number(s) <= 255),
    grapheme
  )
  .nullable();
const schema = z.strictObject({
  Version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  Wraps: z
    .array(
      z
        .array(z.boolean())
        .max(maxCells + 4096)
        .nullable()
    )
    .length(2)
    .optional(),
  // Null entries preserve missing v1 metadata, not a complete recovery baseline.
  SavedCharsets: z
    .array(
      z
        .strictObject({
          Charsets: z.array(charset).length(4),
          GL: integer(3),
          GR: integer(3),
          Single: z.union([z.literal(0), z.literal(2), z.literal(3)]),
        })
        .nullable()
    )
    .length(2)
    .optional(),
  Cols: integer(4096, 1),
  Rows: integer(4096, 1),
  Active: integer(1),
  Phantom: z.boolean(),
  Screens: z.array(screen).length(2),
  Charsets: z.array(charset).length(4),
  GL: integer(3),
  GR: integer(3),
  Single: z.union([z.literal(0), z.literal(2), z.literal(3)]),
  Last: integer(0x10ffff).refine((n) => n < 0xd800 || n > 0xdfff),
  Modes: z
    .array(z.strictObject({ Private: z.boolean(), Number: integer(65535), Setting: integer(4) }))
    .min(1)
    .max(4096),
  Tabs: z
    .array(integer(4095))
    .max(4096)
    .nullable()
    .transform((v) => v ?? []),
  Palette: z.array(color).length(256),
  Colors: z.array(color).length(6),
  Title: text,
  Icon: text,
  Cwd: text,
});

export type TerminalCheckpoint = z.infer<typeof schema>;

function invalid(): never {
  throw new Error("终端检查点格式无效或不受支持");
}

// JSON.parse alone silently accepts duplicate keys. Bound nesting/token count and
// reject duplicates (including escaped/case variants) before allocating the model.
function preflight(source: string) {
  const stack: (Set<string> | null)[] = [];
  const token =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings forbid literal C0 controls.
    /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}[\]:,]/y;
  let offset = 0;
  let count = 0;
  while (offset < source.length) {
    if (/[ \t\r\n]/.test(source[offset])) {
      offset++;
      continue;
    }
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match || ++count > 1 << 20) invalid();
    const value = match[0];
    offset = token.lastIndex;
    if (value === "{" || value === "[") {
      stack.push(value === "{" ? new Set() : null);
      if (stack.length > 32) invalid();
    } else if (value === "}" || value === "]") {
      if (!stack.length) invalid();
      stack.pop();
    } else if (value.startsWith('"') && stack.at(-1) !== null && stack.length) {
      let next = offset;
      while (next < source.length && /[ \t\r\n]/.test(source[next])) next++;
      if (source[next] === ":") {
        const key = (JSON.parse(value) as string).toLowerCase();
        const keys = stack.at(-1)!;
        // Schema libraries may discard prototype-related keys instead of reporting
        // them as unknown. None are part of this wire format, including charsets.
        if (keys.has(key) || key === "__proto__" || key === "constructor" || key === "prototype") invalid();
        keys.add(key);
      }
    }
  }
  if (stack.length) invalid();
}

// Decode only: this does not mutate xterm, execute ANSI, authorize links, or
// establish a replay baseline. All fields must be validated before a future import.
export function decodeTerminalCheckpoint(bytes: Uint8Array): TerminalCheckpoint {
  if (!bytes.length || bytes.length > maxBytes) invalid();
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  preflight(source);
  const result = schema.safeParse(JSON.parse(source));
  if (!result.success) invalid();
  const d = result.data;
  if ((d.Version === 1 && d.SavedCharsets !== undefined) || (d.Version >= 2 && !d.SavedCharsets)) invalid();
  if ((d.Version < 3 && d.Wraps !== undefined) || (d.Version === 3 && !d.Wraps)) invalid();
  if (d.Cols * d.Rows * 2 > maxCells || d.Colors.slice(0, 3).some((v) => v === null)) invalid();
  const modes = new Set<string>();
  for (const mode of d.Modes) {
    const key = `${mode.Private}:${mode.Number}`;
    if (modes.has(key)) invalid();
    modes.add(key);
  }
  let previous = -1;
  for (const stop of d.Tabs) {
    if (stop <= previous || stop >= d.Cols) invalid();
    previous = stop;
  }
  let cells = 0;
  for (const [index, s] of d.Screens.entries()) {
    const layout = d.Wraps?.[index];
    if (layout && layout.length !== s.History.length + d.Rows) invalid();
    const { Min: min, Max: max } = s.Scroll;
    if (
      s.Rows.length !== d.Rows ||
      s.History.length > s.HistoryLimit ||
      min.X >= max.X ||
      min.Y >= max.Y ||
      max.X > d.Cols ||
      max.Y > d.Rows ||
      s.Saved.X >= d.Cols ||
      s.Saved.Y >= d.Rows ||
      (index === d.Active && (s.Cursor.X >= d.Cols || s.Cursor.Y >= d.Rows))
    )
      invalid();
    for (const [rows, visible] of [
      [s.Rows, true],
      [s.History, false],
    ] as const) {
      for (const row of rows) {
        cells += row.length;
        if (cells > maxCells || (visible && row.length !== d.Cols)) invalid();
        for (const [x, c] of row.entries()) {
          if (c.Width === 0 && c.Content !== "") invalid();
          if (c.Width === 2) {
            const next = row[x + 1];
            if ((!next && visible) || (next && (next.Width !== 0 || next.Content !== ""))) invalid();
          }
        }
      }
    }
  }
  return d;
}
