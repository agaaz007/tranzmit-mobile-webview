import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// End-to-end /v1/config -> paywall_resolved stamp, with Statsig mocked at the
// SDK boundary (real statsig.ts, real DynamicConfig) so the Statsig metadata in
// the stamp is what the SDK actually exposes.

const state = vi.hoisted(() => ({
  statsigCalls: [] as Array<{ experiment: string; userID: string | undefined }>,
  events: [] as any[],
  routing: [] as unknown[],
  client: null as unknown,
  legacyRows: [] as unknown[],
  missingBindings: new Set<string>(),
}));

vi.mock("statsig-node", async () => {
  const actual = await vi.importActual<typeof import("statsig-node")>("statsig-node");
  const { DynamicConfig } = actual;
  const details = { configSyncTime: 1_780_000_000_000, initTime: 1_779_999_000_000, reason: "Network" };
  class FakeStatsigServer {
    async initializeAsync() {}
    async shutdownAsync() {}
    logEvent() {}
    getExperimentSync(user: { userID?: string }, experiment: string) {
      state.statsigCalls.push({ experiment, userID: user.userID });
      if (experiment === "hiastro_baseline") {
        const holdout = user.userID === "user-holdout";
        return new DynamicConfig(
          experiment,
          holdout ? { use_autotune: false, variant_id: "default" } : { use_autotune: true },
          holdout ? "rule_holdout" : "rule_autotune",
          holdout ? "Holdout" : "Autotune",
          "userID", [], null, details as any
        );
      }
      if (experiment === "kundli_intent_marriage") {
        const variant = user.userID === "user-unknown-arm" ? "arm-not-in-routing" : "kundli-b";
        return new DynamicConfig(experiment, { variant_id: variant }, "autotune_kundli", variant, "userID", [], null, details as any);
      }
      if (experiment === "legacy_experiment") {
        return new DynamicConfig(experiment, { variant_id: "var_b" }, "legacy_rule", "B", "userID", [], null, details as any);
      }
      return new DynamicConfig(experiment, {}, "", null, null, [], null, { ...details, reason: "Unrecognized" } as any);
    }
  }
  return { ...actual, StatsigServer: FakeStatsigServer };
});

vi.mock("../src/db.js", () => ({
  pool: { connect: vi.fn(), end: vi.fn() },
  query: vi.fn(async () => ({ rows: [] })),
  validatePublicKey: vi.fn(async () => true),
  getPlacementsForKey: vi.fn(async () => state.legacyRows),
  insertEvents: vi.fn(async (publicKey: string, userId: string, _sessionId: string, events: any[]) => {
    state.events.push({ publicKey, userId, ...events[0] });
  }),
}));

vi.mock("../src/config-store.js", () => ({
  database: { query: vi.fn() },
  getEnvironmentPaywall: vi.fn(),
  withTransaction: vi.fn(),
  getConfigClient: vi.fn(async () => state.client),
  getV2PublishedRouting: vi.fn(async () => state.routing),
  getV2PublishedReleases: vi.fn(async (_clientId: string, bindingIds: string[]) => new Map(
    bindingIds.filter((id) => !state.missingBindings.has(id)).map((bindingId) => [bindingId, release(bindingId)])
  )),
}));

function release(bindingId: string) {
  const html = `<main data-binding="${bindingId}">Paywall</main>`;
  return {
    bindingId,
    releaseId: `release-${bindingId}`,
    contentRevisionId: `content-${bindingId}`,
    content: { renderer: "webview", document: { html }, cta: { text: "Continue" }, dismiss: { enabled: true } },
    products: [{ id: "pro_yearly", name: "Pro", price: "₹999/year" }],
    checkout: null,
    documentPayload: { html, cacheKey: `cache-${bindingId}`, revision: `content-${bindingId}`, integrity: `sha256-${bindingId}` },
  };
}

function variant(variantId: string, weight: number, eligibility: unknown = null) {
  return { id: `route-${variantId}`, variantId, bindingId: `binding-${variantId}`, status: "active", fallbackRank: 0, weight, eligibility };
}

