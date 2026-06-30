import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigRequest, ConfigResponse, PlacementConfig } from "@tranzmit/shared";
import { getPlacementsForKey, insertEvents, validatePublicKey } from "../db.js";
import { readBody } from "../middleware/body-parser.js";
import { resolveConfigIdentity } from "../identity.js";
import { getBaselineDecision, getVariantAssignment } from "../statsig.js";
import { configTtlSeconds, ensureWebViewSpec, publicApiBaseUrl, shouldInlineDocuments } from "../webview-documents.js";

type TargetingRule = {
  /**
   * Optional discriminator. The default rule shape is trait-matched
   * (see `when`). A `type: "baseline"` rule is consulted BEFORE any
   * trait-matched rules: it queries a Statsig experiment that returns a
   * `use_autotune` boolean and a `variant_id`. When `use_autotune` is false,
   * the placement skips trait-matched rules entirely and serves the baseline
   * `variant_id` directly (the control holdout). When true, the placement
   * falls through to the existing trait-matched flow. A Statsig outage on the
   * baseline experiment ALSO falls through, so the customer-visible paywall
   * never depends on Statsig being reachable.
   */
  type?: unknown;
  when?: Record<string, unknown>;
  statsig_experiment_id?: unknown;
  experiment_id?: unknown;
  experimentId?: unknown;
};

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
  const resolved: Array<{ trigger: string; experimentId: string | null; viaBaseline: boolean; assignedVariantId: string; variant: string }> = [];
  for (const row of rows) {
    const defaultVariant = row.default_variant_id || "var_default";
    const status = row.status || (row.enabled ? "active" : "paused");
    if (!row.enabled || status !== "active" || !row.spec) {
      placements[row.trigger] = null;
      continue;
    }

    let assignedVariantId = defaultVariant;
    let viaBaseline = false;
    let chosenExperimentId: string | null = null;
    const projectConfig = {
      projectName: row.statsig_project_name,
      serverSecretEnvVar: row.statsig_server_secret_env_var,
    };

    // Optional pre-check: if the placement has a `type: "baseline"` rule, query
    // that Statsig experiment first. If `use_autotune` is false, serve the
    // baseline's `variant_id` directly (skips trait/intent routing). If true,
    // or if Statsig is unreachable, fall through to the existing trait-matched
    // flow. This implements the 10/90 baseline-holdout pattern without
    // disturbing placements that don't use it.
    const baselineRule = findBaselineRule(row.targeting_rules);
    let baselineHandled = false;
    if (baselineRule?.statsig_experiment_id) {
      const decision = await getBaselineDecision(
        identity,
        baselineRule.statsig_experiment_id,
        projectConfig,
      );
      if (decision) {
        if (!decision.useAutotune) {
          assignedVariantId = decision.variantId || defaultVariant;
          baselineHandled = true;
          viaBaseline = true;
        }
        // useAutotune=true => fall through to trait-matched flow below.
      }
      // decision === null (Statsig outage) => fall through too, never serve null.
    }

    if (!baselineHandled) {
      const experimentId = resolveExperimentId(row.targeting_rules, identity.traits, row.experiment_id);
      chosenExperimentId = experimentId ?? null;
      if (experimentId) {
        assignedVariantId = await getVariantAssignment(
          identity,
          experimentId,
          defaultVariant,
          projectConfig,
        );
      }
    }
    const selected = selectVariant(row.variants, assignedVariantId, defaultVariant);
    const variantKey = selected.variantId || defaultVariant;
    resolved.push({ trigger: row.trigger, experimentId: chosenExperimentId, viaBaseline, assignedVariantId, variant: variantKey });
    const selectedSpec = ensureWebViewSpec(selected.spec ?? row.spec, {
      publicKey,
      placementId: row.id,
      variantKey,
      apiBaseUrl,
      includeInline,
      sdkStack: row.sdk_stack,
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

function resolveExperimentId(
  targetingRules: unknown,
  traits: Record<string, unknown>,
  fallbackExperimentId: string | null
): string | null {
  for (const rule of normalizeTargetingRules(targetingRules)) {
    // Skip baseline rules — they're handled by findBaselineRule, NOT the
    // trait-matched flow (their `when` is intentionally empty).
    if (rule.type === "baseline") continue;
    if (!matchesTraits(rule.when, traits)) continue;
    const experimentId = normalizeExperimentId(rule.statsig_experiment_id ?? rule.experiment_id ?? rule.experimentId);
    if (experimentId) return experimentId;
  }
  return fallbackExperimentId;
}

function findBaselineRule(targetingRules: unknown): { statsig_experiment_id: string | null } | null {
  for (const rule of normalizeTargetingRules(targetingRules)) {
    if (rule.type !== "baseline") continue;
    const experimentId = normalizeExperimentId(rule.statsig_experiment_id ?? rule.experiment_id ?? rule.experimentId);
    if (experimentId) return { statsig_experiment_id: experimentId };
  }
  return null;
}

function normalizeTargetingRules(value: unknown): TargetingRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TargetingRule => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function matchesTraits(when: TargetingRule["when"], traits: Record<string, unknown>): boolean {
  if (!when || typeof when !== "object" || Array.isArray(when)) return false;
  const entries = Object.entries(when);
  if (entries.length === 0) return false;
  return entries.every(([key, expected]) => traitMatches(traits[key], expected));
}

function traitMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((item) => traitMatches(actual, item));
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => traitMatches(item, expected));
  }
  if (!isComparableTrait(actual) || !isComparableTrait(expected)) return false;
  return actual === expected;
}

function isComparableTrait(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizeExperimentId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
