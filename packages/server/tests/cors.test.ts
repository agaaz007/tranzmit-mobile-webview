import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyRouteCors, handleCorsPreflight, isExactSameOrigin } from "../src/middleware/cors.js";

const originalPublicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;

function request(input: {
  method?: string;
  origin?: string;
  host?: string;
  forwardedHost?: string;
  publicHost?: string;
  requestedMethod?: string;
  requestedHeaders?: string;
} = {}): IncomingMessage {
  return {
    method: input.method || "GET",
    headers: {
      host: input.host || "api.example.com",
      origin: input.origin,
      "x-forwarded-proto": "https",
      "x-forwarded-host": input.forwardedHost,
      "x-tranzmit-public-host": input.publicHost,
      "access-control-request-method": input.requestedMethod,
      "access-control-request-headers": input.requestedHeaders,
    },
    socket: {},
  } as IncomingMessage;
}

function response(): {
  res: ServerResponse;
  status: () => number | undefined;
  body: () => string;
  header: (name: string) => unknown;
} {
  const headers = new Map<string, unknown>();
  let responseStatus: number | undefined;
  let responseBody = "";
  const res = {
    setHeader: (name: string, value: unknown) => { headers.set(name.toLowerCase(), value); },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    writeHead: (status: number, values?: Record<string, unknown>) => {
      responseStatus = status;
      for (const [name, value] of Object.entries(values || {})) headers.set(name.toLowerCase(), value);
      return res;
    },
    end: (chunk?: unknown) => { responseBody = String(chunk || ""); return res; },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => responseStatus,
    body: () => responseBody,
    header: (name) => headers.get(name.toLowerCase()),
  };
}

describe("route-specific CORS", () => {
  beforeEach(() => {
    delete process.env.PUBLIC_API_BASE_URL;
  });

  afterEach(() => {
    if (originalPublicApiBaseUrl === undefined) {
      delete process.env.PUBLIC_API_BASE_URL;
    } else {
      process.env.PUBLIC_API_BASE_URL = originalPublicApiBaseUrl;
    }
  });

  it("keeps wildcard CORS on public SDK endpoints", () => {
    for (const path of ["/v1/config", "/v1/events", "/v1/paywall-documents/doc/hash", "/assets/image.webp", "/health"]) {
      const output = response();
      applyRouteCors(request({ origin: "https://customer.example" }), output.res, path);
      expect(output.header("Access-Control-Allow-Origin"), path).toBe("*");
    }
  });

  it("never emits wildcard CORS for admin or dashboard routes", () => {
    for (const path of ["/", "/config-dashboard", "/admin/clients", "/v1/admin/clients", "/v1/usage"]) {
      const crossOrigin = response();
      applyRouteCors(request({ origin: "https://evil.example" }), crossOrigin.res, path);
      expect(crossOrigin.header("Access-Control-Allow-Origin"), path).toBeUndefined();
      expect(crossOrigin.header("Content-Security-Policy"), path).toBe("frame-ancestors 'none'");
      expect(crossOrigin.header("X-Frame-Options"), path).toBe("DENY");
      expect(crossOrigin.header("X-Content-Type-Options"), path).toBe("nosniff");
      expect(crossOrigin.header("Referrer-Policy"), path).toBe("no-referrer");

      const sameOrigin = response();
      applyRouteCors(request({ origin: "https://api.example.com" }), sameOrigin.res, path);
      expect(sameOrigin.header("Access-Control-Allow-Origin"), path).toBe("https://api.example.com");
      expect(sameOrigin.header("Access-Control-Allow-Credentials"), path).toBe("true");
    }
  });

  it("answers public preflight safely", () => {
    const output = response();
    expect(handleCorsPreflight(request({
      method: "OPTIONS",
      origin: "https://customer.example",
      requestedMethod: "POST",
      requestedHeaders: "content-type",
    }), output.res, "/v1/config")).toBe(true);
    expect(output.status()).toBe(204);
    expect(output.header("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects cross-origin admin preflight", () => {
    const output = response();
    expect(handleCorsPreflight(request({
      method: "OPTIONS",
      origin: "https://evil.example",
      requestedMethod: "PATCH",
      requestedHeaders: "content-type, authorization",
    }), output.res, "/admin/placements/pl_1")).toBe(true);
    expect(output.status()).toBe(403);
    expect(output.header("Access-Control-Allow-Origin")).toBeUndefined();
    expect(JSON.parse(output.body())).toEqual({ error: "Cross-origin admin requests are not allowed" });
  });

  it("allows exact same-origin admin preflight and rejects unlisted headers", () => {
    const allowed = response();
    handleCorsPreflight(request({
      method: "OPTIONS",
      origin: "https://api.example.com",
      requestedMethod: "PATCH",
      requestedHeaders: "content-type, x-admin-secret",
    }), allowed.res, "/admin/placements/pl_1");
    expect(allowed.status()).toBe(204);
    expect(allowed.header("Access-Control-Allow-Origin")).toBe("https://api.example.com");

    const denied = response();
    handleCorsPreflight(request({
      method: "OPTIONS",
      origin: "https://api.example.com",
      requestedMethod: "PATCH",
      requestedHeaders: "x-untrusted-header",
    }), denied.res, "/admin/placements/pl_1");
    expect(denied.status()).toBe(400);
  });

  it("resolves direct, forwarded, configured, and trusted proxy origins", () => {
    expect(isExactSameOrigin(request({
      host: "api.example.com",
      origin: "https://api.example.com",
    }))).toBe(true);

    expect(isExactSameOrigin(request({
      host: "railway.internal",
      forwardedHost: "dashboard.example.com",
      origin: "https://dashboard.example.com",
    }))).toBe(true);

    process.env.PUBLIC_API_BASE_URL = "https://api.tranzmitai.com/v1/";
    expect(isExactSameOrigin(request({
      host: "railway.internal",
      origin: "https://api.tranzmitai.com",
    }))).toBe(true);

    delete process.env.PUBLIC_API_BASE_URL;
    expect(isExactSameOrigin(request({
      host: "api-production-2146.up.railway.app",
      forwardedHost: "api-production-2146.up.railway.app",
      publicHost: "api.tranzmitai.com",
      origin: "https://api.tranzmitai.com",
    }))).toBe(true);
  });

  it("rejects an origin that does not match the resolved public origin", () => {
    expect(isExactSameOrigin(request({
      host: "api-production-2146.up.railway.app",
      publicHost: "api.tranzmitai.com",
      origin: "https://evil.example",
    }))).toBe(false);
  });
});
