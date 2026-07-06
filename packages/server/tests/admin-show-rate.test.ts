// GET /admin/metrics/show-rate: per-variant resolved vs shown vs inferred
// fallbacks, the health metric that makes cellular init-deaths visible
// (measured 13:00-16:00 UTC: control 30.5%, original 14.3%, intro_offer 12.6%).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let metricRows: Array<Record<string, unknown>> = [];

vi.mock("../src/db.js", () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    return { rows: metricRows };
  }),
  getWorkspaceForPublicKey: vi.fn(async (publicKey: string) =>
    publicKey === "pk_test_valid"
      ? { id: "ws_1", public_key: "pk_test_valid", secret_key: "sk_test", name: "Influish" }
      : null
  ),
}));

vi.mock("../src/statsig.js", () => ({
  getStatsigProjectStatus: vi.fn(() => ({ configured: false })),
  normalizeStatsigSecretEnvVar: vi.fn((v: string) => v),
  isValidStatsigSecretEnvVar: vi.fn(() => true),
}));

vi.mock("../src/middleware/auth.js", () => ({
  resolveAdminAuth: vi.fn(async () => ({ kind: "admin" })),
}));

async function makeRequest(path: string): Promise<{ status: number; body: string }> {
  const { handleAdmin } = await import("../src/routes/admin.js");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    void handleAdmin(req, res, url.pathname);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      headers: { "x-admin-secret": "test-admin-secret" },
    });
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

beforeEach(async () => {
  process.env.ADMIN_SECRET = "test-admin-secret";
  queryCalls.length = 0;
  metricRows = [];
  const auth = await import("../src/middleware/auth.js");
  vi.mocked(auth.resolveAdminAuth).mockResolvedValue({ kind: "admin" } as never);
});

describe("GET /admin/metrics/show-rate", () => {
  it("requires auth", async () => {
    const auth = await import("../src/middleware/auth.js");
    vi.mocked(auth.resolveAdminAuth).mockResolvedValueOnce(null as never);

    const res = await makeRequest("/admin/metrics/show-rate?public_key=pk_test_valid");
    expect(res.status).toBe(401);
    expect(queryCalls).toHaveLength(0);
  });

  it("returns 400 for a missing or unknown public_key", async () => {
    const missing = await makeRequest("/admin/metrics/show-rate");
    expect(missing.status).toBe(400);

    const unknown = await makeRequest("/admin/metrics/show-rate?public_key=pk_test_unknown");
    expect(unknown.status).toBe(400);
  });

  it("returns per-variant rows with computed show_rate_pct", async () => {
    metricRows = [
      { variant: "control", resolved_users: "200", shown_users: "61", inferred_fallback_users: "2" },
      { variant: "intro_offer", resolved_users: "103", shown_users: "13", inferred_fallback_users: "41" },
      { variant: "original", resolved_users: 0, shown_users: 0, inferred_fallback_users: "5" },
    ];

    const res = await makeRequest("/admin/metrics/show-rate?public_key=pk_test_valid");
    expect(res.status).toBe(200);

    const payload = JSON.parse(res.body);
    expect(payload.public_key).toBe("pk_test_valid");
    expect(payload.hours).toBe(3);
    expect(payload.rows).toEqual([
      { variant: "control", resolved_users: 200, shown_users: 61, show_rate_pct: 30.5, inferred_fallback_users: 2 },
      { variant: "intro_offer", resolved_users: 103, shown_users: 13, show_rate_pct: 12.6, inferred_fallback_users: 41 },
      // No resolves -> show rate undefined, never a divide-by-zero.
      { variant: "original", resolved_users: 0, shown_users: 0, show_rate_pct: null, inferred_fallback_users: 5 },
    ]);

    // The SQL groups the three event families per variant, scoped to the key.
    const call = queryCalls[0];
    expect(call.sql).toContain("event_name = 'paywall_resolved'");
    expect(call.sql).toContain("event_name = 'impression'");
    expect(call.sql).toContain("event_name = 'paywall_fallback_inferred'");
    expect(call.sql).toContain("split_part");
    expect(call.sql).toContain("COUNT(DISTINCT user_id)");
    expect(call.params).toEqual(["pk_test_valid", 3]);
  });

  it("honors the hours query param and clamps it to sane bounds", async () => {
    await makeRequest("/admin/metrics/show-rate?public_key=pk_test_valid&hours=6");
    expect(queryCalls[0].params).toEqual(["pk_test_valid", 6]);

    queryCalls.length = 0;
    await makeRequest("/admin/metrics/show-rate?public_key=pk_test_valid&hours=99999");
    expect(queryCalls[0].params).toEqual(["pk_test_valid", 168]);

    queryCalls.length = 0;
    await makeRequest("/admin/metrics/show-rate?public_key=pk_test_valid&hours=garbage");
    expect(queryCalls[0].params).toEqual(["pk_test_valid", 3]);
  });
});
