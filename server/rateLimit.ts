/** 滑动窗口限流器：保证任意 windowMs 时间窗内的调用次数不超过 maxCalls。
 * 需要「跨多处调用共享额度」时，请复用同一个实例（如 windMcpLimiter / westockLimiter）。 */
export class RateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly maxCalls: number,
    private readonly windowMs: number
  ) {}

  /** 取一个调用名额；窗口已满时睡到最早一次调用滑出窗口再占用（精确等待，不忙轮询） */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.maxCalls) {
        this.stamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.stamps[0]) + 5;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
