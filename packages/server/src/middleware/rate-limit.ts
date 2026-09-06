import type { IncomingMessage } from "node:http";

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

const CLEANUP_INTERVAL = 60_000;
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, CLEANUP_INTERVAL);
// Never keep the process alive just to sweep expired buckets.
cleanup.unref?.();

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

/**
 * Public SDK endpoints are limited on two axes:
 *
 * - `*PerClient` is keyed by public key + client IP. This is the abuse guard:
 *   one runaway device or script is capped without touching anyone else.
 *   Indian mobile carriers put thousands of handsets behind a single CGNAT
 *   IP, so these are sized for a crowd, not a phone.
 * - `*PerKey` is keyed by public key alone. It exists only to stop a runaway
 *   integration from taking the service down, and is sized far above real
 *   traffic (the largest customer peaks around 30 config calls a minute).
 *   It must never bite a healthy customer: a 429 is a hard failure for a
 *   first-launch user, who has no cached config to fall back on.
 */
export const LIMITS = {
  configPerClient: { windowMs: 60_000, max: 120 },
  documentPerClient: { windowMs: 60_000, max: 120 },
  eventsPerClient: { windowMs: 60_000, max: 600 },
  configPerKey: { windowMs: 60_000, max: 6_000 },
  documentPerKey: { windowMs: 60_000, max: 6_000 },
  eventsPerKey: { windowMs: 60_000, max: 20_000 },
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

export type PublicScope = "config" | "document" | "events";

export interface RateLimitDecision {
  allowed: boolean;
  resetAt: number;
  /** Which axis rejected the request, when it was rejected. */
  limitedBy: "client" | "key" | null;
}

/**
 * Applies the per-client and per-key limits for a public SDK endpoint.
 *
 * Requests that carry no usable public key are limited per client only and
 * never count against a customer budget; the route rejects them with 400.
 */
export function enforcePublicRateLimit(
  scope: PublicScope,
  publicKey: string | null | undefined,
  ip: string
): RateLimitDecision {
  const keyLabel = publicKey || "unknown";
  const perClient = checkRateLimit(`${scope}:${keyLabel}:${ip}`, LIMITS[`${scope}PerClient`]);
  if (!perClient.allowed) {
    return { allowed: false, resetAt: perClient.resetAt, limitedBy: "client" };
  }
  if (!publicKey) {
    return { allowed: true, resetAt: perClient.resetAt, limitedBy: null };
  }
  const perKey = checkRateLimit(`${scope}:${publicKey}`, LIMITS[`${scope}PerKey`]);
  if (!perKey.allowed) {
    return { allowed: false, resetAt: perKey.resetAt, limitedBy: "key" };
  }
  return { allowed: true, resetAt: perKey.resetAt, limitedBy: null };
}

/**
 * Best-effort client address for rate limiting.
 *
 * `cf-connecting-ip` is set by Cloudflare and cannot be forged through the
 * proxy, so it wins when present. The first `x-forwarded-for` entry is what
 * Vercel and Railway forward today, but it is client-controlled when the
 * service is reached directly, so it only ranks second.
 */
export function getClientIp(req: IncomingMessage): string {
  const cloudflare = req.headers["cf-connecting-ip"];
  if (typeof cloudflare === "string" && cloudflare.trim()) return cloudflare.trim();
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}

/** Extracts `publicKey` from a JSON request body without trusting anything else in it. */
export function publicKeyFromJson(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { publicKey?: unknown };
    return typeof parsed?.publicKey === "string" && parsed.publicKey ? parsed.publicKey : null;
  } catch {
    return null;
  }
}

/** Test hook: clears every bucket. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}
