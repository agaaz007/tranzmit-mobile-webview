import { beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  LIMITS,
  enforcePublicRateLimit,
  getClientIp,
  publicKeyFromJson,
  resetRateLimitsForTests,
} from "../src/middleware/rate-limit.js";
import { readBody } from "../src/middleware/body-parser.js";

const KEY = "pk_live_customer";

function exhaust(scope: "config" | "document" | "events", publicKey: string | null, ip: string, n: number) {
  let last = enforcePublicRateLimit(scope, publicKey, ip);
  for (let i = 1; i < n; i += 1) last = enforcePublicRateLimit(scope, publicKey, ip);
  return last;
}

describe("public endpoint rate limits", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("caps a single client without starving other clients on the same public key", () => {
    const max = LIMITS.configPerClient.max;
    expect(exhaust("config", KEY, "10.0.0.1", max).allowed).toBe(true);

    const denied = enforcePublicRateLimit("config", KEY, "10.0.0.1");
    expect(denied.allowed).toBe(false);
    expect(denied.limitedBy).toBe("client");
    expect(denied.resetAt).toBeGreaterThan(Date.now());

    // A different handset on the same app is unaffected.
    expect(enforcePublicRateLimit("config", KEY, "10.0.0.2").allowed).toBe(true);
  });

  it("lets a CGNAT crowd behind one IP flush events at a normal rate", () => {
    // 100 handsets sharing one carrier IP, each flushing 5 batches a minute.
    const decision = exhaust("events", KEY, "49.36.0.1", 100 * 5);
    expect(decision.allowed).toBe(true);
    expect(decision.limitedBy).toBeNull();
  });

  it("applies the per-key ceiling only as a runaway guard far above real traffic", () => {
    const perClient = LIMITS.configPerClient.max;
    const perKey = LIMITS.configPerKey.max;
    expect(perKey).toBeGreaterThanOrEqual(perClient * 50);

    // Spread requests across enough distinct clients that no client limit trips.
    let count = 0;
    let ip = 0;
    let decision = enforcePublicRateLimit("config", KEY, `client-${ip}`);
    count += 1;
    while (count < perKey) {
      if (count % (perClient - 1) === 0) ip += 1;
      decision = enforcePublicRateLimit("config", KEY, `client-${ip}`);
      count += 1;
    }
    expect(decision.allowed).toBe(true);

    const denied = enforcePublicRateLimit("config", KEY, `client-${ip + 1}`);
    expect(denied.allowed).toBe(false);
    expect(denied.limitedBy).toBe("key");
  });

  it("limits key-less requests per client and never charges a customer budget", () => {
    const perClient = LIMITS.configPerClient.max;
    // 60 clients x the full per-client allowance is more than the per-key
    // ceiling; if key-less traffic shared a bucket this would be denied.
    for (let ip = 0; ip < 60; ip += 1) {
      expect(exhaust("config", null, `anon-${ip}`, perClient).allowed).toBe(true);
    }
    const denied = enforcePublicRateLimit("config", null, "anon-0");
    expect(denied.allowed).toBe(false);
    expect(denied.limitedBy).toBe("client");
    expect(enforcePublicRateLimit("config", KEY, "real-client").allowed).toBe(true);
  });

  it("keeps scopes independent", () => {
    exhaust("events", KEY, "10.0.0.9", LIMITS.eventsPerClient.max);
    expect(enforcePublicRateLimit("events", KEY, "10.0.0.9").allowed).toBe(false);
    expect(enforcePublicRateLimit("config", KEY, "10.0.0.9").allowed).toBe(true);
    expect(enforcePublicRateLimit("document", KEY, "10.0.0.9").allowed).toBe(true);
  });
});

describe("getClientIp", () => {
  function req(headers: Record<string, string | undefined>, remoteAddress?: string): IncomingMessage {
    return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
  }

  it("prefers Cloudflare's connecting IP over forwarded headers", () => {
    expect(getClientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("1.2.3.4");
  });

  it("uses the first x-forwarded-for entry otherwise", () => {
    expect(getClientIp(req({ "x-forwarded-for": " 9.9.9.9 , 10.0.0.1" }))).toBe("9.9.9.9");
  });

  it("falls back to the socket address", () => {
    expect(getClientIp(req({}, "127.0.0.1"))).toBe("127.0.0.1");
    expect(getClientIp(req({ "x-forwarded-for": "" }, undefined))).toBe("unknown");
  });
});

describe("publicKeyFromJson", () => {
  it("returns the public key from a JSON body", () => {
    expect(publicKeyFromJson(JSON.stringify({ publicKey: KEY, identity: { userId: "u" } }))).toBe(KEY);
  });

  it("returns null for empty, invalid, or non-string keys", () => {
    expect(publicKeyFromJson("")).toBeNull();
    expect(publicKeyFromJson("{not json")).toBeNull();
    expect(publicKeyFromJson(JSON.stringify({ publicKey: 42 }))).toBeNull();
    expect(publicKeyFromJson(JSON.stringify({}))).toBeNull();
  });
});

describe("readBody memoization", () => {
  it("serves the same body to the router and the route handler", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    const first = readBody(req, 64 * 1024);
    stream.write('{"publicKey":"');
    stream.write(KEY);
    stream.end('"}');

    await expect(first).resolves.toBe(`{"publicKey":"${KEY}"}`);
    // The stream is already consumed; a second read must not hang or return empty.
    await expect(readBody(req)).resolves.toBe(`{"publicKey":"${KEY}"}`);
    expect(publicKeyFromJson(await readBody(req))).toBe(KEY);
  });

  it("surfaces the same oversize error to every reader", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    const first = readBody(req, 8);
    stream.write("0123456789");

    await expect(first).rejects.toMatchObject({ name: "PayloadTooLargeError" });
    await expect(readBody(req)).rejects.toMatchObject({ name: "PayloadTooLargeError" });
  });
});
