import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigRequest, ConfigResponse, PlacementConfig } from "@tranzmit/shared";
import { getPlacementsForKey, validatePublicKey } from "../db.js";
import { readBody } from "../middleware/body-parser.js";
import { resolveConfigIdentity } from "../identity.js";
import { getVariantAssignment } from "../statsig.js";
import { configTtlSeconds, ensureWebViewSpec, publicApiBaseUrl, shouldInlineDocuments } from "../webview-documents.js";

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

  const rows = await getPlacementsForKey(publicKey);
  const apiBaseUrl = publicApiBaseUrl(req);
  const includeInline = shouldInlineDocuments();

  const placements: ConfigResponse["placements"] = {};
  for (const row of rows) {
    const defaultVariant = row.default_variant_id || "var_default";
    const status = row.status || (row.enabled ? "active" : "paused");
    if (!row.enabled || status !== "active" || !row.spec) {
      placements[row.trigger] = null;
      continue;
    }

    let assignedVariantId = defaultVariant;
    if (row.experiment_id) {
      assignedVariantId = await getVariantAssignment(
        identity,
        row.experiment_id,
        defaultVariant,
        {
          projectName: row.statsig_project_name,
          serverSecretEnvVar: row.statsig_server_secret_env_var,
        }
      );
    }
    const selected = selectVariant(row.variants, assignedVariantId, defaultVariant);
    const variantKey = selected.variantId || defaultVariant;
    const selectedSpec = ensureWebViewSpec(selected.spec ?? row.spec, {
      publicKey,
      placementId: row.id,
      variantKey,
      apiBaseUrl,
      includeInline,
    });
    placements[row.trigger] = {
      trigger: row.trigger,
      enabled: row.enabled,
      placementId: row.id,
      placement_id: row.id,
      variantId: variantKey,
      variantKey,
      variant_key: variantKey,
      spec: selectedSpec as PlacementConfig["spec"],
    };
  }

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

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(config));
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

function selectVariant(
  variants: Array<{ variant_id: string; spec: unknown }> | undefined,
  assignedVariantId: string,
  defaultVariant: string
): { variantId: string; spec: unknown } {
  const available = variants || [];
  const byAssigned = available.find((variant) => variant.variant_id === assignedVariantId);
  if (byAssigned) return { variantId: byAssigned.variant_id, spec: byAssigned.spec };
  const byDefault = available.find((variant) => variant.variant_id === defaultVariant);
  if (byDefault) return { variantId: byDefault.variant_id, spec: byDefault.spec };
  const first = available[0];
  if (first) return { variantId: first.variant_id, spec: first.spec };
  return { variantId: defaultVariant, spec: undefined };
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
