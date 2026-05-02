import {
  Archive,
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Gauge,
  GitBranch,
  GitFork,
  History,
  ImagePlus,
  LoaderCircle,
  LogIn,
  LogOut,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codexApi } from "@/api/codex";
import { fileApi } from "@/api/file";
import {
  appendCodexItemText,
  appendCodexReasoning,
  type CodexThreadSelectionSnapshot,
  cleanupCodexRetryBranch,
  codexRetryBranchPoint,
  codexTranscriptSignature,
  codexUserInputForRetry,
  isCodexBeforeTurnForkUnsupported,
  isCodexThreadSelectionCurrent,
  isCodexTranscriptNearBottom,
  mergeCodexHistoryTurns,
  paginateCodexThreadHistory,
  upsertCodexItem,
  upsertCodexThread,
  upsertCodexTurn,
} from "@/components/codex/codex-state";
import { DirectoryPicker, useDialog } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useFrameController } from "@/framework/frame/controller";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { CodexAppServerClient, CodexRpcRequestError } from "@/lib/codex-app-server-client";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import type {
  CodexAccountRateLimitsResponse,
  CodexAccountResponse,
  CodexAccountUsageResponse,
  CodexApprovalPolicy,
  CodexAttachment,
  CodexConnectionState,
  CodexExecutionSettings,
  CodexLoginResponse,
  CodexMcpElicitationRequest,
  CodexMcpServerStatus,
  CodexMcpServerStatusResponse,
  CodexModel,
  CodexPendingRequest,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexSandboxMode,
  CodexSkill,
  CodexSkillsListResponse,
  CodexStatus,
  CodexThread,
  CodexThreadGoal,
  CodexThreadItem,
  CodexThreadListResponse,
  CodexThreadResponse,
  CodexThreadTurnsListResponse,
  CodexTurn,
  CodexUserInput,
  CodexUserInputQuestion,
} from "@/types/codex";
import "@/components/codex/codex-page.css";

interface CodexPageProps {
  context?: { groupId: string; tabId: string | null; isActive: boolean };
}

type ApprovalKind = "command" | "file" | "permissions" | "input" | "elicitation";

interface ApprovalPrompt {
  request: CodexPendingRequest;
  kind: ApprovalKind;
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const THREAD_TURN_PAGE_SIZE = 1;
const CODEX_RESPONSE_TOO_LARGE_RPC_CODE = -32001;
const PINNED_THREADS_STORAGE_KEY = "vibego_codex_pinned_threads";

class CodexRetryCancelledError extends Error {
  constructor() {
    super("Codex retry operation was cancelled");
    this.name = "CodexRetryCancelledError";
  }
}

const DEFAULT_MODELS = [
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Frontier coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
      { reasoningEffort: "ultra" },
    ],
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description: "Balanced coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
      { reasoningEffort: "ultra" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    isDefault: false,
  },
] as CodexModel[];

function threadTitle(thread: CodexThread, fallback: string): string {
  return thread.name?.trim() || thread.preview?.trim() || fallback;
}

