import { ApiException } from './http-errors.ts';

/**
 * Fixed-window, in-process rate limiter. Adequate for a single API replica and
 * for tests; multi-replica deployments need the shared Redis-backed limiter
 * tracked in docs/RISKS.md (R-007).
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return;
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      throw new ApiException(429, 'RATE_LIMITED', 'Too many attempts; try again later', {
        retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
      });
    }
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
