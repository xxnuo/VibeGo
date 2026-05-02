export type BlockTermModelStatus = "streaming" | "success" | "error" | "interrupted";

export interface BlockTermModelStreamEvent {
  seq?: number;
  delta?: string;
  text?: string;
  status?: BlockTermModelStatus;
  done?: boolean;
  error?: string;
}

export function shouldRetryBlockTermModelStream(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function canControlBlockTermModelStream(status: string, unavailable: boolean): boolean {
  return status === "streaming" && !unavailable;
}

export function nextBlockTermModelReconnectDelay(delayMs: number): number {
  return Math.min(4000, Math.max(250, delayMs) * 2);
}

export function splitBlockTermModelSSE(input: string): { frames: string[]; pending: string } {
  const frames = input.split(/\r?\n\r?\n/);
  return { frames: frames.slice(0, -1), pending: frames.at(-1) || "" };
}

export function parseBlockTermModelSSEFrame(frame: string): BlockTermModelStreamEvent | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      const value = line.slice(5);
      return value.startsWith(" ") ? value.slice(1) : value;
    });
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (!data.trim()) return null;
  if (data.trim() === "[DONE]") return { done: true, status: "success" };
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as BlockTermModelStreamEvent;
  } catch {
    return { error: "model stream returned invalid event data" };
  }
}