function relativeTime(timestamp: number, locale: "en" | "zh"): string {
  if (!timestamp) return "";
  const elapsed = Math.max(0, Date.now() - timestamp * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return locale === "zh" ? "刚刚" : "now";
  if (elapsed < hour)
    return locale === "zh" ? `${Math.floor(elapsed / minute)} 分钟` : `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return locale === "zh" ? `${Math.floor(elapsed / hour)} 小时` : `${Math.floor(elapsed / hour)}h`;
  return locale === "zh" ? `${Math.floor(elapsed / day)} 天` : `${Math.floor(elapsed / day)}d`;
}

function inputText(item: CodexThreadItem): string {
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

function itemStatusLabel(item: CodexThreadItem): string {
  if (item.status === "inProgress" || item.status === "running") return "running";
  if (item.status === "failed" || item.status === "error") return "failed";
  if (item.status === "completed" || item.status === "succeeded") return "done";
  return item.status || "";
}

function approvalKind(method: string): ApprovalKind | null {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") return "command";
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "file";
  if (method === "item/permissions/requestApproval") return "permissions";
  if (method === "item/tool/requestUserInput") return "input";
  if (method === "mcpServer/elicitation/request") return "elicitation";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function elicitationFields(request: CodexMcpElicitationRequest): Array<[string, Record<string, unknown>]> {
  const properties = request.requestedSchema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] => {
    return Boolean(entry[1] && typeof entry[1] === "object");
  });
}

function rateLimitResetLabel(timestamp: number | null | undefined, locale: "en" | "zh"): string {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function mergeRateLimitWindow(
  previous: CodexRateLimitWindow | null | undefined,
  next: CodexRateLimitWindow | null | undefined
): CodexRateLimitWindow | null {
  if (!next) return previous || null;
  return { ...(previous || {}), ...next };
}

function mergeRateLimitSnapshot(
  previous: CodexRateLimitSnapshot | null | undefined,
  next: CodexRateLimitSnapshot
): CodexRateLimitSnapshot {
  return {
    ...(previous || {}),
    ...next,
    limitId: next.limitId || previous?.limitId || null,
    limitName: next.limitName || previous?.limitName || null,
    primary: mergeRateLimitWindow(previous?.primary, next.primary),
    secondary: mergeRateLimitWindow(previous?.secondary, next.secondary),
    rateLimitReachedType: next.rateLimitReachedType || previous?.rateLimitReachedType || null,
    spendControlReached: next.spendControlReached ?? previous?.spendControlReached ?? null,
  };
}

function rateLimitPercentLabel(snapshot: CodexRateLimitSnapshot | null | undefined): string {
  const windows = [snapshot?.primary, snapshot?.secondary].filter((window): window is CodexRateLimitWindow =>
    Boolean(window)
  );
  return windows.length > 0 ? windows.map((window) => `${window.usedPercent}%`).join(" / ") : "-";
}

function rateLimitResetLabels(snapshot: CodexRateLimitSnapshot | null | undefined, locale: "en" | "zh"): string {
  const labels = [snapshot?.primary?.resetsAt, snapshot?.secondary?.resetsAt]
    .filter((timestamp): timestamp is number => typeof timestamp === "number" && timestamp > 0)
    .map((timestamp) => rateLimitResetLabel(timestamp, locale));
  return [...new Set(labels)].join(" / ");
}

function rateLimitRows(response: CodexAccountRateLimitsResponse | null): Array<{
  id: string;
  label: string;
  snapshot: CodexRateLimitSnapshot;
}> {
  const snapshots = Object.entries(response?.rateLimitsByLimitId || {});
  if (snapshots.length === 0) {
    const snapshot = response?.rateLimits;
    return snapshot
      ? [
          {
            id: snapshot.limitId || "default",
            label: snapshot.limitName || "",
            snapshot,
          },
        ]
      : [];
  }
  return snapshots.map(([id, snapshot]) => ({
    id,
    label: snapshot.limitName || snapshot.limitId || id,
    snapshot,
  }));
}

function approvalCommand(prompt: ApprovalPrompt): string {
  const command = prompt.request.params.command;
  if (typeof command === "string" && command.trim()) return command;
  const actions = prompt.request.params.commandActions;
  if (Array.isArray(actions) && actions.length > 0) return JSON.stringify(actions, null, 2);
  return "";
}

function reactNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return reactNodeText(node.props.children);
  return "";
}

function userInputImages(item: CodexThreadItem): CodexUserInput[] {
  if (!Array.isArray(item.content)) return [];
  const content = item.content as CodexUserInput[];
  return content.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const type = (entry as { type?: unknown }).type;
    return type === "image" || type === "localImage";
  }) as CodexUserInput[];
}

function sandboxPolicyFor(mode: CodexSandboxMode, cwd: string): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: cwd ? [cwd] : [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function threadResumeOverrides(threadId: string, settings: CodexExecutionSettings): Record<string, unknown> {
  return {
    threadId,
    model: settings.model || null,
    cwd: settings.cwd || null,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
    // Keep paginated sessions from being expanded into one large response.
    excludeTurns: true,
  };
}

const CodexInputImage: React.FC<{ input: CodexUserInput }> = ({ input }) => {
  const [src, setSrc] = React.useState(input.type === "image" ? input.url || "" : "");
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (input.type !== "localImage" || !input.path) {
      setSrc(input.url || "");
      setFailed(false);
      return;
    }
    setFailed(false);
    void fileApi
      .viewUrl(input.path)
      .then((session) => {
        if (!cancelled) setSrc(session.url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [input.path, input.type, input.url]);

  if (failed || !src) {
    return <span className="codex-image-fallback">{input.path || input.url || "image"}</span>;
  }
  return (
    <img
      className="codex-message-image"
      src={src}
      alt={input.name || input.path?.split(/[\\/]/).pop() || "Codex attachment"}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
};

const CodexOutputImage: React.FC<{ item: CodexThreadItem }> = ({ item }) => {
  const path = typeof item.path === "string" ? item.path : typeof item.savedPath === "string" ? item.savedPath : "";
  const directUrl = typeof item.url === "string" ? item.url : "";
  const [src, setSrc] = React.useState(directUrl);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (directUrl || !path) {
      setSrc(directUrl);
      return;
    }
    void fileApi
      .viewUrl(path)
      .then((session) => {
        if (!cancelled) setSrc(session.url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [directUrl, path]);

  if (failed || !src) {
    return (
      <div className="codex-tool-body">
        <span className="codex-image-fallback">{path || directUrl || "image"}</span>
      </div>
    );
  }
  return (
    <div className="codex-tool-body">
      <img
        className="codex-output-image"
        src={src}
        alt={path.split(/[\\/]/).pop() || "Codex generated image"}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
      {path && <div className="mt-2 truncate text-[10px] text-ide-mute">{path}</div>}
    </div>
  );
};

const CodexPage: React.FC<CodexPageProps> = () => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const isMobile = useIsMobile();
  const dialog = useDialog();
  const { setPageMenuItems } = useFrameController();
  const clientRef = React.useRef<CodexAppServerClient | null>(null);
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = React.useRef<HTMLInputElement | null>(null);
  const loadThreadTokenRef = React.useRef(0);
  const resumedThreadIdsRef = React.useRef<Set<string>>(new Set());
  const startedThreadIdsRef = React.useRef<Set<string>>(new Set());
  const hydratedThreadIdsRef = React.useRef<Set<string>>(new Set());
  const failedHistoryThreadIdsRef = React.useRef<Set<string>>(new Set());
  const selectedThreadIdRef = React.useRef<string | null>(null);
  const threadSelectionEpochRef = React.useRef(0);
  const activeTurnIdRef = React.useRef<string | null>(null);
  const threadListRequestTokenRef = React.useRef(0);
  const threadListCursorRef = React.useRef<string | null>(null);
  const threadTokenUsageByIdRef = React.useRef<Map<string, Record<string, unknown>>>(new Map());
  const searchRef = React.useRef("");
  const showArchivedRef = React.useRef(false);
  const pinnedThreadIdsRef = React.useRef<Set<string>>(new Set());
  const activeLoginIdRef = React.useRef<string | null>(null);
  const cancelledLoginIdsRef = React.useRef<Set<string>>(new Set());
  const cwdRef = React.useRef("");
  const copyResetTimerRef = React.useRef<number | null>(null);
  const sendingRef = React.useRef(false);
  const shouldStickToBottomRef = React.useRef(true);
  const lastTranscriptSignatureRef = React.useRef("");
  const executionSettingsRef = React.useRef<CodexExecutionSettings>({
    model: DEFAULT_MODELS[0].id,
    reasoning: DEFAULT_MODELS[0].defaultReasoningEffort,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    cwd: "",
  });
  const settingsSyncGenerationRef = React.useRef(0);
  const settingsSyncInFlightRef = React.useRef<Promise<void> | null>(null);
  const pendingSettingsSyncRef = React.useRef<{ threadId: string; settings: CodexExecutionSettings } | null>(null);
  const accountInsightsRequestTokenRef = React.useRef(0);
  const accountInsightsInFlightRef = React.useRef<Promise<void> | null>(null);
  const accountInsightsPendingThreadIdRef = React.useRef<string | null | undefined>(undefined);
  const accountInsightsRefreshTimerRef = React.useRef<number | null>(null);
  const mcpInsightsThreadIdRef = React.useRef<string | null>(null);
  const sendOperationTokenRef = React.useRef(0);
  const retryOperationTokenRef = React.useRef(0);
  const threadStartInFlightRef = React.useRef<{
    promise: Promise<CodexThreadResponse>;
    selection: CodexThreadSelectionSnapshot;
  } | null>(null);
  const connectGenerationRef = React.useRef(0);
  const translationRef = React.useRef(t);
  translationRef.current = t;

  const [connectionState, setConnectionState] = React.useState<CodexConnectionState>("connecting");
  const [connectionError, setConnectionError] = React.useState("");
  const [creatingThread, setCreatingThread] = React.useState(false);
  const [status, setStatus] = React.useState<CodexStatus | null>(null);
  const [threads, setThreads] = React.useState<CodexThread[]>([]);
  const [threadListHasMore, setThreadListHasMore] = React.useState(false);
  const [threadListLoading, setThreadListLoading] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const [pinnedThreadIds, setPinnedThreadIds] = React.useState<Set<string>>(() => {
    try {
      if (typeof localStorage === "undefined") return new Set();
      const stored = JSON.parse(localStorage.getItem(PINNED_THREADS_STORAGE_KEY) || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  });
  const [selectedThreadId, setSelectedThreadId] = React.useState<string | null>(null);
  const [selectedThread, setSelectedThread] = React.useState<CodexThread | null>(null);
  const [historyLoadingThreadId, setHistoryLoadingThreadId] = React.useState<string | null>(null);
  const [historyLoadError, setHistoryLoadError] = React.useState<{ threadId: string; message: string } | null>(null);
  const [models, setModels] = React.useState<CodexModel[]>(DEFAULT_MODELS);
  const [skills, setSkills] = React.useState<CodexSkill[]>([]);
  const [selectedSkillPath, setSelectedSkillPath] = React.useState("");
  const [account, setAccount] = React.useState<CodexAccountResponse | null>(null);
  const [accountBusy, setAccountBusy] = React.useState(false);
  const [accountRateLimits, setAccountRateLimits] = React.useState<CodexAccountRateLimitsResponse | null>(null);
  const [accountUsage, setAccountUsage] = React.useState<CodexAccountUsageResponse | null>(null);
  const [mcpServers, setMcpServers] = React.useState<CodexMcpServerStatus[]>([]);
  const [insightsLoading, setInsightsLoading] = React.useState(false);
  const [insightsError, setInsightsError] = React.useState(false);
  const [threadGoal, setThreadGoal] = React.useState<CodexThreadGoal | null>(null);
  const [loginCode, setLoginCode] = React.useState<{ url: string; code: string; loginId: string } | null>(null);
  const [composer, setComposer] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);
  const [model, setModel] = React.useState(DEFAULT_MODELS[0].id);
  const [reasoning, setReasoning] = React.useState("medium");
  const [approvalPolicy, setApprovalPolicy] = React.useState<CodexApprovalPolicy>("on-request");
  const [sandbox, setSandbox] = React.useState<CodexSandboxMode>("workspace-write");
  const [cwd, setCwd] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [showInspector, setShowInspector] = React.useState(true);
  const [mobileSettingsOpen, setMobileSettingsOpen] = React.useState(false);
  const [openDirectoryPickerAfterSettings, setOpenDirectoryPickerAfterSettings] = React.useState(false);
  const [mobileDetail, setMobileDetail] = React.useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = React.useState(false);
  const mobileSettingsRestoreRef = React.useRef<HTMLElement | null>(null);
  const directoryPickerWasOpenRef = React.useRef(false);
  const restoreSettingsAfterDirectoryPickerRef = React.useRef(false);
  const [approvalQueue, setApprovalQueue] = React.useState<ApprovalPrompt[]>([]);
  const [inputAnswers, setInputAnswers] = React.useState<Record<string, string>>({});
  const [elicitationAnswers, setElicitationAnswers] = React.useState<Record<string, unknown>>({});
  const [expandedItems, setExpandedItems] = React.useState<Set<string>>(new Set());
  const [attachments, setAttachments] = React.useState<CodexAttachment[]>([]);
  const [copiedKey, setCopiedKey] = React.useState("");
  const [threadTokenUsage, setThreadTokenUsage] = React.useState<Record<string, unknown> | null>(null);
  const [transcriptAtBottom, setTranscriptAtBottom] = React.useState(true);
  const [unreadTranscriptCount, setUnreadTranscriptCount] = React.useState(0);

  const selectedModel = models.find((entry) => entry.id === model) || models[0];
  const accountRateLimitRows = rateLimitRows(accountRateLimits);
  const approvalPrompt = approvalQueue[0] || null;
  const threadLoading =
    selectedThreadId !== null &&
    (selectedThread?.id !== selectedThreadId || historyLoadingThreadId === selectedThreadId);
  const transcript = selectedThread?.turns || [];

  pinnedThreadIdsRef.current = pinnedThreadIds;
  searchRef.current = search;
  showArchivedRef.current = showArchived;
  cwdRef.current = cwd;
  activeTurnIdRef.current = activeTurnId;
  sendingRef.current = sending;
  executionSettingsRef.current = { model, reasoning, approvalPolicy, sandbox, cwd };

  const sortThreads = React.useCallback((entries: CodexThread[]) => {
    const pinned = pinnedThreadIdsRef.current;
    return [...entries]
      .map((thread) => ({ ...thread, isPinned: pinned.has(thread.id) }))
      .sort((a, b) => {
        if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
        return (b.recencyAt || b.updatedAt || 0) - (a.recencyAt || a.updatedAt || 0);
      });
  }, []);

  const selectThreadId = React.useCallback((threadId: string | null) => {
    selectedThreadIdRef.current = threadId;
    threadSelectionEpochRef.current += 1;
    setSelectedThreadId(threadId);
  }, []);

  const captureThreadSelection = React.useCallback(
    (): CodexThreadSelectionSnapshot => ({
      threadId: selectedThreadIdRef.current,
      epoch: threadSelectionEpochRef.current,
    }),
    []
  );

  const isThreadSelectionCurrent = React.useCallback(
    (snapshot: CodexThreadSelectionSnapshot): boolean =>
      isCodexThreadSelectionCurrent(snapshot, selectedThreadIdRef.current, threadSelectionEpochRef.current),
    []
  );

  const sendRpc = React.useCallback(async <T,>(method: string, params?: unknown): Promise<T> => {
    const client = clientRef.current;
    if (!client) throw new Error(translationRef.current("codex.error.notConnected"));
    return client.request<T>(method, params);
  }, []);

  const loadSkills = React.useCallback(
    async (forceReload = false) => {
      const response = await sendRpc<CodexSkillsListResponse>("skills/list", {
        cwds: cwdRef.current ? [cwdRef.current] : [],
        forceReload,
      });
      const deduplicated = new Map<string, CodexSkill>();
      for (const group of response.data || []) {
        for (const skill of group.skills || []) deduplicated.set(skill.path, skill);
      }
      setSkills([...deduplicated.values()].sort((a, b) => a.name.localeCompare(b.name)));
    },
    [sendRpc]
  );

  const refreshAccount = React.useCallback(async () => {
    const response = await sendRpc<CodexAccountResponse>("account/read", { refreshToken: false });
    setAccount(response);
  }, [sendRpc]);

  const refreshAccountInsights = React.useCallback(
    (threadId: string | null = selectedThreadIdRef.current): Promise<void> => {
      if (!clientRef.current?.connected) return Promise.resolve();
      accountInsightsPendingThreadIdRef.current = threadId;
      if (accountInsightsInFlightRef.current) return accountInsightsInFlightRef.current;

      const run = async () => {
        setInsightsLoading(true);
        setInsightsError(false);
        try {
          for (;;) {
            const targetThreadId = accountInsightsPendingThreadIdRef.current;
            accountInsightsPendingThreadIdRef.current = undefined;
            if (targetThreadId === undefined || !clientRef.current?.connected) break;

            const requestToken = ++accountInsightsRequestTokenRef.current;
            if (mcpInsightsThreadIdRef.current !== targetThreadId) setMcpServers([]);
            const [limits, usage, mcp] = await Promise.allSettled([
              sendRpc<CodexAccountRateLimitsResponse>("account/rateLimits/read"),
              sendRpc<CodexAccountUsageResponse>("account/usage/read"),
              sendRpc<CodexMcpServerStatusResponse>("mcpServerStatus/list", {
                threadId: targetThreadId,
                detail: "toolsAndAuthOnly",
                limit: 100,
              }),
            ]);
            if (
              requestToken === accountInsightsRequestTokenRef.current &&
              selectedThreadIdRef.current === targetThreadId
            ) {
              if (limits.status === "fulfilled") setAccountRateLimits(limits.value);
              if (usage.status === "fulfilled") setAccountUsage(usage.value);
              if (mcp.status === "fulfilled") {
                mcpInsightsThreadIdRef.current = targetThreadId;
                setMcpServers(mcp.value.data || []);
              }
              setInsightsError(
                limits.status === "rejected" || usage.status === "rejected" || mcp.status === "rejected"
              );
            }
          }
        } finally {
          setInsightsLoading(false);
        }
      };

      const request = run();
      const tracked = request.finally(() => {
        if (accountInsightsInFlightRef.current !== tracked) return;
        accountInsightsInFlightRef.current = null;
        const pendingThreadId = accountInsightsPendingThreadIdRef.current;
        if (pendingThreadId !== undefined && clientRef.current?.connected) {
          void refreshAccountInsights(pendingThreadId).catch(() => {});
        }
      });
      accountInsightsInFlightRef.current = tracked;
      return tracked;
    },
    [sendRpc]
  );

  const scheduleAccountInsightsRefresh = React.useCallback(
    (threadId: string | null = selectedThreadIdRef.current) => {
      if (accountInsightsRefreshTimerRef.current !== null) {
        window.clearTimeout(accountInsightsRefreshTimerRef.current);
      }
      accountInsightsRefreshTimerRef.current = window.setTimeout(() => {
        accountInsightsRefreshTimerRef.current = null;
        void refreshAccountInsights(threadId).catch(() => {});
      }, 180);
    },
    [refreshAccountInsights]
  );

  const refreshThreadGoal = React.useCallback(
    async (threadId: string | null) => {
      if (!threadId || !clientRef.current?.connected) {
        setThreadGoal(null);
        return;
      }
      try {
        const response = await sendRpc<{ goal?: CodexThreadGoal | null }>("thread/goal/get", { threadId });
        if (selectedThreadIdRef.current === threadId) setThreadGoal(response.goal || null);
      } catch {
        if (selectedThreadIdRef.current === threadId) setThreadGoal(null);
      }
    },
    [sendRpc]
  );

  const loginAccount = React.useCallback(async () => {
    if (accountBusy) return;
    setAccountBusy(true);
    setConnectionError("");
    try {
      const result = await sendRpc<CodexLoginResponse>("account/login/start", { type: "chatgptDeviceCode" });
      if (!result.verificationUrl || !result.userCode || !result.loginId) {
        throw new Error(t("codex.login.unavailable"));
      }
      activeLoginIdRef.current = result.loginId;
      setLoginCode({ url: result.verificationUrl, code: result.userCode, loginId: result.loginId });
    } catch (error) {
      activeLoginIdRef.current = null;
      setAccountBusy(false);
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [accountBusy, sendRpc, t]);

  const cancelLogin = React.useCallback(async () => {
    if (!loginCode) return;
    cancelledLoginIdsRef.current.add(loginCode.loginId);
    try {
      await sendRpc("account/login/cancel", { loginId: loginCode.loginId });
    } catch {
      // The local login flow can still be dismissed when the server has already completed it.
    }
    activeLoginIdRef.current = null;
    setLoginCode(null);
    setAccountBusy(false);
  }, [loginCode, sendRpc]);

  const logoutAccount = React.useCallback(async () => {
    setAccountBusy(true);
    try {
      await sendRpc("account/logout");
      activeLoginIdRef.current = null;
      setLoginCode(null);
      setAccount({ account: null, requiresOpenaiAuth: true });
      setAccountRateLimits(null);
      setAccountUsage(null);
      setMcpServers([]);
      setInsightsError(false);
      mcpInsightsThreadIdRef.current = null;
      threadTokenUsageByIdRef.current.clear();
      setThreadTokenUsage(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountBusy(false);
    }
  }, [sendRpc]);

  const copyText = React.useCallback(async (value: string, key: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedKey("");
      copyResetTimerRef.current = null;
    }, 1600);
  }, []);

  const scrollTranscriptToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    shouldStickToBottomRef.current = true;
    setTranscriptAtBottom(true);
    setUnreadTranscriptCount(0);
  }, []);

  const handleTranscriptScroll = React.useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const atBottom = isCodexTranscriptNearBottom(transcript);
    shouldStickToBottomRef.current = atBottom;
    setTranscriptAtBottom(atBottom);
    if (atBottom) setUnreadTranscriptCount(0);
  }, []);

  const applyThreadSettings = React.useCallback((response: CodexThreadResponse) => {
    if (typeof response.model === "string" && response.model) setModel(response.model);
    if (typeof response.reasoningEffort === "string" && response.reasoningEffort) {
      setReasoning(response.reasoningEffort);
    }
    if (response.approvalPolicy) setApprovalPolicy(response.approvalPolicy);
    if (typeof response.cwd === "string") setCwd(response.cwd);
    if (response.sandbox?.type === "dangerFullAccess") setSandbox("danger-full-access");
    if (response.sandbox?.type === "readOnly") setSandbox("read-only");
    if (response.sandbox?.type === "workspaceWrite") setSandbox("workspace-write");
  }, []);

  const syncSelectedThreadSettings = React.useCallback(
    (settings: CodexExecutionSettings) => {
      const threadId = selectedThreadIdRef.current;
      const client = clientRef.current;
      if (!threadId || !client?.connected || !resumedThreadIdsRef.current.has(threadId)) {
        return;
      }
      if (sendingRef.current) {
        pendingSettingsSyncRef.current = { threadId, settings };
        return;
      }

      const generation = ++settingsSyncGenerationRef.current;
      const run = async () => {
        if (
          generation !== settingsSyncGenerationRef.current ||
          selectedThreadIdRef.current !== threadId ||
          !clientRef.current?.connected ||
          sendingRef.current
        ) {
          return;
        }
        try {
          const response = await sendRpc<CodexThreadResponse>(
            "thread/resume",
            threadResumeOverrides(threadId, settings)
          );
          if (generation !== settingsSyncGenerationRef.current || selectedThreadIdRef.current !== threadId) {
            return;
          }
          applyThreadSettings(response);
          // `thread/resume` does not accept an effort override; keep the
          // locally selected effort until the next turn carries it.
          setReasoning(settings.reasoning);
          if (response.thread) {
            setSelectedThread((current) =>
              current?.id === threadId ? { ...current, ...response.thread, turns: current.turns || [] } : current
            );
            setThreads((current) => upsertCodexThread(current, { ...response.thread, turns: [] }));
          }
        } catch (error) {
          if (generation === settingsSyncGenerationRef.current) {
            setConnectionError(error instanceof Error ? error.message : String(error));
          }
        }
      };
      const previous = settingsSyncInFlightRef.current || Promise.resolve();
      const next = previous.catch(() => {}).then(run);
      const tracked = next.finally(() => {
        if (settingsSyncInFlightRef.current === tracked) settingsSyncInFlightRef.current = null;
      });
      settingsSyncInFlightRef.current = tracked;
    },
    [applyThreadSettings, sendRpc]
  );

  const updateThreadSettings = React.useCallback(
    (patch: Partial<CodexExecutionSettings>) => {
      const current = executionSettingsRef.current;
      const next = { ...current, ...patch };
      if (patch.model !== undefined && patch.reasoning === undefined) {
        const selected = models.find((entry) => entry.id === patch.model);
        if (selected) next.reasoning = selected.defaultReasoningEffort;
      }
      executionSettingsRef.current = next;
      setModel(next.model);
      setReasoning(next.reasoning);
      setApprovalPolicy(next.approvalPolicy);
      setSandbox(next.sandbox);
      setCwd(next.cwd);
      syncSelectedThreadSettings(next);
    },
    [models, syncSelectedThreadSettings]
  );

  React.useEffect(() => {
    if (sending || !pendingSettingsSyncRef.current) return;
    const pending = pendingSettingsSyncRef.current;
    pendingSettingsSyncRef.current = null;
    if (pending.threadId === selectedThreadIdRef.current) syncSelectedThreadSettings(pending.settings);
  }, [sending, syncSelectedThreadSettings, selectedThreadId]);

  const removeApprovalRequest = React.useCallback((requestId: number | string) => {
    setApprovalQueue((current) => current.filter((prompt) => String(prompt.request.id) !== String(requestId)));
  }, []);

  const loadThreadList = React.useCallback(
    async (options: { reset?: boolean } = {}) => {
      const reset = options.reset !== false;
      const token = ++threadListRequestTokenRef.current;
      setThreadListLoading(true);
      const cursor = reset ? null : threadListCursorRef.current;
      try {
        const response = await sendRpc<CodexThreadListResponse>("thread/list", {
          limit: 100,
          cursor,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: showArchivedRef.current,
          searchTerm: searchRef.current.trim() || null,
        });
        if (token !== threadListRequestTokenRef.current) return;
        const listed = response.data || [];
        const listedIds = new Set(listed.map((thread) => thread.id));
        listed.forEach((thread) => startedThreadIdsRef.current.delete(thread.id));
        threadListCursorRef.current = response.nextCursor || null;
        setThreadListHasMore(Boolean(response.nextCursor));
        setThreads((current) => {
          const pending = current.filter(
            (thread) => startedThreadIdsRef.current.has(thread.id) && !listedIds.has(thread.id)
          );
          const merged = reset
            ? [...listed, ...pending]
            : [...current.filter((thread) => !listedIds.has(thread.id)), ...listed, ...pending];
          return sortThreads(merged);
        });
        if (reset && !selectedThreadIdRef.current && listed[0]?.id) selectThreadId(listed[0].id);
      } finally {
        if (token === threadListRequestTokenRef.current) setThreadListLoading(false);
      }
    },
    [selectThreadId, sendRpc, sortThreads]
  );

  const loadThreadHistory = React.useCallback(
    async (
      threadId: string,
      token: number | null,
      initialPage?: CodexThreadTurnsListResponse | null,
      initialCursor?: string | null,
      isCancelled?: () => boolean
    ): Promise<CodexTurn[] | null> => {
      return paginateCodexThreadHistory(
        ({ cursor, limit, sortDirection, itemsView }) =>
          sendRpc<CodexThreadTurnsListResponse>("thread/turns/list", {
            threadId,
            cursor,
            limit,
            sortDirection,
            itemsView,
          }),
        {
          initialPage,
          initialCursor,
          pageSize: THREAD_TURN_PAGE_SIZE,
          isCancelled: () => (token !== null && token !== loadThreadTokenRef.current) || Boolean(isCancelled?.()),
          shouldDowngradeItemsView: (error) =>
            error instanceof CodexRpcRequestError &&
            (error.code === -32601 || error.code === CODEX_RESPONSE_TOO_LARGE_RPC_CODE),
        }
      );
    },
    [sendRpc]
  );

  const loadThread = React.useCallback(
    async (threadId: string) => {
      const token = ++loadThreadTokenRef.current;
      try {
        failedHistoryThreadIdsRef.current.delete(threadId);
        setHistoryLoadError((current) => (current?.threadId === threadId ? null : current));
        setHistoryLoadingThreadId(threadId);
        activeTurnIdRef.current = null;
        setActiveTurnId(null);
        setSending(false);
        const response = await sendRpc<{ thread: CodexThread }>("thread/read", { threadId, includeTurns: false });
        if (token !== loadThreadTokenRef.current) return;
        let thread = { ...response.thread, turns: [] };
        startedThreadIdsRef.current.delete(threadId);
        setSelectedThread((current) => ({
          ...thread,
          turns: current?.id === threadId ? current.turns || [] : [],
        }));
        setCwd(thread.cwd || "");
        setThreads((current) => upsertCodexThread(current, thread));

        let initialTurnsPage: CodexThreadTurnsListResponse | null = null;
        let turnsBackwardsCursor: string | null = null;
        try {
          const resumed = await sendRpc<CodexThreadResponse>("thread/resume", {
            threadId,
            excludeTurns: true,
            initialTurnsPage: {
              limit: THREAD_TURN_PAGE_SIZE,
              sortDirection: "desc",
              itemsView: "full",
            },
          });
          if (token !== loadThreadTokenRef.current) return;
          resumedThreadIdsRef.current.add(threadId);
          applyThreadSettings(resumed);
          initialTurnsPage = resumed.initialTurnsPage || null;
          turnsBackwardsCursor = resumed.turnsBackwardsCursor || null;
          thread = { ...thread, ...resumed.thread, turns: [] };
          setSelectedThread((current) =>
            current?.id === threadId ? { ...current, ...thread, turns: current.turns || [] } : current
          );
          setThreads((current) => upsertCodexThread(current, thread));
        } catch {
          resumedThreadIdsRef.current.delete(threadId);
        }

        const historyTurns = await loadThreadHistory(threadId, token, initialTurnsPage, turnsBackwardsCursor);
        if (!historyTurns || token !== loadThreadTokenRef.current) return;
        hydratedThreadIdsRef.current.add(threadId);
        failedHistoryThreadIdsRef.current.delete(threadId);
        setHistoryLoadError((current) => (current?.threadId === threadId ? null : current));
        setSelectedThread((current) =>
          current?.id === threadId
            ? { ...current, turns: mergeCodexHistoryTurns(current.turns || [], historyTurns) }
            : current
        );
        const latestTurn = [...historyTurns].reverse().find((turn) => turn.status === "inProgress");
        setActiveTurnId(latestTurn?.id || null);
        setSending(Boolean(latestTurn));
        requestAnimationFrame(() => {
          if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
        });
      } catch (error) {
        if (token === loadThreadTokenRef.current) {
          const message = error instanceof Error ? error.message : String(error);
          failedHistoryThreadIdsRef.current.add(threadId);
          setHistoryLoadError({ threadId, message });
        }
        throw error;
      } finally {
        setHistoryLoadingThreadId((current) => (current === threadId ? null : current));
      }
    },
    [applyThreadSettings, loadThreadHistory, sendRpc]
  );

  const connect = React.useCallback(async () => {
    const generation = ++connectGenerationRef.current;
    ++sendOperationTokenRef.current;
    ++retryOperationTokenRef.current;
    ++loadThreadTokenRef.current;
    threadStartInFlightRef.current = null;
    sendingRef.current = false;
    clientRef.current?.close();
    clientRef.current = null;
    settingsSyncGenerationRef.current += 1;
    settingsSyncInFlightRef.current = null;
    resumedThreadIdsRef.current.clear();
    hydratedThreadIdsRef.current.clear();
    failedHistoryThreadIdsRef.current.clear();
    setHistoryLoadError(null);
    threadListCursorRef.current = null;
    setThreadListHasMore(false);
    setApprovalQueue([]);
    setCreatingThread(false);
    setActiveTurnId(null);
    activeTurnIdRef.current = null;
    setSending(false);
    ++accountInsightsRequestTokenRef.current;
    accountInsightsPendingThreadIdRef.current = undefined;
    if (accountInsightsRefreshTimerRef.current !== null) {
      window.clearTimeout(accountInsightsRefreshTimerRef.current);
      accountInsightsRefreshTimerRef.current = null;
    }
    setInsightsLoading(false);
    setInsightsError(false);
    setAccount(null);
    setAccountRateLimits(null);
    setAccountUsage(null);
    setMcpServers([]);
    mcpInsightsThreadIdRef.current = null;
    setThreadGoal(null);
    setConnectionState("connecting");
    setConnectionError("");
    let client: CodexAppServerClient | null = null;
    try {
      const nextStatus = await codexApi.status();
      if (generation !== connectGenerationRef.current) return;
      setStatus(nextStatus);
      if (!nextStatus.available)
        throw new Error(nextStatus.error || translationRef.current("codex.error.cliUnavailable"));
      const activeClient = new CodexAppServerClient();
      client = activeClient;
      clientRef.current = activeClient;
      const isCurrentClient = () => generation === connectGenerationRef.current && clientRef.current === activeClient;
      activeClient.onConnectionChange((state, detail) => {
        if (!isCurrentClient()) return;
        if (state === "open") setConnectionState("connected");
        if (state === "closed") {
          setConnectionState("disconnected");
          setConnectionError(detail || translationRef.current("codex.error.connectionClosed"));
        }
        if (state === "error") setConnectionState("error");
      });
      activeClient.onMessage((message) => {
        if (!isCurrentClient()) return;
        const params = message.params || {};
        const method = message.method || "";
        const requestKind = method ? approvalKind(method) : null;
        if (message.id !== undefined && requestKind && message.params) {
          const prompt = { request: message as CodexPendingRequest, kind: requestKind };
          setApprovalQueue((current) =>
            current.some((entry) => String(entry.request.id) === String(prompt.request.id))
              ? current
              : [...current, prompt]
          );
          return;
        }
        if (message.id !== undefined && method === "currentTime/read") {
          activeClient.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
          return;
        }
        if (message.id !== undefined && method === "item/tool/call") {
          activeClient.respond(message.id, { contentItems: [], success: false });
          setConnectionError(translationRef.current("codex.error.dynamicToolUnavailable"));
          return;
        }
        if (message.id !== undefined && method === "account/chatgptAuthTokens/refresh") {
          activeClient.reject(message.id, -32000, translationRef.current("codex.error.authRefreshUnavailable"));
          return;
        }
        if (message.id !== undefined && method) {
          activeClient.reject(message.id, -32601, `Unsupported Codex server request: ${method}`);
          return;
        }
        switch (method) {
          case "thread/started": {
            const thread = params.thread as CodexThread | undefined;
            if (thread) {
              startedThreadIdsRef.current.add(thread.id);
              setThreads((current) => upsertCodexThread(current, thread));
            }
            break;
          }
          case "thread/status/changed": {
            const threadId = String(params.threadId || "");
            const nextStatus = params.status as CodexThread["status"];
            setThreads((current) =>
              current.map((thread) => (thread.id === threadId ? { ...thread, status: nextStatus } : thread))
            );
            setSelectedThread((current) => (current?.id === threadId ? { ...current, status: nextStatus } : current));
            break;
          }
          case "thread/name/updated": {
            const threadId = String(params.threadId || "");
            const name = typeof params.name === "string" ? params.name : null;
            setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, name } : thread)));
            setSelectedThread((current) => (current?.id === threadId ? { ...current, name } : current));
            break;
          }
          case "thread/archived":
          case "thread/unarchived": {
            const threadId = String(params.threadId || "");
            const archived = method === "thread/archived";
            setThreads((current) => {
              if (archived !== showArchivedRef.current) return current.filter((thread) => thread.id !== threadId);
              return current.map((thread) => (thread.id === threadId ? { ...thread, archived } : thread));
            });
            setSelectedThread((current) => (current?.id === threadId ? { ...current, archived } : current));
            break;
          }
          case "turn/started": {
            const threadId = String(params.threadId || "");
            const turn = params.turn as CodexTurn | undefined;
            if (!turn) break;
            if (selectedThreadIdRef.current === threadId) {
              activeTurnIdRef.current = turn.id;
              setActiveTurnId(turn.id);
              setSending(true);
            }
            setSelectedThread((current) =>
              current?.id === threadId ? { ...current, turns: upsertCodexTurn(current.turns || [], turn) } : current
            );
            break;
          }
          case "turn/completed": {
            const threadId = String(params.threadId || "");
            const turn = params.turn as CodexTurn | undefined;
            if (!turn) break;
            if (selectedThreadIdRef.current === threadId) {
              if (activeTurnIdRef.current === turn.id) activeTurnIdRef.current = null;
              setSending(false);
              setActiveTurnId((current) => (current === turn.id ? null : current));
            }
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: upsertCodexTurn(current.turns || [], turn),
                    updatedAt: Math.floor(Date.now() / 1000),
                  }
                : current
            );
            setThreads((current) =>
              current.map((thread) =>
                thread.id === threadId
                  ? { ...thread, updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000) }
                  : thread
              )
            );
            setApprovalQueue((current) =>
              current.filter(
                (prompt) =>
                  String(prompt.request.params.threadId || "") !== threadId ||
                  String(prompt.request.params.turnId || "") !== turn.id
              )
            );
            break;
          }
          case "item/started":
          case "item/completed": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            const item = params.item as CodexThreadItem | undefined;
            if (item)
              setSelectedThread((current) =>
                current?.id === threadId
                  ? { ...current, turns: upsertCodexItem(current.turns || [], turnId, item) }
                  : current
              );
            break;
          }
          case "item/agentMessage/delta":
          case "item/plan/delta": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            const itemId = String(params.itemId || "");
            const delta = String(params.delta || "");
            const fallback = method === "item/plan/delta" ? "plan" : "agentMessage";
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: appendCodexItemText(current.turns || [], turnId, itemId, "text", delta, fallback),
                  }
                : current
            );
            break;
          }
          case "item/commandExecution/outputDelta": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            const itemId = String(params.itemId || "");
            const delta = String(params.delta || "");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: appendCodexItemText(
                      current.turns || [],
                      turnId,
                      itemId,
                      "aggregatedOutput",
                      delta,
                      "commandExecution"
                    ),
                  }
                : current
            );
            break;
          }
          case "item/reasoning/summaryTextDelta":
          case "item/reasoning/textDelta": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            const itemId = String(params.itemId || "");
            const delta = String(params.delta || "");
            const index = Number(params.summaryIndex ?? params.contentIndex ?? 0);
            const field = method.endsWith("summaryTextDelta") ? "summary" : "content";
            setSelectedThread((current) =>
              current?.id === threadId
                ? { ...current, turns: appendCodexReasoning(current.turns || [], turnId, itemId, index, delta, field) }
                : current
            );
            break;
          }
          case "item/fileChange/patchUpdated": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            const itemId = String(params.itemId || "");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: upsertCodexItem(current.turns || [], turnId, {
                      id: itemId,
                      type: "fileChange",
                      changes: (params.changes || []) as CodexThreadItem["changes"],
                    }),
                  }
                : current
            );
            break;
          }
          case "item/fileChange/outputDelta": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            const itemId = String(params.itemId || "");
            const delta = String(params.delta || "");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: appendCodexItemText(
                      current.turns || [],
                      turnId,
                      itemId,
                      "aggregatedOutput",
                      delta,
                      "fileChange"
                    ),
                  }
                : current
            );
            break;
          }
          case "turn/diff/updated": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: upsertCodexItem(current.turns || [], turnId, {
                      id: `${turnId}:diff`,
                      type: "turnDiff",
                      text: String(params.diff || ""),
                    }),
                  }
                : current
            );
            break;
          }
          case "turn/plan/updated": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: upsertCodexItem(current.turns || [], turnId, {
                      id: `${turnId}:live-plan`,
                      type: "plan",
                      explanation: typeof params.explanation === "string" ? params.explanation : null,
                      planSteps: Array.isArray(params.plan)
                        ? (params.plan as Array<{ step: string; status: string }>)
                        : [],
                    }),
                  }
                : current
            );
            break;
          }
          case "thread/tokenUsage/updated": {
            const threadId = String(params.threadId || "");
            const tokenUsage = (params.tokenUsage || null) as Record<string, unknown> | null;
            if (tokenUsage) threadTokenUsageByIdRef.current.set(threadId, tokenUsage);
            else threadTokenUsageByIdRef.current.delete(threadId);
            if (selectedThreadIdRef.current === threadId) {
              setThreadTokenUsage(tokenUsage);
            }
            break;
          }
          case "thread/compacted": {
            const threadId = String(params.threadId || "");
            const turnId = String(params.turnId || "");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    turns: upsertCodexItem(current.turns || [], turnId, {
                      id: `${turnId}:context-compaction`,
                      type: "contextCompaction",
                    }),
                  }
                : current
            );
            break;
          }
          case "thread/reverted": {
            const threadId = String(params.threadId || "");
            if (selectedThreadIdRef.current === threadId) {
              hydratedThreadIdsRef.current.delete(threadId);
              void loadThread(threadId).catch(() => {});
            }
            break;
          }
          case "thread/goal/updated": {
            const threadId = String(params.threadId || "");
            if (selectedThreadIdRef.current === threadId)
              setThreadGoal((params.goal || null) as CodexThreadGoal | null);
            break;
          }
          case "thread/goal/cleared": {
            const threadId = String(params.threadId || "");
            if (selectedThreadIdRef.current === threadId) setThreadGoal(null);
            break;
          }
          case "account/rateLimits/updated": {
            const next = params.rateLimits as CodexAccountRateLimitsResponse["rateLimits"] | undefined;
            if (next) {
              setAccountRateLimits((current) => {
                const rateLimits = mergeRateLimitSnapshot(current?.rateLimits, next);
                const limitId = next.limitId || current?.rateLimits.limitId || null;
                const rateLimitsByLimitId = limitId
                  ? {
                      ...(current?.rateLimitsByLimitId || {}),
                      [limitId]: mergeRateLimitSnapshot(current?.rateLimitsByLimitId?.[limitId], next),
                    }
                  : current?.rateLimitsByLimitId;
                return {
                  ...(current || { rateLimits }),
                  rateLimits,
                  rateLimitsByLimitId,
                };
              });
            }
            break;
          }
          case "mcpServer/startupStatus/updated":
            scheduleAccountInsightsRefresh(selectedThreadIdRef.current);
            break;
          case "mcpServer/oauthLogin/completed":
            scheduleAccountInsightsRefresh(selectedThreadIdRef.current);
            if (params.error) setConnectionError(String(params.error));
            break;
          case "warning": {
            const messageText = String(params.message || "");
            const threadId = typeof params.threadId === "string" ? params.threadId : "";
            const currentTurnId = activeTurnIdRef.current;
            if (threadId && selectedThreadIdRef.current === threadId && currentTurnId) {
              setSelectedThread((current) =>
                current?.id === threadId
                  ? {
                      ...current,
                      turns: upsertCodexItem(current.turns || [], currentTurnId, {
                        id: `${currentTurnId}:warning:${messageText}`,
                        type: "warning",
                        text: messageText,
                      }),
                    }
                  : current
              );
            } else if (messageText) {
              setConnectionError(messageText);
            }
            break;
          }
          case "thread/settings/updated": {
            const threadId = String(params.threadId || "");
            if (selectedThreadIdRef.current !== threadId) break;
            const settings = (params.threadSettings || {}) as Record<string, unknown>;
            if (typeof settings.model === "string") setModel(settings.model);
            if (typeof settings.effort === "string") setReasoning(settings.effort);
            if (typeof settings.approvalPolicy === "string") {
              setApprovalPolicy(settings.approvalPolicy as CodexApprovalPolicy);
            }
            if (typeof settings.cwd === "string") setCwd(settings.cwd);
            const sandboxPolicy = settings.sandboxPolicy as { type?: string } | undefined;
            if (sandboxPolicy?.type === "dangerFullAccess") setSandbox("danger-full-access");
            if (sandboxPolicy?.type === "readOnly") setSandbox("read-only");
            if (sandboxPolicy?.type === "workspaceWrite") setSandbox("workspace-write");
            setSelectedThread((current) =>
              current?.id === threadId
                ? {
                    ...current,
                    cwd: typeof settings.cwd === "string" ? settings.cwd : current.cwd,
                  }
                : current
            );
            break;
          }
          case "thread/deleted":
          case "thread/closed": {
            const threadId = String(params.threadId || "");
            threadTokenUsageByIdRef.current.delete(threadId);
            setThreads((current) => current.filter((thread) => thread.id !== threadId));
            if (selectedThreadIdRef.current === threadId) {
              selectThreadId(null);
              setSelectedThread(null);
              activeTurnIdRef.current = null;
              setActiveTurnId(null);
              setSending(false);
            }
            break;
          }
          case "error": {
            const reported = params.error as { message?: unknown } | undefined;
            setConnectionError(
              String(reported?.message || params.message || translationRef.current("codex.error.reported"))
            );
            setSending(false);
            break;
          }
          case "serverRequest/resolved": {
            const requestId = params.requestId;
            if (typeof requestId === "number" || typeof requestId === "string") removeApprovalRequest(requestId);
            break;
          }
          case "account/updated":
            void refreshAccount().catch(() => {});
            scheduleAccountInsightsRefresh(selectedThreadIdRef.current);
            break;
          case "account/login/completed":
            {
              const completedLoginId = typeof params.loginId === "string" ? params.loginId : null;
              if (completedLoginId && cancelledLoginIdsRef.current.delete(completedLoginId)) {
                if (activeLoginIdRef.current === completedLoginId) activeLoginIdRef.current = null;
                setLoginCode(null);
                setAccountBusy(false);
                break;
              }
              if (activeLoginIdRef.current && completedLoginId && activeLoginIdRef.current !== completedLoginId) {
                break;
              }
              activeLoginIdRef.current = null;
              setLoginCode(null);
              setAccountBusy(false);
              if (params.success) void refreshAccount().catch(() => {});
              else if (params.error) setConnectionError(String(params.error));
            }
            break;
          case "skills/changed":
            void loadSkills(true).catch(() => {});
            break;
          default:
            break;
        }
      });
      await activeClient.connect();
      if (!isCurrentClient()) {
        activeClient.close();
        return;
      }
      setConnectionState("connected");
      await Promise.all([
        sendRpc<{ data: CodexModel[] }>("model/list", { limit: 100 })
          .then((response) => {
            const nextModels = response.data?.length ? response.data : DEFAULT_MODELS;
            const defaultModel = nextModels.find((entry) => entry.isDefault) || nextModels[0];
            setModels(nextModels);
            if (defaultModel) {
              setModel(defaultModel.id);
              setReasoning(defaultModel.defaultReasoningEffort);
            }
          })
          .catch(() => {}),
        refreshAccount().catch(() => {}),
        loadSkills(false).catch(() => {}),
        refreshAccountInsights(selectedThreadIdRef.current).catch(() => {}),
      ]);
    } catch (error) {
      if (generation !== connectGenerationRef.current) {
        client?.close();
        return;
      }
      if (client && clientRef.current !== client) {
        client.close();
        return;
      }
      clientRef.current?.close();
      clientRef.current = null;
      setConnectionState("error");
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [
    loadSkills,
    refreshAccount,
    refreshAccountInsights,
    removeApprovalRequest,
    scheduleAccountInsightsRefresh,
    sendRpc,
  ]);

  React.useEffect(() => {
    void connect();
    return () => {
      ++connectGenerationRef.current;
      clientRef.current?.close();
      clientRef.current = null;
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      if (accountInsightsRefreshTimerRef.current !== null) {
        window.clearTimeout(accountInsightsRefreshTimerRef.current);
        accountInsightsRefreshTimerRef.current = null;
      }
    };
  }, [connect]);

  React.useEffect(() => {
    if (connectionState !== "connected") return;
    const timer = window.setTimeout(() => {
      void loadSkills(false).catch(() => {});
    }, 180);
    return () => window.clearTimeout(timer);
  }, [connectionState, cwd, loadSkills]);

  React.useEffect(() => {
    if (selectedSkillPath && !skills.some((skill) => skill.path === selectedSkillPath && skill.enabled)) {
      setSelectedSkillPath("");
    }
  }, [selectedSkillPath, skills]);

  React.useEffect(() => {
    try {
      localStorage.setItem(PINNED_THREADS_STORAGE_KEY, JSON.stringify([...pinnedThreadIds]));
    } catch {
      // Local preferences are best effort.
    }
    setThreads((current) => sortThreads(current));
    setSelectedThread((current) => (current ? { ...current, isPinned: pinnedThreadIds.has(current.id) } : current));
  }, [pinnedThreadIds, sortThreads]);

  React.useEffect(() => {
    if (connectionState !== "connected") return;
    const timer = window.setTimeout(
      () => {
        void loadThreadList({ reset: true }).catch((error) =>
          setConnectionError(error instanceof Error ? error.message : String(error))
        );
      },
      search.trim() || showArchived ? 180 : 0
    );
    return () => window.clearTimeout(timer);
  }, [connectionState, loadThreadList, search, showArchived]);

  React.useEffect(() => {
    if (!selectedThreadId || connectionState !== "connected") return;
    if (historyLoadingThreadId === selectedThreadId || hydratedThreadIdsRef.current.has(selectedThreadId)) return;
    if (failedHistoryThreadIdsRef.current.has(selectedThreadId)) return;
    if (selectedThread?.id === selectedThreadId && resumedThreadIdsRef.current.has(selectedThreadId)) return;
    void loadThread(selectedThreadId).catch((error) =>
      setConnectionError(error instanceof Error ? error.message : String(error))
    );
  }, [connectionState, historyLoadingThreadId, loadThread, selectedThread, selectedThreadId]);

  React.useEffect(() => {
    if (connectionState !== "connected") return;
    void refreshAccountInsights(selectedThreadId).catch(() => {});
    void refreshThreadGoal(selectedThreadId);
  }, [connectionState, refreshAccountInsights, refreshThreadGoal, selectedThreadId]);

  React.useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  React.useEffect(() => {
    if (!creatingThread && !selectedThreadId && threads.length > 0) selectThreadId(threads[0].id);
  }, [creatingThread, selectThreadId, selectedThreadId, threads]);

  React.useEffect(() => {
    if (!selectedThreadId) return;
    setExpandedItems(new Set());
    setMobileDetail(true);
  }, [selectedThreadId]);

  React.useEffect(() => {
    const signature = codexTranscriptSignature(transcript);
    const changed = signature !== lastTranscriptSignatureRef.current;
    lastTranscriptSignatureRef.current = signature;
    if (!changed && !activeTurnId) return;
    if (shouldStickToBottomRef.current) {
      requestAnimationFrame(() => scrollTranscriptToBottom());
      return;
    }
    if (changed && transcript.length > 0) setUnreadTranscriptCount((count) => count + 1);
  }, [activeTurnId, scrollTranscriptToBottom, transcript]);

  React.useEffect(() => {
    lastTranscriptSignatureRef.current = "";
    shouldStickToBottomRef.current = true;
    setTranscriptAtBottom(true);
    setUnreadTranscriptCount(0);
    setThreadTokenUsage(selectedThreadId ? threadTokenUsageByIdRef.current.get(selectedThreadId) || null : null);
    void refreshThreadGoal(selectedThreadId);
  }, [refreshThreadGoal, selectedThreadId]);

  const filteredThreads = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) =>
      `${threadTitle(thread, t("codex.thread.new"))} ${thread.preview} ${thread.cwd}`.toLowerCase().includes(needle)
    );
  }, [search, t, threads]);

  const startThread = React.useCallback((): Promise<CodexThreadResponse> => {
    const pending = threadStartInFlightRef.current;
    if (pending) return pending.promise;

    const selection = captureThreadSelection();
    setCreatingThread(true);
    const request = sendRpc<CodexThreadResponse>("thread/start", {
      model,
      cwd: cwd || undefined,
      approvalPolicy,
      sandbox,
      historyMode: "paginated",
      threadSource: "appServer",
    }).then((response) => {
      resumedThreadIdsRef.current.add(response.thread.id);
      startedThreadIdsRef.current.add(response.thread.id);
      hydratedThreadIdsRef.current.add(response.thread.id);
      setThreads((current) => upsertCodexThread(current, response.thread));
      return response;
    });
    const tracked = request.finally(() => {
      if (threadStartInFlightRef.current?.promise === tracked) {
        threadStartInFlightRef.current = null;
        setCreatingThread(false);
      }
    });
    threadStartInFlightRef.current = { promise: tracked, selection };
    return tracked;
  }, [approvalPolicy, captureThreadSelection, cwd, model, sandbox, sendRpc]);

  const createThread = React.useCallback(async () => {
    let selection: CodexThreadSelectionSnapshot | null = null;
    try {
      setConnectionError("");
      loadThreadTokenRef.current += 1;
      selectThreadId(null);
      selection = captureThreadSelection();
      setSelectedThread(null);
      activeTurnIdRef.current = null;
      setActiveTurnId(null);
      setSending(false);
      setComposer("");
      const response = await startThread();
      const thread = response.thread;
      if (selection && isThreadSelectionCurrent(selection)) {
        applyThreadSettings(response);
        selectThreadId(thread.id);
        setSelectedThread(thread);
        setMobileDetail(true);
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    } catch (error) {
      if (!selection || isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [applyThreadSettings, captureThreadSelection, isThreadSelectionCurrent, selectThreadId, startThread]);

  const sendMessage = React.useCallback(async () => {
    const text = composer.trim();
    if (!text || connectionState !== "connected") return;
    let selection = captureThreadSelection();
    const pendingStart = threadStartInFlightRef.current;
    const pendingThread =
      !selectedThreadId && pendingStart && isThreadSelectionCurrent(pendingStart.selection)
        ? pendingStart.promise
        : null;
    if (!pendingThread && selectedThreadId && selectedThread?.id !== selectedThreadId) return;
    const selectedSkill = skills.find((skill) => skill.path === selectedSkillPath && skill.enabled);
    const input = [
      { type: "text", text, text_elements: [] },
      ...(selectedSkill ? [{ type: "skill", name: selectedSkill.name, path: selectedSkill.path }] : []),
      ...attachments.map((attachment) => ({ type: "image", url: attachment.url })),
    ];
    const currentlySending = sendingRef.current || sending;
    const currentActiveTurnId = activeTurnIdRef.current || activeTurnId;
    if (!pendingThread && currentlySending && selectedThreadId && currentActiveTurnId) {
      try {
        setConnectionError("");
        setComposer("");
        await sendRpc("turn/steer", {
          threadId: selectedThreadId,
          expectedTurnId: currentActiveTurnId,
          input,
        });
        if (isThreadSelectionCurrent(selection)) {
          setAttachments([]);
          setSelectedSkillPath("");
        }
      } catch (error) {
        if (isThreadSelectionCurrent(selection)) {
          setComposer(text);
          setConnectionError(error instanceof Error ? error.message : String(error));
        }
      }
      return;
    }
    if (!pendingThread && currentlySending) return;
    const operationToken = ++sendOperationTokenRef.current;
    const ownsOperation = () => sendOperationTokenRef.current === operationToken;
    const releaseOperation = () => {
      if (!ownsOperation()) return;
      sendingRef.current = false;
      setSending(false);
    };
    sendingRef.current = true;
    setSending(true);
    setConnectionError("");
    setComposer("");
    let thread = selectedThread;
    try {
      if (pendingThread) {
        const response = await pendingThread;
        thread = response.thread;
        if (!ownsOperation() || !isThreadSelectionCurrent(selection)) {
          releaseOperation();
          return;
        }
        if (!selectedThreadIdRef.current) {
          applyThreadSettings(response);
          selectThreadId(thread.id);
          setSelectedThread(thread);
          setMobileDetail(true);
          selection = captureThreadSelection();
        }
      } else if (!thread) {
        const response = await startThread();
        thread = response.thread;
        if (!ownsOperation() || !isThreadSelectionCurrent(selection)) {
          releaseOperation();
          return;
        }
        applyThreadSettings(response);
        selectThreadId(thread.id);
        setSelectedThread(thread);
        setMobileDetail(true);
        selection = captureThreadSelection();
      }
      if (!thread || !ownsOperation() || !isThreadSelectionCurrent(selection)) {
        releaseOperation();
        return;
      }
      if (!resumedThreadIdsRef.current.has(thread.id)) {
        const resumed = await sendRpc<CodexThreadResponse>(
          "thread/resume",
          threadResumeOverrides(thread.id, { model, reasoning, approvalPolicy, sandbox, cwd })
        );
        resumedThreadIdsRef.current.add(thread.id);
        thread = {
          ...thread,
          ...resumed.thread,
          turns: thread.turns?.length ? thread.turns : resumed.thread.turns || [],
        };
        if (isThreadSelectionCurrent(selection) && selectedThreadIdRef.current === thread.id) {
          applyThreadSettings(resumed);
          setSelectedThread(thread);
        }
      }
      if (!ownsOperation() || !isThreadSelectionCurrent(selection) || selectedThreadIdRef.current !== thread.id) {
        releaseOperation();
        return;
      }
      const targetThreadId = thread.id;
      const response = await sendRpc<{ turn: CodexTurn }>("turn/start", {
        threadId: targetThreadId,
        input,
        model,
        cwd: cwd || undefined,
        approvalPolicy,
        sandboxPolicy: sandboxPolicyFor(sandbox, cwd),
        effort: reasoning,
      });
      if (isThreadSelectionCurrent(selection) && selectedThreadIdRef.current === targetThreadId) {
        activeTurnIdRef.current = response.turn.id;
        setActiveTurnId(response.turn.id);
        setSelectedThread((current) =>
          current?.id === targetThreadId
            ? { ...current, turns: upsertCodexTurn(current.turns || [], response.turn) }
            : current
        );
      }
      setThreads((current) =>
        current.map((entry) =>
          entry.id === targetThreadId
            ? {
                ...entry,
                preview: entry.preview || text,
                updatedAt: Math.floor(Date.now() / 1000),
                recencyAt: Math.floor(Date.now() / 1000),
              }
            : entry
        )
      );
      if (isThreadSelectionCurrent(selection)) {
        setAttachments([]);
        setSelectedSkillPath("");
      } else {
        releaseOperation();
      }
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setComposer(text);
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
      releaseOperation();
    }
  }, [
    approvalPolicy,
    activeTurnId,
    applyThreadSettings,
    attachments,
    captureThreadSelection,
    composer,
    connectionState,
    cwd,
    model,
    reasoning,
    sandbox,
    selectedThreadId,
    selectedThread,
    selectedSkillPath,
    selectThreadId,
    sending,
    sendRpc,
    skills,
    startThread,
    isThreadSelectionCurrent,
  ]);

  const interrupt = React.useCallback(async () => {
    if (!selectedThreadId || !activeTurnId) return;
    const selection = captureThreadSelection();
    try {
      await sendRpc("turn/interrupt", { threadId: selectedThreadId, turnId: activeTurnId });
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [activeTurnId, captureThreadSelection, isThreadSelectionCurrent, selectedThreadId, sendRpc]);

  const forkThread = React.useCallback(async () => {
    if (!selectedThread || sending) return;
    const selection = captureThreadSelection();
    try {
      setConnectionError("");
      const response = await sendRpc<CodexThreadResponse>("thread/fork", {
        threadId: selectedThread.id,
        excludeTurns: true,
        model,
        cwd: cwd || undefined,
        approvalPolicy,
        sandbox,
        threadSource: "appServer",
      });
      resumedThreadIdsRef.current.add(response.thread.id);
      startedThreadIdsRef.current.add(response.thread.id);
      hydratedThreadIdsRef.current.delete(response.thread.id);
      setThreads((current) => upsertCodexThread(current, response.thread));
      if (isThreadSelectionCurrent(selection)) {
        applyThreadSettings(response);
        setSelectedThread(null);
        selectThreadId(response.thread.id);
        setMobileDetail(true);
      }
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [
    approvalPolicy,
    applyThreadSettings,
    captureThreadSelection,
    cwd,
    isThreadSelectionCurrent,
    model,
    sandbox,
    selectedThread,
    selectThreadId,
    sendRpc,
    sending,
  ]);

  const compactThread = React.useCallback(async () => {
    if (!selectedThread || sendingRef.current || sending) return;
    const selection = captureThreadSelection();
    const threadId = selectedThread.id;
    try {
      await sendRpc("thread/compact/start", { threadId });
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [captureThreadSelection, isThreadSelectionCurrent, selectedThread, sendRpc, sending]);

  const manageThreadGoal = React.useCallback(async () => {
    if (!selectedThread || sending) return;
    const sourceThreadId = selectedThread.id;
    const selection = captureThreadSelection();
    const objective = await dialog.prompt(t("codex.goal.title"), {
      defaultValue: threadGoal?.objective || "",
      placeholder: t("codex.goal.placeholder"),
    });
    if (objective === null) return;
    if (!isThreadSelectionCurrent(selection)) return;
    try {
      if (!objective.trim()) {
        await sendRpc("thread/goal/clear", { threadId: sourceThreadId });
        if (isThreadSelectionCurrent(selection)) setThreadGoal(null);
        return;
      }
      const response = await sendRpc<{ goal: CodexThreadGoal }>("thread/goal/set", {
        threadId: sourceThreadId,
        objective: objective.trim(),
        status: threadGoal?.status || "active",
        tokenBudget: threadGoal?.tokenBudget ?? null,
      });
      if (isThreadSelectionCurrent(selection)) setThreadGoal(response.goal || null);
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [captureThreadSelection, dialog, isThreadSelectionCurrent, selectedThread, sendRpc, sending, t, threadGoal]);

  const startMcpLogin = React.useCallback(
    async (serverName: string) => {
      if (!serverName) return;
      const popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
      try {
        const response = await sendRpc<{ authorizationUrl: string }>("mcpServer/oauth/login", {
          name: serverName,
          threadId: selectedThreadId || null,
        });
        if (!response.authorizationUrl) {
          popup?.close();
          return;
        }
        if (popup && !popup.closed) popup.location.replace(response.authorizationUrl);
        else window.location.assign(response.authorizationUrl);
      } catch (error) {
        popup?.close();
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    },
    [selectedThreadId, sendRpc]
  );

  const startReview = React.useCallback(async () => {
    if (!selectedThread || sending) return;
    const sourceThread = selectedThread;
    const selection = captureThreadSelection();
    const instructions = await dialog.prompt(t("codex.review.title"), {
      placeholder: t("codex.review.placeholder"),
    });
    if (instructions === null) return;
    if (!isThreadSelectionCurrent(selection)) return;
    try {
      const target = instructions.trim()
        ? { type: "custom", instructions: instructions.trim() }
        : { type: "uncommittedChanges" };
      const response = await sendRpc<{ reviewThreadId: string; turn: CodexTurn }>("review/start", {
        threadId: sourceThread.id,
        target,
        delivery: "inline",
      });
      if (response.reviewThreadId === sourceThread.id && isThreadSelectionCurrent(selection)) {
        activeTurnIdRef.current = response.turn.id;
        setSelectedThread((current) =>
          current?.id === sourceThread.id
            ? { ...current, turns: upsertCodexTurn(current.turns || [], response.turn) }
            : current
        );
        setActiveTurnId(response.turn.id);
        setSending(true);
      }
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [captureThreadSelection, dialog, isThreadSelectionCurrent, selectedThread, sendRpc, sending, t]);

  const retryTurn = React.useCallback(
    async (turn: CodexTurn, userItem: CodexThreadItem, replacementText?: string) => {
      if (!selectedThread || sendingRef.current || sending || !selectedThreadId) return;
      const input = codexUserInputForRetry(userItem, replacementText);
      if (input.length === 0 || (replacementText !== undefined && !replacementText.trim())) return;
      const existingTurns = selectedThread.turns || [];
      const branchPoint = codexRetryBranchPoint(existingTurns, turn.id);
      if (!branchPoint) return;
      const sourceThread = selectedThread;
      const sourceThreadId = selectedThread.id;
      const sourceSelection = captureThreadSelection();
      const operationToken = ++retryOperationTokenRef.current;
      const ownsRetry = () => retryOperationTokenRef.current === operationToken;
      let branchThreadId: string | null = null;
      let branchSelection: CodexThreadSelectionSnapshot | null = null;
      let turnStartRequested = false;
      let retryCancelled = false;
      try {
        if (!ownsRetry() || !isThreadSelectionCurrent(sourceSelection)) return;
        setConnectionError("");
        sendingRef.current = true;
        setSending(true);
        const forkOverrides = {
          threadId: selectedThread.id,
          model,
          cwd: cwd || undefined,
          approvalPolicy,
          sandbox,
          threadSource: "appServer",
          deferGoalContinuation: true,
        };
        let branch: CodexThreadResponse;
        try {
          branch = await sendRpc<CodexThreadResponse>("thread/fork", {
            ...forkOverrides,
            beforeTurnId: turn.id,
            excludeTurns: true,
          });
        } catch (error) {
          if (!ownsRetry() || !isThreadSelectionCurrent(sourceSelection)) {
            retryCancelled = true;
            throw new CodexRetryCancelledError();
          }
          if (!isCodexBeforeTurnForkUnsupported(error)) throw error;
          if (branchPoint.previousTurnId) {
            branch = await sendRpc<CodexThreadResponse>("thread/fork", {
              ...forkOverrides,
              lastTurnId: branchPoint.previousTurnId,
            });
          } else {
            branch = await sendRpc<CodexThreadResponse>("thread/start", {
              model,
              cwd: cwd || undefined,
              approvalPolicy,
              sandbox,
              historyMode: "paginated",
              threadSource: "appServer",
            });
          }
        }
        // Record the server-created branch before checking the UI selection;
        // a late response must still be eligible for cleanup.
        branchThreadId = branch.thread.id;
        if (!ownsRetry() || !isThreadSelectionCurrent(sourceSelection)) {
          retryCancelled = true;
          throw new CodexRetryCancelledError();
        }
        const branchHistory = branch.thread.turns.length > 0 ? branch.thread.turns : branchPoint.retainedTurns;
        const branchThread: CodexThread = {
          ...branch.thread,
          turns: branchHistory || [],
        };
        resumedThreadIdsRef.current.add(branchThread.id);
        startedThreadIdsRef.current.add(branchThread.id);
        hydratedThreadIdsRef.current.add(branchThread.id);
        setThreads((current) => upsertCodexThread(current, branchThread));
        if (!ownsRetry() || !isThreadSelectionCurrent(sourceSelection)) {
          retryCancelled = true;
          throw new CodexRetryCancelledError();
        }
        applyThreadSettings(branch);
        setSelectedThread(branchThread);
        selectThreadId(branchThread.id);
        setMobileDetail(true);
        branchSelection = captureThreadSelection();
        if (!ownsRetry() || !isThreadSelectionCurrent(branchSelection)) {
          retryCancelled = true;
          throw new CodexRetryCancelledError();
        }
        turnStartRequested = true;
        const response = await sendRpc<{ turn: CodexTurn }>("turn/start", {
          threadId: branchThread.id,
          input,
          model,
          cwd: cwd || undefined,
          approvalPolicy,
          sandboxPolicy: sandboxPolicyFor(sandbox, cwd),
          effort: reasoning,
        });
        // A successful response proves that the turn was accepted. If the
        // user moved away while it was in flight, leave the branch intact and
        // let normal thread events/history reconcile it later.
        if (!ownsRetry() || !branchSelection || !isThreadSelectionCurrent(branchSelection)) {
          retryCancelled = true;
          if (ownsRetry()) {
            sendingRef.current = false;
            setSending(false);
          }
          return;
        }
        activeTurnIdRef.current = response.turn.id;
        setActiveTurnId(response.turn.id);
        setSelectedThread((current) =>
          current?.id === branchThread.id
            ? { ...current, turns: upsertCodexTurn(current.turns || [], response.turn) }
            : current
        );
      } catch (error) {
        const outcomeUnknown = turnStartRequested && !(error instanceof CodexRpcRequestError);
        let cleanupError: unknown = null;
        let cleanupSucceeded = branchThreadId === null || outcomeUnknown;
        if (branchThreadId && !outcomeUnknown) {
          try {
            const knownTurnId =
              ownsRetry() && branchSelection && isThreadSelectionCurrent(branchSelection)
                ? activeTurnIdRef.current
                : null;
            await cleanupCodexRetryBranch(sendRpc, branchThreadId, knownTurnId);
            cleanupSucceeded = true;
          } catch (branchCleanupError) {
            cleanupError = branchCleanupError;
          }
          if (cleanupSucceeded) {
            resumedThreadIdsRef.current.delete(branchThreadId);
            startedThreadIdsRef.current.delete(branchThreadId);
            hydratedThreadIdsRef.current.delete(branchThreadId);
            setThreads((current) => current.filter((entry) => entry.id !== branchThreadId));
          }
        }
        if (
          branchThreadId &&
          cleanupSucceeded &&
          !outcomeUnknown &&
          ownsRetry() &&
          branchSelection &&
          isThreadSelectionCurrent(branchSelection)
        ) {
          selectThreadId(sourceThreadId);
          setSelectedThread(sourceThread);
          activeTurnIdRef.current = null;
          setActiveTurnId(null);
        }
        if (
          ownsRetry() &&
          (cleanupSucceeded || outcomeUnknown || retryCancelled || isThreadSelectionCurrent(sourceSelection))
        ) {
          sendingRef.current = false;
          setSending(false);
        }
        const retryErrorMessage = error instanceof Error ? error.message : String(error);
        const showError =
          ownsRetry() &&
          (isThreadSelectionCurrent(sourceSelection) ||
            Boolean(branchSelection && isThreadSelectionCurrent(branchSelection)));
        if (showError && error instanceof CodexRetryCancelledError) {
          return;
        }
        if (showError && cleanupError) {
          const cleanupErrorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          setConnectionError(`${retryErrorMessage}. ${t("codex.error.retryCleanupFailed")}: ${cleanupErrorMessage}`);
        } else if (showError && outcomeUnknown) {
          setConnectionError(`${t("codex.error.retryOutcomeUnknown")}: ${retryErrorMessage}`);
        } else if (showError && !retryCancelled) {
          setConnectionError(retryErrorMessage);
        }
      }
    },
    [
      approvalPolicy,
      applyThreadSettings,
      captureThreadSelection,
      cwd,
      isThreadSelectionCurrent,
      model,
      reasoning,
      sandbox,
      selectedThread,
      selectedThreadId,
      selectThreadId,
      sendRpc,
      sending,
      t,
    ]
  );

  const editTurn = React.useCallback(
    async (turn: CodexTurn, userItem: CodexThreadItem) => {
      const currentText = inputText(userItem);
      const replacement = await dialog.prompt(t("codex.action.edit"), {
        defaultValue: currentText,
        placeholder: t("codex.composer.placeholder"),
      });
      if (replacement === null || !replacement.trim() || replacement.trim() === currentText.trim()) return;
      await retryTurn(turn, userItem, replacement);
    },
    [dialog, retryTurn, t]
  );

  const runShellCommand = React.useCallback(async () => {
    if (!selectedThread || sendingRef.current || sending) return;
    const sourceThreadId = selectedThread.id;
    const selection = captureThreadSelection();
    const command = await dialog.prompt(t("codex.shell.title"), {
      placeholder: t("codex.shell.placeholder"),
    });
    if (!command?.trim()) return;
    if (
      !(await dialog.confirm(t("codex.shell.confirmTitle"), command.trim(), {
        confirmVariant: "danger",
      }))
    ) {
      return;
    }
    if (!isThreadSelectionCurrent(selection)) return;
    try {
      await sendRpc("thread/shellCommand", { threadId: sourceThreadId, command: command.trim() });
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [captureThreadSelection, dialog, isThreadSelectionCurrent, selectedThread, sendRpc, sending, t]);

  const deleteThread = React.useCallback(async () => {
    if (!selectedThread) return;
    const sourceThreadId = selectedThread.id;
    const selection = captureThreadSelection();
    if (
      !(await dialog.confirm(t("codex.thread.deleteTitle"), threadTitle(selectedThread, t("codex.thread.new")), {
        confirmVariant: "danger",
      }))
    )
      return;
    if (!isThreadSelectionCurrent(selection)) return;
    try {
      await sendRpc("thread/delete", { threadId: sourceThreadId });
      resumedThreadIdsRef.current.delete(sourceThreadId);
      startedThreadIdsRef.current.delete(sourceThreadId);
      const remaining = threads.filter((thread) => thread.id !== sourceThreadId);
      setThreads((current) => current.filter((thread) => thread.id !== sourceThreadId));
      if (!isThreadSelectionCurrent(selection)) return;
      loadThreadTokenRef.current += 1;
      selectThreadId(remaining[0]?.id || null);
      setSelectedThread(null);
      activeTurnIdRef.current = null;
      setActiveTurnId(null);
      setSending(false);
      setMobileDetail(false);
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [captureThreadSelection, dialog, isThreadSelectionCurrent, selectedThread, selectThreadId, sendRpc, t, threads]);

  const renameThread = React.useCallback(async () => {
    if (!selectedThread) return;
    const sourceThreadId = selectedThread.id;
    const selection = captureThreadSelection();
    const name = await dialog.prompt(t("codex.thread.renameTitle"), {
      defaultValue: threadTitle(selectedThread, t("codex.thread.new")),
    });
    if (!name?.trim()) return;
    if (!isThreadSelectionCurrent(selection)) return;
    try {
      await sendRpc("thread/name/set", { threadId: sourceThreadId, name: name.trim() });
      if (isThreadSelectionCurrent(selection)) {
        setSelectedThread((current) => (current?.id === sourceThreadId ? { ...current, name: name.trim() } : current));
      }
      setThreads((current) =>
        current.map((thread) => (thread.id === sourceThreadId ? { ...thread, name: name.trim() } : thread))
      );
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [captureThreadSelection, dialog, isThreadSelectionCurrent, selectedThread, sendRpc, t]);

  const togglePin = React.useCallback(() => {
    if (!selectedThread) return;
    setPinnedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(selectedThread.id)) next.delete(selectedThread.id);
      else next.add(selectedThread.id);
      return next;
    });
  }, [selectedThread]);

  const archiveThread = React.useCallback(async () => {
    if (!selectedThread) return;
    const threadId = selectedThread.id;
    const selection = captureThreadSelection();
    const archived = !showArchived;
    try {
      await sendRpc(archived ? "thread/archive" : "thread/unarchive", { threadId });
      const remaining = threads.filter((thread) => thread.id !== threadId);
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      if (isThreadSelectionCurrent(selection) && selectedThreadIdRef.current === threadId) {
        loadThreadTokenRef.current += 1;
        hydratedThreadIdsRef.current.delete(threadId);
        selectThreadId(remaining[0]?.id || null);
        setSelectedThread(null);
        activeTurnIdRef.current = null;
        setActiveTurnId(null);
        setSending(false);
        setMobileDetail(false);
      }
    } catch (error) {
      if (isThreadSelectionCurrent(selection)) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [
    captureThreadSelection,
    isThreadSelectionCurrent,
    selectedThread,
    selectThreadId,
    sendRpc,
    showArchived,
    threads,
  ]);

  const loadMoreThreads = React.useCallback(() => {
    if (!threadListHasMore || threadListLoading) return;
    void loadThreadList({ reset: false }).catch((error) =>
      setConnectionError(error instanceof Error ? error.message : String(error))
    );
  }, [loadThreadList, threadListHasMore, threadListLoading]);

  const retryThreadHistory = React.useCallback(() => {
    if (!selectedThreadId || historyLoadingThreadId === selectedThreadId) return;
    failedHistoryThreadIdsRef.current.delete(selectedThreadId);
    hydratedThreadIdsRef.current.delete(selectedThreadId);
    setHistoryLoadError((current) => (current?.threadId === selectedThreadId ? null : current));
    setConnectionError("");
    void loadThread(selectedThreadId).catch((error) =>
      setConnectionError(error instanceof Error ? error.message : String(error))
    );
  }, [historyLoadingThreadId, loadThread, selectedThreadId]);

  const respondToApproval = React.useCallback(
    (decision: unknown) => {
      if (!approvalPrompt) return;
      const { request, kind } = approvalPrompt;
      let result: Record<string, unknown>;
      if (kind === "command" || kind === "file") {
        result = { decision };
      } else if (kind === "permissions") {
        result = {
          permissions: decision === "accept" || decision === "acceptForSession" ? request.params.permissions || {} : {},
          scope: decision === "acceptForSession" ? "session" : "turn",
        };
      } else if (kind === "elicitation") {
        const elicitation = request.params as unknown as CodexMcpElicitationRequest;
        if (decision === "accept") {
          const required = elicitation.requestedSchema?.required || [];
          const missing = required.filter((name) => {
            const value = elicitationAnswers[name];
            return value === undefined || value === null || (typeof value === "string" && !value.trim());
          });
          if (missing.length > 0) {
            setConnectionError(t("codex.request.requiredFields"));
            return;
          }
        }
        result = {
          action: decision === "accept" ? "accept" : decision === "decline" ? "decline" : "cancel",
          content: decision === "accept" ? { ...elicitationAnswers } : null,
        };
      } else {
        result = { answers: {} };
      }
      clientRef.current?.respond(request.id, result);
      removeApprovalRequest(request.id);
    },
    [approvalPrompt, elicitationAnswers, removeApprovalRequest, t]
  );

  const answerQuestions = React.useMemo(
    () => (approvalPrompt?.request.params.questions || []) as CodexUserInputQuestion[],
    [approvalPrompt]
  );

  React.useEffect(() => {
    if (approvalPrompt?.kind === "elicitation") {
      const defaults: Record<string, unknown> = {};
      const params = approvalPrompt.request.params as unknown as CodexMcpElicitationRequest;
      for (const [name, schema] of elicitationFields(params)) {
        if (schema.default !== undefined && schema.default !== null) defaults[name] = schema.default;
        else if (Array.isArray(schema.enum) && schema.enum.length > 0) defaults[name] = schema.enum[0];
        else if (schema.type === "boolean") defaults[name] = false;
        else defaults[name] = "";
      }
      setElicitationAnswers(defaults);
    } else {
      setElicitationAnswers({});
    }
    if (approvalPrompt?.kind !== "input") {
      setInputAnswers({});
      return;
    }
    const defaults: Record<string, string> = {};
    for (const question of answerQuestions) {
      const firstOption = question.options?.[0]?.label;
      defaults[question.id] = firstOption || "";
    }
    setInputAnswers(defaults);
  }, [answerQuestions, approvalPrompt, approvalPrompt?.kind, approvalPrompt?.request.id]);

  const submitUserInput = React.useCallback(() => {
    if (!approvalPrompt || approvalPrompt.kind !== "input") return;
    const answers = Object.fromEntries(
      answerQuestions.map((question) => {
        const selected = inputAnswers[question.id] || "";
        const answer =
          question.options?.length && question.isOther && selected === ""
            ? inputAnswers[`${question.id}:other`] || ""
            : selected;
        return [question.id, { answers: [answer] }];
      })
    );
    clientRef.current?.respond(approvalPrompt.request.id, { answers });
    removeApprovalRequest(approvalPrompt.request.id);
  }, [answerQuestions, approvalPrompt, inputAnswers, removeApprovalRequest]);

  const addAttachments = React.useCallback(
    async (files: File[]) => {
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      if (images.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
        setConnectionError(t("codex.attachment.tooLarge"));
        return;
      }
      const currentBytes = attachments.reduce((total, attachment) => total + (attachment.size || 0), 0);
      const nextBytes = images.reduce((total, file) => total + file.size, 0);
      if (currentBytes + nextBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        setConnectionError(t("codex.attachment.totalTooLarge"));
        return;
      }
      try {
        const next = await Promise.all(
          images.map(
            (file) =>
              new Promise<CodexAttachment>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () =>
                  resolve({
                    id: `${Date.now()}-${crypto.randomUUID()}`,
                    name: file.name,
                    url: String(reader.result || ""),
                    type: "image",
                    size: file.size,
                  });
                reader.onerror = () => reject(reader.error || new Error(t("codex.attachment.readFailed")));
                reader.readAsDataURL(file);
              })
          )
        );
        setConnectionError("");
        setAttachments((current) => [...current, ...next]);
      } catch (error) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    },
    [attachments, t]
  );

  const openSettings = React.useCallback(
    (event?: React.MouseEvent<HTMLElement>) => {
      if (isMobile) {
        const trigger = event?.currentTarget;
        if (trigger instanceof HTMLElement) mobileSettingsRestoreRef.current = trigger;
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        setMobileSettingsOpen(true);
        return;
      }
      setShowInspector(true);
    },
    [isMobile]
  );

  const toggleSettings = React.useCallback(
    (event?: React.MouseEvent<HTMLElement>) => {
      if (isMobile) {
        const trigger = event?.currentTarget;
        if (trigger instanceof HTMLElement) mobileSettingsRestoreRef.current = trigger;
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        setMobileSettingsOpen(true);
        return;
      }
      setShowInspector((value) => !value);
    },
    [isMobile]
  );

  React.useEffect(() => {
    if (mobileSettingsOpen || !openDirectoryPickerAfterSettings) return;
    const timer = window.setTimeout(() => {
      setDirectoryPickerOpen(true);
      setOpenDirectoryPickerAfterSettings(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [mobileSettingsOpen, openDirectoryPickerAfterSettings]);

  React.useEffect(() => {
    const wasOpen = directoryPickerWasOpenRef.current;
    directoryPickerWasOpenRef.current = directoryPickerOpen;
    if (directoryPickerOpen || !wasOpen) return;
    if (!restoreSettingsAfterDirectoryPickerRef.current) return;
    restoreSettingsAfterDirectoryPickerRef.current = false;
    const trigger = mobileSettingsRestoreRef.current;
    if (!trigger) return;
    let frame = 0;
    let timeout = 0;
    let observer: MutationObserver | null = null;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      observer?.disconnect();
      mobileSettingsRestoreRef.current = null;
    };
    const restore = () => {
      if (!trigger.isConnected) {
        cleanup();
        return;
      }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (
        active &&
        active !== document.body &&
        active !== trigger &&
        !active.closest('[aria-hidden="true"]') &&
        !active.closest('[role="dialog"], [data-slot="dialog-content"]')
      ) {
        cleanup();
        return;
      }
      if (trigger.closest('[aria-hidden="true"]') || trigger.getClientRects().length === 0) {
        frame = requestAnimationFrame(restore);
        return;
      }
      trigger.focus({ preventScroll: true });
      cleanup();
    };
    observer = new MutationObserver(restore);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["aria-hidden", "style"],
    });
    frame = requestAnimationFrame(restore);
    timeout = window.setTimeout(cleanup, 1000);
    return cleanup;
  }, [directoryPickerOpen]);

  const openDirectoryPickerFromMobileSettings = React.useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    restoreSettingsAfterDirectoryPickerRef.current = true;
    setMobileSettingsOpen(false);
    setOpenDirectoryPickerAfterSettings(true);
  }, []);

  usePageTopBar(
    {
      show: true,
      centerContent: <span className="text-sm font-semibold">Codex</span>,
      rightButtons: [
        {
          icon: <RefreshCw size={15} />,
          title: t("codex.action.reconnect"),
          onClick: () => void connect(),
          disabled: connectionState === "connecting",
        },
      ],
    },
    [connect, connectionState, t]
  );

  React.useEffect(() => {
    setPageMenuItems([
      {
        id: "codex-new",
        icon: <Plus size={15} />,
        label: t("codex.action.newThread"),
        onClick: () => void createThread(),
      },
      {
        id: "codex-settings",
        icon: <Settings2 size={15} />,
        label: t("codex.action.settings"),
        onClick: openSettings,
      },
      {
        id: "codex-fork",
        icon: <GitFork size={15} />,
        label: t("codex.action.forkThread"),
        onClick: () => void forkThread(),
      },
      {
        id: "codex-review",
        icon: <Search size={15} />,
        label: t("codex.action.review"),
        onClick: () => void startReview(),
      },
      {
        id: "codex-compact",
        icon: <Sparkles size={15} />,
        label: t("codex.action.compact"),
        onClick: () => void compactThread(),
      },
      {
        id: "codex-shell",
        icon: <TerminalSquare size={15} />,
        label: t("codex.action.shellCommand"),
        onClick: () => void runShellCommand(),
      },
      {
        id: "codex-goal",
        icon: <Target size={15} />,
        label: t("codex.action.goal"),
        onClick: () => void manageThreadGoal(),
      },
    ]);
    return () => setPageMenuItems([]);
  }, [
    compactThread,
    createThread,
    forkThread,
    manageThreadGoal,
    openSettings,
    runShellCommand,
    selectedThread,
    sending,
    setPageMenuItems,
    startReview,
    t,
  ]);

  const renderMarkdown = (text: string, itemKey: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
          const value = reactNodeText(children).replace(/\n$/, "");
          const block = Boolean(className?.startsWith("language-")) || value.includes("\n");
          if (!block) {
            return (
              <code className="codex-inline-code" {...props}>
                {children}
              </code>
            );
          }
          const copyKey = `${itemKey}:code:${value.slice(0, 80)}`;
          return (
            <span className="codex-code-wrap">
              <button
                type="button"
                className="codex-copy-button"
                onClick={() => void copyText(value, copyKey).catch(() => {})}
                title={t("common.copy")}
                aria-label={t("common.copy")}
              >
                {copiedKey === copyKey ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <code className={className} {...props}>
                {children}
              </code>
            </span>
          );
        },
        pre: ({ children }) => <pre className="codex-code-block">{children}</pre>,
      }}
    >
      {text}
    </ReactMarkdown>
  );

  const renderItem = (item: CodexThreadItem, turn?: CodexTurn) => {
    const expanded = expandedItems.has(item.id);
    const toggle = () =>
      setExpandedItems((current) => {
        const next = new Set(current);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    switch (item.type) {
      case "userMessage": {
        const images = userInputImages(item);
        return (
          <div className="codex-user-message-wrap">
            <div className="codex-user-message">
              {inputText(item) && <div>{inputText(item)}</div>}
              {images.length > 0 && (
                <div className="codex-message-images">
                  {images.map((input, index) => (
                    <CodexInputImage key={`${item.id}:image:${index}`} input={input} />
                  ))}
                </div>
              )}
            </div>
            {turn && (
              <div className="codex-message-actions">
                <button
                  type="button"
                  onClick={() => void copyText(inputText(item), `${item.id}:message`)}
                  title={t("common.copy")}
                  aria-label={t("common.copy")}
                >
                  {copiedKey === `${item.id}:message` ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <button
                  type="button"
                  onClick={() => void retryTurn(turn, item)}
                  disabled={sending}
                  title={t("codex.action.retry")}
                  aria-label={t("codex.action.retry")}
                >
                  <RotateCcw size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => void editTurn(turn, item)}
                  disabled={sending}
                  title={t("codex.action.edit")}
                  aria-label={t("codex.action.edit")}
                >
                  <Pencil size={12} />
                </button>
              </div>
            )}
          </div>
        );
      }
      case "agentMessage":
        return (
          <div className="codex-agent-message-wrap">
            <div className="codex-agent-message">{renderMarkdown(item.text || "", item.id)}</div>
            <div className="codex-message-actions codex-agent-actions">
              <button
                type="button"
                onClick={() => void copyText(item.text || "", `${item.id}:message`)}
                title={t("common.copy")}
                aria-label={t("common.copy")}
              >
                {copiedKey === `${item.id}:message` ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          </div>
        );
      case "reasoning":
        return (
          <div className="codex-tool-card">
            <button type="button" className="codex-tool-summary w-full text-left" onClick={toggle}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong>{t("codex.item.reasoning")}</strong>
              <span className="codex-tool-status" data-status="done">
                {itemStatusLabel(item)}
              </span>
            </button>
            {expanded && (
              <div className="codex-tool-body">
                <div className="codex-command-output">
                  {[...(item.summary || []), ...(item.content || [])].join("\n")}
                </div>
              </div>
            )}
          </div>
        );
      case "commandExecution":
        return (
          <div className="codex-tool-card">
            <button type="button" className="codex-tool-summary w-full text-left" onClick={toggle}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <TerminalSquare size={14} />
              <strong>{item.command || t("codex.item.command")}</strong>
              <span className="codex-tool-status" data-status={item.status}>
                {itemStatusLabel(item)}
              </span>
            </button>
            {expanded && (
              <div className="codex-tool-body">
                <div className="codex-command-output">{item.aggregatedOutput || ""}</div>
                {typeof item.exitCode === "number" && (
                  <div className="mt-2 text-[10px] text-ide-mute">
                    {t("codex.item.exitCode")} {item.exitCode}
                    {item.durationMs ? ` · ${item.durationMs}ms` : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      case "fileChange":
        return (
          <div className="codex-tool-card">
            <button type="button" className="codex-tool-summary w-full text-left" onClick={toggle}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <FileCode2 size={14} />
              <strong>{t("codex.item.fileChanges").replace("{count}", String((item.changes || []).length))}</strong>
              <span className="codex-tool-status" data-status={item.status}>
                {itemStatusLabel(item)}
              </span>
            </button>
            {expanded && (
              <div className="codex-tool-body">
                <div className="codex-file-list">
                  {(item.changes || []).map((change) => (
                    <div key={change.path} className="codex-file-change">
                      <div className="codex-file-row">
                        <FileCode2 size={13} className="text-ide-mute" />
                        <span>{change.path}</span>
                        <span className="ml-auto text-ide-mute">{change.kind}</span>
                      </div>
                      {change.diff && <pre className="codex-diff">{change.diff}</pre>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      case "plan":
        return (
          <div className="codex-tool-card">
            <button type="button" className="codex-tool-summary w-full text-left" onClick={toggle}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Check size={14} />
              <strong>{t("codex.item.plan")}</strong>
            </button>
            {expanded && (
              <div className="codex-tool-body">
                {item.explanation && <div className="mb-2 text-xs text-ide-mute">{item.explanation}</div>}
                {item.planSteps?.length ? (
                  <div className="codex-plan-list">
                    {item.planSteps.map((step, index) => (
                      <div key={`${item.id}:step:${index}`} className="codex-plan-step">
                        <span data-status={step.status}>{step.status}</span>
                        <span>{step.step}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="codex-command-output">{item.text || ""}</div>
                )}
              </div>
            )}
          </div>
        );
      case "mcpToolCall":
      case "dynamicToolCall":
      case "collabAgentToolCall":
        return (
          <div className="codex-tool-card">
            <button type="button" className="codex-tool-summary w-full text-left" onClick={toggle}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Bot size={14} />
              <strong>{item.tool ? String(item.tool) : item.type}</strong>
              <span className="codex-tool-status" data-status={item.status}>
                {itemStatusLabel(item)}
              </span>
            </button>
            {expanded && (
              <div className="codex-tool-body">
                <div className="codex-command-output">
                  {JSON.stringify(item.arguments || item.result || {}, null, 2)}
                </div>
              </div>
            )}
          </div>
        );
      case "webSearch":
        return (
          <div className="codex-tool-card">
            <div className="codex-tool-summary">
              <Search size={14} />
              <strong>{item.query || t("codex.item.webSearch")}</strong>
              <span className="codex-tool-status" data-status="done">
                {item.results?.length || 0}
              </span>
            </div>
            {item.results?.length ? (
              <div className="codex-tool-body">
                <div className="codex-command-output">{JSON.stringify(item.results, null, 2)}</div>
              </div>
            ) : null}
          </div>
        );
      case "imageView":
        return (
          <div className="codex-tool-card">
            <div className="codex-tool-summary">
              <ImagePlus size={14} />
              <strong>{t("codex.item.imageView")}</strong>
            </div>
            <CodexOutputImage item={item} />
          </div>
        );
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction":
      case "warning":
      case "turnDiff":
        return (
          <div className="codex-event-row" data-kind={item.type}>
            <Sparkles size={13} />
            <span>{item.text || item.review || t(`codex.item.${item.type}`)}</span>
          </div>
        );
      default:
        return null;
    }
  };

  const connectionLabel =
    connectionState === "connected"
      ? t("codex.connection.connected")
      : connectionState === "connecting"
        ? t("codex.connection.connecting")
        : t("codex.connection.offline");
  return (
    <div className="codex-page" data-testid="codex-page">
      <aside className="codex-sidebar" aria-label={t("codex.thread.listLabel")}>
        <div className="codex-sidebar-header">
          <div className="codex-sidebar-title flex items-center gap-2">
            <Bot size={16} className="text-ide-accent" />
            Codex
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="codex-sidebar-new size-11 md:size-8"
            onClick={() => void createThread()}
            title={t("codex.action.newThread")}
            aria-label={t("codex.action.newThread")}
          >
            <Plus size={16} />
          </Button>
        </div>
        <div className="flex gap-1 border-b border-ide-border px-2 py-2">
          <input
            id="codex-thread-search"
            name="codex-thread-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("codex.thread.search")}
            aria-label={t("codex.thread.search")}
            className="h-8 min-w-0 flex-1 rounded border border-ide-border bg-ide-bg px-2 text-xs text-ide-text outline-none focus:border-ide-accent"
          />
          <button
            type="button"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded border border-ide-border text-ide-mute hover:border-ide-accent hover:text-ide-text md:size-8"
            data-active={showArchived}
            onClick={() => {
              ++sendOperationTokenRef.current;
              ++retryOperationTokenRef.current;
              sendingRef.current = false;
              setShowArchived((value) => !value);
              setThreads([]);
              selectThreadId(null);
              setSelectedThread(null);
              setActiveTurnId(null);
              activeTurnIdRef.current = null;
              setSending(false);
            }}
            title={showArchived ? t("codex.thread.showActive") : t("codex.thread.showArchived")}
            aria-label={showArchived ? t("codex.thread.showActive") : t("codex.thread.showArchived")}
          >
            <Archive size={14} />
          </button>
        </div>
        <div className="codex-thread-list">
          {connectionState !== "connected" && (
            <div className="mb-2 border border-orange-500/25 bg-orange-500/8 px-2 py-2 text-[10px] text-orange-500">
              {connectionError || connectionLabel}
            </div>
          )}
          {filteredThreads.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-ide-mute">
              {connectionState === "connected" ? t("codex.thread.empty") : t("codex.thread.connectToLoad")}
            </div>
          )}
          {filteredThreads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className="codex-thread-row"
              data-active={selectedThreadId === thread.id}
              onClick={() => {
                if (selectedThreadId !== thread.id) {
                  ++sendOperationTokenRef.current;
                  ++retryOperationTokenRef.current;
                  sendingRef.current = false;
                  loadThreadTokenRef.current += 1;
                  hydratedThreadIdsRef.current.delete(thread.id);
                  failedHistoryThreadIdsRef.current.delete(thread.id);
                  setHistoryLoadError((current) => (current?.threadId === thread.id ? null : current));
                  setSelectedThread(null);
                  activeTurnIdRef.current = null;
                  setActiveTurnId(null);
                  setSending(false);
                }
                selectThreadId(thread.id);
                setMobileDetail(true);
              }}
            >
              <div className="mt-0.5 shrink-0 text-ide-mute">
                {thread.isPinned ? <Pin size={13} /> : <History size={14} />}
              </div>
              <div className="codex-thread-row-main">
                <div className="codex-thread-row-title">{threadTitle(thread, t("codex.thread.new"))}</div>
                <div className="codex-thread-row-meta">
                  <span className="codex-thread-row-path">{thread.cwd || t("codex.cwd.none")}</span>
                  <span className="shrink-0">{relativeTime(thread.recencyAt || thread.updatedAt, locale)}</span>
                </div>
              </div>
              {thread.status?.type === "active" && (
                <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
              )}
            </button>
          ))}
          {threadListHasMore && (
            <button
              type="button"
              className="codex-thread-load-more mt-1 flex w-full items-center justify-center gap-2 border-t border-ide-border px-2 py-3 text-xs text-ide-mute hover:text-ide-text"
              onClick={loadMoreThreads}
              disabled={threadListLoading}
            >
              {threadListLoading && <LoaderCircle size={13} className="animate-spin" />}
              {t("codex.thread.loadMore")}
            </button>
          )}
        </div>
        <div className="codex-sidebar-footer">
          <Button
            variant="outline"
            className="h-8 min-w-0 justify-start gap-1.5 overflow-hidden border-ide-border bg-transparent px-2 text-[10px]"
            onClick={() => setDirectoryPickerOpen(true)}
          >
            <FolderOpen size={13} className="shrink-0" />
            <span className="min-w-0 truncate">
              {cwd ? cwd.split("/").pop() || t("codex.cwd.folder") : t("codex.cwd.short")}
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-8 justify-start gap-1.5 border-ide-border bg-transparent px-2 text-[10px]"
            onClick={openSettings}
          >
            <PanelRight size={13} />
            {t("codex.action.settings")}
          </Button>
        </div>
      </aside>

      <section className="codex-main" data-mobile-hidden={isMobile && !mobileDetail}>
        <header className="codex-main-header">
          <div className="codex-main-heading-row flex min-w-0 flex-1 items-center gap-2">
            {isMobile && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="codex-mobile-back size-11 md:size-8"
                onClick={() => setMobileDetail(false)}
                title={t("common.backToList")}
                aria-label={t("common.backToList")}
              >
                <ArrowLeft size={16} />
              </Button>
            )}
            <div className="codex-main-heading">
              <div className="codex-main-title">
                {selectedThread ? threadTitle(selectedThread, t("codex.thread.new")) : t("codex.thread.new")}
              </div>
              <div className="codex-main-subtitle">
                <span>{connectionLabel}</span>
                {selectedThread?.gitInfo?.branch && (
                  <>
                    <GitBranch size={11} />
                    <span>{selectedThread.gitInfo.branch}</span>
                  </>
                )}
                {selectedThread?.cwd && (
                  <>
                    <FolderOpen size={11} />
                    <span>{selectedThread.cwd}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="codex-main-actions">
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 md:size-8"
              onClick={() => void renameThread()}
              disabled={!selectedThread}
              title={t("codex.action.renameThread")}
              aria-label={t("codex.action.renameThread")}
            >
              <Pencil size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 md:size-8"
              onClick={togglePin}
              disabled={!selectedThread}
              title={selectedThread?.isPinned ? t("codex.action.unpinThread") : t("codex.action.pinThread")}
              aria-label={selectedThread?.isPinned ? t("codex.action.unpinThread") : t("codex.action.pinThread")}
            >
              <Pin size={15} fill={selectedThread?.isPinned ? "currentColor" : "none"} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 md:size-8"
              onClick={() => void archiveThread()}
              disabled={!selectedThread}
              title={showArchived ? t("codex.action.unarchiveThread") : t("codex.action.archiveThread")}
              aria-label={showArchived ? t("codex.action.unarchiveThread") : t("codex.action.archiveThread")}
            >
              <Archive size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 text-red-500 hover:text-red-500 md:size-8"
              onClick={() => void deleteThread()}
              disabled={!selectedThread}
              title={t("codex.action.deleteThread")}
              aria-label={t("codex.action.deleteThread")}
            >
              <Trash2 size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 md:size-8"
              onClick={toggleSettings}
              title={t("codex.action.toggleInspector")}
              aria-label={t("codex.action.toggleInspector")}
            >
              <PanelRight size={15} />
            </Button>
          </div>
        </header>
        {connectionError && (
          <div className="codex-error-strip" role="alert">
            <CircleAlert size={13} />
            <span>{connectionError}</span>
            <button
              type="button"
              onClick={() => setConnectionError("")}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div ref={transcriptRef} className="codex-transcript" onScroll={handleTranscriptScroll}>
          <div className="codex-transcript-inner">
            {!selectedThread && (
              <div className="codex-empty">
                <div>
                  <div className="codex-empty-mark">
                    <Bot size={22} />
                  </div>
                  <div className="codex-empty-title">{t("codex.empty.title")}</div>
                </div>
              </div>
            )}
            {selectedThread && threadLoading && transcript.length === 0 && (
              <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-ide-mute">
                <LoaderCircle size={14} className="animate-spin text-ide-accent" />
                {t("common.loading")}
              </div>
            )}
            {selectedThread && historyLoadError?.threadId === selectedThread.id && transcript.length === 0 && (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 text-center text-xs text-ide-mute">
                <CircleAlert size={18} className="text-red-500" />
                <span title={historyLoadError.message}>{t("codex.thread.historyLoadFailed")}</span>
                <Button
                  variant="outline"
                  className="h-11 border-ide-border bg-transparent px-3 text-xs md:h-8"
                  onClick={retryThreadHistory}
                >
                  <RefreshCw size={13} />
                  {t("codex.thread.retryHistory")}
                </Button>
              </div>
            )}
            {selectedThread && historyLoadError?.threadId === selectedThread.id && transcript.length > 0 && (
              <div className="mb-4 flex min-h-11 items-center gap-2 border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-ide-mute">
                <CircleAlert size={15} className="shrink-0 text-red-500" />
                <span className="min-w-0 flex-1" title={historyLoadError.message}>
                  {t("codex.thread.historyLoadFailed")}
                </span>
                <Button
                  variant="outline"
                  className="h-11 shrink-0 border-ide-border bg-transparent px-3 text-xs md:h-8"
                  onClick={retryThreadHistory}
                >
                  <RefreshCw size={13} />
                  {t("codex.thread.retryHistory")}
                </Button>
              </div>
            )}
            {selectedThread &&
              !threadLoading &&
              historyLoadError?.threadId !== selectedThread.id &&
              transcript.length === 0 && (
                <div className="codex-empty">
                  <div>
                    <div className="codex-empty-mark">
                      <Bot size={22} />
                    </div>
                    <div className="codex-empty-title">{t("codex.empty.threadTitle")}</div>
                  </div>
                </div>
              )}
            {transcript.map((turn, turnIndex) => (
              <div className="codex-turn" key={turn.id}>
                <div className="codex-turn-label">
                  <Clock3 size={12} />
                  {t("codex.turn.label").replace("{index}", String(turnIndex + 1))}
                  <span className="ml-auto normal-case tracking-normal">
                    {turn.status === "inProgress" ? t("codex.turn.working") : turn.status}
                  </span>
                </div>
                {(turn.items || []).map((item) => (
                  <div className="codex-item" key={item.id}>
                    {renderItem(item, turn)}
                  </div>
                ))}
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 py-2 text-xs text-ide-mute">
                <LoaderCircle size={14} className="animate-spin text-ide-accent" />
                {t("codex.turn.working")}
              </div>
            )}
          </div>
          {!transcriptAtBottom && (
            <button
              type="button"
              className="codex-scroll-bottom"
              onClick={() => scrollTranscriptToBottom("smooth")}
              title={t("codex.action.scrollToBottom")}
              aria-label={t("codex.action.scrollToBottom")}
            >
              <ArrowDown size={14} />
              {unreadTranscriptCount > 0 && <span>{unreadTranscriptCount}</span>}
            </button>
          )}
        </div>
        <div className="codex-composer-wrap">
          <form
            className="codex-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1 border-b border-ide-border px-3 py-2">
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="inline-flex min-h-11 max-w-full items-center gap-1 rounded border border-ide-border py-0 pl-2 pr-0 text-[10px] text-ide-mute md:min-h-0 md:py-1 md:pr-2"
                  >
                    <FileCode2 size={11} />
                    {attachment.name}
                    <button
                      type="button"
                      className="flex size-11 shrink-0 items-center justify-center md:size-5"
                      onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              id="codex-attachment-input"
              name="codex-attachment-input"
              ref={attachmentInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                void addAttachments(files);
              }}
            />
            <textarea
              id="codex-composer-input"
              name="codex-composer-input"
              ref={composerRef}
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={t("codex.composer.placeholder")}
              aria-label={t("codex.composer.placeholder")}
              disabled={connectionState !== "connected" || threadLoading}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                if (files.length === 0) return;
                event.preventDefault();
                void addAttachments(files);
              }}
            />
            <div className="codex-composer-toolbar">
              <div className="codex-composer-options">
                <button
                  type="button"
                  className="codex-composer-icon"
                  onClick={() => attachmentInputRef.current?.click()}
                  title={t("codex.attachment.add")}
                  aria-label={t("codex.attachment.add")}
                  disabled={!selectedModel?.inputModalities?.includes("image")}
                >
                  <ImagePlus size={14} />
                </button>
                <select
                  id="codex-composer-model"
                  name="codex-composer-model"
                  className="codex-composer-option"
                  value={model}
                  onChange={(event) => updateThreadSettings({ model: event.target.value })}
                  aria-label={t("codex.settings.model")}
                >
                  {models
                    .filter((entry) => !entry.hidden)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName || entry.model}
                      </option>
                    ))}
                </select>
                <select
                  id="codex-composer-reasoning"
                  name="codex-composer-reasoning"
                  className="codex-composer-option"
                  value={reasoning}
                  onChange={(event) => updateThreadSettings({ reasoning: event.target.value })}
                  aria-label={t("codex.settings.reasoning")}
                >
                  {(selectedModel?.supportedReasoningEfforts?.length
                    ? selectedModel.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)
                    : ["low", "medium", "high"]
                  ).map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="codex-composer-option codex-composer-cwd"
                  onClick={() => setDirectoryPickerOpen(true)}
                  title={cwd || t("codex.cwd.choose")}
                >
                  <FolderOpen size={11} className="mr-1 inline" />
                  {cwd ? cwd.split("/").pop() || cwd : t("codex.cwd.short")}
                </button>
                {skills.filter((skill) => skill.enabled).length > 0 && (
                  <select
                    id="codex-composer-skill"
                    name="codex-composer-skill"
                    className="codex-composer-option"
                    value={selectedSkillPath}
                    onChange={(event) => setSelectedSkillPath(event.target.value)}
                    aria-label={t("codex.settings.skills")}
                  >
                    <option value="">{t("codex.skill.none")}</option>
                    {skills
                      .filter((skill) => skill.enabled)
                      .map((skill) => (
                        <option key={skill.path} value={skill.path}>
                          /{skill.name}
                        </option>
                      ))}
                  </select>
                )}
              </div>
              <div className="codex-composer-actions">
                {sending && (
                  <button
                    type="button"
                    className="codex-send-button codex-stop-button"
                    onClick={() => void interrupt()}
                    title={t("codex.action.stop")}
                    aria-label={t("codex.action.stop")}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                )}
                <button
                  type="submit"
                  className="codex-send-button"
                  disabled={!composer.trim() || connectionState !== "connected" || threadLoading}
                  title={sending ? t("codex.action.steer") : t("codex.action.send")}
                  aria-label={sending ? t("codex.action.steer") : t("codex.action.send")}
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>

      {showInspector && !isMobile && (
        <aside className="codex-inspector" aria-label={t("codex.action.settings")}>
          <div className="codex-inspector-section">
            <div className="codex-inspector-heading">
              <span>{t("codex.settings.session")}</span>
              <ShieldCheck size={13} />
            </div>
            <dl className="codex-kv">
              <dt>{t("codex.settings.status")}</dt>
              <dd className="flex items-center gap-1">
                {connectionState === "connected" ? (
                  <Check size={12} className="text-green-500" />
                ) : (
                  <CircleAlert size={12} className="text-orange-500" />
                )}
                {connectionLabel}
              </dd>
              <dt>{t("codex.settings.version")}</dt>
              <dd>{status?.version || "-"}</dd>
              <dt>{t("codex.settings.account")}</dt>
              <dd>
                {account?.account?.type === "chatgpt"
                  ? account.account.email || "ChatGPT"
                  : account?.account?.type || t("codex.settings.notSignedIn")}
              </dd>
              <dt>{t("codex.settings.skills")}</dt>
              <dd>{skills.length || t("codex.settings.none")}</dd>
              {threadTokenUsage && (
                <>
                  <dt>{t("codex.settings.tokens")}</dt>
                  <dd>
                    {String((threadTokenUsage.total as { totalTokens?: unknown } | undefined)?.totalTokens || "-")}
                  </dd>
                </>
              )}
            </dl>
            {account?.requiresOpenaiAuth && (
              <Button
                variant="outline"
                className="mt-3 h-8 w-full gap-1.5 border-ide-border bg-transparent text-[10px]"
                onClick={() => void loginAccount()}
                disabled={accountBusy}
              >
                <LogIn size={13} />
                {accountBusy ? t("common.loading") : t("codex.settings.signIn")}
              </Button>
            )}
            {account?.account && !account.requiresOpenaiAuth && (
              <Button
                variant="outline"
                className="mt-3 h-8 w-full gap-1.5 border-ide-border bg-transparent text-[10px]"
                onClick={() => void logoutAccount()}
                disabled={accountBusy}
              >
                <LogOut size={13} />
                {t("codex.settings.signOut")}
              </Button>
            )}
          </div>
          <div className="codex-inspector-section">
            <div className="codex-inspector-heading">
              <span>{t("codex.insights.title")}</span>
              <button
                type="button"
                className="codex-inspector-refresh"
                onClick={() => void refreshAccountInsights(selectedThreadId).catch(() => {})}
                disabled={insightsLoading}
                title={t("codex.insights.refresh")}
                aria-label={t("codex.insights.refresh")}
              >
                <RefreshCw size={12} className={insightsLoading ? "animate-spin" : ""} />
              </button>
            </div>
            {insightsError && <div className="codex-insight-note text-red-500">{t("codex.insights.loadFailed")}</div>}
            <div className="codex-insight-grid">
              {accountRateLimitRows.length > 0 ? (
                accountRateLimitRows.map((row) => {
                  const resets = rateLimitResetLabels(row.snapshot, locale);
                  return (
                    <React.Fragment key={row.id}>
                      <div className="codex-insight-row">
                        <Gauge size={13} />
                        <span>{row.label || t("codex.insights.rateLimit")}</span>
                        <strong>{rateLimitPercentLabel(row.snapshot)}</strong>
                      </div>
                      {resets && (
                        <div className="codex-insight-note">
                          {t("codex.insights.resets")} {resets}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })
              ) : (
                <div className="codex-insight-row">
                  <Gauge size={13} />
                  <span>{t("codex.insights.rateLimit")}</span>
                  <strong>-</strong>
                </div>
              )}
              {accountUsage?.summary?.lifetimeTokens != null && (
                <div className="codex-insight-row">
                  <Sparkles size={13} />
                  <span>{t("codex.insights.lifetimeTokens")}</span>
                  <strong>{accountUsage.summary.lifetimeTokens.toLocaleString()}</strong>
                </div>
              )}
            </div>
            <div className="codex-inspector-subheading">
              <Server size={12} />
              <span>{t("codex.insights.mcp")}</span>
              <span className="ml-auto">{mcpServers.length}</span>
            </div>
            {mcpServers.length > 0 ? (
              <div className="codex-mcp-list">
                {mcpServers.map((server) => (
                  <div className="codex-mcp-row" key={server.name}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-ide-text">{server.name}</div>
                      <div className="truncate text-[10px] text-ide-mute">
                        {server.runtimeStatus || server.authStatus || t("codex.insights.unavailable")}
                      </div>
                    </div>
                    {server.authStatus === "notLoggedIn" || server.runtimeStatus === "authenticationRequired" ? (
                      <button
                        type="button"
                        className="codex-mcp-login"
                        onClick={() => void startMcpLogin(server.name)}
                        title={t("codex.insights.connect")}
                        aria-label={`${t("codex.insights.connect")}: ${server.name}`}
                      >
                        <ExternalLink size={12} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="codex-insight-note">{t("codex.insights.noMcp")}</div>
            )}
          </div>
          <div className="codex-inspector-section">
            <div className="codex-inspector-heading">
              <span>{t("codex.goal.title")}</span>
              <Target size={13} />
            </div>
            {threadGoal ? (
              <>
                <div className="codex-goal-objective">{threadGoal.objective}</div>
                <div className="codex-goal-meta">
                  <span data-status={threadGoal.status}>{threadGoal.status}</span>
                  <span>
                    {threadGoal.tokensUsed.toLocaleString()} {t("codex.goal.tokens")}
                  </span>
                </div>
              </>
            ) : (
              <div className="codex-insight-note">{t("codex.goal.none")}</div>
            )}
            <Button
              type="button"
              variant="outline"
              className="mt-2 h-8 w-full gap-1.5 border-ide-border bg-transparent text-[10px]"
              onClick={() => void manageThreadGoal()}
              disabled={!selectedThread || sending}
            >
              <Target size={12} />
              {threadGoal ? t("codex.goal.edit") : t("codex.goal.set")}
            </Button>
          </div>
          <div className="codex-inspector-section">
            <div className="codex-inspector-heading">
              <span>{t("codex.settings.execution")}</span>
              <Settings2 size={13} />
            </div>
            <div className="codex-setting-row">
              <label className="codex-setting-label" htmlFor="codex-model">
                {t("codex.settings.model")}
              </label>
              <select
                id="codex-model"
                className="codex-setting-control"
                value={model}
                onChange={(event) => updateThreadSettings({ model: event.target.value })}
              >
                {models
                  .filter((entry) => !entry.hidden)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName || entry.model}
                    </option>
                  ))}
              </select>
            </div>
            <div className="codex-setting-row">
              <label className="codex-setting-label" htmlFor="codex-reasoning">
                {t("codex.settings.reasoning")}
              </label>
              <select
                id="codex-reasoning"
                className="codex-setting-control"
                value={reasoning}
                onChange={(event) => updateThreadSettings({ reasoning: event.target.value })}
              >
                {(selectedModel?.supportedReasoningEfforts?.length
                  ? selectedModel.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)
                  : ["low", "medium", "high"]
                ).map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
            <div className="codex-setting-row">
              <label className="codex-setting-label" htmlFor="codex-approval">
                {t("codex.settings.approval")}
              </label>
              <select
                id="codex-approval"
                className="codex-setting-control"
                value={approvalPolicy}
                onChange={(event) =>
                  updateThreadSettings({ approvalPolicy: event.target.value as CodexApprovalPolicy })
                }
              >
                <option value="on-request">{t("codex.approval.onRequest")}</option>
                <option value="untrusted">{t("codex.approval.untrusted")}</option>
                <option value="never">{t("codex.approval.never")}</option>
              </select>
            </div>
            <div className="codex-setting-row">
              <label className="codex-setting-label" htmlFor="codex-sandbox">
                {t("codex.settings.sandbox")}
              </label>
              <select
                id="codex-sandbox"
                className="codex-setting-control"
                value={sandbox}
                onChange={(event) => updateThreadSettings({ sandbox: event.target.value as CodexSandboxMode })}
              >
                <option value="workspace-write">{t("codex.sandbox.workspaceWrite")}</option>
                <option value="read-only">{t("codex.sandbox.readOnly")}</option>
                <option value="danger-full-access">{t("codex.sandbox.dangerFullAccess")}</option>
              </select>
            </div>
          </div>
          <div className="codex-inspector-section">
            <div className="codex-inspector-heading">
              <span>{t("codex.settings.cwd")}</span>
              <FolderOpen size={13} />
            </div>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded border border-ide-border bg-ide-bg px-2 py-2 text-left text-[11px] text-ide-text hover:border-ide-accent"
              onClick={() => setDirectoryPickerOpen(true)}
            >
              <FolderOpen size={13} className="shrink-0 text-ide-accent" />
              <span className="min-w-0 truncate">{cwd || t("codex.cwd.choose")}</span>
            </button>
          </div>
          <div className="codex-inspector-section">
            <div className="codex-inspector-heading">
              <span>{t("codex.settings.thread")}</span>
              <History size={13} />
            </div>
            <dl className="codex-kv">
              <dt>ID</dt>
              <dd title={selectedThread?.id}>{selectedThread?.id || "-"}</dd>
              <dt>{t("codex.settings.commit")}</dt>
              <dd>{selectedThread?.gitInfo?.sha ? selectedThread.gitInfo.sha.slice(0, 8) : "-"}</dd>
              <dt>CLI</dt>
              <dd>{selectedThread?.cliVersion || status?.version || "-"}</dd>
            </dl>
          </div>
        </aside>
      )}

      <Drawer
        open={mobileSettingsOpen}
        onOpenChange={(open) => {
          setMobileSettingsOpen(open);
          if (!open && !restoreSettingsAfterDirectoryPickerRef.current) mobileSettingsRestoreRef.current = null;
        }}
      >
        <DrawerContent className="w-full min-w-0 max-h-[min(86dvh,42rem)] overflow-hidden border-ide-border bg-ide-panel pb-[max(0.75rem,env(safe-area-inset-bottom))] text-ide-text">
          <DrawerHeader className="border-b border-ide-border pb-3 text-left">
            <DrawerTitle className="text-base">{t("codex.action.settings")}</DrawerTitle>
            <DrawerDescription className="text-xs text-ide-mute">
              {t("codex.settings.mobileDescription")}
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3">
            <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
              <div className="grid gap-2 border-b border-ide-border pb-4">
                <span className="codex-setting-label">{t("codex.settings.account")}</span>
                <div className="min-w-0 truncate text-sm text-ide-text">
                  {account?.account?.type === "chatgpt"
                    ? account.account.email || "ChatGPT"
                    : account?.account?.type || t("codex.settings.notSignedIn")}
                </div>
                {account?.requiresOpenaiAuth && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 min-h-11 w-full gap-2 border-ide-border bg-transparent text-sm"
                    onClick={() => {
                      setMobileSettingsOpen(false);
                      void loginAccount();
                    }}
                    disabled={accountBusy}
                  >
                    <LogIn size={15} />
                    {accountBusy ? t("common.loading") : t("codex.settings.signIn")}
                  </Button>
                )}
                {account?.account && !account.requiresOpenaiAuth && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 min-h-11 w-full gap-2 border-ide-border bg-transparent text-sm"
                    onClick={() => void logoutAccount()}
                    disabled={accountBusy}
                  >
                    <LogOut size={15} />
                    {t("codex.settings.signOut")}
                  </Button>
                )}
              </div>
              <div className="codex-mobile-insights grid gap-2 border-b border-ide-border pb-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="codex-setting-label">{t("codex.insights.title")}</span>
                  <button
                    type="button"
                    className="flex size-11 items-center justify-center text-ide-mute hover:text-ide-text"
                    onClick={() => void refreshAccountInsights(selectedThreadId).catch(() => {})}
                    disabled={insightsLoading}
                    title={t("codex.insights.refresh")}
                    aria-label={t("codex.insights.refresh")}
                  >
                    <RefreshCw size={14} className={insightsLoading ? "animate-spin" : ""} />
                  </button>
                </div>
                {insightsError && (
                  <div className="text-[10px] leading-4 text-red-500">{t("codex.insights.loadFailed")}</div>
                )}
                {accountRateLimitRows.length > 0 ? (
                  accountRateLimitRows.map((row) => {
                    const resets = rateLimitResetLabels(row.snapshot, locale);
                    return (
                      <div className="grid gap-1" key={row.id}>
                        <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-ide-mute">
                          <span className="min-w-0 truncate">{row.label || t("codex.insights.rateLimit")}</span>
                          <span className="shrink-0 font-mono text-ide-text">
                            {rateLimitPercentLabel(row.snapshot)}
                          </span>
                        </div>
                        {resets && (
                          <div className="text-[10px] leading-4 text-ide-mute">
                            {t("codex.insights.resets")} {resets}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="flex items-center justify-between text-xs text-ide-mute">
                    <span>{t("codex.insights.rateLimit")}</span>
                    <span className="font-mono text-ide-text">-</span>
                  </div>
                )}
                {accountUsage?.summary?.lifetimeTokens != null && (
                  <div className="flex items-center justify-between text-xs text-ide-mute">
                    <span>{t("codex.insights.lifetimeTokens")}</span>
                    <span className="font-mono text-ide-text">
                      {accountUsage.summary.lifetimeTokens.toLocaleString()}
                    </span>
                  </div>
                )}
                {threadTokenUsage && (
                  <div className="flex items-center justify-between text-xs text-ide-mute">
                    <span>{t("codex.settings.tokens")}</span>
                    <span className="font-mono text-ide-text">
                      {String((threadTokenUsage.total as { totalTokens?: unknown } | undefined)?.totalTokens || "-")}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-xs text-ide-mute">
                  <span>{t("codex.insights.mcp")}</span>
                  <span className="font-mono text-ide-text">{mcpServers.length}</span>
                </div>
                {mcpServers.length > 0 && (
                  <div className="codex-mcp-list">
                    {mcpServers.map((server) => (
                      <div className="codex-mcp-row" key={server.name}>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-ide-text">{server.name}</div>
                          <div className="truncate text-[10px] text-ide-mute">
                            {server.runtimeStatus || server.authStatus || t("codex.insights.unavailable")}
                          </div>
                        </div>
                        {server.authStatus === "notLoggedIn" || server.runtimeStatus === "authenticationRequired" ? (
                          <button
                            type="button"
                            className="codex-mcp-login"
                            onClick={() => void startMcpLogin(server.name)}
                            title={t("codex.insights.connect")}
                            aria-label={`${t("codex.insights.connect")}: ${server.name}`}
                          >
                            <ExternalLink size={14} />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid gap-2 border-b border-ide-border pb-4">
                <span className="codex-setting-label">{t("codex.goal.title")}</span>
                <div className="text-sm leading-6 text-ide-text">{threadGoal?.objective || t("codex.goal.none")}</div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-h-11 w-full gap-2 border-ide-border bg-transparent text-sm"
                  onClick={() => {
                    setMobileSettingsOpen(false);
                    void manageThreadGoal();
                  }}
                  disabled={!selectedThread || sending}
                >
                  <Target size={15} />
                  {threadGoal ? t("codex.goal.edit") : t("codex.goal.set")}
                </Button>
              </div>
              <div className="grid gap-2">
                <label className="codex-setting-label" htmlFor="codex-mobile-skill">
                  {t("codex.settings.skills")}
                </label>
                <select
                  id="codex-mobile-skill"
                  name="codex-mobile-skill"
                  className="codex-setting-control h-11 min-h-11 text-sm"
                  value={selectedSkillPath}
                  onChange={(event) => setSelectedSkillPath(event.target.value)}
                  disabled={skills.filter((skill) => skill.enabled).length === 0}
                >
                  <option value="">{t("codex.skill.none")}</option>
                  {skills
                    .filter((skill) => skill.enabled)
                    .map((skill) => (
                      <option key={skill.path} value={skill.path}>
                        /{skill.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label className="codex-setting-label" htmlFor="codex-mobile-model">
                  {t("codex.settings.model")}
                </label>
                <select
                  id="codex-mobile-model"
                  name="codex-mobile-model"
                  className="codex-setting-control h-11 min-h-11 text-sm"
                  value={model}
                  onChange={(event) => updateThreadSettings({ model: event.target.value })}
                >
                  {models
                    .filter((entry) => !entry.hidden)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName || entry.model}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label className="codex-setting-label" htmlFor="codex-mobile-reasoning">
                  {t("codex.settings.reasoning")}
                </label>
                <select
                  id="codex-mobile-reasoning"
                  name="codex-mobile-reasoning"
                  className="codex-setting-control h-11 min-h-11 text-sm"
                  value={reasoning}
                  onChange={(event) => updateThreadSettings({ reasoning: event.target.value })}
                >
                  {(selectedModel?.supportedReasoningEfforts?.length
                    ? selectedModel.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)
                    : ["low", "medium", "high"]
                  ).map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label className="codex-setting-label" htmlFor="codex-mobile-approval">
                  {t("codex.settings.approval")}
                </label>
                <select
                  id="codex-mobile-approval"
                  name="codex-mobile-approval"
                  className="codex-setting-control h-11 min-h-11 text-sm"
                  value={approvalPolicy}
                  onChange={(event) =>
                    updateThreadSettings({ approvalPolicy: event.target.value as CodexApprovalPolicy })
                  }
                >
                  <option value="on-request">{t("codex.approval.onRequest")}</option>
                  <option value="untrusted">{t("codex.approval.untrusted")}</option>
                  <option value="never">{t("codex.approval.never")}</option>
                </select>
              </div>
              <div className="grid gap-2">
                <label className="codex-setting-label" htmlFor="codex-mobile-sandbox">
                  {t("codex.settings.sandbox")}
                </label>
                <select
                  id="codex-mobile-sandbox"
                  name="codex-mobile-sandbox"
                  className="codex-setting-control h-11 min-h-11 text-sm"
                  value={sandbox}
                  onChange={(event) => updateThreadSettings({ sandbox: event.target.value as CodexSandboxMode })}
                >
                  <option value="workspace-write">{t("codex.sandbox.workspaceWrite")}</option>
                  <option value="read-only">{t("codex.sandbox.readOnly")}</option>
                  <option value="danger-full-access">{t("codex.sandbox.dangerFullAccess")}</option>
                </select>
              </div>
              <div className="grid gap-2">
                <span className="codex-setting-label">{t("codex.settings.cwd")}</span>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-h-11 w-full min-w-0 max-w-full justify-start gap-2 overflow-hidden border-ide-border bg-transparent px-3 text-left text-sm"
                  onClick={openDirectoryPickerFromMobileSettings}
                  title={cwd || t("codex.cwd.choose")}
                >
                  <FolderOpen size={15} className="shrink-0 text-ide-accent" />
                  <span className="min-w-0 flex-1 truncate">{cwd || t("codex.cwd.choose")}</span>
                </Button>
              </div>
            </div>
          </div>
        </DrawerContent>
      </Drawer>

      {approvalPrompt && (
        <div className="codex-approval" role="dialog" aria-modal="true" aria-labelledby="codex-approval-title">
          <div className="codex-approval-dialog">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div id="codex-approval-title" className="codex-approval-title">
                  {approvalPrompt.kind === "command"
                    ? t("codex.request.commandTitle")
                    : approvalPrompt.kind === "file"
                      ? t("codex.request.fileTitle")
                      : approvalPrompt.kind === "permissions"
                        ? t("codex.request.permissionsTitle")
                        : approvalPrompt.kind === "elicitation"
                          ? t("codex.request.elicitationTitle")
                          : t("codex.request.inputTitle")}
                </div>
                <div className="codex-approval-copy">
                  {t("codex.request.waiting")}
                  {approvalQueue.length > 1 && ` (${approvalQueue.length})`}
                </div>
              </div>
              <button
                type="button"
                className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text md:size-8"
                onClick={() => respondToApproval("cancel")}
                aria-label={t("common.close")}
              >
                <X size={17} />
              </button>
            </div>
            {approvalPrompt.kind === "command" && (
              <div className="codex-approval-command">
                {approvalCommand(approvalPrompt) || t("codex.request.commandUnavailable")}
              </div>
            )}
            {approvalPrompt.kind === "file" && (
              <div className="codex-approval-command">
                {String(approvalPrompt.request.params.reason || t("codex.request.fileFallback"))}
              </div>
            )}
            {approvalPrompt.kind === "permissions" && (
              <div className="codex-approval-command">
                {String(approvalPrompt.request.params.reason || t("codex.request.permissionsFallback"))}
                {"\n\n"}
                {JSON.stringify(approvalPrompt.request.params.permissions || {}, null, 2)}
              </div>
            )}
            {approvalPrompt.kind === "input" && (
              <div className="codex-question-list">
                {answerQuestions.map((question) => (
                  <div key={question.id} className="codex-question">
                    <label className="codex-question-label" htmlFor={`codex-question-${question.id}`}>
                      <span>{question.header}</span>
                      <strong>{question.question}</strong>
                    </label>
                    {question.options?.length ? (
                      <select
                        id={`codex-question-${question.id}`}
                        className="codex-setting-control"
                        value={inputAnswers[question.id] || ""}
                        onChange={(event) =>
                          setInputAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                        }
                      >
                        {question.options.map((option) => (
                          <option key={option.label} value={option.label}>
                            {option.label}
                            {option.description ? ` - ${option.description}` : ""}
                          </option>
                        ))}
                        {question.isOther && <option value="">{t("codex.request.other")}</option>}
                      </select>
                    ) : (
                      <input
                        id={`codex-question-${question.id}`}
                        type={question.isSecret ? "password" : "text"}
                        className="codex-setting-control"
                        value={inputAnswers[question.id] || ""}
                        onChange={(event) =>
                          setInputAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                        }
                      />
                    )}
                    {question.options?.length && question.isOther && inputAnswers[question.id] === "" ? (
                      <input
                        type={question.isSecret ? "password" : "text"}
                        className="codex-setting-control"
                        value={inputAnswers[`${question.id}:other`] || ""}
                        placeholder={t("codex.request.otherPlaceholder")}
                        onChange={(event) =>
                          setInputAnswers((current) => ({ ...current, [`${question.id}:other`]: event.target.value }))
                        }
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {approvalPrompt.kind === "elicitation" &&
              (() => {
                const params = approvalPrompt.request.params as unknown as CodexMcpElicitationRequest;
                const fields = elicitationFields(params);
                return (
                  <div className="codex-question-list">
                    <div className="codex-approval-copy">{params.message}</div>
                    {params.mode === "url" && params.url && (
                      <a
                        className="break-all text-sm text-ide-accent underline"
                        href={params.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={13} className="mr-1 inline" />
                        {params.url}
                      </a>
                    )}
                    {fields.map(([name, schema]) => {
                      const enumValues = Array.isArray(schema.enum)
                        ? stringValues(schema.enum)
                        : Array.isArray(schema.oneOf)
                          ? schema.oneOf
                              .map((value: unknown) => asRecord(value).const)
                              .filter((value): value is string => typeof value === "string")
                          : stringValues(asRecord(schema.items).enum);
                      const isMulti = schema.type === "array";
                      const fieldValue = elicitationAnswers[name];
                      const label = String(schema.title || name);
                      const description = typeof schema.description === "string" ? schema.description : "";
                      return (
                        <div key={name} className="codex-question">
                          <label className="codex-question-label" htmlFor={`codex-elicitation-${name}`}>
                            <span>{label}</span>
                            {description && <small>{description}</small>}
                          </label>
                          {enumValues.length > 0 ? (
                            <select
                              id={`codex-elicitation-${name}`}
                              className="codex-setting-control"
                              multiple={isMulti}
                              value={
                                isMulti
                                  ? Array.isArray(fieldValue)
                                    ? fieldValue.map(String)
                                    : []
                                  : String(fieldValue ?? "")
                              }
                              onChange={(event) => {
                                const value = isMulti
                                  ? Array.from(event.target.selectedOptions).map((option) => option.value)
                                  : event.target.value;
                                setElicitationAnswers((current) => ({ ...current, [name]: value }));
                              }}
                            >
                              {!isMulti && <option value="">{t("codex.request.choose")}</option>}
                              {enumValues.map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          ) : schema.type === "boolean" ? (
                            <label className="flex min-h-11 items-center gap-2 text-sm text-ide-text">
                              <input
                                id={`codex-elicitation-${name}`}
                                type="checkbox"
                                checked={Boolean(fieldValue)}
                                onChange={(event) =>
                                  setElicitationAnswers((current) => ({ ...current, [name]: event.target.checked }))
                                }
                              />
                              {t("codex.request.confirm")}
                            </label>
                          ) : (
                            <input
                              id={`codex-elicitation-${name}`}
                              type={schema.type === "number" || schema.type === "integer" ? "number" : "text"}
                              className="codex-setting-control"
                              value={String(fieldValue ?? "")}
                              min={typeof schema.minimum === "number" ? schema.minimum : undefined}
                              max={typeof schema.maximum === "number" ? schema.maximum : undefined}
                              onChange={(event) => {
                                const value =
                                  schema.type === "number" || schema.type === "integer"
                                    ? event.target.value === ""
                                      ? ""
                                      : Number(event.target.value)
                                    : event.target.value;
                                setElicitationAnswers((current) => ({ ...current, [name]: value }));
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            <div className="codex-approval-actions">
              <Button
                variant="outline"
                className="h-11 border-ide-border bg-transparent text-xs md:h-9"
                onClick={() => respondToApproval("decline")}
              >
                {t("codex.request.decline")}
              </Button>
              {(approvalPrompt.kind === "command" ||
                approvalPrompt.kind === "file" ||
                approvalPrompt.kind === "permissions") && (
                <Button
                  variant="outline"
                  className="h-11 border-ide-border bg-transparent text-xs md:h-9"
                  onClick={() => respondToApproval("acceptForSession")}
                >
                  {t("codex.request.allowSession")}
                </Button>
              )}
              {approvalPrompt.kind === "input" ? (
                <Button className="h-11 bg-ide-accent text-xs text-ide-on-accent md:h-9" onClick={submitUserInput}>
                  {t("codex.request.submit")}
                </Button>
              ) : (
                <Button
                  className="h-11 bg-ide-accent text-xs text-ide-on-accent md:h-9"
                  onClick={() => respondToApproval("accept")}
                >
                  {t("codex.request.allow")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {loginCode && (
        <div className="codex-approval" role="dialog" aria-modal="true" aria-labelledby="codex-login-title">
          <div className="codex-approval-dialog">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div id="codex-login-title" className="codex-approval-title">
                  {t("codex.login.title")}
                </div>
                <div className="codex-approval-copy">{t("codex.login.instructions")}</div>
              </div>
              <button
                type="button"
                className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text md:size-8"
                onClick={() => void cancelLogin()}
                aria-label={t("common.close")}
              >
                <X size={17} />
              </button>
            </div>
            <a
              className="mt-3 block break-all text-sm text-ide-accent underline"
              href={loginCode.url}
              target="_blank"
              rel="noreferrer"
            >
              {loginCode.url}
            </a>
            <div className="mt-3 border border-ide-border bg-ide-bg p-3 text-center font-mono text-xl tracking-[0.18em]">
              {loginCode.code}
            </div>
            <div className="codex-approval-actions">
              <Button
                variant="outline"
                className="h-11 border-ide-border bg-transparent text-xs md:h-9"
                onClick={() => void cancelLogin()}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}
      <DirectoryPicker
        isOpen={directoryPickerOpen}
        onClose={() => setDirectoryPickerOpen(false)}
        onSelect={(path) => {
          updateThreadSettings({ cwd: path });
          setDirectoryPickerOpen(false);
        }}
        initialPath={cwd || "."}
        locale={locale}
      />
    </div>
  );
};

export default CodexPage;
