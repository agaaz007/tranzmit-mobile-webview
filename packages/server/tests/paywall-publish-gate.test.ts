import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Integrity } from "../src/webview-documents.js";

const store = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../src/config-store.js", () => ({
  database: { query: store.query },
  getEnvironmentPaywall: vi.fn(),
  withTransaction: store.withTransaction,
}));

const HTML = '<main><button class="cta" data-tranzmit-action="cta" data-product-id="pro_yearly">Go</button></main>';

function content(): Record<string, unknown> {
  return {
    renderer: "webview",
    document: { html: HTML, integrity: sha256Integrity(HTML) },
    cta: { text: "Go" },
    dismiss: { enabled: true },
  };
}

const PRODUCTS = [{ id: "pro_yearly", name: "Pro", price: "₹999/year" }];

interface Scenario {
  preflight: Record<string, unknown> | null;
  pointerMoved: string[];
  audits: string[];
}

function mockDatabase(preflight: Record<string, unknown> | null): Scenario {
  const scenario: Scenario = { preflight, pointerMoved: [], audits: [] };
  store.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM paywall_environment_bindings b\s+JOIN clients/i.test(sql)) {
      return {
        rows: [{
          id: "binding-live",
          client_id: "client-live",
          project_key: "hiastro",
          paywall_id: "paywall-trial",
          current_release_id: "release-current",
          public_key: "pk_live",
          environment_kind: "live",
          management_status: "editable",
        }],
        rowCount: 1,
      };
    }
    if (/FROM paywall_environment_releases r\s+JOIN paywall_content_revisions/i.test(sql)) {
      return {
        rows: [{
          id: "release-candidate",
          release_number: 4,
          content_revision_id: "content-4",
          products: PRODUCTS,
          checkout: null,
          content: content(),
          content_hash: "content-hash-4",
          document_cache_key: "doc-key",
          document_hash: "doc-hash",
          created_by: "dashboard",
          created_at: "2026-08-24T00:00:00.000Z",
        }],
        rowCount: 1,
      };
    }
    if (/FROM paywall_release_preflights/i.test(sql)) {
      return { rows: scenario.preflight ? [scenario.preflight] : [], rowCount: scenario.preflight ? 1 : 0 };
    }
    if (/UPDATE paywall_environment_bindings/i.test(sql)) {
      scenario.pointerMoved.push(String((params || [])[1]));
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO config_audit_log/i.test(sql)) {
      scenario.audits.push(String((params || [])[4]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return scenario;
}

function passingRow(): Record<string, unknown> {
  return {
    id: "preflight-1",
    status: "pass",
    report: { status: "pass", checks: [] },
    checked_by: "dashboard",
    created_at: "2026-08-24T00:00:00.000Z",
  };
}

beforeEach(() => {
  delete process.env.PAYWALL_PUBLISH_PREFLIGHT;
  store.query.mockReset();
  store.withTransaction.mockReset();
  store.withTransaction.mockImplementation(async (work: (db: { query: typeof store.query }) => Promise<unknown>) => (
    work({ query: store.query })
  ));
});

afterEach(() => {
  delete process.env.PAYWALL_PUBLISH_PREFLIGHT;
});

describe("publish requires a recorded passing check", () => {
  it("refuses to move the pointer for a release that was never validated", async () => {
    const scenario = mockDatabase(null);
    const { publishPaywallRelease } = await import("../src/config-publish.js");

    await expect(publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-current",
      actor: "dashboard",
    })).rejects.toMatchObject({
      status: 428,
      details: { preflight_status: null },
    });
    expect(scenario.pointerMoved).toEqual([]);
    expect(scenario.audits).toEqual([]);
  });

  it("refuses to publish when the recorded verdict failed", async () => {
    const scenario = mockDatabase({ ...passingRow(), status: "fail" });
    const { publishPaywallRelease } = await import("../src/config-publish.js");

    await expect(publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-current",
      actor: "dashboard",
    })).rejects.toMatchObject({ status: 428, details: { preflight_status: "fail" } });
    expect(scenario.pointerMoved).toEqual([]);
  });

  it("publishes when the verdict passed", async () => {
    const scenario = mockDatabase(passingRow());
    const { publishPaywallRelease } = await import("../src/config-publish.js");

    const result = await publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-current",
      actor: "dashboard",
    });
    expect(result).toMatchObject({ current_release_id: "release-candidate", action: "publish" });
    expect(scenario.pointerMoved).toEqual(["release-candidate"]);
    expect(scenario.audits).toEqual(["publish"]);
  });

  it("publishes when the verdict passed with warnings", async () => {
    const scenario = mockDatabase({ ...passingRow(), status: "warn" });
    const { publishPaywallRelease } = await import("../src/config-publish.js");

    await publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-current",
      actor: "dashboard",
    });
    expect(scenario.pointerMoved).toEqual(["release-candidate"]);
  });

  it("never blocks a rollback, which is the way out of a bad publish", async () => {
    const scenario = mockDatabase(null);
    const { publishPaywallRelease } = await import("../src/config-publish.js");

    await publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-current",
      actor: "dashboard",
      action: "rollback",
    });
    expect(scenario.pointerMoved).toEqual(["release-candidate"]);
    expect(scenario.audits).toEqual(["rollback"]);
  });

  it("can be turned off for incident response", async () => {
    process.env.PAYWALL_PUBLISH_PREFLIGHT = "off";
    const scenario = mockDatabase(null);
    const { publishPaywallRelease } = await import("../src/config-publish.js");

    await publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-current",
      actor: "dashboard",
    });
    expect(scenario.pointerMoved).toEqual(["release-candidate"]);
  });
});

describe("preflight fingerprints", () => {
  it("changes when the environment's billing products change", async () => {
    const { productsFingerprint } = await import("../src/config-publish.js");
    expect(productsFingerprint(PRODUCTS, null)).toBe(productsFingerprint([{ ...PRODUCTS[0] }], null));
    expect(productsFingerprint(PRODUCTS, null)).not.toBe(
      productsFingerprint([{ id: "pro_monthly", name: "Pro", price: "₹99/month" }], null)
    );
    expect(productsFingerprint(PRODUCTS, null)).not.toBe(
      productsFingerprint(PRODUCTS, { provider: { planId: "plan_yearly" } })
    );
  });
});
