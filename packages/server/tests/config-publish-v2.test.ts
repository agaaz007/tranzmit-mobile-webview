import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../src/config-store.js", () => {
  const database = { query: store.query };
  return {
    database,
    getEnvironmentPaywall: vi.fn(),
    withTransaction: store.withTransaction,
  };
});

function validSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    renderer: "webview",
    document: { html: "<main><h1>{{headline}}</h1></main>" },
    localization: {
      defaultLocale: "en",
      translations: {
        en: { headline: "Unlock Pro" },
        hi: { headline: "प्रो अनलॉक करें" },
      },
    },
    products: [{ id: "pro_yearly", name: "Pro", price: "₹999/year" }],
    checkout: { provider: { planId: "plan_yearly" } },
    cta: { text: "Continue" },
    dismiss: { enabled: true },
    ...overrides,
  };
}

beforeEach(() => {
  store.query.mockReset();
  store.withTransaction.mockReset();
  store.withTransaction.mockImplementation(async (work: (db: { query: typeof store.query }) => Promise<unknown>) => (
    work({ query: store.query })
  ));
});

describe("V2 paywall publishing", () => {
  it("rejects a candidate when any locale is missing a document token", async () => {
    const { ConfigError, validatePublishableSpec } = await import("../src/config-publish.js");
    const candidate = validSpec({
      localization: {
        defaultLocale: "en",
        translations: {
          en: { headline: "Unlock Pro" },
          hi: {},
        },
      },
    });

    let error: unknown;
    try {
      validatePublishableSpec(candidate);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ status: 422, message: "Paywall cannot be published" });
    expect((error as ConfigError).details).toEqual({
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: "/localization/translations/hi/headline",
          keyword: "localization",
        }),
      ]),
    });
  });

  it("accepts complete en and hi localization and reports the exact tokens", async () => {
    const { validatePublishableSpec } = await import("../src/config-publish.js");

    const result = validatePublishableSpec(validSpec());

    expect(result.tokens).toEqual(["headline"]);
    expect(result.spec.localization).toEqual(expect.objectContaining({ defaultLocale: "en" }));
  });

  it("accepts hi-Latn exactly and rejects an invalid default locale tag", async () => {
    const { ConfigError, validatePublishableSpec } = await import("../src/config-publish.js");
    const localized = validSpec({
      localization: {
        defaultLocale: "hi-Latn",
        translations: {
          en: { headline: "Unlock Pro" },
          hi: { headline: "प्रो अनलॉक करें" },
          "hi-Latn": { headline: "Pro unlock karein" },
        },
      },
    });

    expect(validatePublishableSpec(localized).spec.localization).toEqual(
      expect.objectContaining({ defaultLocale: "hi-Latn" })
    );
    expect(() => validatePublishableSpec({
      ...localized,
      localization: {
        ...(localized.localization as Record<string, unknown>),
        defaultLocale: "Hindi (Latin)",
      },
    })).toThrow(ConfigError);
    expect(() => validatePublishableSpec({
      ...localized,
      localization: {
        defaultLocale: "hi-en",
        translations: { "hi-en": { headline: "Pro unlock karein" } },
      },
    })).toThrow(ConfigError);
  });

  it("keeps the target live products and checkout when promoting test content", async () => {
    const liveProducts = [{ id: "live_yearly", name: "Live Pro", price: "₹1,499/year" }];
    const liveCheckout = { provider: { planId: "live_plan", key: "live-only" } };
    let insertedReleaseParams: unknown[] | undefined;
    let sourceProductId = "test_yearly";
    const statements: string[] = [];

    store.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      if (/FROM paywall_environment_bindings b\s+JOIN clients/i.test(sql)) {
        return {
          rows: [{
            id: "binding-live",
            client_id: "client-live",
            project_key: "hiastro",
            paywall_id: "paywall-marriage",
            current_release_id: "release-live-current",
            public_key: "pk_live",
            environment_kind: "live",
            management_status: "editable",
          }],
          rowCount: 1,
        };
      }
      if (/FROM paywall_environment_releases r\s+JOIN paywall_environment_bindings/i.test(sql)) {
        return {
          rows: [{
            id: "release-test",
            content_revision_id: "content-test-new",
            paywall_id: "paywall-marriage",
            project_key: "hiastro",
            binding_id: "binding-test",
            current_release_id: "release-test",
            client_id: "client-test",
            environment_kind: "test",
          }],
          rowCount: 1,
        };
      }
      if (/SELECT current_release_id\s+FROM paywall_environment_bindings/i.test(sql)) {
        return { rows: [{ current_release_id: "release-test" }], rowCount: 1 };
      }
      if (/SELECT id, products, checkout FROM paywall_environment_releases/i.test(sql)) {
        return {
          rows: [{ id: "release-live-current", products: liveProducts, checkout: liveCheckout }],
          rowCount: 1,
        };
      }
      if (/SELECT content FROM paywall_content_revisions/i.test(sql)) {
        const { products: _products, checkout: _checkout, ...content } = validSpec({
          document: {
            html: `<button data-tranzmit-action="cta" data-product-id="${sourceProductId}">Continue</button>`,
          },
        });
        return { rows: [{ content }], rowCount: 1 };
      }
      if (/SELECT COALESCE\(MAX\(release_number\)/i.test(sql)) {
        return { rows: [{ release_number: 8 }], rowCount: 1 };
      }
      if (/INSERT INTO paywall_environment_releases/i.test(sql)) {
        insertedReleaseParams = params;
        return {
          rows: [{
            id: "release-live-candidate",
            binding_id: "binding-live",
            release_number: 8,
            content_revision_id: "content-test-new",
            products: liveProducts,
            checkout: liveCheckout,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const { promotePaywallContent } = await import("../src/config-publish.js");
    const input = {
      targetBindingId: "binding-live",
      sourceReleaseId: "release-test",
      actor: "dashboard",
    };
    await expect(promotePaywallContent(input)).rejects.toMatchObject({
      status: 422,
      details: {
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "/document/html",
            keyword: "productReference",
            message: 'Document references unknown Billing Product ID "test_yearly"',
          }),
        ]),
      },
    });
    expect(insertedReleaseParams).toBeUndefined();

    sourceProductId = "live_yearly";
    const result = await promotePaywallContent(input);

    expect(result).toMatchObject({
      id: "release-live-candidate",
      content_revision_id: "content-test-new",
    });
    expect(JSON.parse(String(insertedReleaseParams?.[6]))).toEqual(liveProducts);
    expect(JSON.parse(String(insertedReleaseParams?.[7]))).toEqual(liveCheckout);
    expect(insertedReleaseParams?.[5]).toBe("content-test-new");
    const sourceLockIndex = statements.findIndex(
      (sql) => /SELECT current_release_id\s+FROM paywall_environment_bindings/i.test(sql)
        && /FOR UPDATE/i.test(sql)
    );
    const candidateInsertIndex = statements.findIndex((sql) => /INSERT INTO paywall_environment_releases/i.test(sql));
    expect(sourceLockIndex).toBeGreaterThan(-1);
    expect(candidateInsertIndex).toBeGreaterThan(sourceLockIndex);
  });

  it("fails stale paywall pointer publication with a 409 and writes no audit", async () => {
    const auditWrites: string[] = [];
    store.query.mockImplementation(async (sql: string) => {
      if (/FROM paywall_environment_bindings b\s+JOIN clients/i.test(sql)) {
        return {
          rows: [{
            id: "binding-live",
            client_id: "client-live",
            project_key: "hiastro",
            paywall_id: "paywall-marriage",
            current_release_id: "release-actual",
            public_key: "pk_live",
            environment_kind: "live",
            management_status: "editable",
          }],
          rowCount: 1,
        };
      }
      if (/FROM paywall_environment_releases r\s+JOIN paywall_content_revisions/i.test(sql)) {
        const { products, checkout, ...content } = validSpec();
        return {
          rows: [{
            id: "release-candidate",
            release_number: 9,
            content_revision_id: "content-candidate",
            products,
            checkout,
            content,
            content_hash: "content-hash",
            document_cache_key: "doc-key",
            document_hash: "doc-hash",
            created_by: "dashboard",
            created_at: "2026-08-22T00:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (/FROM paywall_release_preflights/i.test(sql)) {
        return {
          rows: [{
            id: "preflight-1",
            status: "pass",
            report: { status: "pass", checks: [] },
            checked_by: "dashboard",
            created_at: "2026-08-22T00:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (/UPDATE paywall_environment_bindings/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO config_audit_log/i.test(sql)) auditWrites.push(sql);
      return { rows: [], rowCount: 1 };
    });

    const { ConfigError, publishPaywallRelease } = await import("../src/config-publish.js");
    await expect(publishPaywallRelease({
      bindingId: "binding-live",
      releaseId: "release-candidate",
      expectedCurrentReleaseId: "release-stale",
      actor: "dashboard",
    })).rejects.toMatchObject({
      status: 409,
      message: "Published release changed; refresh the diff and try again",
      details: {
        expected_current_release_id: "release-stale",
        actual_current_release_id: "release-actual",
      },
    } satisfies Partial<ConfigError>);
    expect(auditWrites).toEqual([]);
  });
});
