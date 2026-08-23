// Route-level compression contract for the cellular-payload fix:
// /v1/paywall-documents/* (271-290KB Influish docs) and /v1/config must gzip
// for clients that accept it, keep identity responses byte-exact, and keep
// serving 304s to clients that cached the pre-compression STRONG ETag.
import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConfigResponse } from "@tranzmit/shared";

vi.mock("../src/db.js", () => ({
  query: vi.fn(async (sql: string) => ({
    rows: /FROM clients\s+WHERE public_key/i.test(sql) ? [{
      id: "client-test",
      public_key: "pk_test_valid",
      project_key: "test-project",
      environment_kind: "test",
      management_status: "editable",
      config_source: "legacy",
      sdk_stack: "react_native",
      statsig_project_name: null,
      statsig_server_secret_env_var: null,
    }] : [],
  })),
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
        // Long headline guarantees both the config response and the hosted
        // document clear the 1KB compression threshold.
        headline: "Welcome to the paywall " + "with a very long headline ".repeat(80),
        cta: "Get Started",
        theme: "light",
        products: [],
      },
      variants: [],
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

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const { handleConfig } = await import("../src/routes/config.js");
  const { handlePaywallDocument } = await import("../src/routes/paywall-documents.js");

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/v1/config") {
      await handleConfig(req, res);
    } else if (url.pathname.startsWith("/v1/paywall-documents/")) {
      await handlePaywallDocument(req, res, url.pathname);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    return await fn(addr.port);
  } finally {
    server.close();
  }
}

// Raw node:http request: undici fetch would auto-send Accept-Encoding AND
// transparently gunzip, hiding the encoded bytes we need to assert on.
function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method || "GET", headers: options.headers || {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function hostedDocPath(port: number): Promise<string> {
  const identityRes = await rawRequest(port, "/v1/config?key=pk_test_valid&userId=u1");
  const config: ConfigResponse = JSON.parse(identityRes.body.toString("utf8"));
  const docUrl = config.placements.onboarding?.spec.document?.url;
  expect(docUrl).toBeTruthy();
  return new URL(docUrl!).pathname + "?key=pk_test_valid";
}

describe("GET /v1/paywall-documents compression", () => {
  it("gzips the document with weak ETag, Vary, and a decodable body", async () => {
    await withServer(async (port) => {
      const path = await hostedDocPath(port);
      const res = await rawRequest(port, path, { headers: { "accept-encoding": "gzip" } });

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(res.headers["etag"]).toMatch(/^W\/"[a-f0-9]+"$/);
      expect(Number(res.headers["content-length"])).toBe(res.body.byteLength);

      const payload = JSON.parse(gunzipSync(res.body).toString("utf8"));
      expect(payload.html).toContain("Welcome to the paywall");
      expect(payload.integrity).toMatch(/^sha256-/);
    });
  });

  it("serves identity bytes with correct Content-Length when gzip is not accepted", async () => {
    await withServer(async (port) => {
      const path = await hostedDocPath(port);
      const gz = await rawRequest(port, path, { headers: { "accept-encoding": "gzip" } });
      const res = await rawRequest(port, path, { headers: { "accept-encoding": "identity" } });

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(Number(res.headers["content-length"])).toBe(res.body.byteLength);
      expect(res.body.byteLength).toBeGreaterThan(gz.body.byteLength);
      expect(JSON.parse(res.body.toString("utf8")).html).toContain("Welcome to the paywall");
    });
  });

  it("returns 304 with Vary for the new weak ETag form", async () => {
    await withServer(async (port) => {
      const path = await hostedDocPath(port);
      const first = await rawRequest(port, path, { headers: { "accept-encoding": "gzip" } });
      const etag = first.headers["etag"] as string;
      expect(etag.startsWith('W/"')).toBe(true);

      const res = await rawRequest(port, path, {
        headers: { "accept-encoding": "gzip", "if-none-match": etag },
      });

      expect(res.status).toBe(304);
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(res.headers["etag"]).toBe(etag);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.body.byteLength).toBe(0);
    });
  });

  it("returns 304 for clients still holding the legacy STRONG ETag from before the deploy", async () => {
    await withServer(async (port) => {
      const path = await hostedDocPath(port);
      const first = await rawRequest(port, path, {});
      const weakEtag = first.headers["etag"] as string;
      const legacyStrongEtag = weakEtag.replace(/^W\//, "");

      const res = await rawRequest(port, path, {
        headers: { "if-none-match": legacyStrongEtag },
      });

      expect(res.status).toBe(304);
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(res.headers["etag"]).toBe(weakEtag);
    });
  });

  it("matches weak ETags inside comma-separated If-None-Match lists", async () => {
    await withServer(async (port) => {
      const path = await hostedDocPath(port);
      const first = await rawRequest(port, path, {});
      const etag = first.headers["etag"] as string;

      const res = await rawRequest(port, path, {
        headers: { "if-none-match": `"stale-etag", ${etag}` },
      });

      expect(res.status).toBe(304);
    });
  });

  it("HEAD with gzip accept returns the gzip headers and an empty body", async () => {
    await withServer(async (port) => {
      const path = await hostedDocPath(port);
      const res = await rawRequest(port, path, {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(res.headers["etag"]).toMatch(/^W\//);
      expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
      expect(res.body.byteLength).toBe(0);
    });
  });
});

describe("POST/GET /v1/config compression", () => {
  it("gzips the config response and keeps no-store + CORS headers", async () => {
    await withServer(async (port) => {
      const res = await rawRequest(port, "/v1/config?key=pk_test_valid&userId=u1", {
        headers: { "accept-encoding": "gzip" },
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(Number(res.headers["content-length"])).toBe(res.body.byteLength);

      const config: ConfigResponse = JSON.parse(gunzipSync(res.body).toString("utf8"));
      expect(config.version).toBe("1.0.0");
      expect(config.placements.onboarding).toBeDefined();
    });
  });

  it("serves identity config bytes when gzip is not accepted", async () => {
    await withServer(async (port) => {
      const res = await rawRequest(port, "/v1/config?key=pk_test_valid&userId=u1", {
        headers: { "accept-encoding": "identity" },
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers["vary"]).toBe("Accept-Encoding");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(Number(res.headers["content-length"])).toBe(res.body.byteLength);

      const config: ConfigResponse = JSON.parse(res.body.toString("utf8"));
      expect(config.version).toBe("1.0.0");
    });
  });
});
