import type { TerminalEvent } from "./api";
import { decodeBase64Bytes } from "./base64.ts";

export async function collectOutput(
  session: string,
  block: string,
  fetchPage: (
    after: number,
    through?: number
  ) => Promise<{ events: TerminalEvent[]; has_more: boolean; through?: number }>,
  limit = 128 * 1024 * 1024,
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void
): Promise<BlobPart[]> {
  const chunks: BlobPart[] = [];
  let cursor = 0;
  let size = 0;
  let through: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const result = await fetchPage(cursor, through);
    signal?.throwIfAborted();
    if (!result || typeof result !== "object" || !Array.isArray(result.events) || typeof result.has_more !== "boolean")
      throw new Error("输出下载返回了无效分页，请重试");
    if (
      (result.through !== undefined && (!Number.isSafeInteger(result.through) || result.through < cursor)) ||
      (through !== undefined && result.through !== through)
    )
      throw new Error("输出下载快照发生变化，请重试");
    through = result.through;
    const previous = cursor;
    for (const event of result.events) {
      if (
        !event ||
        typeof event !== "object" ||
        event.session_id !== session ||
        event.block_id !== block ||
        event.type !== "output" ||
        !Number.isSafeInteger(event.seq) ||
        event.seq <= cursor ||
        (through !== undefined && event.seq > through) ||
        (event.data !== undefined && typeof event.data !== "string")
      )
        throw new Error("输出下载返回了无效记录，请重试");
      cursor = event.seq;
      if (event.data) {
        // The server emits canonical padded base64. Reject oversized records
        // before atob and Uint8Array allocate additional copies of the payload.
        if (event.data.length > Math.ceil((limit - size) / 3) * 4) throw new Error("输出下载超过 128 MiB 上限");
        const data = decodeBase64Bytes(event.data);
        size += data.byteLength;
        if (size > limit) throw new Error("输出下载超过 128 MiB 上限");
        chunks.push(data.buffer);
      }
    }
    onProgress?.(size);
    signal?.throwIfAborted();
    if (!result.has_more) return chunks;
    if (cursor === previous) throw new Error("输出下载游标未推进，请重试");
  }
}
