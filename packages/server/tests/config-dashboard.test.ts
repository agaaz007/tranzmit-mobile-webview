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
});
