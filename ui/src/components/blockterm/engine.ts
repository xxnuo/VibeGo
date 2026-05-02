import { type ISearchResultChangeEvent, SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { CSSProperties } from "react";
import { type Block, bytes, decode, type Session, type TerminalEvent } from "./api";
import { bufferTextChunks } from "./buffer-text";
import {
  validateBlockPayload,
  validateResizePayload,
  validateSessionPayload,
  validateTerminalEvent,
} from "./event-protocol";
import { isWebOutputLink, type OutputLink } from "./output-links";
import { resizeCommandOutput } from "./reflow-resize";
import { lazySnapshotText } from "./snapshot-text";
import { CompleteUTF8Chunks } from "./utf8-chunks";
import { installControlStringLimit } from "./xterm-control-limit";
import { installSavedWrapRestore } from "./xterm-cursor";
import { installGraphemeLimit } from "./xterm-grapheme-limit";
import { captureOutputLinks } from "./xterm-links";
import { installSavedCursorCharset } from "./xterm-saved-charset";
import { installSavedCursorStyle } from "./xterm-saved-style";

export interface Snapshot {
  text: string;
  rows: number;
  cols: number;
  styledRows: { text: string; style: CSSProperties }[][];
  textChunks: string[];
  links?: OutputLink[][];
}

export const LIVE_SEARCH_LIMIT = 1000;

export function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--ide-panel").trim() || "#ffffff",
    foreground: style.getPropertyValue("--ide-text").trim() || "#0f172a",
  };
}

export class BlockEngine {
  readonly terminal: Terminal;
  readonly blocks = new Map<string, Block>();
  readonly snapshots = new Map<string, Snapshot>();
  readonly alternateSnapshots = new Map<string, Snapshot>();
  session: Session;
  current: string | null = null;
  cursor = 0;
  outputStopped = false;
  projectionLimited = false;
  replaying = true;
  watermark = 0;
  private readonly serializer = new SerializeAddon();
  private readonly utf8Chunks = new CompleteUTF8Chunks();
  private readonly search = new SearchAddon({ highlightLimit: LIVE_SEARCH_LIMIT });
  private searching = false;
  private searchQuery = "";
  private frozen: { id: string; screen: "normal" | "alternate" } | null = null;
  private textCache: { id: string; text: string } | null = null;
  private readonly snapshotStyles = new Map<string, CSSProperties>();
  private readonly themeObserver: MutationObserver;
  private readonly savedWrapRestore: { dispose(): void } | null;
  private readonly savedCursorStyle: { dispose(): void };
  private readonly savedCursorCharset: { dispose(): void };
  private readonly graphemeLimit: { dispose(): void };
  private readonly controlStringLimit: { dispose(): void };

