import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConfigResponse } from "@tranzmit/shared";

vi.mock("../src/db.js", () => ({
  validatePublicKey: vi.fn(async (key: string) => key === "pk_test_valid"),
	  getPlacementsForKey: vi.fn(async () => [
	    {
	      id: "pl_1",
	      trigger: "onboarding",
	      enabled: true,
	      default_variant_id: "var_1",
	      experiment_id: null,
	      spec: {
	        layout: "hero_vertical",
        headline: "Welcome",
        cta: "Get Started",
        theme: "light",
	        products: [],
	      },
	      variants: [
	        {
	          id: "pv_1",
	          variant_id: "var_1",
	          enabled: true,
	          fallback_rank: 0,
	          spec: {
	            layout: "hero_vertical",
	            headline: "Welcome",
	            cta: "Get Started",
	            theme: "light",
	            products: [],
	          },
	        },
	      ],
	    },
	  ]),
  insertEvents: vi.fn(async () => {}),
}));

vi.mock("../src/statsig.js", () => ({
  initStatsig: vi.fn(async () => {}),
  getVariantAssignment: vi.fn(async (_user: unknown, _exp: string, def: string) => def),
  getBaselineDecision: vi.fn(async () => null),
  logStatsigEvents: vi.fn(() => {}),
  isInitialized: vi.fn(() => false),
}));

beforeEach(() => {
  process.env.PUBLIC_API_BASE_URL = "https://api.example.test";
});

async function makeRequest(
  path: string,
  method = "GET",
  body?: string
): Promise<{ status: number; body: string }> {
  const { handleConfig } = await import("../src/routes/config.js");
  const { handleEvents } = await import("../src/routes/events.js");
    const { handlePaywallDocument } = await import("../src/routes/paywall-documents.js");

  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/config") {
        await handleConfig(req, res);
      } else if (url.pathname.startsWith("/v1/paywall-documents/")) {
        await handlePaywallDocument(req, res, url.pathname);
      } else if (url.pathname === "/events") {
        await handleEvents(req, res);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const options: RequestInit = { method };
      if (body) {
        options.body = body;
        options.headers = { "Content-Type": "application/json" };
      }

      fetch(url, options)
        .then(async (r) => {
          const text = await r.text();
          server.close();
          resolve({ status: r.status, body: text });
        })
        .catch((err) => {
          server.close();
          resolve({ status: 500, body: err.message });
        });
    });
  });
}

