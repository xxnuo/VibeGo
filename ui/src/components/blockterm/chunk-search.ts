// Preserve default (non-locale) case conversion across chunk boundaries without
// constructing the complete source string. Final_Sigma depends on adjacent
// cased characters after ignoring Case_Ignorable code points.
export function* lowercaseChunks(chunks: readonly string[]): Generator<string> {
  const sources = chunks.some((chunk) => /[\ud800-\udbff]$/u.test(chunk))
    ? [...completeCodePointChunks(chunks)]
    : chunks;
  const contextual = sources.some((chunk) => chunk.includes("\u03a3"));
  let precededByCased = false;
  for (let index = 0; index < sources.length; index++) {
    const chunk = sources[index];
    if (contextual && chunk.includes("\u03a3")) {
      let followedByCased = false;
      for (let next = index + 1; next < sources.length; next++) {
        const first = /[^\p{Case_Ignorable}]/u.exec(sources[next])?.[0];
        if (first !== undefined) {
          followedByCased = /\p{Cased}/u.test(first);
          break;
        }
      }
      // ASCII sentinels encode only the surrounding casing context. They map
      // to one UTF-16 unit each, so removing them preserves all match offsets.
      yield `${precededByCased ? "A" : " "}${chunk}${followedByCased ? "A" : " "}`.toLowerCase().slice(1, -1);
    } else yield chunk.toLowerCase();
    if (contextual) {
      const last = /([^\p{Case_Ignorable}])\p{Case_Ignorable}*$/u.exec(chunk)?.[1];
      if (last !== undefined) precededByCased = /\p{Cased}/u.test(last);
    }
  }
}

type QueryPlan = { query: string; needle: string; failure: Uint32Array | null };
let lastQuery: QueryPlan | undefined;

function queryPlan(query: string): QueryPlan {
  if (lastQuery?.query === query) return lastQuery;
  const needle = query.toLowerCase();
  // Native indexOf is fast for ordinary queries. Cap its carried boundary to
  // 255 units; long queries use a failure table instead of copying long tails.
  const failure = needle.length > 256 ? new Uint32Array(needle.length) : null;
  if (failure) {
    for (let index = 1, matched = 0; index < needle.length; index++) {
      while (matched && needle.charCodeAt(index) !== needle.charCodeAt(matched)) matched = failure[matched - 1];
      if (needle.charCodeAt(index) === needle.charCodeAt(matched)) matched++;
      failure[index] = matched;
    }
  }
  // One immutable plan is shared by blocks searching the same query; do not
  // retain an unbounded cache of previously entered search strings.
  lastQuery = { query, needle, failure };
  return lastQuery;
}

// Yield non-overlapping match offsets in the lowercased UTF-16 stream.
export function* chunkMatches(chunks: readonly string[], query: string): Generator<[number, number]> {
  if (!query) return;
  const { needle, failure } = queryPlan(query);
  if (failure) {
    let matched = 0;
    let position = 0;
    for (const chunk of lowercaseChunks(chunks)) {
      for (let index = 0; index < chunk.length; index++) {
        const code = chunk.charCodeAt(index);
        while (matched && code !== needle.charCodeAt(matched)) matched = failure[matched - 1];
        if (code === needle.charCodeAt(matched)) matched++;
        position++;
        if (matched === needle.length) {
          yield [position - needle.length, position];
          matched = 0;
        }
      }
    }
    return;
  }
  let tail = "";
  let skip = 0;
  let base = 0;
  for (const chunk of lowercaseChunks(chunks)) {
    const text = tail + chunk;
    let offset = skip;
    for (;;) {
      const index = text.indexOf(needle, offset);
      if (index < 0) break;
      yield [base + index, base + index + needle.length];
      offset = index + needle.length;
    }
    const start = Math.max(0, text.length - needle.length + 1);
    tail = text.slice(start);
    skip = Math.max(0, offset - start);
    base += start;
  }
}

// Code points can straddle arbitrary input chunks. Keep at most one high
// surrogate pending so coordinate mapping never needs a joined source string.
function* completeCodePointChunks(chunks: readonly string[]): Generator<string> {
  let pending = "";
  for (const chunk of chunks) {
    const text = pending + chunk;
    pending = "";
    let end = text.length;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) pending = text[--end];
    yield text.slice(0, end);
  }
  if (pending) yield pending;
}

export function* chunkCharacters(chunks: readonly string[]): Generator<string> {
  for (const chunk of completeCodePointChunks(chunks)) yield* chunk;
}
