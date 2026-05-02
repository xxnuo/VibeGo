import type { IBufferCell, Terminal } from "@xterm/xterm";
import type { TerminalCheckpoint } from "./checkpoint-protocol";

type CheckpointCell = TerminalCheckpoint["Screens"][number]["Rows"][number][number];
type CheckpointColor = CheckpointCell["Style"]["Fg"];

interface ExtendedAttributes {
  underlineStyle: number;
  underlineColor: number;
  urlId: number;
  clone(): ExtendedAttributes;
}

export interface XtermCheckpointCell extends IBufferCell {
  fg: number;
  bg: number;
  content: number;
  combinedData: string;
  extended: ExtendedAttributes;
  setFromCharData(value: [number, string, number, number]): void;
  updateExtended(): void;
  clone(): { fg: number; bg: number; extended: ExtendedAttributes };
}

// xterm 6 stores palette identity in bits 24..25. Keeping default colors at zero
// is essential: backend white/black defaults must not override the browser theme.
function colorBits(color: CheckpointColor): number {
  if (!color) return 0;
  const v = color.Value;
  switch (color.Kind) {
    case "basic":
      return 0x1000000 | v[0];
    case "indexed":
      return 0x2000000 | v[0];
    case "true":
      return 0x3000000 | v[0];
    case "rgb":
      return 0x3000000 | (v[0] << 16) | (v[1] << 8) | v[2];
    case "rgba16":
      // xterm has no alpha channel. Do not silently flatten translucent state.
      if (v[3] !== 65535) throw new Error("终端检查点包含不支持的透明颜色");
      return 0x3000000 | ((v[0] >> 8) << 16) | ((v[1] >> 8) << 8) | (v[2] >> 8);
  }
}

function registeredLink(terminal: Terminal, source: CheckpointCell, id: number) {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("终端检查点链接标识无效");
  if (!source.Link.URL) {
    if (id !== 0) throw new Error("终端检查点链接标识无效");
    return;
  }
  const service = (
    terminal as unknown as {
      _core?: { _oscLinkService?: { getLinkData?: (id: number) => { uri: string; id?: string } | undefined } };
    }
  )._core?._oscLinkService;
  const data = service?.getLinkData?.(id);
  const expected =
    source.Link.Params.split(":")
      .find((v) => v.startsWith("id="))
      ?.slice(3) || undefined;
  if (id === 0 || !data || data.uri !== source.Link.URL || data.id !== expected)
    throw new Error("终端检查点链接尚未注册或不匹配");
}

// This factory only creates detached cells/attributes. A future importer owns
// buffer replacement and OSC-link marker lifetimes; never replay cell text as ANSI.
// The source must come from decodeTerminalCheckpoint, not an unchecked object.
export function createCheckpointCell(terminal: Terminal, source: CheckpointCell, linkId = 0): XtermCheckpointCell {
  registeredLink(terminal, source, linkId);
  // SGR 6 has no xterm equivalent; fail closed until that projection is supported.
  if (source.Style.Attrs & 16) throw new Error("终端检查点包含不支持的快速闪烁属性");
  let fg = colorBits(source.Style.Fg);
  let bg = colorBits(source.Style.Bg);
  const underlineColor = colorBits(source.Style.UnderlineColor);
  const attrs = source.Style.Attrs;
  if (attrs & 1) fg |= 0x8000000; // bold
  if (attrs & 2) bg |= 0x8000000; // faint
  if (attrs & 4) bg |= 0x4000000; // italic
  if (attrs & 8) fg |= 0x20000000; // blink
  if (attrs & 32) fg |= 0x4000000; // reverse
  if (attrs & 64) fg |= 0x40000000; // conceal
  if (attrs & 128) fg |= 0x80000000; // strikethrough
  if (source.Style.Underline) fg |= 0x10000000;

  // The public factory returns a fresh CellData, unlike Buffer.getNullCell's
  // shared scratch cell. Guard every private member used by this adapter.
  const cell = terminal.buffer.active.getNullCell() as XtermCheckpointCell;
  if (
    typeof cell.setFromCharData !== "function" ||
    typeof cell.updateExtended !== "function" ||
    typeof cell.clone !== "function" ||
    typeof cell.fg !== "number" ||
    typeof cell.bg !== "number" ||
    typeof cell.content !== "number" ||
    typeof cell.combinedData !== "string" ||
    typeof cell.extended?.clone !== "function" ||
    typeof cell.extended.underlineStyle !== "number" ||
    typeof cell.extended.underlineColor !== "number" ||
    typeof cell.extended.urlId !== "number"
  )
    throw new Error("xterm 检查点格子接口不兼容");
  cell.setFromCharData([fg, source.Content, source.Width, 0]);
  cell.bg = bg;
  cell.extended.underlineStyle = source.Style.Underline;
  cell.extended.underlineColor = underlineColor;
  cell.extended.urlId = linkId;
  cell.updateExtended();
  if (cell.getChars() !== source.Content || cell.getWidth() !== source.Width)
    throw new Error("xterm 无法无损表示检查点格子");
  return cell;
}

// The checkpoint format permits width-zero blanks as well as wide spacers.
// xterm requires width-one blanks; only a cell following width two is a spacer.
// History may omit the final spacer, so reconstruct it without replaying text.
export function createCheckpointRow(
  terminal: Terminal,
  source: readonly CheckpointCell[],
  linkIds?: readonly number[]
): XtermCheckpointCell[] {
  if (linkIds && linkIds.length !== source.length) throw new Error("终端检查点行链接数量无效");
  const row = source.map((cell, index) =>
    createCheckpointCell(
      terminal,
      cell.Width === 0 && (index === 0 || source[index - 1].Width !== 2) ? { ...cell, Width: 1 } : cell,
      linkIds?.[index] ?? 0
    )
  );
  const last = source.at(-1);
  if (last?.Width === 2)
    row.push(createCheckpointCell(terminal, { ...last, Content: "", Width: 0 }, linkIds?.at(-1) ?? 0));
  return row;
}