describe("GET /config", () => {
  it("returns 400 when key is missing", async () => {
    const res = await makeRequest("/config?userId=u1");
    expect(res.status).toBe(400);
  });

  it("returns 400 when userId is missing", async () => {
    const res = await makeRequest("/config?key=pk_test_valid");
    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid public key", async () => {
    const res = await makeRequest("/config?key=pk_test_invalid&userId=u1");
    expect(res.status).toBe(401);
  });

	  it("returns config for valid key", async () => {
	    const res = await makeRequest("/config?key=pk_test_valid&userId=u1");
	    expect(res.status).toBe(200);
    const config: ConfigResponse = JSON.parse(res.body);
    expect(config.version).toBe("1.0.0");
    expect(config.placements.onboarding).toBeDefined();
    expect(config.placements.onboarding.spec.headline).toBe("Welcome");
    expect(config.placements.onboarding.spec.renderer).toBe("webview");
    expect(config.placements.onboarding.spec.document?.html).toContain("Welcome");
    expect(config.placements.onboarding.spec.document?.css).toContain("clamp(");
    expect(config.placements.onboarding.spec.document?.css).toContain("overflow-y:auto");
    expect(config.placements.onboarding.spec.document?.css).toContain("position:fixed");
    expect(config.placements.onboarding.spec.document?.css).not.toContain("overflow:hidden");
    expect(config.placements.onboarding.spec.document?.css).toContain("var(--tz-vh");
    expect(config.placements.onboarding.spec.document?.css).toContain("var(--tz-safe-bottom");
    expect(config.placements.onboarding.spec.presentation?.mode).toBe("sheet");
    expect(config.placements.onboarding.spec.document?.css).toContain("tz-presentation-fullscreen");
    expect(config.placements.onboarding.spec.document?.css).toContain("border-radius:0!important");
    expect(config.placements.onboarding.spec.document?.css).toContain("display:none!important");
    expect(config.placements.onboarding.spec.document?.url).toContain("/v1/paywall-documents/pl_1/var_1/");
	    expect("experimentId" in config.placements.onboarding).toBe(false);
	  });

	  it("changes hosted document URLs when document content changes", async () => {
	    const { ensureWebViewSpec } = await import("../src/webview-documents.js");
	    const context = {
	      publicKey: "pk_test_valid",
	      placementId: "pl_1",
	      variantKey: "var_1",
	      apiBaseUrl: "https://api.example.test",
	      includeInline: false,
	    };
	    const before = ensureWebViewSpec(
	      { renderer: "webview", templateId: "paywall", headline: "Before", cta: "Go", products: [] },
	      context
	    );
	    const after = ensureWebViewSpec(
	      { renderer: "webview", templateId: "paywall", headline: "After", cta: "Go", products: [] },
	      context
	    );

	    expect(before.cacheKey).not.toBe(after.cacheKey);
	    expect(before.document.url).not.toBe(after.document.url);
	  });

	  it("sets hosted document integrity from the exact HTML payload", async () => {
	    const { ensureWebViewSpec, webViewDocumentPayload } = await import("../src/webview-documents.js");
	    const context = {
	      publicKey: "pk_test_valid",
	      placementId: "pl_1",
	      variantKey: "var_1",
	      apiBaseUrl: "https://api.example.test",
	      includeInline: false,
	    };
	    const rawSpec = {
	      renderer: "webview",
	      templateId: "paywall",
	      document: {
	        html: "<main><h1>Welcome</h1></main>",
	        css: "h1{color:purple}",
	      },
	      products: [],
	    };
	    const configSpec = ensureWebViewSpec(rawSpec, context);
	    const payload = webViewDocumentPayload(rawSpec, context);
	    const expected = `sha256-${createHash("sha256").update(payload.html).digest("base64")}`;

	    expect(configSpec.document.integrity).toBe(expected);
	    expect(payload.integrity).toBe(expected);
	  });

	  it("returns the Statsig-assigned variant spec", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([
	      {
	        id: "pl_1",
	        trigger: "upgrade_pro",
	        enabled: true,
	        default_variant_id: "var_default",
	        experiment_id: "paywall_experiment",
	        spec: { layout: "compact", headline: "Default", cta: "Default", theme: "light", products: [] },
	        variants: [
	          {
	            id: "pv_default",
	            variant_id: "var_default",
	            enabled: true,
	            fallback_rank: 0,
	            spec: { layout: "compact", headline: "Default", cta: "Default", theme: "light", products: [] },
	          },
	          {
	            id: "pv_a",
	            variant_id: "var_a",
	            enabled: true,
	            fallback_rank: 1,
	            spec: { layout: "compact", headline: "Variant A", cta: "Try A", theme: "light", products: [] },
	          },
	        ],
	      },
	    ] as any);
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("var_a");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { userId: "u1", identifiers: { stableID: "stable_1" } },
	        traits: { plan: "free" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("var_a");
	    expect(config.placements.upgrade_pro.spec.headline).toBe("Variant A");
	    expect(config.placements.upgrade_pro.spec.renderer).toBe("webview");
	    expect(config.placements.upgrade_pro.spec.document?.html).toContain("Variant A");
	    expect(config.placements.upgrade_pro.spec.document?.url).toContain("/v1/paywall-documents/pl_1/var_a/");
	    expect("experimentId" in config.placements.upgrade_pro).toBe(false);
	    expect(vi.mocked(statsig.getVariantAssignment)).toHaveBeenCalledWith(
	      expect.objectContaining({
	        userId: "u1",
	        identifiers: { stableID: "stable_1" },
	      }),
	      "paywall_experiment",
	      "var_default",
	      expect.objectContaining({})
	    );
	  });

	  it("uses the first intent targeting rule to choose the Statsig experiment", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([
	      {
	        id: "pl_1",
	        trigger: "upgrade_pro",
	        enabled: true,
	        default_variant_id: "control",
	        experiment_id: "fallback_experiment",
	        targeting_rules: [
	          {
	            when: { intent: "wealth" },
	            statsig_experiment_id: "paywall_wealth",
	          },
	          {
	            when: { intent: "love" },
	            statsig_experiment_id: "paywall_love",
	          },
	        ],
	        spec: { layout: "compact", headline: "Control", cta: "Default", theme: "light", products: [] },
	        variants: [
	          {
	            id: "pv_control",
	            variant_id: "control",
	            enabled: true,
	            fallback_rank: 0,
	            spec: { layout: "compact", headline: "Control", cta: "Default", theme: "light", products: [] },
	          },
	          {
	            id: "pv_wealth",
	            variant_id: "wealth_arm",
	            enabled: true,
	            fallback_rank: 1,
	            spec: { layout: "compact", headline: "Hindi Wealth", cta: "Try Wealth", theme: "light", products: [] },
	          },
	        ],
	      },
	    ] as any);
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("wealth_arm");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_1" } },
	        traits: { intent: "wealth" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("wealth_arm");
	    expect(config.placements.upgrade_pro.spec.headline).toBe("Hindi Wealth");
	    expect(vi.mocked(statsig.getVariantAssignment)).toHaveBeenCalledWith(
	      expect.objectContaining({
	        traits: expect.objectContaining({ intent: "wealth" }),
	      }),
	      "paywall_wealth",
	      "control",
	      expect.objectContaining({})
	    );
	  });

	  it("falls back to the placement experiment when intent does not match a targeting rule", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([
	      {
	        id: "pl_1",
	        trigger: "upgrade_pro",
	        enabled: true,
	        default_variant_id: "control",
	        experiment_id: "fallback_experiment",
	        targeting_rules: [
	          {
	            when: { intent: "wealth" },
	            statsig_experiment_id: "paywall_wealth",
	          },
	        ],
	        spec: { layout: "compact", headline: "Control", cta: "Default", theme: "light", products: [] },
	        variants: [
	          {
	            id: "pv_control",
	            variant_id: "control",
	            enabled: true,
	            fallback_rank: 0,
	            spec: { layout: "compact", headline: "Control", cta: "Default", theme: "light", products: [] },
	          },
	          {
	            id: "pv_fallback",
	            variant_id: "fallback_arm",
	            enabled: true,
	            fallback_rank: 1,
	            spec: { layout: "compact", headline: "Fallback Experiment", cta: "Try Fallback", theme: "light", products: [] },
	          },
	        ],
	      },
	    ] as any);
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("fallback_arm");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_1" } },
	        traits: { intent: "career" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("fallback_arm");
	    expect(config.placements.upgrade_pro.spec.headline).toBe("Fallback Experiment");
	    expect(vi.mocked(statsig.getVariantAssignment)).toHaveBeenCalledWith(
	      expect.anything(),
	      "fallback_experiment",
	      "control",
	      expect.objectContaining({})
	    );
	  });

	  it("falls back to default spec when Statsig returns an unknown variant", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([
	      {
	        id: "pl_1",
	        trigger: "upgrade_pro",
	        enabled: true,
	        default_variant_id: "var_default",
	        experiment_id: "paywall_experiment",
	        spec: { layout: "compact", headline: "Default", cta: "Default", theme: "light", products: [] },
	        variants: [
	          {
	            id: "pv_default",
	            variant_id: "var_default",
	            enabled: true,
	            fallback_rank: 0,
	            spec: { layout: "compact", headline: "Default", cta: "Default", theme: "light", products: [] },
	          },
	        ],
	      },
	    ] as any);
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("var_missing");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_1" } },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("var_default");
	    expect(config.placements.upgrade_pro.spec.headline).toBe("Default");
	  });

	  // ─── baseline pre-check (intent-routed placements with a control holdout) ───
	  const baselinePlacementRow = () => ({
	    id: "pl_baseline",
	    trigger: "upgrade_pro",
	    enabled: true,
	    default_variant_id: "control",
	    experiment_id: "paywall_intent_marriage",
	    targeting_rules: [
	      { type: "baseline", statsig_experiment_id: "hiastro-prod-baseline" },
	      { when: { intent: "marriage" }, statsig_experiment_id: "paywall_intent_marriage" },
	      { when: { intent: "love" }, statsig_experiment_id: "paywall_intent_love" },
	    ],
	    spec: { layout: "compact", headline: "Control", cta: "Default", theme: "light", products: [] },
	    variants: [
	      {
	        id: "pv_control",
	        variant_id: "control",
	        enabled: true,
	        fallback_rank: 0,
	        spec: { layout: "compact", headline: "Control Holdout", cta: "Default", theme: "light", products: [] },
	      },
	      {
	        id: "pv_marriage_arm",
	        variant_id: "marriage_arm",
	        enabled: true,
	        fallback_rank: 1,
	        spec: { layout: "compact", headline: "Marriage Autotune", cta: "Try Marriage", theme: "light", products: [] },
	      },
	    ],
	  });

	  it("baseline use_autotune=false serves the baseline variant_id regardless of intent", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(statsig.getVariantAssignment).mockClear();
	    vi.mocked(statsig.getBaselineDecision).mockClear();
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([baselinePlacementRow()] as any);
	    vi.mocked(statsig.getBaselineDecision).mockResolvedValueOnce({ useAutotune: false, variantId: "control" });

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_holdout" } },
	        traits: { intent: "marriage" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("control");
	    expect(config.placements.upgrade_pro.spec.headline).toBe("Control Holdout");
	    // Intent routing must NOT be consulted in this branch.
	    expect(vi.mocked(statsig.getVariantAssignment)).not.toHaveBeenCalled();
	  });

	  it("baseline use_autotune=true falls through to intent-based MAB routing", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([baselinePlacementRow()] as any);
	    vi.mocked(statsig.getBaselineDecision).mockResolvedValueOnce({ useAutotune: true, variantId: null });
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("marriage_arm");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_autotune" } },
	        traits: { intent: "marriage" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("marriage_arm");
	    expect(config.placements.upgrade_pro.spec.headline).toBe("Marriage Autotune");
	    // The intent-matched experiment must be the one queried.
	    expect(vi.mocked(statsig.getVariantAssignment)).toHaveBeenCalledWith(
	      expect.objectContaining({ traits: expect.objectContaining({ intent: "marriage" }) }),
	      "paywall_intent_marriage",
	      "control",
	      expect.objectContaining({})
	    );
	  });

	  it("baseline Statsig outage (null) falls through to intent routing — never breaks the paywall", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([baselinePlacementRow()] as any);
	    vi.mocked(statsig.getBaselineDecision).mockResolvedValueOnce(null);
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("marriage_arm");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_outage" } },
	        traits: { intent: "marriage" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("marriage_arm");
	    expect(vi.mocked(statsig.getVariantAssignment)).toHaveBeenCalled();
	  });

	  it("baseline use_autotune=false with null variant_id serves the placement default variant (safe)", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(statsig.getVariantAssignment).mockClear();
	    vi.mocked(statsig.getBaselineDecision).mockClear();
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([baselinePlacementRow()] as any);
	    vi.mocked(statsig.getBaselineDecision).mockResolvedValueOnce({ useAutotune: false, variantId: null });

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_safe_default" } },
	        traits: { intent: "marriage" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("control");
	    expect(vi.mocked(statsig.getVariantAssignment)).not.toHaveBeenCalled();
	  });

	  it("placements WITHOUT a baseline rule are unaffected (intent routing works as before)", async () => {
	    const db = await import("../src/db.js");
	    const statsig = await import("../src/statsig.js");
	    vi.mocked(statsig.getVariantAssignment).mockClear();
	    vi.mocked(statsig.getBaselineDecision).mockClear();
	    const row = baselinePlacementRow();
	    // Strip the baseline rule entirely.
	    (row as any).targeting_rules = (row as any).targeting_rules.filter((r: any) => r.type !== "baseline");
	    vi.mocked(db.getPlacementsForKey).mockResolvedValueOnce([row] as any);
	    vi.mocked(statsig.getVariantAssignment).mockResolvedValueOnce("marriage_arm");

	    const res = await makeRequest(
	      "/config",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_no_baseline" } },
	        traits: { intent: "marriage" },
	      })
	    );

	    expect(res.status).toBe(200);
	    const config: ConfigResponse = JSON.parse(res.body);
	    expect(config.placements.upgrade_pro.variantId).toBe("marriage_arm");
	    expect(vi.mocked(statsig.getBaselineDecision)).not.toHaveBeenCalled();
	    expect(vi.mocked(statsig.getVariantAssignment)).toHaveBeenCalled();
	  });

	  it("serves hosted WebView document payloads by immutable cache key", async () => {
	    const configRes = await makeRequest("/config?key=pk_test_valid&userId=u1");
	    const config: ConfigResponse = JSON.parse(configRes.body);
	    const doc = config.placements.onboarding.spec.document;
	    const hostedPath = new URL(doc!.url!).pathname + "?key=pk_test_valid";

	    const res = await makeRequest(hostedPath);

	    expect(res.status).toBe(200);
	    const payload = JSON.parse(res.body);
	    expect(payload.cacheKey).toBe(config.placements.onboarding.spec.cacheKey);
	    expect(payload.html).toContain("Welcome");
	    expect(payload.integrity).toMatch(/^sha256-/);
	  });
	});

