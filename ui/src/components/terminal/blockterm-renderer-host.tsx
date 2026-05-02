// Copyright 2023-2024, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import Editor, { type OnMount } from "@monaco-editor/react";
import createDOMPurify from "dompurify";
import {
  AlertTriangle,
  ArrowDownUp,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BlockTermRawOutputResult } from "@/api/blockterm";
import { blockTermModelApi } from "@/api/blockterm-model";
import { type FileInfo, fileApi, type RendererFileClient } from "@/api/file";
import type { BlockTermBlock } from "@/components/terminal/blockterm-model";
import {
  type BlockTermModelStreamEvent,
  canControlBlockTermModelStream,
  nextBlockTermModelReconnectDelay,
  parseBlockTermModelSSEFrame,
  shouldRetryBlockTermModelStream,
  splitBlockTermModelSSE,
} from "@/components/terminal/blockterm-model-stream";
import { renderBlockTermMustache } from "@/components/terminal/blockterm-mustache";
import {
  type BlockTermRendererSpec,
  blockTermRendererRegistry,
  parseBlockTermCsv,
  parseBlockTermRendererState,
  resolveRendererRelativeResource,
} from "@/components/terminal/blockterm-renderer";
import {
  type BlockTermRawRendererPayload,
  canCreateBlockTermRawView,
  getBlockTermRendererTextByteLimit,
  isBlockTermRendererTextSizeAllowed,
  resolveBlockTermRawRendererPayload,
} from "@/components/terminal/blockterm-renderer-raw";
import { useTranslation } from "@/lib/i18n";
import {
  clampMediaRestoreTime,
  mergeViewSession,
  VIEW_SESSION_MAX_ERROR_RETRIES,
  type ViewSession,
  viewResourceKey,
  viewSessionRenewDelay,
  viewSessionRetryDelay,
} from "@/lib/view-session";
import { useAppStore } from "@/stores/app-store";
import { getLanguageFromExtension } from "@/stores/preview-store";

const MAX_RENDERED_CSV_ROWS = 1_000;
const mustachePurifier = typeof window === "undefined" ? null : createDOMPurify(window);

interface RendererFileData {
  info: FileInfo | null;
  content: string;
  bytes: Uint8Array;
  mimeType?: string;
  missing: boolean;
  writable: boolean;
  viewSession: ViewSession | null;
}

interface BlockTermRendererComponentProps {
  block: BlockTermBlock;
  spec: BlockTermRendererSpec;
  data: RendererFileData;
  onReload: () => void;
  readOnly: boolean;
}

type BlockTermRawOutputLoader = (blockId: string, signal: AbortSignal) => Promise<BlockTermRawOutputResult>;

interface CodeDraft {
  path: string;
  content: string;
  original: string;
  dirty: boolean;
}

const codeDraftCache = new Map<string, CodeDraft>();
const RendererFileClientContext = React.createContext<RendererFileClient>(fileApi);

export function clearBlockTermRendererCache(blockId: string): void {
  codeDraftCache.delete(blockId);
}

function extensionFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function rendererParentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) return ".";
  if (slashIndex === 0) return "/";
  if (/^[A-Za-z]:$/.test(normalized.slice(0, slashIndex))) return `${normalized.slice(0, slashIndex)}/`;
  return normalized.slice(0, slashIndex);
}

function hasWritePermission(info: FileInfo): boolean {
  const permissions = Number.parseInt(info.mode, 8);
  return Number.isFinite(permissions) && (permissions & 0o222) !== 0;
}

function hasBinaryMarkdownCharacters(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) <= 8) return true;
  }
  return false;
}

function rendererDisplayName(spec: BlockTermRendererSpec, data: RendererFileData): string {
  return (
    data.info?.name || (spec.source === "pty" ? "PTY output" : spec.filePath.split(/[\\/]/).pop() || spec.filePath)
  );
}

function isPtyRendererSpec(spec: BlockTermRendererSpec): boolean {
  return spec.source === "pty";
}

function makeRawViewSession(
  renderer: BlockTermRendererSpec["renderer"],
  payload: BlockTermRawRendererPayload
): ViewSession | null {
  if (renderer !== "image" && renderer !== "pdf" && renderer !== "media") return null;
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  if (!canCreateBlockTermRawView(renderer, payload.mimeType)) return null;
  const blob = new Blob([new Uint8Array(payload.bytes).buffer], { type: payload.mimeType });
  return { url: URL.createObjectURL(blob), expiresAt: null };
}

