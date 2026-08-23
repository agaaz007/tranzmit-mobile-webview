import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "../src/config-store.js";
import {
  hashDocument,
  sha256Integrity,
  webViewDocumentPayload,
} from "../src/webview-documents.js";

const API_BASE_URL = "https://api.example.com";
const originalPublicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;

const store = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../src/config-store.js", () => ({
  database: { query: store.query },
  getEnvironmentPaywall: vi.fn(),
  withTransaction: store.withTransaction,
}));

type JsonRecord = Record<string, any>;

const completeProduct: JsonRecord = {
  id: "pro_yearly",
  name: "Annual Pro",
  description: "Full access for one year",
  price: { amount: 99900, currency: "INR", interval: "year" },
  originalPrice: "₹1,499/year",
  badge: "Best value",
  features: ["Unlimited reports", "Priority support"],
  isDefault: true,
  metadata: { campaign: "marriage", source: "app" },
  highlighted: true,
};

beforeEach(() => {
  store.query.mockReset();
  store.withTransaction.mockReset();
});

afterEach(() => {
  if (originalPublicApiBaseUrl === undefined) {
    delete process.env.PUBLIC_API_BASE_URL;
  } else {
    process.env.PUBLIC_API_BASE_URL = originalPublicApiBaseUrl;
  }
});

describe("V2 legacy parity product comparison", () => {
  it.each([
    ["id", (product: JsonRecord) => { product.id = "pro_monthly"; }],
    ["name", (product: JsonRecord) => { product.name = "Monthly Pro"; }],
    ["description", (product: JsonRecord) => { product.description = "Different terms"; }],
    ["price", (product: JsonRecord) => { product.price.amount = 129900; }],
    ["originalPrice", (product: JsonRecord) => { product.originalPrice = "₹1,999/year"; }],
    ["badge", (product: JsonRecord) => { product.badge = "Popular"; }],
    ["features", (product: JsonRecord) => { product.features[0] = "Different feature"; }],
    ["isDefault", (product: JsonRecord) => { product.isDefault = false; }],
    ["metadata", (product: JsonRecord) => { product.metadata.campaign = "trial"; }],
    ["highlighted", (product: JsonRecord) => { product.highlighted = false; }],
  ])("fails exact parity when the product %s changes", async (_field, mutate) => {
    const changedProduct = structuredClone(completeProduct);
    mutate(changedProduct);

    const comparison = await compareProducts([completeProduct], [changedProduct]);

    expect(comparison.passed).toBe(false);
    expect(comparison.legacy_hash).not.toBe(comparison.v2_hash);
  });

  it("treats product array order as served configuration", async () => {
    const secondProduct = {
      ...structuredClone(completeProduct),
      id: "pro_monthly",
      name: "Monthly Pro",
    };

    const comparison = await compareProducts(
      [completeProduct, secondProduct],
      [secondProduct, completeProduct]
    );

    expect(comparison.passed).toBe(false);
  });

  it("ignores JSON object key insertion order while comparing complete products", async () => {
    const sameProductDifferentKeyOrder = {
      highlighted: true,
      metadata: { source: "app", campaign: "marriage" },
      isDefault: true,
      features: ["Unlimited reports", "Priority support"],
      badge: "Best value",
      originalPrice: "₹1,499/year",
      price: { interval: "year", currency: "INR", amount: 99900 },
      description: "Full access for one year",
      name: "Annual Pro",
      id: "pro_yearly",
    };

    const comparison = await compareProducts(
      [completeProduct],
      [sameProductDifferentKeyOrder]
    );

    expect(comparison.passed).toBe(true);
    expect(comparison.legacy_hash).toBe(comparison.v2_hash);
  });

  it("blocks V2 cutover when a non-ID product field differs", async () => {
    const changedProduct = structuredClone(completeProduct);
    changedProduct.metadata.campaign = "trial";
    const db = comparisonDatabase([completeProduct], [changedProduct], true);
    store.withTransaction.mockImplementation(async (work: (executor: DbExecutor) => Promise<unknown>) => (
      work(db)
    ));

    const { setEnvironmentConfigSource } = await import("../src/config-publish.js");
    await expect(setEnvironmentConfigSource({
      clientId: "client-live",
      source: "v2",
      expectedSource: "legacy",
      actor: "test",
    })).rejects.toMatchObject({
      status: 422,
      message: "Legacy/V2 comparison failed; cutover was not applied",
      details: {
        comparison: expect.objectContaining({ passed: false }),
      },
    });
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => (
      /UPDATE clients SET config_source/.test(String(sql))
    ))).toBe(false);
  });
});

