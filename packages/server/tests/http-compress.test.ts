import { describe, it, expect } from "vitest";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { acceptsGzip, sendJsonCompressed } from "../src/http-compress.js";

// undici's fetch auto-negotiates gzip AND transparently decompresses, hiding
// the wire bytes. Use raw node:http so we can assert encoded byte counts,
// Content-Encoding, and Content-Length exactly as clients on cellular see them.
async function rawRequest(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: addr.port,
          path,
          method: options.method || "GET",
          headers: options.headers || {},
        },
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
  } finally {
    server.close();
  }
}

const bigPayload = JSON.stringify({ html: "<main>" + "paywall ".repeat(600) + "</main>" });
const smallPayload = JSON.stringify({ ok: true });

function jsonHandler(body: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    sendJsonCompressed(req, res, 200, body, { "Cache-Control": "no-store" });
  };
}

describe("acceptsGzip", () => {
  const fakeReq = (acceptEncoding?: string) =>
    ({ headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding } }) as IncomingMessage;

  it("accepts plain gzip and gzip in lists", () => {
    expect(acceptsGzip(fakeReq("gzip"))).toBe(true);
    expect(acceptsGzip(fakeReq("gzip, deflate, br"))).toBe(true);
    expect(acceptsGzip(fakeReq("deflate, gzip;q=0.8"))).toBe(true);
    expect(acceptsGzip(fakeReq("GZIP"))).toBe(true);
  });

  it("rejects missing header, identity-only, and q=0", () => {
    expect(acceptsGzip(fakeReq())).toBe(false);
    expect(acceptsGzip(fakeReq("identity"))).toBe(false);
    expect(acceptsGzip(fakeReq("gzip;q=0"))).toBe(false);
    expect(acceptsGzip(fakeReq("gzip;q=0.0, deflate"))).toBe(false);
  });
});

describe("sendJsonCompressed", () => {
  it("gzips large payloads with correct headers and the JSON survives the round trip", async () => {
    const res = await rawRequest(jsonHandler(bigPayload), "/", {
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Number(res.headers["content-length"])).toBe(res.body.byteLength);
    expect(res.body.byteLength).toBeLessThan(Buffer.byteLength(bigPayload));
    expect(JSON.parse(gunzipSync(res.body).toString("utf8"))).toEqual(JSON.parse(bigPayload));
  });

  it("serves identity with correct Content-Length and Vary when gzip is not accepted", async () => {
    const res = await rawRequest(jsonHandler(bigPayload), "/", {
      headers: { "accept-encoding": "identity" },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(bigPayload));
    expect(res.body.toString("utf8")).toBe(bigPayload);
  });

  it("does not compress payloads under the 1KB threshold", async () => {
    const res = await rawRequest(jsonHandler(smallPayload), "/", {
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.body.toString("utf8")).toBe(smallPayload);
  });

  it("HEAD returns encoded headers with an empty body", async () => {
    const res = await rawRequest(jsonHandler(bigPayload), "/", {
      method: "HEAD",
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
    expect(res.body.byteLength).toBe(0);
  });
});
