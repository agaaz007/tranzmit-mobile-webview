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

    expect(result).toEqual({ valid: true, errors: [] });
  });
});
