import { toast } from "sonner";
import { API_BASE, getAuthHeaders, request } from "@/api/request";
import { createStatusBarItem } from "./status-bar-service";
import type { PluginHostTasks, TaskExecution } from "./types";

const active = new Map<string, TaskExecution>();
export const tasks: PluginHostTasks = {
  getActiveTasks: () => [...active.values()],
  async runTask(options) {
    const connection = new AbortController();
    const response = await fetch(`${API_BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify(options),
      signal: connection.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error || response.statusText);
    if (!response.body) throw new Error("Task output stream unavailable");
    const reader = response.body.getReader();
    const outputs = new Set<(chunk: string) => void>();
    const exits = new Set<(code: number) => void>();
    let history = "";
    let exitCode: number | undefined;
    let cancelled = false;
    let execution: TaskExecution;
    const item = createStatusBarItem("tasks", { id: crypto.randomUUID(), alignment: "right" });
    item.text = options.title || options.command;
    item.tooltip = options.command;
    let resolveStart!: (execution: TaskExecution) => void;
    let rejectStart!: (error: unknown) => void;
    const started = new Promise<TaskExecution>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const notify = <T>(listeners: Set<(value: T) => void>, value: T) => {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch (error) {
          console.error("Task listener failed", error);
        }
      }
    };
    const finish = (code: number) => {
      if (exitCode !== undefined) return;
      exitCode = code;
      if (execution) active.delete(execution.id);
      item.dispose();
      notify(exits, code);
      outputs.clear();
      exits.clear();
      if (code !== 0 && !cancelled) {
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted")
            new Notification(options.title || options.command, { body: String(code) });
        } catch {
          /* The in-app notification remains available. */
        }
        toast.error(`${options.title || options.command}: ${code}`);
      }
    };
    const consume = (line: string) => {
      const event = JSON.parse(line) as { id?: string; output?: string; exitCode?: number };
      if (event.id) {
        execution = {
          id: event.id,
          command: options.command,
          kill() {
            cancelled = true;
            void request(`/tasks/${encodeURIComponent(execution.id)}`, { method: "DELETE" }).catch(() =>
              connection.abort()
            );
          },
          onDidOutput(listener) {
            if (history) listener(history);
            if (exitCode === undefined) outputs.add(listener);
            return () => {
              outputs.delete(listener);
            };
          },
          onDidExit(listener) {
            if (exitCode !== undefined) listener(exitCode);
            else exits.add(listener);
            return () => {
              exits.delete(listener);
            };
          },
        };
        active.set(execution.id, execution);
        item.show();
        resolveStart(execution);
      }
      if (event.output !== undefined) {
        // ponytail: replay the last MiB to late listeners; stream full logs through onDidOutput.
        history = (history + event.output).slice(-1024 * 1024);
        notify(outputs, event.output);
      }
      if (event.exitCode !== undefined) finish(event.exitCode);
    };
    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line) consume(line);
            newline = buffer.indexOf("\n");
          }
          if (done) break;
        }
        if (exitCode === undefined) throw new Error("Task output disconnected");
      } catch (error) {
        rejectStart(error);
        finish(-1);
      } finally {
        reader.releaseLock();
      }
    })();
    return started;
  },
};
