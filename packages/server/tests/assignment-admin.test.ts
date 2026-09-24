import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Admin API: fixed-split settings accepted on POST /admin/placements/:id/revisions
// (validated and persisted), and re-checked on publish.

const store = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../src/config-store.js", () => ({
  database: { query: store.query },
  getEnvironmentPaywall: vi.fn(),
  withTransaction: store.withTransaction,
  listConfigEnvironments: vi.fn(),
  listEnvironmentPaywalls: vi.fn(),
  listEnvironmentPlacements: vi.fn(),
}));

interface Captured {
  revision?: unknown[];
  variants: unknown[][];
  pointerUpdates: number;
}

let captured: Captured;
let fixedSplitReadiness: { assignment_mode: string; positive_active: number; restricted_default: boolean };

beforeEach(() => {
  captured = { variants: [], pointerUpdates: 0 };
  fixedSplitReadiness = { assignment_mode: "fixed_split", positive_active: 2, restricted_default: false };
  store.query.mockReset();
  store.withTransaction.mockReset();
  store.withTransaction.mockImplementation(async (work: (db: { query: typeof store.query }) => Promise<unknown>) => (
    work({ query: store.query })
  ));
  store.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FOR SHARE OF c/i.test(sql)) return { rows: [{ id: "client-live" }], rowCount: 1 };
    if (/SELECT p\.id, p\.client_id, p\.project_key, p\.current_revision_id/i.test(sql)) {
      return {
        rows: [{
          id: "pl_upgrade",
          client_id: "client-live",
          project_key: "hiastro",
          current_revision_id: "rev-current",
          trigger: "upgrade_pro",
          management_status: "editable",
        }],
        rowCount: 1,
      };
    }
    if (/SELECT id FROM paywall_environment_bindings/i.test(sql)) {
      return { rows: (params[2] as string[]).map((id) => ({ id })), rowCount: (params[2] as string[]).length };
    }
    if (/COALESCE\(MAX\(revision_number\)/i.test(sql)) return { rows: [{ revision_number: 4 }], rowCount: 1 };
    if (/INSERT INTO placement_revisions/i.test(sql)) {
      captured.revision = params;
      return {
        rows: [{ id: "rev-new", assignment_mode: params[10], holdout_percent: String(params[11]), assignment_salt: params[12] }],
        rowCount: 1,
      };
    }
    if (/INSERT INTO placement_revision_variants/i.test(sql)) {
      captured.variants.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id FROM placement_revisions WHERE id = \$1 AND placement_id/i.test(sql)) {
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (/SELECT pr\.status, pr\.default_binding_id/i.test(sql)) {
      return {
        rows: [{
          status: "active",
          default_binding_id: "binding-control",
          default_variant_key: "control",
          default_variant_binding_id: "binding-control",
          default_variant_status: "active",
        }],
        rowCount: 1,
      };
    }
    if (/SELECT pr\.assignment_mode,/i.test(sql)) return { rows: [fixedSplitReadiness], rowCount: 1 };
    if (/WITH requested AS/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/UPDATE placements SET current_revision_id/i.test(sql)) {
      captured.pointerUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
});

const baseRevision = {
  status: "active" as const,
  defaultBindingId: "binding-control",
  defaultVariantKey: "control",
};

describe("placement revision assignment settings", () => {
  it("persists statsig revisions exactly as before (mode statsig, no holdout, no salt, no eligibility)", async () => {
    const { createPlacementRevision } = await import("../src/config-publish.js");
    await createPlacementRevision("pl_upgrade", {
      ...baseRevision,
      statsigExperimentId: "paywall_intent_marriage",
      targetingRules: [{ when: { intent: "marriage" }, statsig_experiment_id: "paywall_intent_marriage" }],
      variants: [
        { variantKey: "control", bindingId: "binding-control", weight: 50 },
        // Statsig mode keeps the historical lenient weight normalization.
        { variantKey: "marriage-02", bindingId: "binding-m2", weight: 250 },
      ],
    });
    expect(captured.revision?.slice(7, 13)).toEqual([
      "paywall_intent_marriage",
      JSON.stringify([{ when: { intent: "marriage" }, statsig_experiment_id: "paywall_intent_marriage" }]),
      "api",
      "statsig",
      0,
      null,
    ]);
    expect(captured.variants.map((params) => [params[4], params[7], params[9]])).toEqual([
      ["control", 50, null],
      ["marriage-02", 100, null],
    ]);
  });

  it("persists a fixed_split revision with holdout, salt and per-variant eligibility", async () => {
    const { createPlacementRevision } = await import("../src/config-publish.js");
    const result = await createPlacementRevision("pl_upgrade", {
      ...baseRevision,
      assignmentMode: "fixed_split",
      holdoutPercent: 10,
      assignmentSalt: "marriage-exp-2026-09",
      variants: [
        { variantKey: "control", bindingId: "binding-control", weight: 25 },
        { variantKey: "marriage-02", bindingId: "binding-m2", weight: 25, eligibility: { intent: ["marriage"] } },
      ],
    });
    expect(captured.revision?.slice(10, 13)).toEqual(["fixed_split", 10, "marriage-exp-2026-09"]);
    expect(captured.variants.map((params) => [params[4], params[7], params[9]])).toEqual([
      ["control", 25, null],
      ["marriage-02", 25, JSON.stringify({ intent: ["marriage"] })],
    ]);
    expect(result).toMatchObject({ id: "rev-new", assignment_mode: "fixed_split" });
  });

  it("rejects invalid fixed_split settings with 422 and writes nothing", async () => {
    const { createPlacementRevision } = await import("../src/config-publish.js");
    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ holdoutPercent: 60 }, "/holdoutPercent"],
      [{ holdoutPercent: -5 }, "/holdoutPercent"],
      [{ variants: [{ variantKey: "control", bindingId: "binding-control", weight: -1 }] }, "/variants/0/weight"],
      [{ variants: [{ variantKey: "control", bindingId: "binding-control", weight: 0 }] }, "/variants"],
      [{ variants: [{ variantKey: "control", bindingId: "binding-control" }] }, "/variants/0/weight"],
      [{ statsigExperimentId: "paywall_intent_marriage" }, "/statsigExperimentId"],
      [{
        variants: [
          { variantKey: "control", bindingId: "binding-control", weight: 1, eligibility: { intent: "marriage" } },
        ],
      }, "/variants/0/eligibility"],
    ];
    for (const [overrides, path] of invalid) {
      captured = { variants: [], pointerUpdates: 0 };
      await expect(createPlacementRevision("pl_upgrade", {
        ...baseRevision,
        assignmentMode: "fixed_split",
        variants: [{ variantKey: "control", bindingId: "binding-control", weight: 1 }],
        ...overrides,
      } as any)).rejects.toMatchObject({
        status: 422,
        message: "Invalid assignment settings",
        details: { errors: expect.arrayContaining([expect.objectContaining({ path })]) },
      });
      expect(captured.revision).toBeUndefined();
      expect(captured.variants).toEqual([]);
    }
  });

  it("accepts the settings through the admin HTTP route in camelCase and snake_case", async () => {
    const { handleAdminV2 } = await import("../src/routes/admin-v2.js");
    const post = (body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        await handleAdminV2(req, res, new URL(req.url || "/", "http://x").pathname, { kind: "admin", source: "admin_secret_bearer" });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        fetch(`http://127.0.0.1:${port}/admin/placements/pl_upgrade/revisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: JSON.parse(text) });
        }).catch((error) => {
          server.close();
          reject(error);
        });
      });
    });

    const snake = await post({
      status: "active",
      default_binding_id: "binding-control",
      default_variant_key: "control",
      assignment_mode: "fixed_split",
      holdout_percent: 12.5,
      assignment_salt: "exp-1",
      variants: [
        { variant_key: "control", binding_id: "binding-control", weight: 1 },
        { variant_key: "marriage-02", binding_id: "binding-m2", weight: 3, eligibility: { intent: ["marriage"] } },
      ],
    });
    expect(snake.status).toBe(201);
    expect(captured.revision?.slice(10, 13)).toEqual(["fixed_split", 12.5, "exp-1"]);
    expect(captured.variants[1][9]).toBe(JSON.stringify({ intent: ["marriage"] }));

    const rejected = await post({
      status: "active",
      defaultBindingId: "binding-control",
      defaultVariantKey: "control",
      assignmentMode: "fixed_split",
      holdoutPercent: 75,
      variants: [{ variantKey: "control", bindingId: "binding-control", weight: 1 }],
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body).toEqual({
      error: "Invalid assignment settings",
      details: { errors: [{ path: "/holdoutPercent", message: "Must be between 0 and 50" }] },
    });
  });

  it("re-checks fixed_split readiness on publish", async () => {
    const { publishPlacementRevision } = await import("../src/config-publish.js");
    const publish = () => publishPlacementRevision({
      placementId: "pl_upgrade",
      revisionId: "rev-new",
      expectedCurrentRevisionId: "rev-current",
      actor: "test",
    });

    await expect(publish()).resolves.toMatchObject({ current_revision_id: "rev-new" });
    expect(captured.pointerUpdates).toBe(1);

    fixedSplitReadiness = { assignment_mode: "fixed_split", positive_active: 0, restricted_default: false };
    await expect(publish()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/weight > 0/) });
    fixedSplitReadiness = { assignment_mode: "fixed_split", positive_active: 3, restricted_default: true };
    await expect(publish()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/default variant/) });
    expect(captured.pointerUpdates).toBe(1);

    fixedSplitReadiness = { assignment_mode: "statsig", positive_active: 0, restricted_default: false };
    await expect(publish()).resolves.toMatchObject({ current_revision_id: "rev-new" });
  });
});