  constructor(host: HTMLElement, session: Session) {
    this.session = session;
    this.terminal = new Terminal({
      cols: session.cols,
      rows: session.rows,
      scrollback: 100000,
      fontFamily: '"JetBrains Mono Variable", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      allowProposedApi: true,
      cursorBlink: true,
      theme: terminalTheme(),
      linkHandler: {
        activate: (_event, uri) => {
          if (isWebOutputLink(uri) && window.confirm(`是否打开终端链接？\n${uri}\n请确认目标地址可信。`))
            window.open(uri, "_blank", "noopener,noreferrer");
        },
      },
    });
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
    const reportProjectionLimit = () => {
      this.projectionLimited = true;
    };
    this.graphemeLimit = installGraphemeLimit(this.terminal, reportProjectionLimit);
    this.controlStringLimit = installControlStringLimit(this.terminal, reportProjectionLimit);
    this.terminal.loadAddon(this.serializer);
    this.terminal.loadAddon(this.search);
    this.terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (isWebOutputLink(uri)) window.open(uri, "_blank", "noopener,noreferrer");
      })
    );
    this.terminal.open(host);
    this.terminal.onWriteParsed(() => {
      this.frozen = null;
    });
    this.terminal.onResize(() => {
      this.frozen = null;
    });
    this.terminal.parser.registerCsiHandler({ final: "l", prefix: "?" }, (params) => {
      if (
        this.current &&
        this.terminal.buffer.active.type === "alternate" &&
        params.some((mode) => mode === 47 || mode === 1047 || mode === 1049)
      ) {
        this.alternateSnapshots.set(this.current, this.snapshot(true));
      }
      return false;
    });
    this.savedCursorStyle = installSavedCursorStyle(this.terminal);
    this.savedCursorCharset = installSavedCursorCharset(this.terminal);
    this.savedWrapRestore = session.resize_mode === "reflow-v1" ? installSavedWrapRestore(this.terminal) : null;
    this.themeObserver = new MutationObserver(() => {
      this.frozen = null;
      this.terminal.options.theme = terminalTheme();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    // The server owns terminal query replies, including when this view is disconnected.
    for (const final of ["n", "c"]) {
      for (const prefix of [undefined, "?", ">"])
        this.terminal.parser.registerCsiHandler({ final, prefix }, () => true);
    }
    this.terminal.parser.registerEscHandler({ final: "Z" }, () => true);
    this.terminal.parser.registerCsiHandler({ final: "p", intermediates: "$", prefix: "?" }, () => true);
    this.terminal.parser.registerCsiHandler({ final: "u", prefix: "?" }, () => true);
    this.terminal.parser.registerCsiHandler({ final: "t" }, (params) => Number(params[0]) >= 14);
    for (const code of [10, 11, 12]) this.terminal.parser.registerOscHandler(code, (data) => data === "?");
    this.terminal.parser.registerOscHandler(4, (data) => data.includes(";?"));
    for (const intermediates of ["+", "$"])
      this.terminal.parser.registerDcsHandler({ final: "q", intermediates }, () => true);
  }

  onSearchResults(listener: (result: ISearchResultChangeEvent) => void) {
    return this.search.onDidChangeResults(listener);
  }

  searchOutput(query: string, direction: "next" | "previous" | "refresh" | "first" | "last" = "refresh"): boolean {
    this.searchQuery = query;
    if (!query) {
      if (this.searching) this.terminal.clearSelection();
      this.search.clearDecorations();
      this.searching = false;
      return false;
    }
    this.searching = true;
    if (direction === "refresh") {
      const selection = this.terminal.getSelectionPosition();
      // A cached findNext advances from the old selection's end, even with
      // incremental enabled. Rebuild from its start without losing the anchor.
      this.search.clearDecorations();
      if (selection) {
        const length = (selection.end.y - selection.start.y) * this.terminal.cols + selection.end.x - selection.start.x;
        this.terminal.select(selection.start.x, selection.start.y, length);
      }
    }
    // Public addon searches start at buffer boundaries when there is no selection.
    // This avoids replaying every intermediate match when entering live results.
    if (direction === "first" || direction === "last") this.terminal.clearSelection();
    const color = terminalTheme().foreground;
    const options = {
      incremental: direction === "refresh",
      decorations: {
        matchBorder: color,
        activeMatchBorder: color,
        matchOverviewRuler: color,
        activeMatchColorOverviewRuler: color,
      },
    };
    return direction === "previous" || direction === "last"
      ? this.search.findPrevious(query, options)
      : this.search.findNext(query, options);
  }

  stepOutputSearch(query: string, direction: "next" | "previous"): { found: boolean; wrapped: boolean } {
    const before = this.searchQuery === query ? this.terminal.getSelectionPosition()?.start : undefined;
    const found = this.searchOutput(query, direction);
    const after = this.terminal.getSelectionPosition()?.start;
    if (!found || !before || !after) return { found, wrapped: false };
    const order = after.y - before.y || after.x - before.x;
    // Equal positions mean the sole match was selected again. Coordinates also
    // work beyond the addon's bounded decoration list, where resultIndex is -1.
    return { found, wrapped: direction === "next" ? order <= 0 : order >= 0 };
  }

  private write(data: string | Uint8Array): Promise<void> {
    // Internal screen/mode controls belong to the same byte stream: they must
    // interrupt any incomplete code point before another block supplies bytes.
    data = this.utf8Chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    if (!data.length) return Promise.resolve();
    this.frozen = null;
    return new Promise((resolve) =>
      this.terminal.write(data, () => {
        this.textCache = null;
        resolve();
      })
    );
  }

  private snapshotStyle(span: HTMLElement): CSSProperties {
    const key = span.style.cssText;
    const cached = this.snapshotStyles.get(key);
    if (cached) return cached;
    const style = Object.freeze({
      color: span.style.color,
      backgroundColor: span.style.backgroundColor,
      fontWeight: span.style.fontWeight,
      fontStyle: span.style.fontStyle,
      textDecoration: span.style.textDecoration,
    } satisfies CSSProperties);
    // True-color logs may contain arbitrarily many styles. Only retain a small
    // shared palette; uncommon styles remain owned by their output snapshots.
    if (this.snapshotStyles.size < 256) this.snapshotStyles.set(key, style);
    return style;
  }

  snapshot(active = false): Snapshot {
    const buffer = active ? this.terminal.buffer.active : this.terminal.buffer.normal;
    let end = buffer.length - 1;
    while (end > 0 && !buffer.getLine(end)?.translateToString(true)) end--;
    const html = this.serializer.serializeAsHTML({
      range: { startLine: 0, endLine: end, startCol: 0 },
      includeGlobalBackground: false,
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    const rows = [...document.querySelectorAll("pre > div > div")];
    const styledRows = rows.map((row) =>
      [...row.querySelectorAll("span")].map((span) => ({
        text: span.textContent ?? "",
        style: this.snapshotStyle(span),
      }))
    );
    const textChunks = bufferTextChunks(buffer, end);
    const readText = lazySnapshotText(textChunks);
    return {
      get text() {
        return readText();
      },
      rows: end + 1,
      cols: this.terminal.cols,
      styledRows,
      textChunks,
      links: captureOutputLinks(this.terminal, buffer, textChunks),
    };
  }

  freeze() {
    if (!this.current) return;
    const screen = this.terminal.buffer.active.type;
    if (this.frozen?.id === this.current && this.frozen.screen === screen) return;
    // HTML serialization uses the active buffer. Never pair alternate HTML
    // with normal-buffer text while a background/full-screen block is active.
    if (this.terminal.buffer.active.type === "alternate")
      this.alternateSnapshots.set(this.current, this.snapshot(true));
    else this.snapshots.set(this.current, this.snapshot());
    this.frozen = { id: this.current, screen };
  }

  outputText(id: string): string {
    if (this.current !== id) return this.snapshots.get(id)?.text ?? "";
    if (this.textCache?.id === id) return this.textCache.text;
    const buffer = this.terminal.buffer.normal;
    let end = buffer.length - 1;
    while (end > 0 && !buffer.getLine(end)?.translateToString(true)) end--;
    const text = bufferTextChunks(buffer, end).join("");
    this.textCache = { id, text };
    return text;
  }

  outputTextChunks(id: string): readonly string[] {
    if (this.current !== id) return this.snapshots.get(id)?.textChunks ?? [];
    const buffer = this.terminal.buffer.normal;
    let end = buffer.length - 1;
    while (end > 0 && !buffer.getLine(end)?.translateToString(true)) end--;
    return bufferTextChunks(buffer, end);
  }

  publishBackground() {
    if (this.current && this.blocks.get(this.current)?.kind === "background") this.freeze();
  }

  private async select(id: string) {
    if (this.current === id) return;
    this.searchOutput("");
    if (this.terminal.buffer.active.type === "alternate") await this.write("\x1b[?1049l");
    this.freeze();
    // Clear the output grid, preserving the continuous parser's attributes and modes.
    await this.write("\x1b[2J\x1b[H\x1b[3J");
    this.current = id;
  }

  private async restoreProgramModes() {
    if (this.terminal.buffer.active.type === "alternate") await this.write("\x1b[?1049l");
    await this.write("\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l");
  }

  async apply(event: TerminalEvent) {
    validateTerminalEvent(event, this.session.id);
    if (event.type === "fault") {
      this.session.error = event.data ? decode(event.data) : "输出读取失败";
      return;
    }
    if (event.type === "hello") {
      if (event.seq < this.cursor) throw new Error("服务器回放水位落后于当前游标，无法安全同步");
      this.watermark = event.seq;
      return;
    }
    if (event.seq <= this.cursor) return;
    if (event.seq !== this.cursor + 1) throw new Error("终端事件存在缺口，请重新连接");
    if (event.type === "block") {
      const block = JSON.parse(decode(event.data ?? "")) as Block;
      validateBlockPayload(block, event);
      this.blocks.set(block.id, block);
      if (block.status === "running") await this.select(block.id);
      if (["done", "interrupted", "not_executed"].includes(block.status)) {
        if (block.id === this.current) {
          this.searchOutput("");
          await this.restoreProgramModes();
          this.freeze();
          // Prompt redraws and the next command's echo must not mutate a finished block.
          this.current = null;
        }
      }
    } else if (event.type === "output" && event.block_id && event.data) {
      await this.select(event.block_id);
      await this.write(bytes(event.data));
    } else if (event.type === "terminal" && event.data) {
      await this.write(bytes(event.data));
    } else if (event.type === "state") {
      const session = JSON.parse(decode(event.data ?? "")) as Session;
      validateSessionPayload(session, event);
      this.session = session;
      if (this.session.phase === "editing") await this.select("input");
      if (this.session.phase === "exited") {
        this.searchOutput("");
        // A shell can exit from native editing without a command block completion event.
        await this.restoreProgramModes();
      }
      if (this.session.phase === "ready" || this.session.phase === "exited") this.freeze();
    } else if (event.type === "resize") {
      const size = JSON.parse(decode(event.data ?? "")) as { cols: number; rows: number };
      validateResizePayload(size);
      if (
        this.session.resize_mode === "reflow-v1" &&
        this.current &&
        this.blocks.get(this.current)?.status === "running" &&
        this.terminal.buffer.active.type === "normal"
      )
        resizeCommandOutput(this.terminal, size.cols, size.rows);
      else this.terminal.resize(size.cols, size.rows);
      this.textCache = null;
    } else if (event.type === "gap") {
      this.outputStopped = true;
      this.session.error = event.data ? decode(event.data) : "输出记录存在缺口";
    }
    this.cursor = event.seq;
  }

  dispose() {
    this.snapshotStyles.clear();
    this.savedWrapRestore?.dispose();
    this.savedCursorCharset.dispose();
    this.savedCursorStyle.dispose();
    this.graphemeLimit.dispose();
    this.controlStringLimit.dispose();
    this.themeObserver.disconnect();
    this.terminal.dispose();
    this.blocks.clear();
    this.snapshots.clear();
    this.alternateSnapshots.clear();
    this.textCache = null;
    this.frozen = null;
    this.current = null;
    this.searchQuery = "";
  }
}