function useRendererData(
  block: BlockTermBlock,
  spec: BlockTermRendererSpec,
  reloadVersion: number,
  rawOutput: BlockTermRawOutputLoader | undefined
) {
  const fileClient = React.useContext(RendererFileClientContext);
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const [data, setData] = useState<RendererFileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    const load = async () => {
      if (isPtyRendererSpec(spec)) {
        if (!rawOutput) throw new Error("PTY renderer source is unavailable");
        const result = await rawOutput(block.id, controller.signal);
        if (cancelled) return;
        const payload = resolveBlockTermRawRendererPayload(spec.renderer, result.data);
        if (!isBlockTermRendererTextSizeAllowed(spec.renderer, payload.bytes.byteLength)) {
          throw new Error(t("preview.fileTooLargeToPreview"));
        }
        const content = new TextDecoder().decode(payload.bytes);
        const viewSession = makeRawViewSession(spec.renderer, payload);
        objectUrl = viewSession?.url || null;
        setData({
          info: null,
          content,
          bytes: payload.bytes,
          mimeType: payload.mimeType,
          missing: false,
          writable: false,
          viewSession,
        });
        return;
      }
      if (!spec.filePath) throw new Error("file renderer source is missing a path");
      let info: FileInfo;
      try {
        info = await fileClient.info(spec.filePath);
      } catch (loadError) {
        if (spec.renderer === "code" && spec.mode === "edit") {
          const check = await fileClient.check(spec.filePath);
          if (!check.exist) {
            const parent = await fileClient.info(rendererParentPath(spec.filePath));
            if (!parent.isDir) throw new Error("parent path is not a directory");
            if (!cancelled)
              setData({
                info: null,
                content: "",
                bytes: new Uint8Array(),
                missing: true,
                writable: true,
                viewSession: null,
              });
            return;
          }
        }
        throw loadError;
      }
      if (info.isDir) throw new Error("path is a directory");
      const limit = getBlockTermRendererTextByteLimit(spec.renderer);
      if (limit !== null && info.size > limit) throw new Error(t("preview.fileTooLargeToPreview"));
      let content = "";
      if (limit !== null) {
        const response = await fileClient.read(spec.filePath);
        content = response.content;
      }
      if ((spec.renderer === "markdown" || spec.renderer === "mustache") && hasBinaryMarkdownCharacters(content)) {
        throw new Error(`error: not rendering ${spec.renderer}, binary characters detected`);
      }
      let viewSession: ViewSession | null = null;
      try {
        viewSession = await fileClient.viewUrl(spec.filePath);
      } catch (viewError) {
        if (spec.renderer === "image" || spec.renderer === "pdf" || spec.renderer === "media") throw viewError;
      }
      if (!cancelled) {
        setData({
          info,
          content,
          bytes: new TextEncoder().encode(content),
          mimeType: info.mimeType,
          missing: false,
          writable: !info.isSymlink && hasWritePermission(info),
          viewSession,
        });
      }
    };
    void load()
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("preview.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [block.id, fileClient, rawOutput, reloadVersion, spec.filePath, spec.mode, spec.renderer, spec.source, t]);

  return { data, loading, error };
}

type ViewSessionRefreshResult = "changed" | "unchanged" | "failed" | "skipped";

function useRenewingViewSession(
  path: string,
  initialSession: ViewSession | null,
  options: { enabled?: boolean; onBeforeUrlChange?: () => void } = {}
) {
  const fileClient = React.useContext(RendererFileClientContext);
  const enabled = options.enabled ?? true;
  const [session, setSession] = useState<ViewSession | null>(initialSession);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [resourceRecoveryFailed, setResourceRecoveryFailed] = useState(false);
  const sessionRef = useRef<ViewSession | null>(initialSession);
  const generationRef = useRef(0);
  const inFlightRef = useRef<Promise<ViewSessionRefreshResult> | null>(null);
  const requestRetryCountRef = useRef(0);
  const resourceRetryCountRef = useRef(0);
  const resourceRecoveryPendingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<() => Promise<ViewSessionRefreshResult>>(async () => "skipped");
  const onBeforeUrlChangeRef = useRef(options.onBeforeUrlChange);
  onBeforeUrlChangeRef.current = options.onBeforeUrlChange;

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<ViewSessionRefreshResult> => {
    if (!enabled) return "skipped";
    const current = sessionRef.current;
    if (current?.expiresAt === null) return "skipped";
    if (inFlightRef.current) return inFlightRef.current;

    const generation = generationRef.current;
    const request = fileClient
      .viewUrl(path)
      .then((next) => {
        if (generationRef.current !== generation) return "skipped" as const;
        clearRetryTimer();
        requestRetryCountRef.current = 0;
        const merged = mergeViewSession(sessionRef.current, next);
        if (merged.urlChanged) onBeforeUrlChangeRef.current?.();
        sessionRef.current = merged.session;
        setSession(merged.session);
        if (resourceRecoveryPendingRef.current) {
          resourceRecoveryPendingRef.current = false;
          setResourceRecoveryFailed(false);
          setResourceRevision((value) => value + 1);
        }
        return merged.urlChanged ? ("changed" as const) : ("unchanged" as const);
      })
      .catch(() => {
        if (generationRef.current !== generation) return "skipped" as const;
        const attempt = requestRetryCountRef.current + 1;
        const delay = viewSessionRetryDelay(attempt);
        if (delay !== null) {
          requestRetryCountRef.current = attempt;
          clearRetryTimer();
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void refreshRef.current();
          }, delay);
        } else if (resourceRecoveryPendingRef.current) {
          resourceRecoveryPendingRef.current = false;
          setResourceRecoveryFailed(true);
        }
        return "failed" as const;
      })
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
    inFlightRef.current = request;
    return request;
  }, [clearRetryTimer, enabled, fileClient, path]);
  refreshRef.current = refresh;

  useEffect(() => {
    generationRef.current += 1;
    clearRetryTimer();
    inFlightRef.current = null;
    requestRetryCountRef.current = 0;
    resourceRetryCountRef.current = 0;
    resourceRecoveryPendingRef.current = false;
    setResourceRevision(0);
    setResourceRecoveryFailed(false);
    sessionRef.current = initialSession;
    setSession(initialSession);
    if (enabled && !initialSession) void refreshRef.current();
    return () => {
      generationRef.current += 1;
      clearRetryTimer();
    };
  }, [clearRetryTimer, enabled, initialSession?.expiresAt, initialSession?.url, path]);

  useEffect(() => {
    if (!enabled || !session) return;
    const delay = viewSessionRenewDelay(session, Date.now());
    if (delay === null) return;
    const timer = setTimeout(
      () => {
        void refresh();
      },
      Math.max(1_000, delay)
    );
    return () => clearTimeout(timer);
  }, [enabled, refresh, session]);

  useEffect(() => {
    if (!enabled) return;
    const renewSignedSession = () => {
      if (sessionRef.current?.expiresAt === null) return;
      void refresh();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") renewSignedSession();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", renewSignedSession);
    window.addEventListener("online", renewSignedSession);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", renewSignedSession);
      window.removeEventListener("online", renewSignedSession);
    };
  }, [enabled, refresh]);

  const retryAfterResourceError = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current;
    if (!current || current.expiresAt === null || resourceRetryCountRef.current >= VIEW_SESSION_MAX_ERROR_RETRIES) {
      return false;
    }
    resourceRetryCountRef.current += 1;
    resourceRecoveryPendingRef.current = true;
    setResourceRecoveryFailed(false);
    onBeforeUrlChangeRef.current?.();
    const result = await refresh();
    return result === "changed" || result === "unchanged" || retryTimerRef.current !== null;
  }, [refresh]);

  const markResourceLoaded = useCallback(() => {
    resourceRetryCountRef.current = 0;
    resourceRecoveryPendingRef.current = false;
    setResourceRecoveryFailed(false);
  }, []);

  return { session, resourceRevision, resourceRecoveryFailed, retryAfterResourceError, markResourceLoaded };
}

