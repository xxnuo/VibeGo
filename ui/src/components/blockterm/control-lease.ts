export class ControlLease {
  private stopped = false;
  private pending = false;
  private readonly claim: () => Promise<unknown>;
  private readonly release: () => Promise<unknown>;
  private readonly publish: (controlled: boolean) => void;

  constructor(claim: () => Promise<unknown>, release: () => Promise<unknown>, publish: (controlled: boolean) => void) {
    this.claim = claim;
    this.release = release;
    this.publish = publish;
  }

  async renew() {
    if (this.stopped || this.pending) return;
    this.pending = true;
    try {
      await this.claim();
      if (!this.stopped) this.publish(true);
    } catch {
      if (!this.stopped) this.publish(false);
    } finally {
      this.pending = false;
      // Cleanup may have raced a request which acquired the lease after release.
      if (this.stopped) await this.release().catch(() => undefined);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    void this.release().catch(() => undefined);
  }
}
