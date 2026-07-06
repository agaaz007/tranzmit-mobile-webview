import type { IncomingMessage, ServerResponse } from "node:http";
import { getPlacementsForKey, validatePublicKey } from "../db.js";
import { sendJsonCompressed } from "../http-compress.js";
import { hashDocument, publicApiBaseUrl, webViewDocumentPayload } from "../webview-documents.js";

/**
 * True when any entity-tag in an If-None-Match header matches the document's
 * content hash. Weak comparison per RFC 9110 §8.8.3.2: the W/ prefix is
 * stripped from both sides, so clients still holding the pre-compression
 * STRONG ETag ("<hash>") keep getting 304s after the switch to W/"<hash>".
 * Handles comma-separated lists and the `*` wildcard.
 */
function ifNoneMatchMatches(header: string | string[] | undefined, hash: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;
  return raw.split(",").some((candidate) => {
    const tag = candidate.trim();
    if (tag === "*") return true;
    return tag.replace(/^W\//i, "") === `"${hash}"`;
  });
}

export async function handlePaywallDocument(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const publicKey = url.searchParams.get("key") || "";
  if (!publicKey || !(await validatePublicKey(publicKey))) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid public key" }));
    return;
  }

  const match = path.match(/^\/v1\/paywall-documents\/([^/]+)\/([^/]+)\/(.+)\.json$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Paywall document not found" }));
    return;
  }

  const placementId = decodeURIComponent(match[1]);
  const variantKey = decodeURIComponent(match[2]);
  const requestedCacheKey = decodeURIComponent(match[3]);
  const rows = await getPlacementsForKey(publicKey);
  const row = rows.find((item) => item.id === placementId);
  if (!row) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Paywall document not found" }));
    return;
  }

  const defaultVariant = row.default_variant_id || "var_default";
  const variant = (row.variants || []).find((item) => item.variant_id === variantKey);
  const rawSpec = variant?.spec ?? (variantKey === defaultVariant ? row.spec : undefined);
  if (!rawSpec) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Paywall document not found" }));
    return;
  }

  const payload = webViewDocumentPayload(rawSpec, {
    publicKey,
    placementId: row.id,
    variantKey,
    apiBaseUrl: publicApiBaseUrl(req),
    // Must mirror the config endpoint so the recomputed cacheKey matches the
    // one embedded in the document URL (RN clients suppress the legacy CSS).
    sdkStack: row.sdk_stack,
  });
  if (payload.cacheKey !== requestedCacheKey) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Paywall document revision not found" }));
    return;
  }

  const body = JSON.stringify(payload);
  const contentHash = hashDocument(payload);
  // WEAK ETag: gzip changes the representation bytes but not the content, so a
  // strong validator would be wrong per RFC 9110 (nginx weakens ETags the same
  // way when it compresses).
  const etag = `W/"${contentHash}"`;
  if (ifNoneMatchMatches(req.headers["if-none-match"], contentHash)) {
    res.writeHead(304, {
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": etag,
      // 304s carry no body, so no Content-Encoding/Content-Length — but caches
      // still need to know the 200 representation varies on Accept-Encoding.
      "Vary": "Accept-Encoding",
    });
    res.end();
    return;
  }

  sendJsonCompressed(
    req,
    res,
    200,
    body,
    {
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": etag,
      "Access-Control-Allow-Origin": "*",
    },
    // Documents are immutable per content hash, so gzipped bytes are safely
    // cacheable across requests. The key must include cacheKey too: the hash
    // covers only html/css/js/baseUrl, but the serialized body also carries
    // cacheKey (templateId-prefixed) — two templates with identical content
    // must not share cached bytes or one would serve the other's cacheKey.
    { compressionCacheKey: `${payload.cacheKey}:${contentHash}` }
  );
}
