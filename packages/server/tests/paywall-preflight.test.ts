import { describe, expect, it } from "vitest";
import {
  REQUIRED_PROBE_WIDTHS,
  runPaywallPreflight,
  type ViewportAudit,
} from "../src/paywall-preflight.js";
import { sha256Integrity } from "../src/webview-documents.js";

const HTML = [
  "<!doctype html><html><head>",
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<style>.tz-scroll{overflow:auto}</style>",
  "</head><body>",
  '<main class="tz-template"><div class="tz-scroll"><h1>{{headline}}</h1></div>',
  '<footer class="tz-footer"><button class="cta" data-tranzmit-action="cta" data-product-id="pro_yearly">{{cta}}</button></footer>',
  "</main></body></html>",
].join("");

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    renderer: "webview",
    document: { html: HTML, integrity: sha256Integrity(HTML) },
    localization: {
      defaultLocale: "en",
      translations: {
        en: { headline: "Unlock Pro", cta: "Continue" },
        "hi-Latn": { headline: "Pro unlock karein", cta: "Aage badhein" },
      },
    },
    products: [{ id: "pro_yearly", name: "Pro yearly", price: "₹999/year" }],
    cta: { text: "Continue" },
    dismiss: { enabled: true },
    ...overrides,
  };
}

// The harness matrix: every gated width, once per configured locale.
const DEVICES = [
  { id: "se1", label: "iPhone SE 1", width: 320, height: 568 },
  { id: "android360", label: "Android", width: 360, height: 640 },
  { id: "se3", label: "iPhone SE 3", width: 375, height: 667 },
  { id: "i14", label: "iPhone 14", width: 390, height: 844 },
  { id: "android412", label: "Android", width: 412, height: 915 },
  { id: "max", label: "16 Pro Max", width: 430, height: 932 },
  { id: "ipad", label: "iPad", width: 768, height: 1024 },
];

function probes(
  overrides: Partial<ViewportAudit> = {},
  locales: string[] = ["en", "hi-Latn"]
): ViewportAudit[] {
  const audits: ViewportAudit[] = [];
  for (const locale of locales) {
    for (const device of DEVICES) {
      audits.push({
        id: `${locale}:${device.id}`,
        deviceId: device.id,
        label: device.label,
        locale,
        width: device.width,
        height: device.height,
        passed: true,
        failures: [],
        ...overrides,
      });
    }
  }
  return audits;
}

function check(report: ReturnType<typeof runPaywallPreflight>, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`No check ${id} in ${report.checks.map((entry) => entry.id).join(", ")}`);
  return found;
}

