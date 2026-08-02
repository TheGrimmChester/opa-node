'use strict';

/**
 * Per-process token bucket keyed by transaction name (Transaction / ingest controls/7A-6 parity).
 *
 * Same contract as the PHP extension: suppress skips instrumentation work;
 * residual suppressed count rides on the next admit's sample_weight so
 * sum(sample_weight) stays exact. The agent-side limiter remains authoritative
 * for the fleet; this is the overhead win inside one Node process.
 */

class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  /**
   * @returns {{ allowed: boolean, weightBonus: number }}
   */
  allow(txnName, perMinute, burst) {
    const perMin = Number(perMinute);
    if (!Number.isFinite(perMin) || perMin <= 0) {
      return { allowed: true, weightBonus: 0 };
    }
    let b = Number(burst);
    if (!Number.isFinite(b) || b <= 0) b = perMin;

    const key = txnName && String(txnName).length > 0 ? String(txnName) : 'unknown';
    const now = Date.now() / 1000;
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { tokens: b, residual: 0, last: now };
      this.buckets.set(key, entry);
    } else {
      const elapsed = Math.max(0, now - entry.last);
      entry.tokens = Math.min(b, entry.tokens + elapsed * (perMin / 60));
      entry.last = now;
    }

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      const bonus = entry.residual;
      entry.residual = 0;
      return { allowed: true, weightBonus: bonus };
    }
    entry.residual += 1;
    return { allowed: false, weightBonus: 0 };
  }

  /** Test helper: drop all state. */
  reset() {
    this.buckets.clear();
  }
}

const shared = new RateLimiter();

module.exports = { RateLimiter, shared };
