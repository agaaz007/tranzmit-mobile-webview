import type { ConfigResponse, PaywallSpec } from "@tranzmit/shared";

export const baseSpec: PaywallSpec = {
  renderer: "webview",
  templateId: "test_paywall",
  revision: "test-1",
  cacheKey: "test_paywall:test-1",
  header: {
    title: "Unlock Pro",
    subtitle: "Get unlimited exports",
  },
  document: {
    html: `
      <main class="paywall">
        <h1>Unlock Pro</h1>
        <p>Get unlimited exports</p>
        <button data-tranzmit-action="cta" data-product-id="pro_monthly">Start Free Trial</button>
        <button data-tranzmit-action="dismiss">Maybe later</button>
      </main>
    `,
    css: ".paywall{font-family:Inter,sans-serif}",
  },
  bridge: { version: 1, allowedActions: ["cta", "dismiss", "open_url"] },
  cta: "Start Free Trial",
  secondaryCta: "Maybe later",
  theme: "light",
  features: ["Unlimited exports", "Priority support"],
  products: [
    {
      id: "pro_monthly",
      name: "Pro Monthly",
      price: { amount: 999, currency: "USD", interval: "month" },
      badge: "Popular",
      highlighted: true,
    },
    {
      id: "pro_yearly",
      name: "Pro Yearly",
      price: { amount: 9999, currency: "USD", interval: "year" },
    },
  ],
};

export const mockConfig: ConfigResponse = {
  version: "1.0.0",
  placements: {
    upgrade_pro: {
      trigger: "upgrade_pro",
      enabled: true,
      variantId: "var_a",
      spec: baseSpec,
    },
  },
  assets: {},
  ttl: 300,
};
