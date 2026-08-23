import { describe, expect, it } from "vitest";

import { validatePaywallSpec } from "../src/paywall-schema.js";

describe("paywall spec schema", () => {
  function validSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      renderer: "webview",
      document: { html: "<main>Upgrade</main>" },
      products: [{ id: "pro", name: "Pro", price: "₹999/year" }],
      cta: { text: "Continue" },
      dismiss: { enabled: true },
      ...overrides,
    };
  }

  it("allows exact canonical localization tags for tokenized WebView documents", () => {
    const result = validatePaywallSpec(validSpec({
      document: { html: "<main><h1>{{headline}}</h1></main>" },
      localization: {
        defaultLocale: "hi-Latn",
        translations: {
          "hi-Latn": { headline: "Pro unlock karein" },
          hi: { headline: "प्रो अनलॉक करें" },
          en: { headline: "Unlock Pro" },
        },
      },
    }));

    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("rejects non-canonical or unregistered locale tags", () => {
    for (const locale of ["hi-en", "hi-EN", "hi-latn"]) {
      const result = validatePaywallSpec(validSpec({
        document: { html: "<main><h1>{{headline}}</h1></main>" },
        localization: {
          defaultLocale: locale,
          translations: { [locale]: { headline: "Pro unlock karein" } },
        },
      }));
      expect(result.valid, locale).toBe(false);
      expect(result.errors.some((error) => error.keyword === "locale"), locale).toBe(true);
    }
  });

  it("accepts the SDK security and checkout contract", () => {
    const result = validatePaywallSpec(validSpec({
      security: {
        allowedOrigins: ["https://paywalls.tranzmit.com"],
        externalUrlHosts: ["billing.example.test"],
        externalUrlSchemes: ["https", "upi"],
      },
      checkout: {
        provider: {
          planId: "plan_yearly",
          mandate: { maxAmount: 15_000, recurring: true },
        },
        ui: {
          enabled: true,
          showToggle: true,
          appPriority: ["phonepe", "gpay", "net.one97.paytm"],
          defaultApp: "gpay",
          maxVisibleApps: 5,
          iconStyle: "tile",
          fallbackToPlainCta: true,
        },
      },
    }));

    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("rejects wildcard or path-based security allowlist entries", () => {
    const result = validatePaywallSpec(validSpec({
      security: {
        allowedOrigins: ["https://*.example.com/path"],
        externalUrlHosts: ["https://billing.example.test"],
        externalUrlSchemes: ["HTTPS"],
      },
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(expect.arrayContaining([
      "/security/allowedOrigins/0",
      "/security/externalUrlHosts/0",
      "/security/externalUrlSchemes/0",
    ]));
  });

  it("rejects malformed checkout UI values", () => {
    const result = validatePaywallSpec(validSpec({
      checkout: {
        ui: {
          appPriority: ["bad id"],
          defaultApp: "x".repeat(65),
          maxVisibleApps: 13,
          iconStyle: "square",
          unexpected: true,
        },
      },
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(expect.arrayContaining([
      "/checkout/ui",
      "/checkout/ui/appPriority/0",
      "/checkout/ui/defaultApp",
      "/checkout/ui/maxVisibleApps",
      "/checkout/ui/iconStyle",
    ]));
  });

  // Size guardrails: 271-290KB documents (base64 PNGs in the html) caused the
  // 2026-07-06 cellular-timeout incident. These pin the warn/reject bands so a
  // giant document can never be stored silently again.
  function specWithDocumentBytes(bytes: number): Record<string, unknown> & {
    document: { html: string; css?: string };
  } {
    return {
      renderer: "webview",
      document: { html: `<main>${"x".repeat(Math.max(0, bytes - 13))}</main>` },
      products: [{ id: "pro", name: "Pro", price: "₹999/year" }],
      cta: { text: "Continue" },
      dismiss: { enabled: true },
    };
  }

  it("accepts a lean document with no warnings", () => {
    const result = validatePaywallSpec(specWithDocumentBytes(30_000));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("warns on documents over 100KB but still accepts them", () => {
    const result = validatePaywallSpec(specWithDocumentBytes(150_000));
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ path: "/document", keyword: "documentSizeWarning" });
    expect(result.warnings[0].message).toContain("cellular");
  });

  it("rejects documents over 512KB with an actionable error", () => {
    const result = validatePaywallSpec(specWithDocumentBytes(600_000));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: "/document", keyword: "maxDocumentBytes" });
    expect(result.errors[0].message).toContain("WebP");
  });

  it("counts html+css+js together toward the limits", () => {
    const spec = specWithDocumentBytes(60_000);
    spec.document.css = "y".repeat(60_000);
    const result = validatePaywallSpec(spec);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});