const RendererToolbar: React.FC<{
  spec: BlockTermRendererSpec;
  fileName?: string;
  viewUrl: string | null;
  onReload: () => void;
  reloadDisabled?: boolean;
  children?: React.ReactNode;
}> = ({ spec, fileName, viewUrl, onReload, reloadDisabled, children }) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const sourceLabel = spec.source === "pty" ? fileName || "PTY output" : fileName || spec.filePath;
  return (
    <div className="flex h-11 min-w-0 items-center gap-1 overflow-x-auto border-b border-ide-border bg-ide-panel px-2 md:h-9">
      <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-ide-mute" title={sourceLabel}>
        {sourceLabel}
      </span>
      {children}
      <button
        type="button"
        className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-40 md:size-auto"
        title={t("common.refresh")}
        aria-label={t("common.refresh")}
        onClick={onReload}
        disabled={reloadDisabled}
      >
        <RefreshCw size={14} />
      </button>
      {viewUrl && (
        <>
          <a
            href={viewUrl}
            download={fileName || true}
            className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto"
            title={t("preview.download")}
            aria-label={t("preview.download")}
          >
            <Download size={14} />
          </a>
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto"
            title={t("preview.openInNewTab")}
            aria-label={t("preview.openInNewTab")}
          >
            <ExternalLink size={14} />
          </a>
        </>
      )}
    </div>
  );
};

const RendererLoading: React.FC = () => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  return (
    <div className="h-64 flex items-center justify-center gap-2 text-xs text-ide-mute">
      <Loader2 className="animate-spin" size={16} />
      <span>{t("common.loading")}</span>
    </div>
  );
};

