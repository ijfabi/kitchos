import { Injectable } from '@nestjs/common';
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

  /** Counts an attempt and throws once the limit is exceeded. */
  consume(key: string, now = Date.now()): void {
    const entry = this.current(key, now);
    entry.count += 1;
    if (entry.count > this.limit) this.reject(entry, now);
  }

  /** Throws if `key` has already reached the limit, without counting this attempt. */
  assertAllowed(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > now && entry.count >= this.limit) this.reject(entry, now);
  }

  /** Counts a failed attempt (used where only failures should exhaust the budget). */
  recordFailure(key: string, now = Date.now()): void {
    this.current(key, now).count += 1;
  }

  private current(key: string, now: number) {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
      if (this.hits.size > 50_000) this.sweep(now);
    }
    return entry;
  }

  private reject(entry: { resetAt: number }, now: number): never {
    throw new ApiException(429, 'RATE_LIMITED', 'Too many attempts; try again later', {
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    });
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

const WINDOW_MS = 15 * 60_000;

/**
 * One password-guessing budget shared by sign-in and terminal re-authentication.
 * Failures are counted per account regardless of client IP (so rotating
 * X-Forwarded-For does not reset it) and, for overrides, per requesting user;
 * successful checks do not count, so busy approvers are never locked out.
 * Every attempt also counts against a per-IP ceiling.
 */
@Injectable()
export class CredentialThrottle {
  private readonly perIp = new FixedWindowLimiter(100, WINDOW_MS);
  private readonly accountFailures = new FixedWindowLimiter(10, WINDOW_MS);
  private readonly requesterFailures = new FixedWindowLimiter(10, WINDOW_MS);

  async check<T>(
    args: { ip: string; email: string; requesterId?: string },
    verify: () => Promise<T>,
  ): Promise<T> {
    const account = args.email.trim().toLowerCase();
    this.perIp.consume(args.ip);
    this.accountFailures.assertAllowed(account);
    if (args.requesterId) this.requesterFailures.assertAllowed(args.requesterId);
    try {
      return await verify();
    } catch (err) {
      if (err instanceof ApiException && err.code === 'INVALID_CREDENTIALS') {
        this.accountFailures.recordFailure(account);
        if (args.requesterId) this.requesterFailures.recordFailure(args.requesterId);
      }
      throw err;
    }
  }
}
