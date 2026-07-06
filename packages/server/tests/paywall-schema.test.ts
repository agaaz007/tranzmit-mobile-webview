import { describe, expect, it } from "vitest";

import { validatePaywallSpec } from "../src/paywall-schema.js";

describe("paywall spec schema", () => {
  it("allows localization metadata for tokenized WebView documents", () => {
    const result = validatePaywallSpec({
      renderer: "webview",
      document: { html: "<main><h1>{{headline}}</h1></main>" },
      products: [{ id: "pro", name: "Pro", price: "₹999/year" }],
      cta: { text: "Continue" },
      dismiss: { enabled: true },
      localization: {
        defaultLocale: "hi-en",
        translations: {
          "hi-en": { headline: "Pro unlock karein" },
          en: { headline: "Unlock Pro" },
        },
      },
    });

    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
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
