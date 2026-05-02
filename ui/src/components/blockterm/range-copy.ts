export type CopySection = { block: string; screen: "command" | "normal" | "alternate"; chunks: string[] };
export type CopyPoint = { block: string; screen: "command" | "normal" | "alternate"; row: number; offset: number };

export function copyOutputRange(sections: CopySection[], start: CopyPoint, end: CopyPoint): string | null {
  const locate = (point: CopyPoint) => {
    const index = sections.findIndex((section) => section.block === point.block && section.screen === point.screen);
    const chunks = sections[index]?.chunks;
    if (!chunks || !Number.isInteger(point.row) || point.row < 0 || point.row >= chunks.length) return null;
    const chunk = chunks[point.row];
    const prefix = point.screen !== "command" && chunk.startsWith("\n") ? 1 : 0;
    if (!Number.isInteger(point.offset) || point.offset < 0 || point.offset > chunk.length - prefix) return null;
    let offset = prefix + point.offset;
    for (let row = 0; row < point.row; row++) offset += chunks[row].length;
    return { index, offset };
  };
  const first = locate(start);
  const last = locate(end);
  if (!first || !last || first.index > last.index || (first.index === last.index && first.offset > last.offset))
    return null;
  const parts: string[] = [];
  for (let index = first.index; index <= last.index; index++) {
    const text = sections[index].chunks.join("");
    parts.push(text.slice(index === first.index ? first.offset : 0, index === last.index ? last.offset : undefined));
  }
  return parts.join("\n");
}
