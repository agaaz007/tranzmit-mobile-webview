import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Payloads smaller than this are never worth the gzip CPU + header overhead. */
const MIN_COMPRESS_BYTES = 1024;

/**
 * Module-level cache of gzipped bytes for content-addressed payloads (hosted
 * paywall documents are immutable per content hash). Insertion-order Map used
 * as a tiny LRU: hits are re-inserted for recency, oldest entry evicted over cap.
 */
const GZIP_CACHE_MAX_ENTRIES = 32;
const gzipCache = new Map<string, Buffer>();

/**
 * True when the request's Accept-Encoding lists gzip with a non-zero q value.
 */
export function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers["accept-encoding"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;

  for (const part of raw.split(",")) {
    const [token, ...params] = part.split(";");
    if (token.trim().toLowerCase() !== "gzip") continue;
    for (const param of params) {
      const match = param.trim().match(/^q=([0-9]*\.?[0-9]+)$/i);
      if (match && Number.parseFloat(match[1]) === 0) return false;
    }
    return true;
  }
  return false;
}

function gzipEncoded(identity: Buffer, compressionCacheKey?: string): Buffer {
  if (!compressionCacheKey) return gzipSync(identity);

  const cached = gzipCache.get(compressionCacheKey);
  if (cached) {
    // Refresh recency: delete + re-set moves the key to the end of the Map's
    // insertion order, so eviction always removes the least-recently-used key.
    gzipCache.delete(compressionCacheKey);
    gzipCache.set(compressionCacheKey, cached);
    return cached;
  }

  const compressed = gzipSync(identity);
  gzipCache.set(compressionCacheKey, compressed);
  while (gzipCache.size > GZIP_CACHE_MAX_ENTRIES) {
    const oldest = gzipCache.keys().next().value;
    if (oldest === undefined) break;
    gzipCache.delete(oldest);
  }
  return compressed;
}

/**
 * Sends a pre-serialized JSON body, gzip-compressed when the client accepts it
 * and the payload is large enough to benefit. Always sets Vary: Accept-Encoding
 * (identity responses too — caches must key on the request encoding either way)
 * and an explicit Content-Length of the encoded bytes.
 *
 * `opts.compressionCacheKey` opts into the module-level gzip LRU: only pass it
 * for content-addressed payloads (e.g. hosted documents keyed by content hash).
 * Dynamic payloads (e.g. /v1/config embeds fetched_at) must compress per-request.
 */
export function sendJsonCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string>,
  opts?: { compressionCacheKey?: string }
): void {
  const identity = Buffer.from(body);
  let encoded: Buffer = identity;
  let compressed = false;

  if (acceptsGzip(req) && identity.byteLength >= MIN_COMPRESS_BYTES) {
    const gzipped = gzipEncoded(identity, opts?.compressionCacheKey);
    // Only serve gzip when it actually shrinks the payload.
    if (gzipped.byteLength < identity.byteLength) {
      encoded = gzipped;
      compressed = true;
    }
  }

  res.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
    "Vary": "Accept-Encoding",
    ...(compressed ? { "Content-Encoding": "gzip" } : {}),
    "Content-Length": String(encoded.byteLength),
  });

  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(encoded);
  }
}
