import { createHash } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_COMPLETED_BATCHES = 10_000;

export interface EventBatchIdempotencyOptions {
  ttlMs?: number;
  maxCompletedBatches?: number;
  now?: () => number;
}

/**
 * Coalesces concurrent retries and remembers recently completed event batches.
 *
 * The SDK sends the same serialized request body to its primary and fallback
 * hosts. Hashing that body (rather than the host or URL) lets both requests
 * share one write while keeping the existing events API unchanged.
 */
export class EventBatchIdempotency {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly completed = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxCompletedBatches: number;
  private readonly now: () => number;

  constructor(options: EventBatchIdempotencyOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxCompletedBatches = options.maxCompletedBatches ?? DEFAULT_MAX_COMPLETED_BATCHES;
    this.now = options.now ?? Date.now;
  }

  async run(rawBody: string, work: () => Promise<void>): Promise<void> {
    const fingerprint = createHash("sha256").update(rawBody).digest("hex");
    const now = this.now();
    this.purgeExpired(now);

    const completedUntil = this.completed.get(fingerprint);
    if (completedUntil !== undefined && completedUntil > now) return;

    const pending = this.inFlight.get(fingerprint);
    if (pending) {
      await pending;
      return;
    }

    const operation = (async () => {
      await work();
      this.rememberCompleted(fingerprint);
    })();
    this.inFlight.set(fingerprint, operation);

    try {
      await operation;
    } finally {
      if (this.inFlight.get(fingerprint) === operation) {
        this.inFlight.delete(fingerprint);
      }
    }
  }

  clear(): void {
    this.inFlight.clear();
    this.completed.clear();
  }

  private rememberCompleted(fingerprint: string): void {
    this.completed.set(fingerprint, this.now() + this.ttlMs);

    while (this.completed.size > this.maxCompletedBatches) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private purgeExpired(now: number): void {
    // Completed entries use one fixed TTL and Map preserves insertion order,
    // so every expired entry is a prefix. Stop at the first live entry rather
    // than scanning the full bounded cache for every event request.
    for (const [fingerprint, expiresAt] of this.completed) {
      if (expiresAt > now) break;
      this.completed.delete(fingerprint);
    }
  }
}

export const eventBatchIdempotency = new EventBatchIdempotency();
