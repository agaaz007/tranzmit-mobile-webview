import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Regression guard for the default ('statsig' / unset) assignment path.
//
// The snapshot in __snapshots__/assignment-default-path.test.ts.snap was
// recorded against the resolver BEFORE fixed-split assignment and the
// assignment stamp existed. It pins, for legacy and V2 environments:
//   - the exact /v1/config response body (minus the per-request timestamp),
//   - every Statsig SDK evaluation (experiment name + StatsigUser),
//   - the `paywall_resolved` row minus the additive `assignment` keys,
//   - the `[tz.resolve]` log payload.
// Statsig is mocked at the SDK boundary (statsig-node), not at our statsig.ts
// wrapper, so the guard survives internal refactors of the wrapper.
// Never update this snapshot to make a change pass: a diff here means the
// default serving path changed.

const state = vi.hoisted(() => ({
  statsigCalls: [] as Array<{ experiment: string; user: unknown }>,
  events: [] as unknown[],
  routing: [] as unknown[],
  client: null as unknown,
  legacyRows: [] as unknown[],
}));

vi.mock("statsig-node", async () => {
  const actual = await vi.importActual<typeof import("statsig-node")>("statsig-node");
  const { DynamicConfig } = actual;
  const details = (reason: string) => ({ configSyncTime: 1_780_000_000_000, initTime: 1_779_999_000_000, reason });
  class FakeStatsigServer {
    constructor(readonly secret: string) {}
    async initializeAsync() {}
    async shutdownAsync() {}
    logEvent() {}
    getExperimentSync(user: { userID?: string }, experiment: string) {
      state.statsigCalls.push({ experiment, user: JSON.parse(JSON.stringify(user)) });
      const userID = user.userID || "";
      if (experiment === "hiastro_baseline") {
        if (userID === "user-holdout") {
          return new DynamicConfig(experiment, { use_autotune: false, variant_id: "control" }, "rule_holdout", "Holdout", "userID", [], null, details("Network") as any);
        }
        if (userID === "user-baseline-string") {
          return new DynamicConfig(experiment, { use_autotune: "true" }, "rule_autotune", "Autotune", "userID", [], null, details("Network") as any);
        }
        return new DynamicConfig(experiment, { use_autotune: true }, "rule_autotune", "Autotune", "userID", [], null, details("Network") as any);
      }
      if (experiment === "paywall_intent_marriage") {
        const variant = userID === "user-unknown-arm" ? "arm-not-in-routing" : "marriage-02";
        return new DynamicConfig(experiment, { variant_id: variant }, "autotune_marriage", variant, "userID", [], null, details("Network") as any);
      }
      if (experiment === "paywall_default") {
        return new DynamicConfig(experiment, { variant_id: "marriage-03" }, "ab_default", "Test", "userID", [], null, details("Network") as any);
      }
      if (experiment === "legacy_experiment") {
        return new DynamicConfig(experiment, { variant_id: "var_b" }, "legacy_rule", "B", "userID", [], null, details("Network") as any);
      }
      return new DynamicConfig(experiment, {}, "", null, null, [], null, details("Unrecognized") as any);
    }
  }
  return { ...actual, StatsigServer: FakeStatsigServer, default: { ...(actual as any).default } };
});

vi.mock("../src/db.js", () => ({
  pool: { connect: vi.fn(), end: vi.fn() },
  query: vi.fn(async () => ({ rows: [] })),
  validatePublicKey: vi.fn(async () => true),
  getPlacementsForKey: vi.fn(async () => state.legacyRows),
  insertEvents: vi.fn(async (publicKey: string, userId: string, sessionId: string, events: any[], identity: unknown) => {
    state.events.push({ publicKey, userId, sessionId, events, identity });
  }),
}));

vi.mock("../src/config-store.js", () => ({
  database: { query: vi.fn() },
  getEnvironmentPaywall: vi.fn(),
  withTransaction: vi.fn(),
  getConfigClient: vi.fn(async () => state.client),
  getV2PublishedRouting: vi.fn(async () => state.routing),
  getV2PublishedReleases: vi.fn(async (_clientId: string, bindingIds: string[]) => new Map(
    bindingIds.map((bindingId) => [bindingId, release(bindingId)])
  )),
}));

const ADDITIVE_EVENT_KEYS = ["assignment", "other_assignments"];

function release(bindingId: string) {
  const html = `<main data-binding="${bindingId}"><button data-tranzmit-action="cta" data-product-id="pro_yearly">Go</button></main>`;
  return {
    bindingId,
    releaseId: `release-${bindingId}`,
    contentRevisionId: `content-${bindingId}`,
    content: {
      renderer: "webview",
      document: { html },
      cta: { text: "Continue" },
      dismiss: { enabled: true },
    },
    products: [{ id: "pro_yearly", name: "Pro", price: "₹999/year" }],
    checkout: { provider: { planId: "plan_yearly" } },
    documentPayload: {
      html,
      css: "main{color:#111}",
      cacheKey: `cache-${bindingId}`,
      revision: `content-${bindingId}`,
      integrity: `sha256-${bindingId}`,
    },
  };
}

function variant(variantId: string, fallbackRank: number, weight: number) {
  return {
    id: `route-${variantId}`,
    variantId,
    bindingId: `binding-${variantId}`,
    status: "active",
    fallbackRank,
    weight,
  };
}

