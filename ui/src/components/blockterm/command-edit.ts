const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function deleteCommandText(text: string, start: number, end: number, action: "u" | "k" | "w" | "d" | "h") {
  let from = start;
  let to = end;
  if (start === end) {
    if (action === "d" || action === "h") {
      const segment = graphemes.segment(text).containing(action === "h" ? start - 1 : start);
      if (segment) {
        from = segment.index;
        to = segment.index + segment.segment.length;
      }
    } else if (action === "u") {
      from = text.lastIndexOf("\n", start - 1) + 1;
      if (start === 0) from = 0;
    } else if (action === "k") {
      const newline = text.indexOf("\n", start);
      to = newline < 0 ? text.length : newline === start ? start + 1 : newline;
    } else {
      const prefix = text.slice(0, start);
      from = prefix.replace(/\S+\s*$/u, "").length;
      if (from === start) from = prefix.replace(/\s+$/u, "").length;
    }
  }
  return { text: text.slice(0, from) + text.slice(to), cursor: from };
}

export function insertCommandText(text: string, start: number, end: number, value: string) {
  return { text: text.slice(0, start) + value + text.slice(end), cursor: start + value.length };
}
