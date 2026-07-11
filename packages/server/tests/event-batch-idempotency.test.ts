import { describe, expect, it, vi } from "vitest";
import { EventBatchIdempotency } from "../src/event-batch-idempotency.js";

describe("EventBatchIdempotency", () => {
  it("coalesces identical in-flight request bodies", async () => {
    const idempotency = new EventBatchIdempotency();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const work = vi.fn(() => blocked);

    const first = idempotency.run('{"batch":"same"}', work);
    const second = idempotency.run('{"batch":"same"}', work);

    expect(work).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("deduplicates only within the completed-batch TTL", async () => {
    let now = 1_000;
    const idempotency = new EventBatchIdempotency({ ttlMs: 100, now: () => now });
    const work = vi.fn(async () => {});

    await idempotency.run('{"batch":"same"}', work);
    now = 1_099;
    await idempotency.run('{"batch":"same"}', work);
    expect(work).toHaveBeenCalledTimes(1);

    now = 1_100;
    await idempotency.run('{"batch":"same"}', work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("purges the expired prefix while retaining newer completions", async () => {
    let now = 1_000;
    const idempotency = new EventBatchIdempotency({ ttlMs: 100, now: () => now });
    const work = vi.fn(async () => {});

    await idempotency.run("old-batch", work);
    now = 1_050;
    await idempotency.run("newer-batch", work);
    now = 1_100;
    await idempotency.run("trigger-purge", work);
    await idempotency.run("old-batch", work);
    await idempotency.run("newer-batch", work);

    expect(work).toHaveBeenCalledTimes(4);
  });

  it("does not remember failed batches", async () => {
    const idempotency = new EventBatchIdempotency();
    const work = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(idempotency.run('{"batch":"retry"}', work)).rejects.toThrow("database unavailable");
    await expect(idempotency.run('{"batch":"retry"}', work)).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("bounds the completed-batch cache", async () => {
    const idempotency = new EventBatchIdempotency({ maxCompletedBatches: 2 });
    const work = vi.fn(async () => {});

    await idempotency.run("batch-1", work);
    await idempotency.run("batch-2", work);
    await idempotency.run("batch-3", work);
    await idempotency.run("batch-1", work);

    expect(work).toHaveBeenCalledTimes(4);
  });
});