async function compareProducts(legacyProducts: JsonRecord[], v2Products: JsonRecord[]) {
  process.env.PUBLIC_API_BASE_URL = API_BASE_URL;
  const db = comparisonDatabase(legacyProducts, v2Products);

  const { compareLegacyAndV2Client } = await import("../src/compare-v2.js");
  const comparison = await compareLegacyAndV2Client("client-live", db);
  if (!comparison) throw new Error("Expected comparison result");
  return comparison;
}

function comparisonDatabase(
  legacyProducts: JsonRecord[],
  v2Products: JsonRecord[],
  includeCutoverQueries = false
): DbExecutor {
  process.env.PUBLIC_API_BASE_URL = API_BASE_URL;
  const checkout = { provider: { planId: "plan_yearly" } };
  const content = {
    renderer: "webview",
    document: {
      html: "<main><h1>{{headline}}</h1></main>",
      baseUrl: API_BASE_URL,
    },
    localization: {
      defaultLocale: "en",
      translations: {
        en: { headline: "Unlock Pro" },
        hi: { headline: "प्रो अनलॉक करें" },
      },
    },
    cta: { text: "Continue" },
    dismiss: { enabled: true },
  };
  const legacySpec = {
    ...content,
    products: structuredClone(legacyProducts),
    checkout,
  };
  const documentPayload = webViewDocumentPayload(legacySpec, {
    publicKey: "pk_live_test",
    placementId: "placement-upgrade",
    variantKey: "control",
    apiBaseUrl: API_BASE_URL,
    includeInline: true,
    sdkStack: "react_native",
  });
  return {
    query: vi.fn(async (sql: string) => {
      if (includeCutoverQueries && /SELECT id, project_key, config_source FROM clients/.test(sql)) {
        return rows([{
          id: "client-live",
          project_key: "hiastro",
          config_source: "legacy",
        }]);
      }
      if (includeCutoverQueries && /SELECT COUNT\(\*\)::text AS count/.test(sql)) {
        return rows([{ count: "0" }]);
      }
      if (includeCutoverQueries && /SELECT pr\.id, p\.client_id, p\.project_key/.test(sql)) {
        return rows([]);
      }
      if (/FROM clients WHERE id = \$1/.test(sql)) {
        return rows([{
          id: "client-live",
          public_key: "pk_live_test",
          name: "Live",
          sdk_stack: "react_native",
        }]);
      }
      if (/FROM placements p\s+LEFT JOIN paywall_specs/.test(sql)) {
        return rows([{
          id: "placement-upgrade",
          trigger: "upgrade_pro",
          status: "active",
          variant_id: "control",
          statsig_experiment_id: null,
          targeting_rules: [],
          default_spec: legacySpec,
        }]);
      }
      if (/FROM placement_variants pv/.test(sql)) {
        return rows([{
          placement_id: "placement-upgrade",
          variant_key: "control",
          weight: 100,
          fallback_rank: 0,
          spec: legacySpec,
          created_at: "2026-08-23T00:00:00.000Z",
        }]);
      }
      if (/SELECT p\.id AS placement_id/.test(sql)) {
        return rows([{
          placement_id: "placement-upgrade",
          trigger: "upgrade_pro",
          placement_status: "active",
          default_variant_key: "control",
          statsig_experiment_id: null,
          targeting_rules: [],
          variant_key: "control",
          weight: 100,
          fallback_rank: 0,
          content,
          content_hash: sha256(stableJson(content)),
          document_hash: hashDocument(documentPayload),
          document_cache_key: documentPayload.cacheKey,
          document_revision: documentPayload.revision,
          document_integrity: sha256Integrity(documentPayload.html),
          document_payload: documentPayload,
          products: structuredClone(v2Products),
          checkout,
        }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as DbExecutor["query"],
  };
}

function rows<T extends Record<string, unknown>>(values: T[]) {
  return { rows: values, rowCount: values.length } as any;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
