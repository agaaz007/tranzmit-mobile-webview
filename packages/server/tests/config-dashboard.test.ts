import { describe, expect, it } from "vitest";
import { serveConfigDashboard } from "../src/routes/config-dashboard.js";
import type { ServerResponse } from "node:http";

function renderDashboard(): string {
  let body = "";
  let res: ServerResponse;
  res = {
    writeHead: () => res,
    end: (chunk?: unknown) => {
      body = String(chunk ?? "");
      return res;
    },
  } as unknown as ServerResponse;

  serveConfigDashboard(res);
  return body;
}

function decodeStandaloneTemplates(html: string): Record<string, string> {
  const match = html.match(/STANDALONE_PAYWALL_HTML_BY_TEMPLATE = JSON\.parse\(decodeBase64Utf8\("([^"]+)"\)\)/);
  expect(match).toBeTruthy();
  return JSON.parse(Buffer.from(match![1], "base64").toString("utf8"));
}

function decodeStandaloneCss(html: string): string {
  const match = html.match(/STANDALONE_PAYWALL_CSS = decodeBase64Utf8\("([^"]+)"\)/);
  expect(match).toBeTruthy();
  return Buffer.from(match![1], "base64").toString("utf8");
}

describe("config dashboard product editing", () => {
  it("exposes billing product ID as an editable paywall field", () => {
    const html = renderDashboard();

    expect(html).toContain("Billing Product ID");
    expect(html).toContain('id="fieldBillingProductId"');
    expect(html).toContain("'fieldBillingProductId'");
  });

  it("hydrates and saves product IDs used by the CTA bridge", () => {
    const html = renderDashboard();

    expect(html).toContain("els.fieldBillingProductId.value = product.id || ''");
    expect(html).toContain("product.id = els.fieldBillingProductId.value.trim() || product.id || 'product'");
    expect(html).toContain('data-product-id="');
  });

  it("keeps the intro offer 24-hour countdown in dashboard templates", () => {
    const html = renderDashboard();
    const templates = decodeStandaloneTemplates(html);
    const css = decodeStandaloneCss(html);

    expect(templates.influish_intro_offer).toContain("countdown-trigger");
    expect(templates.influish_intro_offer).toContain("Offer expires in:");
    expect(templates.influish_intro_offer).toContain("tranzmit:intro-offer-expiry");
    expect(css).toContain(".countdown-trigger");
  });

  it("serves valid inline dashboard JavaScript", () => {
    const html = renderDashboard();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    expect(() => new Function(match![1])).not.toThrow();
  });
});
