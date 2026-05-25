import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, gate, track, reportConversion, reset, flush } from "../src/index.js";
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
          { id: "pro_monthly", name: "Pro Monthly", price: { amount: 999, currency: "USD", interval: "month" }, highlighted: true },
          { id: "pro_yearly", name: "Pro Yearly", price: { amount: 9999, currency: "USD", interval: "year" } },
        ],
        features: ["Unlimited exports", "Priority support"],
      },
    },
    onboarding: {
      trigger: "onboarding",
      enabled: true,
      variantId: "var_b",
      spec: {
        layout: "compact",
        headline: "Welcome",
        cta: "Choose Plan",
        theme: "dark",
        products: [{ id: "starter", name: "Starter", price: { amount: 499, currency: "USD", interval: "month" } }],
      },
    },
    custom_paywall: {
      trigger: "custom_paywall",
      enabled: true,
      variantId: "var_c",
      spec: {
        layout: "custom",
        headline: "Go Pro",
        subheadline: "Join us",
        cta: "Subscribe",
        theme: "light",
        products: [{ id: "pro", name: "Pro", price: { amount: 1999, currency: "USD", interval: "month" }, highlighted: true }],
        customHtml: '<div class="custom"><h1>{{headline}}</h1>{{#products}}<button data-tranzmit-cta="{{id}}">Buy {{name}}</button>{{/products}}<a data-tranzmit-dismiss>Close</a></div>',
        customCss: '.custom { background: white; }',
      },
    },
    disabled_one: {
      trigger: "disabled_one",
      enabled: false,
      variantId: "var_d",
      spec: { layout: "compact", headline: "Nope", cta: "No", theme: "light", products: [] },
    },
  },
  assets: {},
  ttl: 300,
};

function customRoot(): ParentNode {
  const host = document.querySelector(".tranzmit-custom-host") as HTMLElement | null;
  return host?.shadowRoot || document;
}

function mockFetch(config = mockConfig, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status === 200,
    status,
    json: () => Promise.resolve(config),
  }));
}

