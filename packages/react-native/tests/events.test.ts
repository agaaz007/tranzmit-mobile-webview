import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranzmitClient, type PlatformAdapter } from "@tranzmit/shared";
import { mockConfig } from "./fixtures.js";

function memoryAdapter(): PlatformAdapter {
  const storage = new Map<string, string>();
  const backgroundCallbacks = new Set<() => void>();

  return {
    storage: {
      get: async (key) => storage.get(key) || null,
      set: async (key, value) => {
        storage.set(key, value);
      },
      remove: async (key) => {
        storage.delete(key);
      },
    },
    lifecycle: {
      onBackground(cb) {
        backgroundCallbacks.add(cb);
        return () => backgroundCallbacks.delete(cb);
      },
      onForeground() {
        return () => {};
      },
    },
  };
}

describe("shared RN event batching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })
    );
  });

  it("flushes when the queue reaches ten events", async () => {
    const client = createTranzmitClient(memoryAdapter(), {
      platform: "react-native",
      os: "ios",
      sdkVersion: "1.0.0",
    });

    await client.init({ publicKey: "pk_test_demo" });
    vi.mocked(fetch).mockClear();

    for (let i = 0; i < 10; i++) {
      client.track("feature_clicked", { i });
    }

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.events).toHaveLength(10);
    expect(body.events[0].properties.platform).toBe("react-native");
    expect(body.events[0].properties.os).toBe("ios");
  });

  it("flushes conversions immediately", async () => {
    const client = createTranzmitClient(memoryAdapter(), { platform: "react-native" });
    await client.init({ publicKey: "pk_test_demo" });
    vi.mocked(fetch).mockClear();

    client.reportConversion({ productId: "pro_monthly", revenue: 9.99, currency: "USD" });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    const conversion = body.events.find((event: any) => event.event === "conversion");
    expect(conversion).toBeTruthy();
    expect(conversion.properties.productId).toBe("pro_monthly");
  });
});
