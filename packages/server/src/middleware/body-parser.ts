import type { IncomingMessage } from "node:http";

const MAX_BODY_SIZE = 512 * 1024; // 512KB

export function readBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new PayloadTooLargeError(maxSize));
        return;
      }
      body += chunk;
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export class PayloadTooLargeError extends Error {
  status = 413;
  readonly limitBytes: number;
  constructor(limitBytes = MAX_BODY_SIZE) {
    super("Request body too large");
    this.name = "PayloadTooLargeError";
    this.limitBytes = limitBytes;
  }
}
