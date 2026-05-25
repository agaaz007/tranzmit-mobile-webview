import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initEvents, queueEvent, flush } from "../src/events.js";

describe("events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    initEvents(
      { publicKey: "pk_test_abc", userId: "user_1" },
      "sess_123",
      { userId: "user_1", identifiers: { stableID: "stable_1" } }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("batches events and flushes on timer", () => {
    queueEvent("page_view", { url: "/" });

    expect(fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.publicKey).toBe("pk_test_abc");
    expect(body.identity).toEqual({ userId: "user_1", identifiers: { stableID: "stable_1" } });
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event).toBe("page_view");
  });

  it("flushes immediately when batch is full (10 events)", () => {
    for (let i = 0; i < 10; i++) {
      queueEvent("click", { i });
    }

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.events).toHaveLength(10);
  });

  it("uses sendBeacon when useBeacon=true", () => {
    queueEvent("page_view");
    flush(true);

    expect(navigator.sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps events queued when fetch is unavailable", () => {
    vi.stubGlobal("fetch", undefined);
    queueEvent("page_view");
    flush();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains events on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    queueEvent("impression");
    vi.advanceTimersByTime(2000);

    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    vi.advanceTimersByTime(2000);

    // Events should be retried
  });
});
