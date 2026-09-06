import type { IncomingMessage } from "node:http";

const MAX_BODY_SIZE = 512 * 1024; // 512KB

// A request stream can only be consumed once. The router reads the body
// early to scope rate limits by public key; memoizing per request lets the
// route handler call readBody() again and receive the same bytes. The first
// caller's size limit applies.
const bodies = new WeakMap<IncomingMessage, Promise<string>>();

export function readBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<string> {
  const cached = bodies.get(req);
  if (cached) return cached;

  const pending = new Promise<string>((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      body += chunk;
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
  // Keep the rejection attached to the cached promise so a later reader sees
  // the same error instead of an unhandled rejection.
  pending.catch(() => {});
  bodies.set(req, pending);
  return pending;
}

export class PayloadTooLargeError extends Error {
  status = 413;
  constructor() {
    super("Request body too large");
    this.name = "PayloadTooLargeError";
  }
}
