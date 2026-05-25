interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

const CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, CLEANUP_INTERVAL);

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export const LIMITS = {
  config: { windowMs: 60_000, max: 60 },
  events: { windowMs: 60_000, max: 30 },
  admin: { windowMs: 60_000, max: 100 },
} as const;

export function checkRateLimit(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.max - 1, resetAt: now + config.windowMs };
  }

  bucket.count++;
  const allowed = bucket.count <= config.max;
  return { allowed, remaining: Math.max(0, config.max - bucket.count), resetAt: bucket.resetAt };
}
