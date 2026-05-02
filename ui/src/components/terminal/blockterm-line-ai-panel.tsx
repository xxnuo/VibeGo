import { Loader2, RotateCcw, Send, Sparkles, Square, Terminal, Trash2, User, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { blockTermModelApi } from "@/api/blockterm-model";
import {
  type BlockTermLineAIMessage,
  type BlockTermLineAIRefillEdit,
  type BlockTermLineAIRunInput,
  buildBlockTermLineAIRefillEdit,
  buildBlockTermLineAIRetryInput,
  buildBlockTermLineAIRunInput,
  extractBlockTermLineAICodeBlocks,
  getBlockTermLineAIDefaultPrompt,
} from "@/components/terminal/blockterm-line-ai";
import { type BlockTermBlock, generateId } from "@/components/terminal/blockterm-model";
import {
  type BlockTermModelStatus,
  type BlockTermModelStreamEvent,
  nextBlockTermModelReconnectDelay,
  parseBlockTermModelSSEFrame,
  shouldRetryBlockTermModelStream,
  splitBlockTermModelSSE,
} from "@/components/terminal/blockterm-model-stream";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";

interface BlockTermLineAIUIMessage extends BlockTermLineAIMessage {
  id: string;
  status?: BlockTermModelStatus;
  error?: string;
  request?: BlockTermLineAIRunInput;
  restartOnRetry?: boolean;
}

interface ActiveRun {
  id: string;
  assistantId: string;
  controller: AbortController;
  created: boolean;
  stopRequested: boolean;
}

interface CachedConversation {
  sourceBlockId: string;
  messages: BlockTermLineAIUIMessage[];
  draft: string;
}

const conversationCache = new Map<string, CachedConversation>();

export function clearBlockTermLineAIConversation(terminalId: string): void {
  conversationCache.delete(terminalId);
}

interface BlockTermLineAIPanelProps {
  active: boolean;
  terminalId: string;
  sourceBlock: BlockTermBlock;
  onClose: () => void;
  onRefill: (edit: BlockTermLineAIRefillEdit) => void;
  allocateLineNum: () => number;
}

function reconnectWait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

const BlockTermLineAIPanel: React.FC<BlockTermLineAIPanelProps> = ({
  active,
  terminalId,
  sourceBlock,
  onClose,
  onRefill,
  allocateLineNum,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const initialConversation = conversationCache.get(terminalId);
  const [messages, setMessages] = useState<BlockTermLineAIUIMessage[]>(() =>
    initialConversation?.sourceBlockId === sourceBlock.id ? initialConversation.messages : []
  );
  const [draft, setDraft] = useState(() =>
    initialConversation?.sourceBlockId === sourceBlock.id
      ? initialConversation.draft
      : getBlockTermLineAIDefaultPrompt(sourceBlock)
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const conversationIdentityRef = useRef(`${terminalId}:${sourceBlock.id}`);
  const messagesRef = useRef(messages);
  const draftRef = useRef(draft);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  messagesRef.current = messages;
  draftRef.current = draft;

  const updateAssistant = useCallback(
    (assistantId: string, patch: Partial<Omit<BlockTermLineAIUIMessage, "id" | "role">>) => {
      setMessages((items) => items.map((item) => (item.id === assistantId ? { ...item, ...patch } : item)));
    },
    []
  );

  const clearActiveRun = useCallback((runId: string) => {
    if (activeRunRef.current?.id !== runId) return;
    activeRunRef.current = null;
    setActiveRunId(null);
    setStopping(false);
  }, []);

  const streamRun = useCallback(
    async (runId: string, assistantId: string, controller: AbortController, initialOutput: string) => {
      let output = initialOutput;
      let lastSequence: number | undefined;
      let reconnectDelay = 250;
      let settled = false;

      const applyEvent = (event: BlockTermModelStreamEvent) => {
        if (typeof event.seq === "number") {
          if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq <= (lastSequence ?? -1)) return;
          lastSequence = event.seq;
        }
        if (typeof event.text === "string") output = event.text;
        else if (typeof event.delta === "string") output += event.delta;
        const terminalStatus = event.status === "success" || event.status === "error" || event.status === "interrupted";
        const status = terminalStatus ? event.status : event.done ? (event.error ? "error" : "success") : "streaming";
        updateAssistant(assistantId, {
          content: output,
          status,
          error: event.error || undefined,
          restartOnRetry: status === "error",
        });
        if (terminalStatus || event.done) settled = true;
      };

      while (!controller.signal.aborted && !settled) {
        try {
          const response = await fetch(blockTermModelApi.eventsUrl(runId, lastSequence), {
            headers: blockTermModelApi.authHeaders(),
            signal: controller.signal,
          });
          if (!response.ok) {
            if (!shouldRetryBlockTermModelStream(response.status)) {
              updateAssistant(assistantId, {
                status: "error",
                error: t("plugin.blockTerm.lineAI.streamFailed"),
                restartOnRetry: false,
              });
              break;
            }
            throw new Error(`model stream failed (${response.status})`);
          }
          if (!response.body) throw new Error("model stream returned no body");
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let pending = "";
          let progressed = false;
          while (!controller.signal.aborted && !settled) {
            const next = await reader.read();
            if (next.done) break;
            pending += next.value;
            const parsed = splitBlockTermModelSSE(pending);
            pending = parsed.pending;
            for (const frame of parsed.frames) {
              const event = parseBlockTermModelSSEFrame(frame);
              if (!event) continue;
              applyEvent(event);
              progressed = true;
              if (settled) {
                await reader.cancel();
                break;
              }
            }
          }
          if (!settled && pending.trim()) {
            const event = parseBlockTermModelSSEFrame(pending);
            if (event) {
              applyEvent(event);
              progressed = true;
            }
          }
          if (settled || controller.signal.aborted) break;
          if (progressed) reconnectDelay = 250;
        } catch (error) {
          if (controller.signal.aborted) break;
          updateAssistant(assistantId, {
            status: "streaming",
            error: error instanceof Error ? error.message : t("plugin.blockTerm.lineAI.streamFailed"),
          });
        }
        const delay = reconnectDelay;
        reconnectDelay = nextBlockTermModelReconnectDelay(reconnectDelay);
        await reconnectWait(delay, controller.signal);
      }
      clearActiveRun(runId);
    },
    [clearActiveRun, t, updateAssistant]
  );

  const startRun = useCallback(
    async (request: BlockTermLineAIRunInput, assistantId: string) => {
      if (activeRunRef.current) return;
      const controller = new AbortController();
      activeRunRef.current = {
        id: request.id,
        assistantId,
        controller,
        created: false,
        stopRequested: false,
      };
      setActiveRunId(request.id);
      setStopping(false);
      updateAssistant(assistantId, {
        status: "streaming",
        error: undefined,
        request,
        restartOnRetry: false,
      });
      try {
        const response = await blockTermModelApi.create(request);
        const current = activeRunRef.current;
        if (current?.id === request.id) current.created = true;
        if (controller.signal.aborted) {
          await blockTermModelApi.cancel(request.id).catch(() => {});
          clearActiveRun(request.id);
          return;
        }
        const block = response.block;
        updateAssistant(assistantId, {
          content: block.output,
          status: block.status === "running" ? "streaming" : block.status,
          error: undefined,
          request,
          restartOnRetry: block.status === "error",
        });
        if (block.status !== "streaming") {
          clearActiveRun(request.id);
          return;
        }
        if (current?.id === request.id && current.stopRequested) {
          try {
            await blockTermModelApi.cancel(request.id);
          } catch (error) {
            if (activeRunRef.current?.id === request.id && !controller.signal.aborted) {
              current.stopRequested = false;
              setStopping(false);
              updateAssistant(assistantId, {
                error: error instanceof Error ? error.message : t("plugin.blockTerm.stopFailed"),
              });
            }
          }
        }
        if (controller.signal.aborted || activeRunRef.current?.id !== request.id) return;
        await streamRun(request.id, assistantId, controller, block.output);
      } catch (error) {
        // A failed Create response is ambiguous: the server may have admitted
        // the run before the connection was lost. Cancel the stable ID before
        // releasing it so a detached model request cannot keep running.
        let canceled = false;
        try {
          await blockTermModelApi.cancel(request.id);
          canceled = true;
        } catch {
          // A missing run remains ambiguous, so Retry must probe the stable ID.
        }
        if (!controller.signal.aborted) {
          updateAssistant(assistantId, {
            status: "error",
            error: error instanceof Error ? error.message : t("plugin.blockTerm.lineAI.requestFailed"),
            request,
            restartOnRetry: canceled,
          });
        }
        clearActiveRun(request.id);
      }
    },
    [clearActiveRun, streamRun, t, updateAssistant]
  );

  useEffect(() => {
    conversationCache.set(terminalId, {
      sourceBlockId: sourceBlock.id,
      messages,
      draft,
    });
  }, [draft, messages, sourceBlock.id, terminalId]);

  useEffect(() => {
    const identity = `${terminalId}:${sourceBlock.id}`;
    if (conversationIdentityRef.current === identity) return;
    conversationIdentityRef.current = identity;
    const current = activeRunRef.current;
    if (current) {
      current.controller.abort();
      void blockTermModelApi.cancel(current.id).catch(() => {});
      activeRunRef.current = null;
    }
    const cached = conversationCache.get(terminalId);
    setMessages(cached?.sourceBlockId === sourceBlock.id ? cached.messages : []);
    setDraft(cached?.sourceBlockId === sourceBlock.id ? cached.draft : getBlockTermLineAIDefaultPrompt(sourceBlock));
    setActiveRunId(null);
    setStopping(false);
  }, [sourceBlock, terminalId]);

  useEffect(
    () => () => {
      const current = activeRunRef.current;
      let cachedMessages = messagesRef.current;
      if (current) {
        current.controller.abort();
        void blockTermModelApi.cancel(current.id).catch(() => {});
        cachedMessages = cachedMessages.map((message) =>
          message.id === current.assistantId && message.status === "streaming"
            ? { ...message, status: "interrupted" }
            : message
        );
        activeRunRef.current = null;
      }
      conversationCache.set(terminalId, {
        sourceBlockId: sourceBlock.id,
        messages: cachedMessages,
        draft: draftRef.current,
      });
    },
    [sourceBlock.id, terminalId]
  );

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [active, sourceBlock.id]);

  useEffect(() => {
    const element = messageListRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  const sendPrompt = useCallback(() => {
    const userQuery = draft.trim();
    if (!userQuery || activeRunRef.current) return;
    const history = messages
      .filter((message) => message.content && message.status !== "streaming")
      .map(({ role, content }) => ({ role, content }));
    const runId = generateId();
    const request = buildBlockTermLineAIRunInput({
      id: runId,
      terminalId,
      lineNum: allocateLineNum(),
      selectedBlock: sourceBlock,
      userQuery,
      history,
    });
    const userId = generateId();
    const assistantId = generateId();
    setMessages((items) => [
      ...items,
      { id: userId, role: "user", content: userQuery, status: "success" },
      { id: assistantId, role: "assistant", content: "", status: "streaming", request },
    ]);
    setDraft("");
    void startRun(request, assistantId);
  }, [allocateLineNum, draft, messages, sourceBlock, startRun, terminalId]);

  const retryRun = useCallback(
    (request: BlockTermLineAIRunInput, assistantId: string, restart: boolean) => {
      const retryRequest = buildBlockTermLineAIRetryInput(
        request,
        restart,
        generateId(),
        restart ? allocateLineNum() : undefined
      );
      void startRun(retryRequest, assistantId);
    },
    [allocateLineNum, startRun]
  );

  const stopRun = useCallback(async () => {
    const current = activeRunRef.current;
    if (!current || current.stopRequested || stopping) return;
    const requestedBeforeCreate = !current.created;
    current.stopRequested = true;
    setStopping(true);
    try {
      await blockTermModelApi.cancel(current.id);
    } catch (error) {
      if (requestedBeforeCreate || activeRunRef.current?.id !== current.id) return;
      current.stopRequested = false;
      updateAssistant(current.assistantId, {
        error: error instanceof Error ? error.message : t("plugin.blockTerm.stopFailed"),
      });
      setStopping(false);
    }
  }, [stopping, t, updateAssistant]);

  const clearConversation = useCallback(() => {
    if (activeRunRef.current) return;
    setMessages([]);
    setDraft(getBlockTermLineAIDefaultPrompt(sourceBlock));
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [sourceBlock]);

  const sourceLabel = useMemo(
    () => sourceBlock.command || sourceBlock.text || t("plugin.blockTerm.lineAI.sourceBlock"),
    [sourceBlock.command, sourceBlock.text, t]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-ide-bg" data-blockterm-line-ai>
      <div className="flex min-h-11 items-center gap-2 border-b border-ide-border bg-ide-panel px-2 md:h-9 md:min-h-0">
        <Sparkles size={14} className="shrink-0 text-ide-accent" />
        <span className="min-w-0 flex-1 truncate text-xs text-ide-text" title={sourceLabel}>
          {sourceLabel}
        </span>
        {activeRunId && (
          <button
            type="button"
            className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-yellow-500 disabled:opacity-50 md:size-auto md:p-1.5"
            onClick={() => void stopRun()}
            disabled={stopping}
            title={t("plugin.blockTerm.stop")}
            aria-label={t("plugin.blockTerm.stop")}
          >
            {stopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />}
          </button>
        )}
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-40 md:size-auto md:p-1.5"
          onClick={clearConversation}
          disabled={!!activeRunId || messages.length === 0}
          title={t("plugin.blockTerm.lineAI.clear")}
          aria-label={t("plugin.blockTerm.lineAI.clear")}
        >
          <Trash2 size={14} />
        </button>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-1.5"
          onClick={onClose}
          title={t("plugin.blockTerm.closeSidebar")}
          aria-label={t("plugin.blockTerm.closeSidebar")}
        >
          <X size={14} />
        </button>
      </div>

      <div ref={messageListRef} className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-32 items-center justify-center px-4 text-xs text-ide-mute">
            {t("plugin.blockTerm.lineAI.empty")}
          </div>
        ) : (
          messages.map((message) => {
            const codeBlocks = message.role === "assistant" ? extractBlockTermLineAICodeBlocks(message.content) : [];
            return (
              <div
                key={message.id}
                data-blockterm-line-ai-message={message.role}
                className={`border-b border-ide-border px-3 py-3 text-sm leading-6 ${
                  message.role === "user" ? "bg-ide-panel/50" : "bg-ide-bg"
                }`}
              >
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ide-mute">
                  {message.role === "user" ? <User size={12} /> : <Sparkles size={12} />}
                  <span>
                    {message.role === "user"
                      ? t("plugin.blockTerm.lineAI.you")
                      : t("plugin.blockTerm.lineAI.assistant")}
                  </span>
                  {message.status === "streaming" && <Loader2 size={12} className="animate-spin" />}
                </div>
                {message.content && (
                  <article className="select-text break-words text-ide-text [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-ide-border [&_blockquote]:pl-3 [&_code]:font-mono [&_code]:text-[0.9em] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:border [&_pre]:border-ide-border [&_pre]:bg-ide-panel [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                  </article>
                )}
                {message.role === "assistant" && !message.content && message.status === "streaming" && (
                  <span className="text-ide-mute">...</span>
                )}
                {codeBlocks.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {codeBlocks.map((codeBlock) => (
                      <button
                        key={codeBlock.index}
                        type="button"
                        className="inline-flex min-h-11 items-center gap-1.5 border border-ide-border px-3 text-xs text-ide-mute hover:bg-ide-panel hover:text-ide-text md:min-h-8 md:px-2"
                        onClick={() => {
                          const edit = buildBlockTermLineAIRefillEdit(message.content, codeBlock.index);
                          if (edit) onRefill(edit);
                        }}
                        title={t("plugin.blockTerm.lineAI.refill")}
                      >
                        <Terminal size={13} />
                        <span>{t("plugin.blockTerm.lineAI.refill")}</span>
                      </button>
                    ))}
                  </div>
                )}
                {message.error && (
                  <div className="mt-2 border-t border-red-500/40 pt-2 text-xs text-red-500">{message.error}</div>
                )}
                {message.status === "error" && message.request && !activeRunId && (
                  <button
                    type="button"
                    data-blockterm-line-ai-retry
                    className="mt-2 inline-flex min-h-11 items-center gap-1.5 border border-ide-border px-3 text-xs text-ide-mute hover:bg-ide-panel hover:text-ide-text md:min-h-8 md:px-2"
                    onClick={() =>
                      retryRun(message.request as BlockTermLineAIRunInput, message.id, !!message.restartOnRetry)
                    }
                  >
                    <RotateCcw size={13} />
                    <span>{t("plugin.blockTerm.lineAI.retry")}</span>
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-ide-border bg-ide-panel p-2">
        <div className="flex items-end gap-2 border-l-2 border-transparent bg-ide-bg p-2 focus-within:border-ide-accent">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              sendPrompt();
            }}
            rows={2}
            disabled={!!activeRunId}
            className="max-h-32 min-h-12 min-w-0 flex-1 resize-none bg-transparent text-sm text-ide-text outline-none disabled:opacity-60"
            placeholder={t("plugin.blockTerm.lineAI.placeholder")}
          />
          <button
            type="button"
            data-blockterm-line-ai-send
            className="flex size-11 shrink-0 items-center justify-center bg-ide-accent text-ide-on-accent disabled:bg-ide-border disabled:text-ide-mute disabled:opacity-50 md:size-9"
            onClick={sendPrompt}
            disabled={!!activeRunId || !draft.trim()}
            title={t("plugin.blockTerm.lineAI.send")}
            aria-label={t("plugin.blockTerm.lineAI.send")}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default BlockTermLineAIPanel;
