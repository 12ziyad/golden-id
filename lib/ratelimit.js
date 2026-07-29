'use strict';

// A small fixed-window rate limiter.
//
// Extraction and comparison call paid models and do real CPU work, and the OTP
// endpoint is a brute-force target. Without limits a single client can drain
// the Workers AI budget or grind through OTP codes. In-memory is adequate for a
// single-process prototype; production needs a shared store.

function createLimiter() {
  const buckets = new Map();

  const limiter = {
    /**
     * Consume one unit. Returns `{ allowed, remaining, retryAfterSeconds }`.
     * `key` should identify the caller (session, user or address).
     */
    take(key, { limit, windowMs }) {
      const now = Date.now();
      const bucket = buckets.get(key);

      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }
      if (bucket.count >= limit) {
        return {
          allowed: false, remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        };
      }
      bucket.count++;
      return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
    },

    reset(key) { buckets.delete(key); },
    clear() { buckets.clear(); },

    /** Drop expired buckets so the map cannot grow without bound. */
    sweep(now = Date.now()) {
      for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
    }
  };

  return limiter;
}

// Per-endpoint budgets. Deliberately generous for a demo, but finite.
const LIMITS = {
  otpRequest: { limit: 5, windowMs: 15 * 60_000 },
  otpVerify: { limit: 10, windowMs: 15 * 60_000 },
  extract: { limit: 60, windowMs: 60 * 60_000 },
  compare: { limit: 60, windowMs: 60 * 60_000 },
  cardRetrieve: { limit: 120, windowMs: 60 * 60_000 }
};

module.exports = { createLimiter, LIMITS };
