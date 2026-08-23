import { describe, expect, it } from "vitest";

function publishableSpec(html: string, productId = "voice_text_pack") {
  return {
    renderer: "webview",
    document: { html },
    products: [{ id: productId, name: "Voice Pack", price: "₹1" }],
    cta: { text: "Continue" },
    dismiss: { enabled: true },
  };
}

function legacySpec(name: string, id = "legacy-id") {
  return {
    id,
    workspace_id: "client-test",
    name,
    spec: {},
    status: "active",
    version: 1,
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
    created_by: null,
  };
}

describe("V2 backfill paywall identity mapping", () => {
  it("maps HiAstro marriage-02 to trial-reminder and marriage-03 to marriage", async () => {
    const { __private } = await import("../src/backfill-v2.js");

    expect(__private.logicalPaywallKey(
      "hiastro",
      legacySpec("Response_HiAstro marriage-02") as any
    )).toBe("trial-reminder");
    expect(__private.logicalPaywallKey(
      "hiastro",
      legacySpec("HiAstro marriage -03") as any
    )).toBe("marriage");
  });

  it("returns the same stable identity on repeated backfill mapping passes", async () => {
    const { __private } = await import("../src/backfill-v2.js");
    const input = legacySpec("Response_marriage-02", "spec-marriage-02") as any;

    expect([
      __private.logicalPaywallKey("hiastro", input),
      __private.logicalPaywallKey("hiastro", input),
    ]).toEqual(["trial-reminder", "trial-reminder"]);
  });

  it("keeps the live standalone general default separate from the general-01 variant", async () => {
    const { __private } = await import("../src/backfill-v2.js");

    expect(__private.logicalPaywallKey(
      "hiastro",
      legacySpec("HiAstro general-01", "86bfd043-243e-4331-814e-e0a2722cbb32") as any
    )).toBe("general-default");
    expect(__private.logicalPaywallKey(
      "hiastro",
      legacySpec("Response_general-01", "22dd13df-d8f3-4fdc-9586-6f5392c0be5c") as any
    )).toBe("general-01");
  });

  it("fails closed when equal-priority releases with different payloads share a binding", async () => {
    const { __private } = await import("../src/backfill-v2.js");
    const current = {
      releaseId: "release-a",
      paywallId: "paywall",
      payloadHash: "hash-a",
      priority: 3,
      source: "spec-a",
    };

    expect(() => __private.preferPointerChoice(current, {
      ...current,
      releaseId: "release-b",
      payloadHash: "hash-b",
      source: "spec-b",
    })).toThrow("equal priority but different payloads");
  });

  it("serves referenced draft specs but never archived specs", async () => {
    const { __private } = await import("../src/backfill-v2.js");

    expect(__private.isLegacySpecServable("active")).toBe(true);
    expect(__private.isLegacySpecServable("draft")).toBe(true);
    expect(__private.isLegacySpecServable("archived")).toBe(false);
  });
});

describe("V2 legacy-spec compatibility normalization", () => {
  it("copies exact hi-en localization to canonical hi-Latn without mutating legacy JSON", async () => {
    const { normalizeLegacyPaywallSpecForV2, validatePaywallSpec } = await import("../src/paywall-schema.js");
    const input = {
      ...publishableSpec("<main lang=\"{{html_lang}}\">{{headline}}</main>"),
      metadata: { defaultLocale: "hi-en" },
      localization: {
        defaultLocale: "hi-en",
        translations: {
          en: { html_lang: "en", headline: "Unlock Pro" },
          "hi-en": { html_lang: "hi-en", headline: "Pro unlock karein" },
        },
      },
    };
    const before = structuredClone(input);

    const normalized = normalizeLegacyPaywallSpecForV2(input);

    expect(input).toEqual(before);
    expect(normalized.localization).toEqual({
      defaultLocale: "hi-Latn",
      translations: {
        en: { html_lang: "en", headline: "Unlock Pro" },
        "hi-Latn": { html_lang: "hi-Latn", headline: "Pro unlock karein" },
      },
    });
    expect(normalized.metadata.defaultLocale).toBe("hi-Latn");
    expect(validatePaywallSpec(normalized).valid).toBe(true);
  });

  it("deduplicates an equal hi-Latn map and refuses to hide conflicting copy", async () => {
    const { normalizeLegacyPaywallSpecForV2, validatePaywallSpec } = await import("../src/paywall-schema.js");
    const equalCopy = { headline: "Pro unlock karein" };
    const equal = normalizeLegacyPaywallSpecForV2({
      ...publishableSpec("<main>{{headline}}</main>"),
      localization: {
        defaultLocale: "hi-en",
        translations: { "hi-en": equalCopy, "hi-Latn": equalCopy },
      },
    });
    expect(equal.localization.translations).toEqual({
      "hi-Latn": { headline: "Pro unlock karein" },
    });
    expect(validatePaywallSpec(equal).valid).toBe(true);

    const conflicting = {
      ...publishableSpec("<main>{{headline}}</main>"),
      localization: {
        defaultLocale: "hi-en",
        translations: {
          "hi-en": { headline: "Legacy copy" },
          "hi-Latn": { headline: "Different copy" },
        },
      },
    };
    const refused = normalizeLegacyPaywallSpecForV2(conflicting);
    expect(refused).toEqual(conflicting);
    expect(validatePaywallSpec(refused).valid).toBe(false);
  });
});

describe("V2 CTA Billing Product ID validation", () => {
  it("ignores template identity attributes on non-CTA containers", async () => {
    const { validatePublishableSpec } = await import("../src/config-publish.js");

    expect(() => validatePublishableSpec(publishableSpec(
      '<main data-product-id="hiastro-marriage-3-shifts-paywall"><button data-tranzmit-action="cta">Continue</button></main>'
    ))).not.toThrow();
  });

  it("normalizes escaped CTA attributes and validates their product ID", async () => {
    const { ConfigError, validatePublishableSpec } = await import("../src/config-publish.js");
    const html = String.raw`<script>const markup = '<button data-product-id=\"voice_text_pack\" data-tranzmit-action=\"cta\">Continue</button>';</script>`;

    expect(() => validatePublishableSpec(publishableSpec(html))).not.toThrow();
    let error: unknown;
    try {
      validatePublishableSpec(publishableSpec(html, "different-product"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as InstanceType<typeof ConfigError>).details).toEqual({
      errors: [expect.objectContaining({
        keyword: "productReference",
        message: 'Document references unknown Billing Product ID "voice_text_pack"',
      })],
    });
  });

  it("still rejects an ordinary action-bound unknown product regardless of attribute order", async () => {
    const { ConfigError, validatePublishableSpec } = await import("../src/config-publish.js");

    let error: unknown;
    try {
      validatePublishableSpec(publishableSpec(
        '<button data-product-id="unknown" type="button" data-tranzmit-action="cta">Continue</button>'
      ));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as InstanceType<typeof ConfigError>).details).toEqual({
      errors: [expect.objectContaining({
        keyword: "productReference",
        message: 'Document references unknown Billing Product ID "unknown"',
      })],
    });
  });
});