const RendererError: React.FC<{ error: string; output: string; onRetry: () => void }> = ({
  error,
  output,
  onRetry,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  return (
    <div className="min-h-28 p-3 flex flex-col gap-2 text-xs">
      <div className="flex items-start gap-2 text-red-500">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <span className="break-words">{error}</span>
        <button
          type="button"
          className="ml-auto flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-panel hover:text-ide-text md:size-auto"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          onClick={onRetry}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {output && <pre className="select-text whitespace-pre-wrap break-words font-mono text-ide-mute">{output}</pre>}
    </div>
  );
};

const CodeRenderer: React.FC<BlockTermRendererComponentProps> = ({ block, spec, data, onReload, readOnly }) => {
  const blockId = block.id;
  const fileClient = React.useContext(RendererFileClientContext);
  const theme = useAppStore((state) => state.theme);
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const cached = readOnly ? undefined : codeDraftCache.get(blockId);
  const initial = cached?.path === spec.filePath ? cached : null;
  const [content, setContent] = useState(initial?.content ?? data.content);
  const [original, setOriginal] = useState(initial?.original ?? data.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const saveActionRef = useRef<{ dispose: () => void } | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const editable = !readOnly && spec.mode === "edit" && data.writable;
  const dirty = editable && content !== original;

  useEffect(() => {
    if (readOnly) {
      setContent(data.content);
      setOriginal(data.content);
      return;
    }
    const draft = codeDraftCache.get(blockId);
    if (draft?.path === spec.filePath && draft.dirty) return;
    setContent(data.content);
    setOriginal(data.content);
    codeDraftCache.delete(blockId);
  }, [blockId, data.content, readOnly, spec.filePath]);

  const save = useCallback(async () => {
    if (!editable || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fileClient.save(spec.filePath, content);
      setOriginal(content);
      codeDraftCache.delete(blockId);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("preview.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [blockId, content, dirty, editable, fileClient, saving, spec.filePath, t]);
  saveRef.current = () => void save();

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    saveActionRef.current?.dispose();
    if (!editable) {
      saveActionRef.current = null;
      return;
    }
    saveActionRef.current = editor.addAction({
      id: `blockterm-save-${blockId}`,
      label: t("common.save"),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveRef.current(),
    });
  };

  useEffect(
    () => () => {
      saveActionRef.current?.dispose();
      saveActionRef.current = null;
    },
    []
  );

  const language = spec.lang || getLanguageFromExtension(extensionFromPath(spec.filePath || block.command));
  const fileName = rendererDisplayName(spec, data);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, { enabled: Boolean(data.viewSession) });
  return (
    <div className="h-[min(52vh,34rem)] min-h-72 flex flex-col">
      <RendererToolbar
        spec={spec}
        fileName={fileName}
        viewUrl={viewSession.session?.url || null}
        onReload={onReload}
        reloadDisabled={dirty || saving}
      >
        {data.missing && <span className="px-1 text-[10px] text-yellow-500">new</span>}
        {dirty && <span className="h-1.5 w-1.5 bg-yellow-500" title={t("preview.unsavedChanges")} />}
        {editable && (
          <button
            type="button"
            className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-40 md:size-auto"
            title={t("common.save")}
            aria-label={t("common.save")}
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
          </button>
        )}
      </RendererToolbar>
      {saveError && <div className="px-3 py-1.5 border-b border-red-500/30 text-xs text-red-500">{saveError}</div>}
      <div className="min-h-0 flex-1">
        <Editor
          path={`file:///blockterm/${encodeURIComponent(blockId)}/${encodeURIComponent(fileName || "source")}`}
          height="100%"
          language={language}
          value={content}
          theme={theme === "light" ? "light" : "vs-dark"}
          onChange={(value) => {
            if (readOnly) return;
            const next = value ?? "";
            setContent(next);
            if (editable && next !== original) {
              codeDraftCache.set(blockId, {
                path: spec.filePath,
                content: next,
                original,
                dirty: true,
              });
            } else {
              codeDraftCache.delete(blockId);
            }
          }}
          onMount={handleMount}
          options={{
            readOnly: !editable,
            minimap: { enabled: spec.minimap !== false },
            automaticLayout: true,
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 8, bottom: 8 },
            glyphMargin: false,
          }}
        />
      </div>
    </div>
  );
};

function safeExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

function useRendererResourceSession(path: string) {
  return useRenewingViewSession(path, null);
}

const RendererResourceLink: React.FC<{
  path: string;
  children: React.ReactNode;
}> = ({ path, children }) => {
  const { session } = useRendererResourceSession(path);
  const url = session?.url;
  if (!url) return <span>{children}</span>;
  return (
    <a className="text-ide-accent underline" href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

const RendererResourceImage: React.FC<{ path: string; alt: string }> = ({ path, alt }) => {
  const { session, resourceRevision, retryAfterResourceError, markResourceLoaded } = useRendererResourceSession(path);
  const url = session?.url;
  if (!url) return null;
  return (
    <img
      key={viewResourceKey(session, resourceRevision)}
      src={url}
      alt={alt}
      className="my-3 max-w-full"
      onLoad={markResourceLoaded}
      onError={() => void retryAfterResourceError()}
    />
  );
};

const MarkdownRenderer: React.FC<BlockTermRendererComponentProps> = ({ spec, data, onReload }) => {
  const fileName = rendererDisplayName(spec, data);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, { enabled: Boolean(data.viewSession) });
  return (
    <div className="h-[min(52vh,34rem)] min-h-64 flex flex-col">
      <RendererToolbar spec={spec} fileName={fileName} viewUrl={viewSession.session?.url || null} onReload={onReload} />
      <article className="min-h-0 flex-1 overflow-auto custom-scrollbar p-4 text-sm leading-6 text-ide-text">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ node: _node, ...props }) => <h1 className="mb-3 mt-1 text-xl font-semibold" {...props} />,
            h2: ({ node: _node, ...props }) => <h2 className="mb-2 mt-5 text-lg font-semibold" {...props} />,
            h3: ({ node: _node, ...props }) => <h3 className="mb-2 mt-4 text-base font-semibold" {...props} />,
            p: ({ node: _node, ...props }) => <p className="my-3" {...props} />,
            ul: ({ node: _node, ...props }) => <ul className="my-3 list-disc pl-6" {...props} />,
            ol: ({ node: _node, ...props }) => <ol className="my-3 list-decimal pl-6" {...props} />,
            blockquote: ({ node: _node, ...props }) => (
              <blockquote className="my-3 border-l-2 border-ide-border pl-3 text-ide-mute" {...props} />
            ),
            pre: ({ node: _node, ...props }) => (
              <pre
                className="my-3 overflow-auto border border-ide-border bg-ide-panel p-3 font-mono text-xs"
                {...props}
              />
            ),
            code: ({ node: _node, ...props }) => <code className="font-mono text-[0.9em]" {...props} />,
            table: ({ node: _node, ...props }) => <table className="my-3 w-full border-collapse text-xs" {...props} />,
            th: ({ node: _node, ...props }) => (
              <th className="border border-ide-border bg-ide-panel px-2 py-1 text-left" {...props} />
            ),
            td: ({ node: _node, ...props }) => <td className="border border-ide-border px-2 py-1" {...props} />,
            a: ({ node: _node, href, children, ...props }) => {
              if (!href) return <span>{children}</span>;
              if (href.startsWith("#")) return <a href={href}>{children}</a>;
              if (safeExternalHref(href)) {
                return (
                  <a
                    className="text-ide-accent underline"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    {...props}
                  >
                    {children}
                  </a>
                );
              }
              if (spec.source !== "file") return <span>{children}</span>;
              const localPath = resolveRendererRelativeResource(spec.filePath, href);
              if (!localPath) return <span>{children}</span>;
              return <RendererResourceLink path={localPath}>{children}</RendererResourceLink>;
            },
            img: ({ node: _node, src, alt }) => {
              if (!src) return null;
              if (spec.source !== "file") return null;
              const localPath = resolveRendererRelativeResource(spec.filePath, src);
              if (!localPath) return null;
              return <RendererResourceImage path={localPath} alt={alt || ""} />;
            },
          }}
        >
          {data.content}
        </ReactMarkdown>
      </article>
    </div>
  );
};

