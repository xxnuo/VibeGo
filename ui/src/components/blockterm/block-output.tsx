import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildTextSearch, type TextMatchRange } from "./buffer-text";
import type { Snapshot } from "./engine";
import { mergeOutputLinks, type OutputLink, outputLinks } from "./output-links";
import { hasSnapshotText } from "./snapshot-text";

const readingPositions = new WeakMap<Snapshot, { top: number; left: number }>();

export function BlockOutput({
  snapshot,
  query,
  searchTarget,
  onNavigate,
  showSearchControls = true,
}: {
  snapshot: Snapshot;
  query: string;
  searchTarget?: { index: number };
  onNavigate?: (index: number) => void;
  showSearchControls?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [selectedRows, setSelectedRows] = useState<[number, number] | null>(null);
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const row = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const target = element?.closest<HTMLElement>("[data-output-row]");
        return target && host.current?.contains(target) ? Number(target.dataset.outputRow) : null;
      };
      const start = row(selection?.anchorNode ?? null);
      const end = row(selection?.focusNode ?? null);
      const next: [number, number] | null =
        selection && !selection.isCollapsed && (start !== null || end !== null)
          ? [Math.min(start ?? end!, end ?? start!), Math.max(start ?? end!, end ?? start!)]
          : null;
      setSelectedRows((previous) => (previous?.[0] === next?.[0] && previous?.[1] === next?.[1] ? previous : next));
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  const extractRange = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = new Set(defaultRangeExtractor(range));
      if (focusedRow !== null && focusedRow >= 0 && focusedRow < range.count) indexes.add(focusedRow);
      if (selectedRows) {
        for (const index of selectedRows) if (index >= 0 && index < range.count) indexes.add(index);
      }
      return [...indexes].sort((a, b) => a - b);
    },
    [selectedRows, focusedRow]
  );
  const { rows: matches, matchRows } = useMemo(() => buildTextSearch(snapshot.textChunks, query), [snapshot, query]);
  const links = useMemo(() => mergeOutputLinks(outputLinks(snapshot.textChunks), snapshot.links ?? []), [snapshot]);
  const [selection, setSelection] = useState({ query, index: 0 });
  useEffect(() => {
    if (searchTarget) setSelection({ query, index: searchTarget.index });
  }, [query, searchTarget]);
  const selected = selection.query === query ? Math.min(selection.index, Math.max(0, matchRows.length - 1)) : 0;
  // Commit query resets and count clamping, so returning to an old query or
  // growing a snapshot cannot resurrect an obsolete selected match.
  if (selection.query !== query || selection.index !== selected) setSelection({ query, index: selected });
  const move = (direction: number) => {
    const index = (selected + direction + matchRows.length) % matchRows.length;
    setSelection({ query, index });
    onNavigate?.(index);
  };
  const spanOffsets = useMemo(
    () =>
      snapshot.styledRows.map((spans) => {
        let offset = 0;
        return spans.map((span) => {
          const start = offset;
          offset += span.text.length;
          return start;
        });
      }),
    [snapshot]
  );
  const virtual = useVirtualizer({
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
    count: snapshot.styledRows.length,
    getScrollElement: () => host.current,
    estimateSize: () => 16,
    overscan: 5,
    rangeExtractor: extractRange,
    initialOffset: query ? 0 : (readingPositions.get(snapshot)?.top ?? 0),
  });
  useLayoutEffect(() => {
    const node = host.current;
    if (!node || query) return;
    const saved = readingPositions.get(snapshot);
    if (saved) {
      node.scrollTop = saved.top;
      node.scrollLeft = saved.left;
    }
    return () => {
      readingPositions.set(snapshot, { top: node.scrollTop, left: node.scrollLeft });
    };
  }, [snapshot, query]);
  useEffect(() => {
    if (!query) return;
    const index = matchRows[selected];
    if (index === undefined) return;
    virtual.scrollToIndex(index, { align: "center" });
    let frame = 0;
    let attempts = 0;
    const reveal = () => {
      const container = host.current;
      const mark = container?.querySelector<HTMLElement>(`[data-output-row="${index}"] mark[data-active-match]`);
      if (!container || !mark) {
        if (++attempts < 12) frame = requestAnimationFrame(reveal);
        return;
      }
      // Use rendered geometry: UTF-16 offsets are not display columns for
      // wide glyphs, combining sequences, or differently styled spans.
      const viewport = container.getBoundingClientRect();
      const target = mark.getBoundingClientRect();
      const left = viewport.left + container.clientLeft;
      const right = left + container.clientWidth;
      if (target.left < left || target.width > container.clientWidth) container.scrollLeft += target.left - left;
      else if (target.right > right) container.scrollLeft += target.right - right;
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [query, matchRows, selected, virtual]);
  if (!hasSnapshotText(snapshot)) return null;
  return (
    <>
      {showSearchControls && query && matchRows.length > 0 && (
        <div className="flex min-h-11 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span role="status" className="w-full">
            输出匹配 {selected + 1} / {matchRows.length}
          </span>
          <Button variant="ghost" className="h-11" aria-label="上一处输出匹配" onClick={() => move(-1)}>
            上一处
          </Button>
          <Button variant="ghost" className="h-11" aria-label="下一处输出匹配" onClick={() => move(1)}>
            下一处
          </Button>
        </div>
      )}
      <div
        ref={host}
        data-blockterm-output
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus enables native scrolling of terminal history.
        tabIndex={0}
        role="region"
        aria-label="命令输出滚动区"
        onFocusCapture={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-output-row]");
          setFocusedRow(row && event.currentTarget.contains(row) ? Number(row.dataset.outputRow) : null);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRow(null);
        }}
        onCopy={(event) => {
          const selection = document.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
          const range = selection.getRangeAt(0);
          const endpoint = (node: Node, offset: number) => {
            const element = node instanceof Element ? node : node.parentElement;
            const row = element?.closest<HTMLElement>("[data-output-row]");
            if (!row || !event.currentTarget.contains(row)) return null;
            const prefix = document.createRange();
            prefix.selectNodeContents(row);
            prefix.setEnd(node, offset);
            return { row: Number(row.dataset.outputRow), offset: prefix.toString().length };
          };
          const start = endpoint(range.startContainer, range.startOffset);
          const end = endpoint(range.endContainer, range.endOffset);
          if (!start || !end) return;
          const parts: string[] = [];
          for (let row = start.row; row <= end.row; row++) {
            const chunk = snapshot.textChunks[row] ?? "";
            const newline = chunk.startsWith("\n");
            const text = newline ? chunk.slice(1) : chunk;
            parts.push(
              `${row > start.row && newline ? "\n" : ""}${text.slice(row === start.row ? start.offset : 0, row === end.row ? end.offset : undefined)}`
            );
          }
          event.clipboardData.setData("text/plain", parts.join(""));
          event.preventDefault();
          event.stopPropagation();
        }}
        onScroll={(event) => {
          if (!query)
            readingPositions.set(snapshot, {
              top: event.currentTarget.scrollTop,
              left: event.currentTarget.scrollLeft,
            });
        }}
        className="select-text overflow-auto font-mono text-[13px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ height: Math.min(100, snapshot.rows) * 16 }}
      >
        <div className="relative min-w-full" style={{ height: virtual.getTotalSize(), width: `${snapshot.cols}ch` }}>
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-output-row={row.index}
              className="absolute left-0 top-0 whitespace-pre"
              style={{ transform: `translateY(${row.start}px)`, height: 16 }}
            >
              {snapshot.styledRows[row.index].map((span, index) => (
                <span key={`${index}:${span.text}`} style={span.style}>
                  <LinkedOutputText
                    text={span.text}
                    offset={spanOffsets[row.index][index]}
                    ranges={matches[row.index] ?? []}
                    selected={selected}
                    links={links[row.index] ?? []}
                  />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function HighlightedCommand({ command, query, selected }: { command: string; query: string; selected: number }) {
  const ranges = useMemo(() => buildTextSearch([command], query).rows[0] ?? [], [command, query]);
  return (
    <HighlightedText text={command} offset={command.startsWith("\n") ? -1 : 0} ranges={ranges} selected={selected} />
  );
}

function LinkedOutputText({
  text,
  offset,
  ranges,
  selected,
  links,
}: {
  text: string;
  offset: number;
  ranges: TextMatchRange[];
  selected: number;
  links: OutputLink[];
}) {
  if (!links.length) return <HighlightedText text={text} offset={offset} ranges={ranges} selected={selected} />;
  const parts = [];
  let cursor = 0;
  const render = (start: number, end: number) => (
    <HighlightedText text={text.slice(start, end)} offset={offset + start} ranges={ranges} selected={selected} />
  );
  for (const link of links) {
    const start = Math.max(cursor, link.start - offset);
    const end = Math.min(text.length, link.end - offset);
    if (start >= end) continue;
    if (start > cursor) parts.push(<span key={`text-${cursor}`}>{render(cursor, start)}</span>);
    parts.push(
      <a
        key={`link-${start}`}
        href={link.href}
        aria-label={link.href}
        title={link.href}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        className="underline decoration-dotted underline-offset-2"
        onClick={(event) => {
          if (document.getSelection()?.isCollapsed === false) event.preventDefault();
        }}
      >
        {render(start, end)}
      </a>
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(<span key={`text-${cursor}`}>{render(cursor, text.length)}</span>);
  return parts;
}

function HighlightedText({
  text,
  offset,
  ranges,
  selected,
}: {
  text: string;
  offset: number;
  ranges: TextMatchRange[];
  selected: number;
}) {
  const parts = [];
  let cursor = 0;
  for (const { start, end, match } of ranges) {
    const left = Math.max(cursor, start - offset);
    const right = Math.min(text.length, end - offset);
    if (left >= right) continue;
    if (left > cursor) parts.push(text.slice(cursor, left));
    parts.push(
      <mark
        key={left}
        data-active-match={match === selected || undefined}
        className="bg-accent text-accent-foreground data-[active-match]:outline data-[active-match]:outline-1 data-[active-match]:outline-ring"
      >
        {text.slice(left, right)}
      </mark>
    );
    cursor = right;
  }
  parts.push(text.slice(cursor));
  return parts;
}