function fixedSplitUpgrade(extra: Record<string, unknown> = {}) {
  return {
    placementId: "pl_upgrade",
    revisionId: "rev-upgrade-9",
    trigger: "upgrade_pro",
    status: "active",
    defaultVariantKey: "control",
    defaultBindingId: "binding-control",
    // Deliberately left on the row: a fixed_split placement must not consult
    // Statsig even if a Statsig experiment and baseline are still configured.
    experimentId: "upgrade_experiment_should_not_run",
    targetingRules: [{ type: "baseline", statsig_experiment_id: "upgrade_baseline_should_not_run" }],
    assignmentMode: "fixed_split",
    holdoutPercent: 10,
    assignmentSalt: "marriage-exp-2026-09",
    variants: [
      variant("control", 1),
      variant("marriage-01", 1, { intent: ["marriage"] }),
      variant("marriage-02", 1, { intent: ["marriage"] }),
      variant("marriage-03", 1, { intent: ["marriage"] }),
    ],
    ...extra,
  };
}

function statsigKundli() {
  return {
    placementId: "pl_kundli",
    revisionId: "rev-kundli-2",
    trigger: "kundli_report",
    status: "active",
    defaultVariantKey: "default",
    defaultBindingId: "binding-default",
    experimentId: null,
    targetingRules: [
      { type: "baseline", statsig_experiment_id: "hiastro_baseline" },
      { when: { intent: "marriage" }, statsig_experiment_id: "kundli_intent_marriage" },
    ],
    assignmentMode: "statsig",
    holdoutPercent: 0,
    assignmentSalt: null,
    variants: [variant("default", 50), variant("kundli-b", 50)],
  };
}

function v2Client(statsigServerSecretEnvVar = "STATSIG_HIASTRO") {
  return {
    id: "client-hiastro-live",
    publicKey: "pk_live_hiastro",
    projectKey: "hiastro",
    environmentKind: "live",
    managementStatus: "editable",
    configSource: "v2",
    sdkStack: "react_native",
    statsigProjectName: "hiastro",
    statsigServerSecretEnvVar,
  };
}

async function postConfig(body: Record<string, unknown>): Promise<any> {
  const { handleConfig } = await import("../src/routes/config.js");
  const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => handleConfig(req, res));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}/v1/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: JSON.parse(text) });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response.body;
}

function lastEvent() {
  return state.events[state.events.length - 1];
}

function decisions(event: any): any[] {
  return [event.properties.assignment, ...(event.properties.other_assignments || [])].filter(Boolean);
}

/** Spec acceptance checks A-E for one paywall_resolved event. */
function assertSpecChecks(event: any) {
  expect(event.event).toBe("paywall_resolved");
  expect(event.properties.assignment).toEqual(expect.objectContaining({ schema_version: 1 })); // A
  const resolved = new Map<string, string>(
    String(event.properties.resolved).split(",").map((entry: string) => {
      const [trigger, value] = entry.trim().split("=");
      return [trigger, value.replace(/\s*\(baseline\)\s*$/, "")];
    })
  );
  const all = decisions(event);
  expect(all.map((stamp) => stamp.trigger)).toEqual(Array.from(resolved.keys()));
  for (const stamp of all) {
    expect(["fixed_uniform", "fixed_weighted", "adaptive_bandit", "sticky_replay", "holdout_forced", "fallback_default"])
      .toContain(stamp.mechanism); // E
    if (stamp.probability_source === "exact") {
      const sum = stamp.candidates.reduce((total: number, candidate: any) => total + candidate.probability, 0);
      expect(Math.abs(1 - sum)).toBeLessThanOrEqual(1e-6); // B
    }
    expect(stamp.candidates).toContainEqual(expect.objectContaining({ variant_key: stamp.chosen, eligible: true })); // C
    expect(resolved.get(stamp.trigger)).toBe(stamp.chosen); // D
  }
}

beforeEach(() => {
  process.env.PUBLIC_API_BASE_URL = "https://api.example.test";
  process.env.STATSIG_HIASTRO = "secret-hiastro";
  delete process.env.STATSIG_MISSING;
  delete process.env.PAYWALL_ASSIGNMENT_STAMP;
  state.statsigCalls.length = 0;
  state.events.length = 0;
  state.missingBindings.clear();
  state.client = v2Client();
  state.routing = [fixedSplitUpgrade(), statsigKundli()];
  state.legacyRows = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.PAYWALL_ASSIGNMENT_STAMP;
  vi.restoreAllMocks();
});

afterAll(async () => {
  const { shutdownStatsig } = await import("../src/statsig.js");
  await shutdownStatsig();
});

