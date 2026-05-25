import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, gate, track, reportConversion, reset } from "../src/index.js";
import type { ConfigResponse } from "@tranzmit/shared";

const mockConfig: ConfigResponse = {
  version: "1.0.0",
  placements: {
    upgrade_pro: {
      trigger: "upgrade_pro",
      enabled: true,
      variantId: "var_a",
      spec: {
        layout: "hero_vertical",
        headline: "Unlock Pro",
        subheadline: "Get unlimited access",
        cta: "Start Free Trial",
        theme: "light",
        products: [
          {
            id: "pro_monthly",
            name: "Pro Monthly",
            price: { amount: 999, currency: "USD", interval: "month" },
            highlighted: true,
          },
        ],
        features: ["Unlimited exports", "Priority support"],
      },
    },
    disabled_trigger: {
      trigger: "disabled_trigger",
      enabled: false,
      variantId: "var_b",
      spec: {
        layout: "compact",
        headline: "Disabled",
        cta: "Nope",
        theme: "dark",
        products: [],
      },
    },
  },
  assets: {},
  ttl: 300,
};

describe("SDK", () => {
  beforeEach(() => {
    reset();
    localStorage.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("init", () => {
    it("throws on invalid publicKey", async () => {
      await expect(init({ publicKey: "bad", userId: "u1" })).rejects.toThrow(
        "pk_live_xxx or pk_test_xxx"
      );
    });

    it("initializes and fetches config", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      expect(fetch).toHaveBeenCalled();
    });

    it("uses cached config on subsequent init (stale-while-revalidate)", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });

      vi.mocked(fetch).mockClear();
      reset();

      await init({ publicKey: "pk_test_demo", userId: "user_1" });

      // Should still be initialized from cache (fetch is for background refresh)
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(true);
    });

    it("deduplicates concurrent init calls for the same app user", async () => {
      await Promise.all([
        init({ publicKey: "pk_test_demo", userId: "user_1" }),
        init({ publicKey: "pk_test_demo", userId: "user_1" }),
        init({ publicKey: "pk_test_demo", userId: "user_1" }),
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("gate", () => {
    it("returns shown:false before init", () => {
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(false);
    });

    it("renders paywall for valid trigger", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(true);
      expect(result.variantId).toBe("var_a");
    });

    it("returns shown:false for disabled trigger", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const result = gate("disabled_trigger");
      expect(result.shown).toBe(false);
    });

    it("returns shown:false for unknown trigger", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const result = gate("nonexistent");
      expect(result.shown).toBe(false);
    });

    it("returns shown:false when no mount target is available", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const body = document.body;
      document.documentElement.removeChild(body);
      expect(gate("upgrade_pro").shown).toBe(false);
      document.documentElement.appendChild(body);
    });

    it("calls onCTA callback when product clicked", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const onCTA = vi.fn();
      gate("upgrade_pro", { onCTA });

      const ctaButton = document.querySelector(".tranzmit-cta") as HTMLElement;
      ctaButton?.click();

      expect(onCTA).toHaveBeenCalledWith(
        expect.objectContaining({ id: "pro_monthly" })
      );
    });

    it("calls onDismiss when close button clicked", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const onDismiss = vi.fn();
      gate("upgrade_pro", { onDismiss });

      const closeBtn = document.querySelector(".tranzmit-close") as HTMLElement;
      closeBtn?.click();

      expect(onDismiss).toHaveBeenCalled();
    });

    it("dismiss() removes the paywall", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      const result = gate("upgrade_pro");
      expect(document.querySelector(".tranzmit-paywall")).not.toBeNull();

      result.dismiss();
      expect(document.querySelector(".tranzmit-paywall")).toBeNull();
    });
  });

  describe("track", () => {
    it("queues custom event", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      track("custom_event", { foo: "bar" });
      // Event is queued, will flush on timer
    });
  });

  describe("reportConversion", () => {
    it("queues conversion event", async () => {
      await init({ publicKey: "pk_test_demo", userId: "user_1" });
      reportConversion({ trigger: "upgrade_pro", revenue: 999, currency: "USD" });
      // Event queued
    });
  });
});