describe("Stress Tests: Cross-webapp Compatibility", () => {
  beforeEach(() => {
    reset();
    localStorage.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    mockFetch();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("Init resilience", () => {
    it("handles network failure gracefully on first init", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
      const onError = vi.fn();
      await expect(init({ publicKey: "pk_test_demo", userId: "u1", onError })).rejects.toThrow("Network error");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "config_fetch_failed", recoverable: true }));
    });

    it("serves stale cache when refresh fails", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      reset();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Timeout")));
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(true);
    });

    it("handles HTTP 500 response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      await expect(init({ publicKey: "pk_test_demo", userId: "u1" })).rejects.toThrow("HTTP 500");
    });

    it("handles slow network (fetch resolves after delay)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(mockConfig) }), 100);
      })));
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      expect(gate("upgrade_pro").shown).toBe(true);
    });

    it("handles corrupted localStorage cache", async () => {
      localStorage.setItem("tranzmit:config:pk_test_demo", "not-json{{{");
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      expect(gate("upgrade_pro").shown).toBe(true);
    });

    it("handles localStorage quota exceeded", async () => {
      const origSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceeded"); });
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      expect(gate("upgrade_pro").shown).toBe(true);
      vi.spyOn(localStorage, "setItem").mockImplementation(origSetItem);
    });

    it("handles missing localStorage (SSR/Node context)", async () => {
      const orig = globalThis.localStorage;
      Object.defineProperty(globalThis, "localStorage", {
        get: () => { throw new Error("localStorage is not defined"); },
        configurable: true,
      });
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      expect(gate("upgrade_pro").shown).toBe(true);
      Object.defineProperty(globalThis, "localStorage", { value: orig, configurable: true });
    });

    it("multiple init calls don't double-fetch", async () => {
      const p1 = init({ publicKey: "pk_test_demo", userId: "u1" });
      reset();
      const p2 = init({ publicKey: "pk_test_demo", userId: "u1" });
      await Promise.all([p1, p2]);
      // fetch called twice (two separate init sessions), not more
      expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Gate stress", () => {
    it("gate before init returns gracefully (no crash)", () => {
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(false);
      expect(typeof result.dismiss).toBe("function");
      result.dismiss(); // should not throw
    });

    it("rapid gate calls for same trigger (deduplication)", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const r1 = gate("upgrade_pro");
      const r2 = gate("upgrade_pro");
      expect(r1.shown).toBe(true);
      expect(r2.shown).toBe(true);
      // should only have one paywall in DOM
      expect(document.querySelectorAll(".tranzmit-paywall").length).toBe(1);
    });

    it("multiple different triggers render independently", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      gate("onboarding");
      expect(document.querySelectorAll(".tranzmit-paywall").length).toBe(2);
    });

    it("dismiss one paywall doesn't affect others", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const r1 = gate("upgrade_pro");
      gate("onboarding");
      r1.dismiss();
      expect(document.querySelectorAll(".tranzmit-paywall").length).toBe(1);
    });

    it("gate with nonexistent trigger is safe", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("totally_fake_trigger_123");
      expect(result.shown).toBe(false);
    });

    it("gate with empty string trigger is safe", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("");
      expect(result.shown).toBe(false);
    });

    it("gate with disabled trigger returns shown:false", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("disabled_one");
      expect(result.shown).toBe(false);
      expect(document.querySelector(".tranzmit-paywall")).toBeNull();
    });

    it("calling dismiss() multiple times is safe (idempotent)", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("upgrade_pro");
      result.dismiss();
      result.dismiss();
      result.dismiss();
      expect(document.querySelector(".tranzmit-paywall")).toBeNull();
    });

    it("gate with custom container element", async () => {
      const container = document.createElement("div");
      container.id = "paywall-root";
      document.body.appendChild(container);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro", { container });
      expect(container.querySelector(".tranzmit-paywall")).not.toBeNull();
      expect(document.body.children.length).toBe(1); // only the container
    });

    it("CTA fires callback with correct product", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const onCTA = vi.fn();
      gate("upgrade_pro", { onCTA });
      const buttons = document.querySelectorAll(".tranzmit-cta");
      (buttons[0] as HTMLElement).click();
      expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro_monthly", name: "Pro Monthly" }));
    });

    it("onDismiss fires and removes paywall from DOM", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const onDismiss = vi.fn();
      gate("upgrade_pro", { onDismiss });
      const close = document.querySelector(".tranzmit-close") as HTMLElement;
      close.click();
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".tranzmit-paywall")).toBeNull();
    });

    it("clicking overlay background dismisses", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const onDismiss = vi.fn();
      gate("upgrade_pro", { onDismiss });
      const overlay = document.querySelector(".tranzmit-paywall") as HTMLElement;
      overlay.click();
      expect(onDismiss).toHaveBeenCalled();
    });

    it("onImpression fires exactly once per gate", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const onImpression = vi.fn();
      gate("upgrade_pro", { onImpression });
      expect(onImpression).toHaveBeenCalledTimes(1);
    });
  });

  describe("Custom HTML paywall stress", () => {
    it("renders custom layout with interpolation", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("custom_paywall");
      expect(customRoot().querySelector(".custom h1")?.textContent).toBe("Go Pro");
    });

    it("custom CTA binding works", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const onCTA = vi.fn();
      gate("custom_paywall", { onCTA });
      const btn = customRoot().querySelector("[data-tranzmit-cta]") as HTMLElement;
      btn.click();
      expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro" }));
    });

    it("custom dismiss binding works", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const onDismiss = vi.fn();
      gate("custom_paywall", { onDismiss });
      const dismiss = customRoot().querySelector("[data-tranzmit-dismiss]") as HTMLElement;
      dismiss.click();
      expect(onDismiss).toHaveBeenCalled();
    });

    it("handles empty customHtml gracefully (falls back to structured)", async () => {
      const config = structuredClone(mockConfig);
      config.placements.custom_paywall.spec.customHtml = "";
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("custom_paywall");
      // empty customHtml falls back to structured renderer
      expect(document.querySelector(".tranzmit-paywall")).not.toBeNull();
    });

    it("escapes XSS in template variables", async () => {
      const config = structuredClone(mockConfig);
      config.placements.custom_paywall.spec.headline = '<img src=x onerror=alert(1)>';
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("custom_paywall");
      expect(document.querySelector("img")).toBeNull();
      expect(customRoot().querySelector(".custom h1")?.textContent).toContain("<img");
    });
  });

  describe("Events stress", () => {
    it("track works before init (no crash, events dropped)", () => {
      track("some_event", { key: "value" });
      // no throw
    });

    it("reportConversion queues event", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      reportConversion({ trigger: "upgrade_pro", revenue: 999, currency: "USD" });
      // no crash
    });

    it("rapid-fire tracking doesn't crash", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      for (let i = 0; i < 100; i++) {
        track("rapid_event_" + i, { index: i });
      }
      // flush should batch
      flush();
      expect(fetch).toHaveBeenCalled();
    });

    it("flush uses sendBeacon on page hide", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      track("before_hide");
      const beaconMock = vi.fn().mockReturnValue(true);
      vi.stubGlobal("navigator", { sendBeacon: beaconMock });
      flush(true);
      expect(beaconMock).toHaveBeenCalled();
    });
  });

  describe("Framework compatibility", () => {
    it("works in shadow DOM (custom container)", async () => {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const container = document.createElement("div");
      shadow.appendChild(container);
      document.body.appendChild(host);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro", { container });
      expect(container.querySelector(".tranzmit-paywall")).not.toBeNull();
    });

    it("works when document.body has existing content", async () => {
      document.body.innerHTML = '<div id="app"><header>Nav</header><main>Content</main></div>';
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      expect(document.querySelector("#app")).not.toBeNull();
      expect(document.querySelector(".tranzmit-paywall")).not.toBeNull();
    });

    it("doesn't interfere with existing event listeners", async () => {
      const clickHandler = vi.fn();
      document.body.addEventListener("click", clickHandler);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      // click inside the card should not propagate to body
      const card = document.querySelector(".tranzmit-paywall-card") as HTMLElement;
      card?.click();
      // but clicking body itself should still work after dismiss
      const result = gate("upgrade_pro");
      result.dismiss();
      document.body.click();
      expect(clickHandler).toHaveBeenCalled();
    });

    it("paywall gets highest z-index (above modals)", async () => {
      const modal = document.createElement("div");
      modal.style.zIndex = "9999";
      modal.style.position = "fixed";
      document.body.appendChild(modal);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      const paywall = document.querySelector(".tranzmit-paywall") as HTMLElement;
      expect(parseInt(paywall.style.zIndex)).toBeGreaterThan(9999);
    });

    it("works with CSP-friendly inline styles (no style tags for structured)", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      // structured paywall uses inline styles, no <style> tags
      const paywall = document.querySelector(".tranzmit-paywall") as HTMLElement;
      expect(paywall.style.position).toBe("fixed");
    });

    it("handles re-init after SPA navigation", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      // simulate SPA navigation: clear body, re-init
      document.body.innerHTML = "";
      reset();
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(true);
      expect(document.querySelectorAll(".tranzmit-paywall").length).toBe(1);
    });

    it("handles concurrent init + gate race condition", async () => {
      const initPromise = init({ publicKey: "pk_test_demo", userId: "u1" });
      // gate before init resolves
      const earlyResult = gate("upgrade_pro");
      expect(earlyResult.shown).toBe(false);
      await initPromise;
      // now gate should work
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(true);
    });
  });

  describe("Edge cases: config shapes", () => {
    it("handles config with empty placements", async () => {
      mockFetch({ version: "1.0.0", placements: {}, assets: {}, ttl: 300 });
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("anything");
      expect(result.shown).toBe(false);
    });

    it("handles config with null spec fields", async () => {
      const config = structuredClone(mockConfig);
      config.placements.upgrade_pro.spec.features = undefined as any;
      config.placements.upgrade_pro.spec.subheadline = undefined as any;
      config.placements.upgrade_pro.spec.secondaryCta = undefined as any;
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const result = gate("upgrade_pro");
      expect(result.shown).toBe(true);
    });

    it("handles product with zero price", async () => {
      const config = structuredClone(mockConfig);
      config.placements.upgrade_pro.spec.products = [
        { id: "free", name: "Free Tier", price: { amount: 0, currency: "USD" } },
      ];
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      const price = document.querySelector(".tranzmit-product-price");
      expect(price?.textContent).toContain("0.00");
    });

    it("handles non-USD currency", async () => {
      const config = structuredClone(mockConfig);
      config.placements.upgrade_pro.spec.products = [
        { id: "pro", name: "Pro", price: { amount: 2499, currency: "EUR", interval: "month" } },
      ];
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      const price = document.querySelector(".tranzmit-product-price");
      expect(price?.textContent).toMatch(/24[.,]99/);
    });

    it("handles very long headline without overflow", async () => {
      const config = structuredClone(mockConfig);
      config.placements.upgrade_pro.spec.headline = "A".repeat(200);
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      const headline = document.querySelector(".tranzmit-headline");
      expect(headline?.textContent?.length).toBe(200);
    });

    it("handles many products (10+)", async () => {
      const config = structuredClone(mockConfig);
      config.placements.upgrade_pro.spec.products = Array.from({ length: 12 }, (_, i) => ({
        id: `plan_${i}`,
        name: `Plan ${i}`,
        price: { amount: (i + 1) * 500, currency: "USD", interval: "month" },
      }));
      mockFetch(config);
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      gate("upgrade_pro");
      expect(document.querySelectorAll(".tranzmit-product").length).toBe(12);
    });
  });

  describe("Trigger point clarity", () => {
    it("only fires for exact trigger match (no partial matching)", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      expect(gate("upgrade").shown).toBe(false);
      expect(gate("upgrade_pro_extra").shown).toBe(false);
      expect(gate("UPGRADE_PRO").shown).toBe(false); // case-sensitive
      expect(gate("upgrade_pro").shown).toBe(true);
    });

    it("trigger is developer-controlled, fires only when gate() called", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      // nothing shows until gate is explicitly called
      expect(document.querySelector(".tranzmit-paywall")).toBeNull();
      gate("upgrade_pro");
      expect(document.querySelector(".tranzmit-paywall")).not.toBeNull();
    });

    it("same trigger can be gated, dismissed, then gated again", async () => {
      await init({ publicKey: "pk_test_demo", userId: "u1" });
      const r1 = gate("upgrade_pro");
      expect(r1.shown).toBe(true);
      r1.dismiss();
      expect(document.querySelector(".tranzmit-paywall")).toBeNull();
      const r2 = gate("upgrade_pro");
      expect(r2.shown).toBe(true);
      expect(document.querySelector(".tranzmit-paywall")).not.toBeNull();
    });
  });
});