describe("paywall_resolved assignment stamp", () => {
  it("serves fixed_split by hash without consulting Statsig, and stamps exact probabilities", async () => {
    const served = new Map<string, number>();
    for (let index = 0; index < 60; index += 1) {
      const userId = `user-${index}`;
      const config = await postConfig({ publicKey: "pk_live_hiastro", identity: { userId }, traits: { intent: "marriage" } });
      const event = lastEvent();
      assertSpecChecks(event);
      const stamp = event.properties.assignment;
      expect(stamp).toMatchObject({
        trigger: "upgrade_pro",
        placement_id: "pl_upgrade",
        revision_id: "rev-upgrade-9",
        allocator: "fixed_split_hash",
        policy_id: "fixed_split:marriage-exp-2026-09",
        policy_version: "rev:rev-upgrade-9",
        holdout_probability: 0.1,
        probability_source: "exact",
        unit_type: "user_id",
        served: true,
      });
      expect(config.placements.upgrade_pro.variantId).toBe(stamp.chosen);
      if (!stamp.is_holdout) {
        expect(stamp.mechanism).toBe("fixed_uniform");
        expect(stamp.candidates.map((candidate: any) => candidate.probability)).toEqual([0.25, 0.25, 0.25, 0.25]);
      } else {
        expect(stamp).toMatchObject({ mechanism: "holdout_forced", chosen: "control" });
      }
      // Same unit, same revision: identical decision and assignment_id on every re-resolve.
      await postConfig({ publicKey: "pk_live_hiastro", identity: { userId }, traits: { intent: "marriage" } });
      expect(lastEvent().properties.assignment).toEqual(stamp);
      served.set(stamp.chosen, (served.get(stamp.chosen) || 0) + 1);
    }
    expect(served.size).toBeGreaterThan(2);
    const experiments = new Set(state.statsigCalls.map((call) => call.experiment));
    expect(experiments.has("upgrade_experiment_should_not_run")).toBe(false);
    expect(experiments.has("upgrade_baseline_should_not_run")).toBe(false);
    // The Statsig-mode placement in the same environment still resolves through Statsig.
    expect(experiments).toEqual(new Set(["hiastro_baseline", "kundli_intent_marriage"]));
  });

  it("renormalizes over eligible arms for other intents and records the ineligible ones", async () => {
    const config = await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-career" }, traits: { intent: "career" } });
    const event = lastEvent();
    assertSpecChecks(event);
    expect(config.placements.upgrade_pro.variantId).toBe("control");
    expect(event.properties.assignment.candidates).toEqual([
      { variant_key: "control", probability: 1, weight: 1, eligible: true },
      { variant_key: "marriage-01", probability: 0, weight: 1, eligible: false },
      { variant_key: "marriage-02", probability: 0, weight: 1, eligible: false },
      { variant_key: "marriage-03", probability: 0, weight: 1, eligible: false },
    ]);
  });

  it("stamps Statsig autotune decisions with the SDK's rule, group and config version, and null probabilities", async () => {
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-7" }, traits: { intent: "marriage" } });
    const event = lastEvent();
    assertSpecChecks(event);
    expect(event.properties.resolved).toMatch(/kundli_report=kundli-b$/);
    expect(event.properties.other_assignments).toEqual([expect.objectContaining({
      trigger: "kundli_report",
      chosen: "kundli-b",
      mechanism: "adaptive_bandit",
      allocator: "statsig_autotune",
      policy_id: "kundli_intent_marriage",
      policy_version: "rev:rev-kundli-2|statsig_lcut:1780000000000",
      is_holdout: false,
      holdout_probability: null,
      probability_source: "unknown",
      candidates: [
        { variant_key: "default", probability: null, weight: null, eligible: null },
        { variant_key: "kundli-b", probability: null, weight: null, eligible: true },
      ],
      statsig: {
        baseline: {
          experiment_id: "hiastro_baseline",
          status: "assigned",
          variant_id: null,
          use_autotune: true,
          rule_id: "rule_autotune",
          group_name: "Autotune",
          reason: "Network",
          config_sync_time: 1780000000000,
        },
        experiment: {
          experiment_id: "kundli_intent_marriage",
          status: "assigned",
          variant_id: "kundli-b",
          rule_id: "autotune_kundli",
          group_name: "kundli-b",
          reason: "Network",
          config_sync_time: 1780000000000,
        },
      },
    })]);
  });

  it("stamps the Statsig baseline holdout as holdout_forced", async () => {
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-holdout" }, traits: { intent: "marriage" } });
    const event = lastEvent();
    assertSpecChecks(event);
    expect(event.properties.resolved).toMatch(/kundli_report=default \(baseline\)$/);
    expect(event.properties.other_assignments[0]).toMatchObject({
      chosen: "default",
      mechanism: "holdout_forced",
      allocator: "statsig_baseline_holdout",
      policy_id: "hiastro_baseline",
      is_holdout: true,
      holdout_probability: null,
      statsig: { baseline: { rule_id: "rule_holdout", group_name: "Holdout", use_autotune: false } },
    });
  });

  it("records fallbacks: unknown Statsig arm, Statsig unavailable, missing release", async () => {
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-unknown-arm" }, traits: { intent: "marriage" } });
    assertSpecChecks(lastEvent());
    expect(lastEvent().properties.other_assignments[0]).toMatchObject({
      chosen: "default",
      mechanism: "fallback_default",
      fallback_reason: "variant_not_in_routing",
      statsig: { experiment: { variant_id: "arm-not-in-routing" } },
    });

    state.client = v2Client("STATSIG_MISSING");
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-7" }, traits: { intent: "marriage" } });
    assertSpecChecks(lastEvent());
    // Baseline unavailable falls through to the experiment, which is also unavailable.
    expect(lastEvent().properties.other_assignments[0]).toMatchObject({
      chosen: "default",
      mechanism: "fallback_default",
      fallback_reason: "statsig_unavailable",
      statsig: { baseline: { status: "unavailable" }, experiment: { status: "unavailable" } },
    });

    state.client = v2Client();
    state.routing = [fixedSplitUpgrade({ holdoutPercent: 0, variants: [variant("control", 0), variant("marriage-01", 1)] })];
    state.missingBindings.add("binding-marriage-01");
    const config = await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-7" } });
    assertSpecChecks(lastEvent());
    expect(config.placements.upgrade_pro).toBeNull();
    expect(lastEvent().properties.assignment).toMatchObject({ chosen: "marriage-01", served: false });
  });

  it("stamps legacy environments too", async () => {
    state.client = { id: "client-legacy", configSource: "legacy" };
    state.legacyRows = [{
      id: "pl_legacy",
      trigger: "onboarding",
      enabled: true,
      status: "active",
      default_variant_id: "var_a",
      experiment_id: "legacy_experiment",
      targeting_rules: [],
      statsig_project_name: "legacy",
      statsig_server_secret_env_var: "STATSIG_HIASTRO",
      sdk_stack: "react_native",
      spec: { layout: "hero_vertical", headline: "A", cta: "Go", theme: "light", products: [] },
      variants: [
        { id: "pv_a", variant_id: "var_a", enabled: true, fallback_rank: 0, status: "active", spec: { layout: "hero_vertical", headline: "A", cta: "Go", theme: "light", products: [] } },
        { id: "pv_b", variant_id: "var_b", enabled: true, fallback_rank: 1, status: "active", spec: { layout: "hero_vertical", headline: "B", cta: "Go", theme: "light", products: [] } },
      ],
    }];
    await postConfig({ publicKey: "pk_live_hiastro", identity: { identifiers: { stableID: "stable-9" } } });
    const event = lastEvent();
    assertSpecChecks(event);
    expect(event.properties.assignment).toMatchObject({
      placement_id: "pl_legacy",
      revision_id: null,
      chosen: "var_b",
      mechanism: "adaptive_bandit",
      policy_version: "legacy|statsig_lcut:1780000000000",
      unit_type: "stable_id",
    });
    expect(event.userId).toBe("stable-9");
  });

  it("honours the PAYWALL_ASSIGNMENT_STAMP rollout switch", async () => {
    process.env.PAYWALL_ASSIGNMENT_STAMP = "off";
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-1" }, traits: { intent: "marriage" } });
    expect(Object.keys(lastEvent().properties).sort()).toEqual(["intent", "resolved", "traits"]);

    process.env.PAYWALL_ASSIGNMENT_STAMP = "pk_live_other";
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-1" }, traits: { intent: "marriage" } });
    expect(lastEvent().properties).not.toHaveProperty("assignment");

    process.env.PAYWALL_ASSIGNMENT_STAMP = "pk_live_other,pk_live_hiastro";
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-1" }, traits: { intent: "marriage" } });
    expect(lastEvent().properties).toHaveProperty("assignment.trigger", "upgrade_pro");
  });

  it("emits an explicit null assignment when no placement resolved", async () => {
    state.routing = [{ ...statsigKundli(), status: "paused" }];
    await postConfig({ publicKey: "pk_live_hiastro", identity: { userId: "user-1" } });
    expect(lastEvent().properties).toMatchObject({ resolved: "", assignment: null });
    expect(lastEvent().properties).not.toHaveProperty("other_assignments");
  });
});