describe("POST /events", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await makeRequest("/events", "POST", "not json");
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing fields", async () => {
    const res = await makeRequest("/events", "POST", JSON.stringify({ publicKey: "pk" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid public key", async () => {
    const res = await makeRequest(
      "/events",
      "POST",
      JSON.stringify({
        publicKey: "pk_test_invalid",
        userId: "u1",
        sessionId: "sess_1",
        events: [{ event: "page_view", timestamp: Date.now() }],
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 204 for empty events array", async () => {
    const res = await makeRequest(
      "/events",
      "POST",
      JSON.stringify({
        publicKey: "pk_test_valid",
        userId: "u1",
        sessionId: "sess_1",
        events: [],
      })
    );
    expect(res.status).toBe(204);
  });

	  it("returns 204 for valid event batch", async () => {
	    const statsig = await import("../src/statsig.js");
    const res = await makeRequest(
      "/events",
      "POST",
      JSON.stringify({
        publicKey: "pk_test_valid",
        userId: "u1",
        sessionId: "sess_1",
        events: [{ event: "page_view", timestamp: Date.now() }],
      })
    );
    expect(res.status).toBe(204);
	    expect(vi.mocked(statsig.logStatsigEvents)).toHaveBeenCalledWith(
	      expect.objectContaining({
	        publicKey: "pk_test_valid",
	        sessionId: "sess_1",
	        identity: expect.objectContaining({
	          userId: "u1",
	          storageUserId: "u1",
	        }),
	      })
	    );
	  });

	  it("accepts anonymous events with stable identity", async () => {
	    const statsig = await import("../src/statsig.js");
	    const res = await makeRequest(
	      "/events",
	      "POST",
	      JSON.stringify({
	        publicKey: "pk_test_valid",
	        identity: { identifiers: { stableID: "stable_anon" } },
	        sessionId: "sess_anon",
	        events: [{ event: "conversion", timestamp: Date.now(), properties: { revenue: 100 } }],
	      })
	    );
	    expect(res.status).toBe(204);
	    expect(vi.mocked(statsig.logStatsigEvents)).toHaveBeenCalledWith(
	      expect.objectContaining({
	        identity: expect.objectContaining({
	          identifiers: { stableID: "stable_anon" },
	          storageUserId: "stable_anon",
	        }),
	      })
	    );
	  });
	});
