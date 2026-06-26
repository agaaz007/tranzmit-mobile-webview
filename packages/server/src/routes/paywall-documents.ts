import type { IncomingMessage, ServerResponse } from "node:http";
import { getPlacementsForKey, validatePublicKey } from "../db.js";
import { hashDocument, publicApiBaseUrl, webViewDocumentPayload } from "../webview-documents.js";

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
  const etag = `"${hashDocument(payload)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, {
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": etag,
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=31536000, immutable",
    "ETag": etag,
    "Access-Control-Allow-Origin": "*",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}
