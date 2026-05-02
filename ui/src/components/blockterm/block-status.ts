import type { Block } from "./api";

export function blockStatus(block: Block) {
  if (block.kind === "background") return { label: "后台输出", failed: false };
  if (block.status === "submitted") return { label: "待执行", failed: false };
  if (block.status === "running") return { label: "运行中", failed: false };
  if (block.status === "not_executed") return { label: "未执行", failed: false };
  if (block.status === "interrupted" || block.exit_code === 130) return { label: "中断", failed: false };
  if (block.exit_code === 141) return { label: "管道关闭", failed: false };
  if (block.status !== "done") return { label: "状态未知", failed: false };
  const failed = block.success === false || (block.success == null && block.exit_code != null && block.exit_code !== 0);
  if (failed) return { label: "失败", failed: true };
  return { label: block.success === true || block.exit_code === 0 ? "完成" : "已结束", failed: false };
}

export function blockDuration(block: Block, now: number) {
  if (!block.created_at || block.kind === "background") return "";
  const end = block.finished_at || (block.status === "running" || block.status === "submitted" ? now : 0);
  if (!end) return "";
  const elapsed = Math.max(0, end - (block.started_at || block.created_at));
  if (elapsed < 1000) return `${Math.round(elapsed)} ms`;
  if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)} s`;
  return `${Math.floor(elapsed / 60000)} m ${Math.floor((elapsed % 60000) / 1000)} s`;
}
