import { codexApi } from "@/api/codex";
import type { CodexInitializeResponse, CodexRpcMessage } from "@/types/codex";

type MessageListener = (message: CodexRpcMessage) => void;
type ConnectionListener = (state: "open" | "closed" | "error", detail?: string) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CodexRpcRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "CodexRpcRequestError";
  }
}

export class CodexAppServerClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private connectionGeneration = 0;
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private messageListeners = new Set<MessageListener>();
  private connectionListeners = new Set<ConnectionListener>();

  get connected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<CodexInitializeResponse> {
    this.close();
    const generation = this.connectionGeneration;
    const socket = new WebSocket(codexApi.wsUrl());
    this.socket = socket;

    const isCurrent = () => this.connectionGeneration === generation && this.socket === socket;

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        if (!isCurrent()) {
          reject(new Error("Codex connection superseded"));
          return;
        }
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Unable to connect to Codex app-server"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });

    if (!isCurrent()) throw new Error("Codex connection superseded");

    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);

    const initialized = await this.request<CodexInitializeResponse>("initialize", {
      clientInfo: {
        name: "vibego",
        title: "VibeGo Codex",
        version: "0.3.5",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    if (!isCurrent()) throw new Error("Codex connection superseded");
    this.notify("initialized");
    this.ready = true;
    // Signal readiness only after the app-server handshake is complete. The
    // page starts follow-up requests when it observes this event.
    this.connectionListeners.forEach((listener) => listener("open"));
    return initialized;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.send({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  reject(id: number | string, code: number, message: string, data?: unknown): void {
    this.send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  close(): void {
    this.connectionGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket) {
      socket.removeEventListener("message", this.handleMessage);
      socket.removeEventListener("close", this.handleClose);
      socket.removeEventListener("error", this.handleError);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "VibeGo Codex page closed");
      }
    }
    this.rejectPending(new Error("Codex connection closed"));
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage = (event: MessageEvent) => {
    let message: CodexRpcMessage;
    try {
      message = JSON.parse(String(event.data)) as CodexRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexRpcRequestError(message.error.message, message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.messageListeners.forEach((listener) => listener(message));
  };

  private handleClose = (event: CloseEvent) => {
    this.ready = false;
    if (this.socket?.readyState === WebSocket.CLOSED) {
      this.socket = null;
    }
    const detail = event.reason || `WebSocket closed (${event.code})`;
    this.rejectPending(new Error(detail));
    this.connectionListeners.forEach((listener) => listener("closed", detail));
  };

  private handleError = () => {
    this.ready = false;
    this.connectionListeners.forEach((listener) => listener("error", "Codex WebSocket error"));
  };

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
