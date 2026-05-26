import { describe, it, expect, vi, beforeEach } from "vitest";
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
  logStatsigEvents: vi.fn(() => {}),
  isInitialized: vi.fn(() => false),
}));

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