describe("paywall publish preflight", () => {
  it("passes a complete paywall measured at every device size", () => {
    const report = runPaywallPreflight({ spec: spec(), environmentKind: "test", viewports: probes() });
    expect(report.status).toBe("pass");
    expect(report.tokens).toEqual(["cta", "headline"]);
    expect(report.productIds).toEqual(["pro_yearly"]);
  });

  it("refuses to pass a paywall that was never rendered", () => {
    const report = runPaywallPreflight({ spec: spec(), environmentKind: "test" });
    expect(report.status).toBe("fail");
    const coverage = check(report, "viewport-coverage");
    expect(coverage.status).toBe("fail");
    for (const width of REQUIRED_PROBE_WIDTHS) {
      expect(coverage.items?.join(" ")).toContain(String(width));
    }
  });

  it("refuses to pass when a required width was not measured", () => {
    const partial = probes().filter((probe) => probe.width !== 320);
    const report = runPaywallPreflight({ spec: spec(), environmentKind: "test", viewports: partial });
    expect(check(report, "viewport-coverage").status).toBe("fail");
  });

  it("requires every configured locale to be rendered, not just the default", () => {
    const englishOnly = probes({}, ["en"]);
    const report = runPaywallPreflight({ spec: spec(), environmentKind: "test", viewports: englishOnly });
    const coverage = check(report, "viewport-coverage");
    expect(coverage.status).toBe("fail");
    expect(coverage.items?.join(" ")).toContain("hi-Latn");
    expect(coverage.items?.join(" ")).not.toContain("en:");
  });

  it("reports the harness failure for the exact locale and device that failed", () => {
    const audits = probes().map((audit) => (
      audit.width === 320 && audit.locale === "hi-Latn"
        ? { ...audit, passed: false, failures: ["horizontal overflow: 412px > 320px", "2 painted text overflow(s)"] }
        : audit
    ));
    const report = runPaywallPreflight({ spec: spec(), environmentKind: "test", viewports: audits });
    expect(report.status).toBe("fail");
    const rendering = check(report, "viewport-rendering");
    expect(rendering.status).toBe("fail");
    expect(rendering.detail).toContain("1 of 14 renders failed");
    const items = rendering.items?.join(" ") || "";
    expect(items).toContain("hi-Latn");
    expect(items).toContain("320px");
    expect(items).toContain("horizontal overflow: 412px > 320px");
    expect(items).toContain("2 painted text overflow(s)");
  });

  it("fails a render that timed out instead of treating it as clean", () => {
    const audits = probes().map((audit) => (
      audit.deviceId === "se1" ? { ...audit, passed: false, failures: [], timedOut: true } : audit
    ));
    const report = runPaywallPreflight({ spec: spec(), environmentKind: "test", viewports: audits });
    expect(check(report, "viewport-rendering").items?.join(" ")).toContain("never reported back");
  });

  it("fails a bridge action the SDK cannot route, such as a reintroduced back control", () => {
    const html = HTML.replace(
      '<footer class="tz-footer">',
      '<footer class="tz-footer"><button data-tranzmit-action="back" aria-label="{{back_aria}}">Back</button>'
    );
    const report = runPaywallPreflight({
      spec: spec({ document: { html, integrity: sha256Integrity(html) } }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(report.status).toBe("fail");
    const bridge = check(report, "bridge-actions");
    expect(bridge.status).toBe("fail");
    expect(bridge.items?.join(" ")).toContain('data-tranzmit-action="back"');
  });

  it("fails a paywall that declares the back control forbidden when one returns", () => {
    const html = HTML.replace("<h1>", '<span aria-label="{{back_aria}}"></span><h1>');
    const report = runPaywallPreflight({
      spec: spec({
        document: { html, integrity: sha256Integrity(html) },
        metadata: { forbidBackAction: "true" },
      }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "bridge-actions").items?.join(" ")).toContain("forbids a back control");
  });

  it("fails a live paywall still bound to the test environment's billing product", () => {
    const report = runPaywallPreflight({
      spec: spec(),
      environmentKind: "live",
      testEnvironmentProductIds: ["pro_yearly"],
      viewports: probes(),
    });
    expect(report.status).toBe("fail");
    expect(check(report, "billing").items?.join(" ")).toContain("test environment's Billing Product ID");
  });

  it("allows the same product ID on a test environment", () => {
    const report = runPaywallPreflight({
      spec: spec(),
      environmentKind: "test",
      testEnvironmentProductIds: ["pro_yearly"],
      viewports: probes(),
    });
    expect(check(report, "billing").status).toBe("pass");
  });

  it("fails a placeholder billing product ID", () => {
    const report = runPaywallPreflight({
      spec: spec({ products: [{ id: "REPLACE_ME", name: "Pro", price: "₹999" }] }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "billing").status).toBe("fail");
    expect(check(report, "billing").items?.join(" ")).toContain("placeholder");
  });

  it("fails when the document's CTA points at an unknown product", () => {
    const html = HTML.replace('data-product-id="pro_yearly"', 'data-product-id="pro_monthly"');
    const report = runPaywallPreflight({
      spec: spec({ document: { html, integrity: sha256Integrity(html) } }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "billing").status).toBe("fail");
    expect(check(report, "billing").items?.join(" ")).toContain("pro_monthly");
  });

  it("fails a locale that is missing a token the document uses", () => {
    const report = runPaywallPreflight({
      spec: spec({
        localization: {
          defaultLocale: "en",
          translations: {
            en: { headline: "Unlock Pro", cta: "Continue" },
            "hi-Latn": { headline: "Pro unlock karein" },
          },
        },
      }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "localization").status).toBe("fail");
    expect(check(report, "localization").items?.join(" ")).toContain("cta");
  });

  it("fails an integrity hash that does not describe the uploaded HTML", () => {
    const report = runPaywallPreflight({
      spec: spec({ document: { html: HTML, integrity: "sha256-not-the-real-hash" } }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "document").status).toBe("fail");
  });

  it("fails a document with no CTA bridge at all", () => {
    const html = HTML.replace(' data-tranzmit-action="cta"', "");
    const report = runPaywallPreflight({
      spec: spec({ document: { html, integrity: sha256Integrity(html) } }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "cta-bridge").status).toBe("fail");
  });

  it("fails relative assets that would resolve to nothing on device", () => {
    const html = HTML.replace("<h1>", '<img src="assets/hero.png"><h1>');
    const report = runPaywallPreflight({
      spec: spec({ document: { html, integrity: sha256Integrity(html) } }),
      environmentKind: "test",
      viewports: probes(),
    });
    expect(check(report, "assets").status).toBe("fail");
    expect(check(report, "assets").items?.join(" ")).toContain("assets/hero.png");
  });

  it("warns about authoring rules that cause the layouts it cannot see", () => {
    const html = HTML.replace("<style>", "<style>.card{width:600px}.screen{height:100vh}");
    const report = runPaywallPreflight({
      spec: spec({ document: { html, integrity: sha256Integrity(html) } }),
      environmentKind: "test",
      viewports: probes(),
    });
    const responsive = check(report, "responsive-source");
    expect(responsive.status).toBe("warn");
    expect(responsive.items?.join(" ")).toContain("100vh");
    expect(responsive.items?.join(" ")).toContain("600px");
    expect(report.status).toBe("warn");
  });
});
