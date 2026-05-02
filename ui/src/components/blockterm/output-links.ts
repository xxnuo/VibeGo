export type OutputLink = { start: number; end: number; href: string };
// Bound repeated href/accessibility attributes without truncating output text.
export const MAX_OUTPUT_LINK_LENGTH = 8192;

export function isWebOutputLink(href: string): boolean {
  if (href.length > MAX_OUTPUT_LINK_LENGTH || /[\p{Cc}\p{Cf}]/u.test(href)) return false;
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function mergeOutputLinks(automatic: OutputLink[][], explicit: OutputLink[][]): OutputLink[][] {
  return automatic.map((links, row) => {
    const overrides = explicit[row] ?? [];
    if (!overrides.length) return links;
    return [
      ...links.filter((link) => !overrides.some((other) => link.start < other.end && other.start < link.end)),
      ...overrides,
    ].sort((a, b) => a.start - b.start);
  });
}

export function outputLinks(chunks: string[]): OutputLink[][] {
  const matches: OutputLink[] = [];
  for (const match of chunks.join("").matchAll(/https?:\/\/[^\s<>"'\p{Cc}\p{Cf}]+/giu)) {
    const candidate = match[0];
    if (candidate.length > MAX_OUTPUT_LINK_LENGTH) continue;
    const balance: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
    for (const character of candidate) {
      const index = "([{".indexOf(character);
      if (index >= 0) balance[")]}"[index]]--;
      else if (character in balance) balance[character]++;
    }
    let end = candidate.length;
    while (end > 0) {
      const last = candidate[end - 1];
      if (!".,;:!?".includes(last) && !(balance[last] > 0)) break;
      if (last in balance) balance[last]--;
      end--;
    }
    const href = candidate.slice(0, end);
    if (!isWebOutputLink(href)) continue;
    matches.push({ start: match.index, end: match.index + href.length, href });
  }
  let base = 0;
  let first = 0;
  return chunks.map((chunk) => {
    const start = base + (chunk.startsWith("\n") ? 1 : 0);
    const end = base + chunk.length;
    const links: OutputLink[] = [];
    while (first < matches.length && matches[first].end <= start) first++;
    for (let index = first; index < matches.length && matches[index].start < end; index++) {
      const match = matches[index];
      const left = Math.max(start, match.start);
      const right = Math.min(end, match.end);
      if (left < right) links.push({ start: left - start, end: right - start, href: match.href });
    }
    base = end;
    return links;
  });
}