const MustacheRenderer: React.FC<BlockTermRendererComponentProps> = ({ spec, data, onReload }) => {
  const result = useMemo(() => {
    try {
      if (!mustachePurifier) throw new Error("mustache renderer is unavailable outside a browser");
      return { html: renderBlockTermMustache(data.content, spec.variables || {}, mustachePurifier), error: null };
    } catch (error) {
      return { html: "", error: error instanceof Error ? error.message : "mustache renderer failed" };
    }
  }, [data.content, spec.variables]);
  const fileName = rendererDisplayName(spec, data);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, { enabled: Boolean(data.viewSession) });
  if (result.error) return <RendererError error={result.error} output="" onRetry={onReload} />;
  return (
    <div className="h-[min(52vh,34rem)] min-h-64 flex flex-col">
      <RendererToolbar spec={spec} fileName={fileName} viewUrl={viewSession.session?.url || null} onReload={onReload} />
      <article
        className="min-h-0 flex-1 overflow-auto custom-scrollbar p-4 text-sm leading-6 text-ide-text [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-ide-border [&_blockquote]:pl-3 [&_code]:font-mono [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:border [&_pre]:border-ide-border [&_pre]:bg-ide-panel [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_td]:border [&_td]:border-ide-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-ide-border [&_th]:bg-ide-panel [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: result.html is sanitized by DOMPurify above.
        dangerouslySetInnerHTML={{ __html: result.html }}
      />
    </div>
  );
};

