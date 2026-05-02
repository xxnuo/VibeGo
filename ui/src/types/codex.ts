export type CodexConnectionState = "connecting" | "connected" | "disconnected" | "error";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexTurnItemsView = "notLoaded" | "summary" | "full";
export type CodexThreadHistoryMode = "legacy" | "paginated";

export interface CodexExecutionSettings {
  model: string;
  reasoning: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  cwd: string;
}

export interface CodexStatus {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface CodexRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: CodexRpcError;
}

export interface CodexInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: string[];
}

export interface CodexGitInfo {
  sha?: string;
  branch?: string;
  originUrl?: string;
}

export interface CodexUserInput {
  type: string;
  text?: string;
  text_elements?: unknown[];
  url?: string;
  path?: string;
  name?: string;
  detail?: string;
}

export interface CodexFileChange {
  path: string;
  kind: string;
  diff: string;
}

export interface CodexThreadItem {
  type: string;
  id: string;
  clientId?: string | null;
  content?: CodexUserInput[] | unknown[] | null;
  text?: string;
  phase?: string | null;
  summary?: string[];
  command?: string;
  cwd?: string;
  processId?: string | null;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: CodexFileChange[];
  explanation?: string | null;
  planSteps?: Array<{ step: string; status: string }>;
  query?: string;
  results?: unknown[] | null;
  review?: string;
  savedPath?: string | null;
  revisedPrompt?: string | null;
  success?: boolean | null;
  server?: string;
  tool?: string | Record<string, unknown>;
  namespace?: string | null;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  receiverThreadIds?: string[];
  senderThreadId?: string;
  prompt?: string | null;
  agentsStates?: Record<string, unknown>;
  path?: string;
  [key: string]: unknown;
}

export interface CodexTurnError {
  message?: string;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  itemsView?: CodexTurnItemsView;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: CodexTurnError | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  preview: string;
  name?: string | null;
  cwd: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: CodexThreadStatus;
  historyMode?: CodexThreadHistoryMode;
  source: unknown;
  path?: string | null;
  cliVersion?: string;
  gitInfo?: CodexGitInfo | null;
  turns: CodexTurn[];
  ephemeral?: boolean;
  /** Local UI preference; app-server does not currently persist pin state. */
  isPinned?: boolean;
  /** Present on some app-server builds when the thread was returned from an archive query. */
  archived?: boolean;
}

export interface CodexThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadTurnsListResponse {
  data: CodexTurn[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadResponse {
  thread: CodexThread;
  model?: string;
  reasoningEffort?: string | null;
  approvalPolicy?: CodexApprovalPolicy;
  cwd?: string;
  sandbox?: {
    type: "dangerFullAccess" | "readOnly" | "workspaceWrite" | "externalSandbox";
    [key: string]: unknown;
  };
  initialTurnsPage?: CodexThreadTurnsListResponse | null;
  turnsBackwardsCursor?: string | null;
  itemsBackwardsCursor?: string | null;
}

export interface CodexModelReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexModelReasoningEffort[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
  defaultServiceTier?: string | null;
}

export interface CodexModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

export type CodexAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export interface CodexAccountResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
}

export interface CodexAccountRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits?: {
    availableCount: number;
    credits?: Array<{
      id: string;
      title?: string | null;
      description?: string | null;
      status?: string;
      expiresAt?: number | null;
    }> | null;
  } | null;
}

export interface CodexAccountUsageResponse {
  summary: {
    lifetimeTokens?: number | null;
    peakDailyTokens?: number | null;
    currentStreakDays?: number | null;
    longestStreakDays?: number | null;
    longestRunningTurnSec?: number | null;
  };
  dailyUsageBuckets?: Array<{ startDate: string; tokens: number }> | null;
  threadUsage?: {
    threadId: string;
    estimatedUsageCreditsMicros: number;
    estimatedUsageUsdMicros?: number | null;
    groups?: Array<Record<string, unknown>>;
  } | null;
}

export interface CodexMcpServerStatus {
  name: string;
  authStatus?: string;
  runtimeStatus?: string | null;
  pluginId?: string | null;
  serverInfo?: {
    name?: string;
    title?: string | null;
    version?: string;
    description?: string | null;
  } | null;
  tools?: Record<string, unknown>;
}

export interface CodexMcpServerStatusResponse {
  data: CodexMcpServerStatus[];
  nextCursor?: string | null;
}

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexMcpElicitationRequest {
  serverName: string;
  threadId: string;
  turnId?: string | null;
  mode: "form" | "openai/form" | "url";
  message: string;
  requestedSchema?: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[] | null;
    [key: string]: unknown;
  };
  url?: string;
  elicitationId?: string;
  [key: string]: unknown;
}

export interface CodexLoginResponse {
  type: string;
  loginId?: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: string;
  enabled: boolean;
  pluginId?: string | null;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    defaultPrompt?: string;
  };
}

export interface CodexSkillsListResponse {
  data: Array<{ cwd: string; skills: CodexSkill[]; errors: Array<{ path: string; message: string }> }>;
}

export interface CodexPendingRequest extends CodexRpcMessage {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[] | null;
}

export interface CodexAttachment {
  id: string;
  name: string;
  url: string;
  type: "image";
  size: number;
}
