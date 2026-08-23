import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigRequest, ConfigResponse } from "@tranzmit/shared";
import { insertEvents, validatePublicKey } from "../db.js";
import { sendJsonCompressed } from "../http-compress.js";
import { readBody } from "../middleware/body-parser.js";
import { resolveConfigIdentity } from "../identity.js";
import { resolveConfigPlacements } from "../config-resolver.js";
import { configTtlSeconds, publicApiBaseUrl, shouldInlineDocuments } from "../webview-documents.js";

export async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const request = await parseConfigRequest(req, url);
  const publicKey = request?.publicKey;

  if (!request || !publicKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing publicKey" }));
    return;
  }

  const identity = resolveConfigIdentity(request);
  if (!identity) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing identity: provide userId or identity.identifiers" }));
    return;
  }

  const valid = await validatePublicKey(publicKey);
  if (!valid) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid public key" }));
    return;
  }

  const apiBaseUrl = publicApiBaseUrl(req);
  const includeInline = shouldInlineDocuments();
  const resolution = await resolveConfigPlacements({
    publicKey,
    identity,
    apiBaseUrl,
    includeInline,
  });
  const placements = resolution.placements;
  const resolved = resolution.traces;

  // Resolution log: the targeting traits the SDK passed (e.g. `intent`) and how
  // each placement resolved — via the baseline holdout or an intent-matched
  // experiment — plus the final variant. Lets us see "user came with intent X ->
  // got paywall Y". Greppable in the Railway logs via the [tz.resolve] tag.
  console.log("[tz.resolve]", JSON.stringify({
    publicKey,
    userId: identity.userId ?? null,
    identifiers: identity.identifiers ?? null,
    traits: request.traits ?? null,
    resolved,
  }));

  // Also record the resolution as a `paywall_resolved` event so it shows in the
  // Events dashboard with the intent the SDK passed and the variant each
  // placement resolved to. Fire-and-forget so it never adds latency or breaks the
  // config response.
  const intentValue =
    request.traits && typeof request.traits === "object"
      ? (request.traits as Record<string, unknown>).intent
      : undefined;
  void insertEvents(
    publicKey,
    identity.userId || identity.storageUserId,
    identity.storageUserId,
    [
      {
        event: "paywall_resolved",
        timestamp: Date.now(),
        properties: {
          intent: intentValue != null ? String(intentValue) : "(none)",
          resolved: resolved
            .map((r) => `${r.trigger}=${r.variant}${r.viaBaseline ? " (baseline)" : ""}`)
            .join(", "),
          traits: request.traits ? JSON.stringify(request.traits) : "",
        },
      },
    ],
    identity,
  ).catch((err) => console.warn("[tz.resolve] paywall_resolved insert failed:", err));

  const fetchedAt = new Date().toISOString();
  const ttl = configTtlSeconds();
  const config: ConfigResponse = {
    version: "1.0.0",
    placements,
    assets: {},
    ttl,
    _meta: {
      config_version: "v1",
      fetched_at: fetchedAt,
      cache_ttl_seconds: ttl,
      document_delivery: includeInline ? "hosted+inline" : "hosted",
    },
  };

  // No compressionCacheKey: the payload embeds fetched_at, so it changes on
  // every request and must be compressed per-request.
  sendJsonCompressed(req, res, 200, JSON.stringify(config), {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
}

async function parseConfigRequest(req: IncomingMessage, url: URL): Promise<ConfigRequest | null> {
  if (req.method === "POST") {
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw) as ConfigRequest & {
        public_key?: string;
        userTraits?: Record<string, unknown>;
        identity?: ConfigRequest["identity"] & {
          userTraits?: Record<string, unknown>;
          privateTraits?: Record<string, unknown>;
        };
      };
      return {
        publicKey: body.publicKey || body.public_key || "",
        identity: body.identity,
        userId: body.userId,
        traits: body.traits || body.userTraits || body.identity?.userTraits,
        privateTraits: body.privateTraits || body.identity?.privateTraits,
      };
    } catch {
      return null;
    }
  }

  return {
    publicKey: url.searchParams.get("key") || "",
    userId: url.searchParams.get("userId") || undefined,
    traits: parseUserTraits(url.searchParams.get("traits")),
  };
}

function parseUserTraits(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