const CsvRenderer: React.FC<BlockTermRendererComponentProps> = ({ spec, data, onReload }) => {
  const table = useMemo(() => parseBlockTermCsv(data.content), [data.content]);
  const [sort, setSort] = useState<{ column: number; direction: "asc" | "desc" } | null>(null);
  const rows = useMemo(() => {
    const values = table.rows.slice();
    if (sort) {
      values.sort((left, right) => {
        const a = left[sort.column] || "";
        const b = right[sort.column] || "";
        const numericA = Number(a);
        const numericB = Number(b);
        const comparison =
          Number.isFinite(numericA) && Number.isFinite(numericB) ? numericA - numericB : a.localeCompare(b);
        return sort.direction === "asc" ? comparison : -comparison;
      });
    }
    return values.slice(0, MAX_RENDERED_CSV_ROWS);
  }, [sort, table.rows]);
  const renderedRowCount = Math.min(table.rows.length, MAX_RENDERED_CSV_ROWS);
  const fileName = rendererDisplayName(spec, data);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, { enabled: Boolean(data.viewSession) });
  return (
    <div className="h-[min(52vh,34rem)] min-h-64 flex flex-col">
      <RendererToolbar spec={spec} fileName={fileName} viewUrl={viewSession.session?.url || null} onReload={onReload}>
        <span className="px-1 text-[10px] tabular-nums text-ide-mute">
          {renderedRowCount < table.totalRows ? `${renderedRowCount}/${table.totalRows}` : table.totalRows} ×{" "}
          {table.columns.length}
          {table.truncated ? "+" : ""}
        </span>
      </RendererToolbar>
      <div className="min-h-0 flex-1 overflow-auto custom-scrollbar">
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-ide-panel">
            <tr>
              {table.columns.map((column, index) => (
                <th key={`${column}-${index}`} className="border-b border-r border-ide-border text-left font-medium">
                  <button
                    type="button"
                    className="h-8 w-full px-2 flex items-center justify-between gap-2 hover:bg-ide-bg"
                    onClick={() =>
                      setSort((current) => ({
                        column: index,
                        direction: current?.column === index && current.direction === "asc" ? "desc" : "asc",
                      }))
                    }
                  >
                    <span className="max-w-64 truncate">{column}</span>
                    <ArrowDownUp size={11} className="shrink-0 text-ide-mute" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-ide-border hover:bg-ide-panel">
                {table.columns.map((column, columnIndex) => (
                  <td
                    key={`${column}-${columnIndex}`}
                    className="max-w-80 border-r border-ide-border px-2 py-1.5 align-top whitespace-pre-wrap break-words"
                  >
                    {row[columnIndex]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const ImageRenderer: React.FC<BlockTermRendererComponentProps> = ({ spec, data, onReload }) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const [scale, setScale] = useState(1);
  const [decodeError, setDecodeError] = useState(false);
  const fileName = rendererDisplayName(spec, data);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, { enabled: Boolean(data.viewSession) });
  const session = viewSession.session;
  const url = session?.url || null;
  useEffect(() => setDecodeError(viewSession.resourceRecoveryFailed), [url, viewSession.resourceRecoveryFailed]);
  if (!session || !url) return <RendererError error={t("preview.loadFailed")} output="" onRetry={onReload} />;
  if (decodeError) return <RendererError error={t("preview.loadFailed")} output="" onRetry={onReload} />;
  return (
    <div className="h-[min(52vh,34rem)] min-h-64 flex flex-col">
      <RendererToolbar spec={spec} fileName={fileName} viewUrl={url} onReload={onReload}>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto"
          title={t("preview.zoomOut")}
          aria-label={t("preview.zoomOut")}
          onClick={() => setScale((value) => Math.max(0.1, value / 1.25))}
        >
          <ZoomOut size={14} />
        </button>
        <span className="w-10 text-center text-[10px] tabular-nums text-ide-mute">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto"
          title={t("preview.zoomIn")}
          aria-label={t("preview.zoomIn")}
          onClick={() => setScale((value) => Math.min(5, value * 1.25))}
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center p-1.5 text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto"
          title={t("preview.reset")}
          aria-label={t("preview.reset")}
          onClick={() => setScale(1)}
        >
          <RotateCcw size={14} />
        </button>
      </RendererToolbar>
      <div className="min-h-0 flex-1 overflow-auto custom-scrollbar flex items-center justify-center bg-ide-bg p-3">
        <img
          key={viewResourceKey(session, viewSession.resourceRevision)}
          src={url}
          alt={fileName || ""}
          className="max-h-full max-w-full object-contain"
          style={{ transform: `scale(${scale})`, transformOrigin: "center" }}
          onLoad={viewSession.markResourceLoaded}
          onError={() => {
            void viewSession.retryAfterResourceError().then((willReload) => {
              if (!willReload) setDecodeError(true);
            });
          }}
        />
      </div>
    </div>
  );
};

const PdfRenderer: React.FC<BlockTermRendererComponentProps> = ({ spec, data, onReload }) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const fileName = rendererDisplayName(spec, data);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, { enabled: Boolean(data.viewSession) });
  const session = viewSession.session;
  const url = session?.url || null;
  if (!session || !url) return <RendererError error={t("preview.loadFailed")} output="" onRetry={onReload} />;
  return (
    <div className="h-[min(58vh,38rem)] min-h-80 flex flex-col">
      <RendererToolbar spec={spec} fileName={fileName} viewUrl={url} onReload={onReload} />
      <iframe
        key={session ? viewResourceKey(session, viewSession.resourceRevision) : "missing"}
        src={url || undefined}
        className="min-h-0 flex-1 w-full border-0 bg-white"
        title={fileName || spec.filePath}
        onLoad={viewSession.markResourceLoaded}
        onError={() => void viewSession.retryAfterResourceError()}
      />
    </div>
  );
};

interface MediaPlaybackSnapshot {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
}

const MediaRenderer: React.FC<BlockTermRendererComponentProps> = ({ spec, data, onReload }) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const [playbackError, setPlaybackError] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const pendingPlaybackRef = useRef<MediaPlaybackSnapshot | null>(null);
  const fileName = rendererDisplayName(spec, data);
  const extension = (data.info?.extension || extensionFromPath(spec.filePath)).toLowerCase();
  const isAudio =
    data.mimeType?.startsWith("audio/") || [".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"].includes(extension);
  const capturePlayback = useCallback(() => {
    const media = mediaRef.current;
    if (!media || pendingPlaybackRef.current) return;
    pendingPlaybackRef.current = {
      currentTime: media.currentTime,
      paused: media.paused,
      playbackRate: media.playbackRate,
      volume: media.volume,
      muted: media.muted,
    };
  }, []);
  const viewSession = useRenewingViewSession(spec.filePath, data.viewSession, {
    enabled: Boolean(data.viewSession),
    onBeforeUrlChange: capturePlayback,
  });
  const session = viewSession.session;
  const url = session?.url || null;
  useEffect(() => setPlaybackError(viewSession.resourceRecoveryFailed), [url, viewSession.resourceRecoveryFailed]);

  const setMediaElement = useCallback((media: HTMLMediaElement | null) => {
    mediaRef.current = media;
  }, []);

  const restorePlayback = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    viewSession.markResourceLoaded();
    const snapshot = pendingPlaybackRef.current;
    if (!snapshot) return;
    pendingPlaybackRef.current = null;
    media.playbackRate = snapshot.playbackRate;
    media.volume = snapshot.volume;
    media.muted = snapshot.muted;
    try {
      media.currentTime = clampMediaRestoreTime(snapshot.currentTime, media.duration);
    } catch {
      // Some media formats are not seekable until more data has loaded.
    }
    if (snapshot.paused) {
      media.pause();
    } else {
      void media.play().catch(() => {});
    }
  }, [viewSession.markResourceLoaded]);

  const handlePlaybackError = useCallback(() => {
    void viewSession.retryAfterResourceError().then((willReload) => {
      if (!willReload) setPlaybackError(true);
    });
  }, [viewSession.retryAfterResourceError]);

  if (!session || !url) return <RendererError error={t("preview.loadFailed")} output="" onRetry={onReload} />;
  return (
    <div className={`${isAudio ? "min-h-28" : "h-[min(52vh,34rem)] min-h-64"} flex flex-col`}>
      <RendererToolbar spec={spec} fileName={fileName} viewUrl={url} onReload={onReload} />
      <div className="min-h-0 flex-1 flex items-center justify-center bg-ide-bg p-4">
        {playbackError ? (
          <div className="flex items-center gap-2 text-xs text-red-500">
            <AlertTriangle size={15} />
            <span>{t("preview.loadFailed")}</span>
          </div>
        ) : isAudio ? (
          <audio
            key={viewResourceKey(session, viewSession.resourceRevision)}
            ref={setMediaElement}
            src={url}
            controls
            className="w-full max-w-xl"
            onLoadedMetadata={restorePlayback}
            onError={handlePlaybackError}
          >
            {t("preview.audioUnsupported")}
          </audio>
        ) : (
          <video
            key={viewResourceKey(session, viewSession.resourceRevision)}
            ref={setMediaElement}
            src={url}
            controls
            className="max-h-full max-w-full"
            onLoadedMetadata={restorePlayback}
            onError={handlePlaybackError}
          >
            {t("preview.videoUnsupported")}
          </video>
        )}
      </div>
    </div>
  );
};

interface ModelRendererProps {
  block: BlockTermBlock;
  spec: BlockTermRendererSpec;
  fallback: React.ReactNode;
  readOnly: boolean;
  onModelEvent?: (patch: Partial<Pick<BlockTermBlock, "output" | "status" | "exitCode" | "finishedAt">>) => void;
  onStreamUnavailable?: (unavailable: boolean) => void;
}

const ModelRenderer: React.FC<ModelRendererProps> = ({
  block,
  spec,
  fallback,
  readOnly,
  onModelEvent,
  onStreamUnavailable,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const [output, setOutput] = useState(block.output);
  const [error, setError] = useState<string | null>(spec.error || null);
  const [stopping, setStopping] = useState(false);
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  const lastSequence = useRef<number | undefined>(undefined);
  const outputRef = useRef(block.output);
  const modelEventRef = useRef(onModelEvent);
  const streamUnavailableRef = useRef(onStreamUnavailable);
  modelEventRef.current = onModelEvent;
  streamUnavailableRef.current = onStreamUnavailable;

  useEffect(() => {
    setOutput(block.output);
    outputRef.current = block.output;
    setError(spec.error || null);
    setStreamUnavailable(false);
    streamUnavailableRef.current?.(false);
    lastSequence.current = undefined;
  }, [block.id, spec.error]);

  useEffect(() => {
    if (readOnly || block.status !== "streaming") return;
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let reconnectDelay = 250;

    const scheduleReconnect = () => {
      if (controller.signal.aborted || settled) return;
      const delay = reconnectDelay;
      reconnectDelay = nextBlockTermModelReconnectDelay(reconnectDelay);
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    const applyEvent = (event: BlockTermModelStreamEvent): { settled: boolean; progressed: boolean } => {
      let progressed = false;
      if (typeof event.seq === "number") {
        if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq <= (lastSequence.current ?? -1))
          return { settled: false, progressed: false };
        lastSequence.current = event.seq;
        progressed = true;
      }
      let outputChanged = false;
      if (typeof event.text === "string") {
        outputRef.current = event.text;
        setOutput(event.text);
        outputChanged = true;
      } else if (typeof event.delta === "string") {
        outputRef.current += event.delta;
        setOutput(outputRef.current);
        outputChanged = true;
      }
      if (outputChanged) {
        progressed = true;
        setError(null);
        modelEventRef.current?.({ output: outputRef.current });
      }
      if (event.error) setError(event.error);
      if (progressed) reconnectDelay = 250;
      const terminalStatus = event.status === "success" || event.status === "error" || event.status === "interrupted";
      if (terminalStatus || event.done) {
        settled = true;
        progressed = true;
        setStreamUnavailable(false);
        streamUnavailableRef.current?.(false);
        const status = terminalStatus ? event.status : event.error ? "error" : "success";
        modelEventRef.current?.({
          output: outputRef.current,
          status,
          exitCode: status === "success" ? 0 : null,
          finishedAt: Date.now(),
        });
        return { settled: true, progressed };
      }
      return { settled: false, progressed };
    };

    const connect = async (): Promise<void> => {
      if (controller.signal.aborted || settled) return;
      try {
        const response = await fetch(blockTermModelApi.eventsUrl(block.id, lastSequence.current), {
          headers: blockTermModelApi.authHeaders(),
          signal: controller.signal,
        });
        if (!response.ok) {
          const message = `model stream failed (${response.status})`;
          if (!shouldRetryBlockTermModelStream(response.status)) {
            settled = true;
            setError(message);
            setStreamUnavailable(true);
            streamUnavailableRef.current?.(true);
            return;
          }
          throw new Error(message);
        }
        if (!response.body) throw new Error("model stream returned no body");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = "";
        let receivedProgress = false;
        while (!controller.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          pending += next.value;
          const parsedFrames = splitBlockTermModelSSE(pending);
          pending = parsedFrames.pending;
          for (const frame of parsedFrames.frames) {
            const event = parseBlockTermModelSSEFrame(frame);
            if (!event) continue;
            const applied = applyEvent(event);
            receivedProgress ||= applied.progressed;
            if (applied.settled) {
              await reader.cancel();
              return;
            }
          }
        }
        if (pending.trim()) {
          const event = parseBlockTermModelSSEFrame(pending);
          if (event) receivedProgress ||= applyEvent(event).progressed;
        }
        if (receivedProgress) reconnectDelay = 250;
        scheduleReconnect();
      } catch (streamError) {
        if (controller.signal.aborted || settled) return;
        setError(streamError instanceof Error ? streamError.message : "model stream failed");
        scheduleReconnect();
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    };
  }, [block.id, block.status, readOnly]);

  const cancel = async () => {
    setStopping(true);
    try {
      await blockTermModelApi.cancel(block.id);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "failed to stop model run");
    } finally {
      setStopping(false);
    }
  };

  const prompt = block.text || spec.prompt || (typeof fallback === "string" ? fallback : "");
  return (
    <div className="border-t border-ide-border bg-ide-bg" data-blockterm-renderer="model">
      <div className="flex items-center justify-between border-b border-ide-border px-3 py-2 text-xs text-ide-mute">
        <span className="truncate">{spec.model || t("plugin.blockTerm.rendererOptions.openai")}</span>
        {!readOnly && canControlBlockTermModelStream(block.status, streamUnavailable) && (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text"
            onClick={() => void cancel()}
            disabled={stopping}
            title={t("plugin.blockTerm.stop")}
            aria-label={t("plugin.blockTerm.stop")}
          >
            {stopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />}
          </button>
        )}
      </div>
      <article className="max-h-[52vh] overflow-auto custom-scrollbar p-3 text-sm leading-6 text-ide-text [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-ide-border [&_blockquote]:pl-3 [&_blockquote]:text-ide-mute [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:mb-3 [&_h1]:mt-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:border [&_pre]:border-ide-border [&_pre]:bg-ide-panel [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_td]:border [&_td]:border-ide-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-ide-border [&_th]:bg-ide-panel [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6">
        <div className="mb-3 border-b border-ide-border pb-3 text-xs text-ide-mute" data-model-prompt>
          {prompt}
        </div>
        {output ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
        ) : (
          <span className="text-ide-mute">
            {!readOnly && canControlBlockTermModelStream(block.status, streamUnavailable) ? "..." : ""}
          </span>
        )}
        {error && <div className="mt-3 border-t border-red-500/40 pt-2 text-xs text-red-500">{error}</div>}
      </article>
    </div>
  );
};

interface BlockTermRendererHostProps {
  block: BlockTermBlock;
  fallback: React.ReactNode;
  fileClient: RendererFileClient;
  rawOutput?: BlockTermRawOutputLoader;
  readOnly?: boolean;
  onModelEvent?: (
    blockId: string,
    patch: Partial<Pick<BlockTermBlock, "output" | "status" | "exitCode" | "finishedAt">>
  ) => void;
  onModelStreamUnavailable?: (blockId: string, unavailable: boolean) => void;
}

const blockTermRendererHostRegistry = blockTermRendererRegistry.createDispatch<
  React.FC<BlockTermRendererComponentProps>
>({
  code: CodeRenderer,
  markdown: MarkdownRenderer,
  csv: CsvRenderer,
  image: ImageRenderer,
  pdf: PdfRenderer,
  media: MediaRenderer,
  mustache: MustacheRenderer,
  openai: () => null,
});

const BlockTermRendererHost: React.FC<BlockTermRendererHostProps> = ({
  block,
  fallback,
  fileClient,
  rawOutput,
  readOnly = false,
  onModelEvent,
  onModelStreamUnavailable,
}) => {
  const rendererDispatch = blockTermRendererHostRegistry.resolve(block.renderer);
  const spec = useMemo(
    () => parseBlockTermRendererState(block.renderer, block.stateJson, block.cwd),
    [block.cwd, block.renderer, block.stateJson]
  );
  const [reloadVersion, setReloadVersion] = useState(0);
  if (!block.renderer) return fallback;
  if (block.renderer === "none") return null;
  if (!rendererDispatch) return fallback;
  if (!spec) {
    return (
      <div className="border-t border-ide-border bg-ide-bg">
        <RendererError
          error="invalid renderer state"
          output={block.output}
          onRetry={() => setReloadVersion((v) => v + 1)}
        />
      </div>
    );
  }
  if (spec.renderer === "openai") {
    return (
      <ModelRenderer
        block={block}
        spec={spec}
        fallback={fallback}
        readOnly={readOnly}
        onModelEvent={(patch) => onModelEvent?.(block.id, patch)}
        onStreamUnavailable={(unavailable) => onModelStreamUnavailable?.(block.id, unavailable)}
      />
    );
  }
  if (block.status === "running") return fallback;
  return (
    <RendererFileClientContext.Provider value={fileClient}>
      <KnownBlockRenderer
        block={block}
        spec={spec}
        reloadVersion={reloadVersion}
        setReloadVersion={setReloadVersion}
        rendererComponent={rendererDispatch.handler}
        rawOutput={rawOutput}
        readOnly={readOnly}
      />
    </RendererFileClientContext.Provider>
  );
};

const KnownBlockRenderer: React.FC<{
  block: BlockTermBlock;
  spec: BlockTermRendererSpec;
  reloadVersion: number;
  setReloadVersion: React.Dispatch<React.SetStateAction<number>>;
  rendererComponent: React.FC<BlockTermRendererComponentProps>;
  rawOutput?: BlockTermRawOutputLoader;
  readOnly: boolean;
}> = ({ block, spec, reloadVersion, setReloadVersion, rendererComponent: RendererComponent, rawOutput, readOnly }) => {
  const { data, loading, error } = useRendererData(block, spec, reloadVersion, rawOutput);
  const reload = () => setReloadVersion((value) => value + 1);
  return (
    <div className="border-t border-ide-border bg-ide-bg" data-blockterm-renderer={spec.renderer}>
      {loading ? (
        <RendererLoading />
      ) : error || !data ? (
        <RendererError error={error || "renderer failed to load"} output={block.output} onRetry={reload} />
      ) : (
        <RendererComponent block={block} spec={spec} data={data} onReload={reload} readOnly={readOnly} />
      )}
    </div>
  );
};

export default BlockTermRendererHost;
