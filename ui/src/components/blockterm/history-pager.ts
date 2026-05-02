type FetchPage<T> = (
  scope: string,
  query: string,
  cursor: string,
  signal: AbortSignal
) => Promise<{
  blocks: T[];
  has_more: boolean;
  next_cursor?: string;
}>;

export class HistoryPager<T extends { id: string }> {
  loading = false;
  private controller = new AbortController();
  private scope = "";
  private query = "";
  private cursor = "";
  private cursors = new Set<string>();
  private records: T[] = [];
  private more = true;
  private fetchPage: FetchPage<T>;

  constructor(fetchPage: FetchPage<T>) {
    this.fetchPage = fetchPage;
  }

  reset(scope: string, query: string) {
    this.controller.abort();
    this.controller = new AbortController();
    this.scope = scope;
    this.query = query;
    this.cursor = "";
    this.cursors.clear();
    this.records = [];
    this.more = true;
    this.loading = false;
  }

  cancel() {
    this.controller.abort();
  }

  async load() {
    if (this.loading || !this.more || this.controller.signal.aborted) return null;
    const controller = this.controller;
    this.loading = true;
    try {
      const result = await this.fetchPage(this.scope, this.query, this.cursor, controller.signal);
      if (controller.signal.aborted) return null;
      if (
        !result ||
        !Array.isArray(result.blocks) ||
        typeof result.has_more !== "boolean" ||
        (result.next_cursor !== undefined && typeof result.next_cursor !== "string") ||
        result.blocks.some((block) => !block || typeof block.id !== "string" || !block.id)
      ) {
        throw new Error("历史分页响应无效，请重试");
      }
      if (result.has_more && (!result.next_cursor || this.cursors.has(result.next_cursor))) {
        throw new Error("历史分页游标未推进，请重试");
      }
      const records = [...new Map([...this.records, ...result.blocks].map((block) => [block.id, block])).values()];
      if (result.has_more && result.next_cursor) this.cursors.add(result.next_cursor);
      this.cursor = result.next_cursor ?? "";
      this.records = records;
      this.more = result.has_more;
      return { blocks: this.records, has_more: this.more, signal: controller.signal };
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      if (controller === this.controller) this.loading = false;
    }
  }
}
