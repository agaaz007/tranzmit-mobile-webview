import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCachedConfig, setCachedConfig, fetchConfig } from "../src/config.js";

describe("config", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe("getCachedConfig", () => {
    it("returns null when no cache exists", () => {
      expect(getCachedConfig({ publicKey: "pk_test_abc", userId: "user_1" })).toBeNull();
    });

    it("returns cached config when present", () => {
      const sdkConfig = { publicKey: "pk_test_abc", userId: "user_1" };
      const config = { version: "1.0.0", placements: {}, assets: {}, ttl: 300 };
      setCachedConfig(sdkConfig, config);
      expect(getCachedConfig(sdkConfig)).toEqual(config);
    });

    it("returns null for different public key", () => {
      const sdkConfig = { publicKey: "pk_test_abc", userId: "user_1" };
      const config = { version: "1.0.0", placements: {}, assets: {}, ttl: 300 };
      setCachedConfig(sdkConfig, config);
      expect(getCachedConfig({ publicKey: "pk_test_other", userId: "user_1" })).toBeNull();
    });

    it("expires cached config after ttl", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const sdkConfig = { publicKey: "pk_test_abc", userId: "user_1" };
      const config = { version: "1.0.0", placements: {}, assets: {}, ttl: 1 };
      setCachedConfig(sdkConfig, config);
      expect(getCachedConfig(sdkConfig)).toEqual(config);
      vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
      expect(getCachedConfig(sdkConfig)).toBeNull();
      vi.useRealTimers();
    });
  });

  describe("fetchConfig", () => {
    it("fetches config from API", async () => {
      const mockConfig = { version: "1.0.0", placements: {}, assets: {}, ttl: 300 };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockConfig),
        })
      );

      const result = await fetchConfig({
        publicKey: "pk_test_abc",
        userId: "user_1",
      });

      expect(result).toEqual(mockConfig);
      expect(fetch).toHaveBeenCalledWith(
        "https://tranzmit-api-production.up.railway.app/v1/config",
        expect.objectContaining({ method: "POST" })
      );
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.publicKey).toBe("pk_test_abc");
      expect(body.identity.userId).toBe("user_1");
      expect(body.identity.identifiers.stableID).toMatch(/^trz_/);
    });

    it("sends user traits and private traits in the POST body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ version: "1.0.0", placements: {}, assets: {}, ttl: 300 }),
        })
      );

      await fetchConfig({
        publicKey: "pk_test_abc",
        userId: "user_1",
        userTraits: { plan: "free", uploads: 5 },
        privateTraits: { email: "private@example.com" },
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.traits).toEqual({ plan: "free", uploads: 5 });
      expect(body.privateTraits).toEqual({ email: "private@example.com" });
    });

    it("supports anonymous users with generated stable IDs", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ version: "1.0.0", placements: {}, assets: {}, ttl: 300 }),
        })
      );

      await fetchConfig({ publicKey: "pk_test_abc" });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.identity.userId).toBeUndefined();
      expect(body.identity.identifiers.stableID).toMatch(/^trz_/);
    });

    it("uses custom apiBaseUrl", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ version: "1.0.0", placements: {}, assets: {}, ttl: 300 }),
        })
      );

      await fetchConfig({
        publicKey: "pk_test_abc",
        userId: "user_1",
        apiBaseUrl: "http://localhost:3000",
      });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/v1/config",
        expect.any(Object)
      );
    });

    it("throws on non-ok response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 401 })
      );

      await expect(
        fetchConfig({ publicKey: "pk_test_abc", userId: "user_1" })
      ).rejects.toThrow("HTTP 401");
    });
  });
});
