import type { IBuffer, IBufferCell, Terminal } from "@xterm/xterm";
import { isWebOutputLink, type OutputLink } from "./output-links";

// xterm exposes cells publicly but not OSC 8 destinations. Keep this guarded
// private compatibility boundary isolated; snapshots own the resolved strings.
export function captureOutputLinks(terminal: Terminal, buffer: IBuffer, chunks: string[]): OutputLink[][] {
  const service = (
    terminal as unknown as {
      _core?: {
        _oscLinkService?: {
          getLinkData?: (id: number) => { uri?: string } | undefined;
          _dataByLinkId?: Map<number, unknown>;
        };
      };
    }
  )._core?._oscLinkService;
  if (
    typeof service?.getLinkData !== "function" ||
    (service._dataByLinkId instanceof Map && service._dataByLinkId.size === 0)
  )
    return [];
  const rows: OutputLink[][] = chunks.map(() => []);
  const destinations = new Map<number, string | null>();
  const reusable = buffer.getNullCell();
  chunks.forEach((chunk, row) => {
    const line = buffer.getLine(row);
    if (!line) return;
    const length = chunk.length - (chunk.startsWith("\n") ? 1 : 0);
    let offset = 0;
    for (let column = 0; column < line.length && offset < length; column++) {
      const cell = line.getCell(column, reusable) as
        | (IBufferCell & {
            extended?: { urlId?: number };
            hasExtendedAttrs?: () => boolean | number;
          })
        | undefined;
      if (!cell || cell.getWidth() === 0) continue;
      const end = Math.min(length, offset + (cell.getChars() || " ").length);
      const id =
        typeof cell.hasExtendedAttrs === "function" && cell.hasExtendedAttrs() ? cell.extended?.urlId : undefined;
      if (id) {
        if (!destinations.has(id)) {
          const uri = service.getLinkData?.(id)?.uri;
          destinations.set(id, typeof uri === "string" && isWebOutputLink(uri) ? uri : null);
        }
        const href = destinations.get(id);
        if (href) {
          const previous = rows[row].at(-1);
          if (previous?.href === href && previous.end === offset) previous.end = end;
          else rows[row].push({ start: offset, end, href });
        }
      }
      offset = end;
    }
  });
  return rows;
}