function upgradeRouting(extra: Record<string, unknown> = {}) {
  return {
    placementId: "pl_upgrade",
    revisionId: "rev-upgrade-3",
    trigger: "upgrade_pro",
    status: "active",
    defaultVariantKey: "control",
    defaultBindingId: "binding-control",
    experimentId: "paywall_default",
    targetingRules: [
      { type: "baseline", statsig_experiment_id: "hiastro_baseline" },
      { when: { intent: "marriage" }, statsig_experiment_id: "paywall_intent_marriage" },
    ],
    variants: [
      variant("control", 0, 25),
      variant("marriage-01", 1, 25),
      variant("marriage-02", 2, 25),
      variant("marriage-03", 3, 25),
    ],
    ...extra,
  };
}

function staticRouting() {
  return {
    placementId: "pl_kundli",
    revisionId: "rev-kundli-1",
    trigger: "kundli_report",
    status: "active",
    defaultVariantKey: "default",
    defaultBindingId: "binding-default",
    experimentId: null,
    targetingRules: [],
    variants: [variant("default", 0, 50)],
  };
}

function pausedRouting() {
  return {
    placementId: "pl_paused",
    revisionId: "rev-paused-1",
    trigger: "paused_trigger",
    status: "paused",
    defaultVariantKey: "default",
    defaultBindingId: "binding-default",
    experimentId: null,
    targetingRules: [],
    variants: [variant("default", 0, 50)],
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

function legacyRow() {
  const spec = (headline: string) => ({
    layout: "hero_vertical",
    headline,
    cta: "Continue",
    theme: "light",
    products: [],
  });
  return {
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
    spec: spec("A"),
    variants: [
      { id: "pv_a", variant_id: "var_a", enabled: true, fallback_rank: 0, status: "active", spec: spec("A") },
      { id: "pv_b", variant_id: "var_b", enabled: true, fallback_rank: 1, status: "active", spec: spec("B") },
    ],
  };
}

async function postConfig(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const { handleConfig } = await import("../src/routes/config.js");
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      await handleConfig(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}/v1/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          const text = await response.text();
          server.close();
          resolve({ status: response.status, body: JSON.parse(text) });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

async function flushEvents() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function capture(name: string, body: Record<string, unknown>) {
  state.statsigCalls.length = 0;
  state.events.length = 0;
  const logs: unknown[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((tag: unknown, payload: unknown) => {
    if (tag === "[tz.resolve]") logs.push(JSON.parse(String(payload)));
  });
  const response = await postConfig(body);
  await flushEvents();
  logSpy.mockRestore();
  expect(response.status).toBe(200);
  delete response.body._meta.fetched_at;
  const events = (state.events as any[]).map((batch) => ({
    ...batch,
    events: batch.events.map((event: any) => {
      expect(typeof event.timestamp).toBe("number");
      const properties = { ...event.properties };
      for (const key of ADDITIVE_EVENT_KEYS) delete properties[key];
      return { event: event.event, properties };
    }),
  }));
  return { name, response: response.body, statsigCalls: [...state.statsigCalls], events, logs };
}

beforeEach(() => {
  process.env.PUBLIC_API_BASE_URL = "https://api.example.test";
  process.env.STATSIG_HIASTRO = "secret-hiastro";
  delete process.env.STATSIG_MISSING;
  state.client = v2Client();
  state.routing = [upgradeRouting(), staticRouting(), pausedRouting()];
  state.legacyRows = [legacyRow()];
});

afterAll(async () => {
  const { shutdownStatsig } = await import("../src/statsig.js");
  await shutdownStatsig();
});

describe("default (statsig) assignment path is unchanged", () => {
  it("matches the pre-change V2 and legacy resolution snapshot", async () => {
    const scenarios = [];

    scenarios.push(await capture("v2 baseline holdout", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-holdout", identifiers: { stableID: "stable-holdout" } },
      traits: { intent: "marriage" },
    }));
    scenarios.push(await capture("v2 autotune marriage", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-autotune", identifiers: { stableID: "stable-autotune" } },
      traits: { intent: "marriage" },
    }));
    scenarios.push(await capture("v2 autotune string boolean", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-baseline-string" },
      traits: { intent: "marriage" },
    }));
    scenarios.push(await capture("v2 unknown statsig arm falls back to default", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-unknown-arm" },
      traits: { intent: "marriage" },
    }));
    scenarios.push(await capture("v2 non-matching intent uses placement experiment", {
      publicKey: "pk_live_hiastro",
      identity: { identifiers: { stableID: "stable-anonymous" } },
      traits: { intent: "career" },
    }));

    state.routing = [upgradeRouting({ assignmentMode: "statsig" }), staticRouting()];
    scenarios.push(await capture("v2 explicit statsig mode", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-autotune" },
      traits: { intent: "marriage" },
    }));

    state.routing = [upgradeRouting({ targetingRules: [], experimentId: "unregistered_experiment" })];
    scenarios.push(await capture("v2 unrecognized experiment", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-autotune" },
    }));

    state.client = v2Client("STATSIG_MISSING");
    state.routing = [upgradeRouting()];
    scenarios.push(await capture("v2 statsig secret missing", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-autotune" },
      traits: { intent: "marriage" },
    }));

    state.client = { id: "client-legacy", configSource: "legacy" };
    scenarios.push(await capture("legacy statsig experiment", {
      publicKey: "pk_live_hiastro",
      identity: { userId: "user-legacy", identifiers: { stableID: "stable-legacy" } },
      traits: { intent: "marriage" },
    }));

    expect(scenarios).toMatchSnapshot();
  });
});
