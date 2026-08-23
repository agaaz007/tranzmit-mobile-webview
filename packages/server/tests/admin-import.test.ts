// ============================================================================
// REGRESSION GUARD for the 2026-06-30 production incident.
//
// A run of scripts/push-influish-production.mjs (which POSTs to
// /admin/config/import with placements that carry NO statsig_experiment_id)
// overwrote the live placement's experiment link with NULL. Variant selection
// is 100% Statsig-driven, so 100% of production traffic silently fell back to
// the default variant (`control`) for six days with no error anywhere.
//
// These tests pin the contract: an import payload that OMITS a field must
// PRESERVE the existing production value. If they fail because someone
// "simplified" the upsert back to `experiment_id = EXCLUDED.experiment_id`,
// that person is about to re-cause the incident. Do not delete them.
// ============================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const queryCalls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("../src/db.js", () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    if (/INSERT INTO placements/i.test(sql)) return { rows: [{ id: "pl_test" }] };
    if (/SELECT public_key FROM clients WHERE id/i.test(sql)) {
      return { rows: [{ public_key: "pk_test_valid" }] };
    }
    return { rows: [] };
  }),
  pool: {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queryCalls.push({ sql, params: params ?? [] });
        if (/SELECT id, public_key, management_status, config_source/i.test(sql)) {
          return {
            rows: [{
              id: "ws_1",
              public_key: "pk_test_valid",
              management_status: "editable",
              config_source: "legacy",
            }],
          };
        }
        if (/SELECT trigger,[\s\S]*FROM placements/i.test(sql)) {
          return {
            rows: ((params?.[1] as string[] | undefined) || []).map((trigger) => ({
              trigger,
              status: "active",
              default_spec_id: "existing-spec",
              has_inline_spec: true,
            })),
          };
        }
        if (/INSERT INTO placements/i.test(sql)) return { rows: [{ id: "pl_test" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
  },
  getWorkspaceForPublicKey: vi.fn(async () => ({
    id: "ws_1",
    public_key: "pk_test_valid",
    secret_key: "sk_test",
    name: "Test Workspace",
  })),
}));

vi.mock("../src/statsig.js", () => ({
  getStatsigProjectStatus: vi.fn(async () => ({ configured: false })),
  normalizeStatsigSecretEnvVar: vi.fn((v: string) => v),
  isValidStatsigSecretEnvVar: vi.fn(() => true),
}));

async function makeAdminRequest(path: string, method: string, body: unknown): Promise<{ status: number; body: string }> {
  const { handleAdmin } = await import("../src/routes/admin.js");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    void handleAdmin(req, res, url.pathname);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": "test-admin-secret",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

function placementUpsert(): { sql: string; params: unknown[] } | undefined {
  return queryCalls.find((call) => /INSERT INTO placements/i.test(call.sql));
}

beforeEach(() => {
  process.env.ADMIN_SECRET = "test-admin-secret";
  queryCalls.length = 0;
});

describe("POST /admin/config/import placement upsert", () => {
  it("preserves the existing statsig experiment link when the payload omits it", async () => {
    const res = await makeAdminRequest("/admin/config/import", "POST", {
      publicKey: "pk_test_valid",
      placements: [
        {
          id: "pl_existing",
          trigger: "upgrade_pro",
          status: "active",
          targeting_rules: [],
          // NO statsig_experiment_id — exactly what push-influish-production.mjs sends
        },
      ],
    });
    expect(res.status).toBe(200);

    const upsert = placementUpsert();
    expect(upsert).toBeDefined();
    // The ON CONFLICT clause must fall back to the row's current value, not
    // overwrite it with the payload's NULL.
    expect(upsert!.sql).toMatch(/experiment_id\s*=\s*CASE WHEN \$9 THEN EXCLUDED\.experiment_id ELSE placements\.experiment_id END/);
    expect(upsert!.sql).toMatch(
      /statsig_experiment_id\s*=\s*CASE WHEN \$9 THEN EXCLUDED\.statsig_experiment_id ELSE placements\.statsig_experiment_id END/
    );
    expect(upsert!.params[7]).toBeNull();
    expect(upsert!.params[8]).toBe(false);
  });

  it("passes an explicit statsig_experiment_id through to the upsert", async () => {
    const res = await makeAdminRequest("/admin/config/import", "POST", {
      publicKey: "pk_test_valid",
      placements: [
        {
          id: "pl_existing",
          trigger: "upgrade_pro",
          status: "active",
          statsig_experiment_id: "influish_production_mobile_prod",
        },
      ],
    });
    expect(res.status).toBe(200);

    const upsert = placementUpsert();
    expect(upsert).toBeDefined();
    expect(upsert!.params[7]).toBe("influish_production_mobile_prod");
    expect(upsert!.params[8]).toBe(true);
  });

  it("does not blank the stored spec/default_spec_id when the payload has no default_spec_id", async () => {
    await makeAdminRequest("/admin/config/import", "POST", {
      publicKey: "pk_test_valid",
      placements: [{ trigger: "upgrade_pro", status: "active" }],
    });

    const upsert = placementUpsert();
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toMatch(/default_spec_id\s*=\s*CASE WHEN \$11 THEN EXCLUDED\.default_spec_id ELSE placements\.default_spec_id END/);
    expect(upsert!.sql).toMatch(/ELSE placements\.spec/);
    expect(upsert!.params[10]).toBe(false);
  });

  it("distinguishes explicit null from omission for restore fields", async () => {
    await makeAdminRequest("/admin/config/import", "POST", {
      publicKey: "pk_test_valid",
      placements: [{
        trigger: "upgrade_pro",
        status: "paused",
        statsig_experiment_id: null,
        default_spec_id: null,
        spec: null,
      }],
    });

    const upsert = placementUpsert();
    expect(upsert).toBeDefined();
    expect(upsert!.params[7]).toBeNull();
    expect(upsert!.params[8]).toBe(true);
    expect(upsert!.params[9]).toBeNull();
    expect(upsert!.params[10]).toBe(true);
    expect(upsert!.params[13]).toBeNull();
    expect(upsert!.params[14]).toBe(true);
  });
});
