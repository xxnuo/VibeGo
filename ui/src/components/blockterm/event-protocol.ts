import type { TerminalEvent } from "./api";

const recordedTypes = new Set(["block", "output", "terminal", "state", "resize", "gap"]);
const phases = new Set(["initializing", "compatible", "ready", "submitted", "running", "editing", "exited"]);
const statuses = new Set(["submitted", "running", "done", "interrupted", "not_executed"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("终端事件内容必须是对象");
  return value as Record<string, unknown>;
}

function textFields(value: Record<string, unknown>, fields: string[]) {
  for (const field of fields)
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error("终端事件文本字段无效");
}

export function validateBlockPayload(value: unknown, event: TerminalEvent) {
  const block = object(value);
  if (
    typeof block.id !== "string" ||
    !block.id ||
    block.id !== event.block_id ||
    (block.session_id !== undefined && block.session_id !== event.session_id) ||
    typeof block.status !== "string" ||
    !statuses.has(block.status)
  )
    throw new Error("命令块身份或状态无效");
  textFields(block, ["command", "cwd", "kind"]);
  for (const field of ["created_at", "started_at", "finished_at", "exit_code", "native_exit_code", "shell_status"])
    if (block[field] != null && (typeof block[field] !== "number" || !Number.isFinite(block[field])))
      throw new Error("命令块数值字段无效");
  if (block.success != null && typeof block.success !== "boolean") throw new Error("命令块结果无效");
}

export function validateResizePayload(value: unknown) {
  const size = object(value);
  if (
    !Number.isInteger(size.cols) ||
    !Number.isInteger(size.rows) ||
    (size.cols as number) < 2 ||
    (size.cols as number) > 500 ||
    (size.rows as number) < 2 ||
    (size.rows as number) > 300
  )
    throw new Error("终端尺寸无效");
}

export function validateSessionPayload(value: unknown, event: TerminalEvent) {
  const session = object(value);
  if (session.id !== event.session_id || typeof session.phase !== "string" || !phases.has(session.phase))
    throw new Error("终端会话身份或状态无效");
  textFields(session, ["group_id", "shell", "cwd", "error", "warning", "exit_signal"]);
  if (
    session.exit_signal !== undefined &&
    (session.phase !== "exited" || !session.exit_signal || session.exit_code !== undefined)
  )
    throw new Error("终端进程终止信号无效");
  if (
    session.exit_code !== undefined &&
    (session.phase !== "exited" ||
      !Number.isInteger(session.exit_code) ||
      (session.exit_code as number) < 0 ||
      (session.exit_code as number) > 0xffffffff)
  )
    throw new Error("终端进程退出码无效");
  if (session.cols !== undefined || session.rows !== undefined) validateResizePayload(session);
}

export function validateTerminalEvent(value: unknown, session: string): asserts value is TerminalEvent {
  if (!value || typeof value !== "object") throw new Error("终端事件格式无效");
  const event = value as Partial<TerminalEvent>;
  // Faults are out-of-band and older servers omit their session/sequence fields.
  if (event.type === "fault") {
    if (event.data !== undefined && typeof event.data !== "string") throw new Error("终端故障消息无效");
    return;
  }
  if (
    event.session_id !== session ||
    !Number.isSafeInteger(event.seq) ||
    (event.seq as number) < (event.type === "hello" ? 0 : 1)
  )
    throw new Error("终端事件会话或序号无效");
  if (event.type !== "hello" && !recordedTypes.has(event.type ?? ""))
    throw new Error("不支持的终端事件，请更新客户端后重试");
  if (typeof event.data !== "string") throw new Error("终端事件缺少数据");
  if (event.type === "output" && (typeof event.block_id !== "string" || !event.block_id))
    throw new Error("终端输出缺少命令块标识");
}
