import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { publicApiBaseUrl } from "../src/webview-documents.js";

const originalPublicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;

afterEach(() => {
  if (originalPublicApiBaseUrl === undefined) {
    delete process.env.PUBLIC_API_BASE_URL;
  } else {
    process.env.PUBLIC_API_BASE_URL = originalPublicApiBaseUrl;
  }
});

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("publicApiBaseUrl", () => {
  it("keeps the direct Railway request host when no trusted proxy host is present", () => {
    delete process.env.PUBLIC_API_BASE_URL;

    expect(publicApiBaseUrl(request({
      host: "api-production-2146.up.railway.app",
      "x-forwarded-proto": "https",
    }))).toBe("https://api-production-2146.up.railway.app");
  });

  it("uses the allowlisted Vercel public host for proxied requests", () => {
    delete process.env.PUBLIC_API_BASE_URL;

    expect(publicApiBaseUrl(request({
      host: "api-production-2146.up.railway.app",
      "x-forwarded-host": "api-production-2146.up.railway.app",
      "x-forwarded-proto": "https",
      "x-tranzmit-public-host": "api.tranzmitai.com",
    }))).toBe("https://api.tranzmitai.com");
  });

  it("allows the isolated Vercel parity hostname", () => {
    delete process.env.PUBLIC_API_BASE_URL;

    expect(publicApiBaseUrl(request({
      host: "api-production-2146.up.railway.app",
      "x-tranzmit-public-host": " API-PROXY-PREVIEW.TRANZMITAI.COM ",
    }))).toBe("https://api-proxy-preview.tranzmitai.com");
  });

  it("ignores untrusted public-host values", () => {
    delete process.env.PUBLIC_API_BASE_URL;

    expect(publicApiBaseUrl(request({
      host: "api-production-2146.up.railway.app",
      "x-forwarded-host": "api-production-2146.up.railway.app",
      "x-forwarded-proto": "https",
      "x-tranzmit-public-host": "attacker.example",
    }))).toBe("https://api-production-2146.up.railway.app");
  });

  it("keeps an explicit server base URL authoritative", () => {
    process.env.PUBLIC_API_BASE_URL = "https://explicit.example/";

    expect(publicApiBaseUrl(request({
      host: "api-production-2146.up.railway.app",
      "x-tranzmit-public-host": "api.tranzmitai.com",
    }))).toBe("https://explicit.example");
  });
});
