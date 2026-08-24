import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listConfigEnvironments,
  listEnvironmentPaywalls,
  listEnvironmentPlacements,
} from "../config-store.js";
import {
  ConfigError,
  createPaywallBinding,
  createPaywallRelease,
  createPlacementIdentity,
  createPlacementRevision,
  getPaywallDetails,
  getPaywallReleaseDiff,
  getPlacementRevisionDiff,
  getReleasePreflight,
  listPlacementRevisions,
  previewPaywallCandidate,
  promotePaywallContent,
  publishPaywallRelease,
  publishPlacementRevision,
  runReleasePreflight,
  setEnvironmentConfigSource,
} from "../config-publish.js";
import { REQUIRED_PROBE_WIDTHS, type ViewportAudit } from "../paywall-preflight.js";
import { readBody } from "../middleware/body-parser.js";
import type { AdminAuthContext } from "../middleware/auth.js";

export async function handleAdminV2(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  auth: AdminAuthContext
): Promise<boolean> {
  try {
    const actor = auth.kind === "workspace"
      ? `workspace:${auth.workspaceId}`
      : auth.source || "admin";
    const workspaceId = auth.kind === "workspace" ? auth.workspaceId : undefined;

    if (path === "/admin/v2/environments" && req.method === "GET") {
      sendJson(res, 200, await listConfigEnvironments(workspaceId));
      return true;
    }

    const sourceMatch = path.match(/^\/admin\/v2\/environments\/([^/]+)\/source$/);
    if (sourceMatch && req.method === "POST") {
      if (auth.kind !== "admin") throw new ConfigError("Admin credential required", 403);
      const body = await readJson(req);
      sendJson(res, 200, await setEnvironmentConfigSource({
        clientId: sourceMatch[1],
        source: body.source,
        expectedSource: body.expectedConfigSource ?? body.expected_source,
        actor,
      }));
      return true;
    }

    if (path === "/admin/paywalls" && req.method === "GET") {
      const publicKey = requestUrl(req).searchParams.get("public_key")
        || requestUrl(req).searchParams.get("publicKey")
        || (auth.kind === "workspace" ? auth.publicKey : "");
      if (!publicKey) throw new ConfigError("Missing public_key", 422);
      sendJson(res, 200, await listEnvironmentPaywalls(publicKey, workspaceId));
      return true;
    }

    if (path === "/admin/paywalls" && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 201, await createPaywallBinding({
        publicKey: body.publicKey || body.public_key || (auth.kind === "workspace" ? auth.publicKey : ""),
        paywallKey: body.paywallKey || body.paywall_key,
        displayName: body.displayName || body.display_name,
        actor,
        workspaceId,
      }));
      return true;
    }

    const paywallDetailMatch = path.match(/^\/admin\/paywalls\/([^/]+)$/);
    if (paywallDetailMatch && req.method === "GET") {
      sendJson(res, 200, await getPaywallDetails(paywallDetailMatch[1], workspaceId));
      return true;
    }

    const releasesMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/releases$/);
    if (releasesMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 201, await createPaywallRelease(releasesMatch[1], {
        spec: body.spec,
        contentRevisionId: body.contentRevisionId || body.content_revision_id,
        products: body.products,
        checkout: body.checkout,
        createdBy: actor,
      }, workspaceId));
      return true;
    }

    // The device matrix itself lives in the dashboard's vendored responsive.mjs,
    // shared with the authoring harness. This only reports which widths a
    // publish is gated on, so the UI can explain the requirement.
    if (path === "/admin/v2/preflight/viewports" && req.method === "GET") {
      sendJson(res, 200, { requiredWidths: REQUIRED_PROBE_WIDTHS });
      return true;
    }

    // Dry run: validate an unsaved candidate. Writes nothing, never 422s — the
    // report itself carries the verdict so the dashboard can render every
    // problem at once instead of one exception at a time.
    const validateMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/validate$/);
    if (validateMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await previewPaywallCandidate(validateMatch[1], {
        spec: body.spec,
        viewports: normalizeViewports(body.viewports),
      }, workspaceId));
      return true;
    }

    const preflightMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/releases\/([^/]+)\/preflight$/);
    if (preflightMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await runReleasePreflight({
        bindingId: preflightMatch[1],
        releaseId: preflightMatch[2],
        viewports: normalizeViewports(body.viewports),
        actor,
        workspaceId,
      }));
      return true;
    }
    if (preflightMatch && req.method === "GET") {
      const report = await getReleasePreflight(preflightMatch[1], preflightMatch[2], workspaceId);
      sendJson(res, report ? 200 : 404, report || { error: "No validation has been recorded for these bytes" });
      return true;
    }

    const releaseDiffMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/releases\/([^/]+)\/diff$/);
    if (releaseDiffMatch && req.method === "GET") {
      sendJson(res, 200, await getPaywallReleaseDiff(releaseDiffMatch[1], releaseDiffMatch[2], workspaceId));
      return true;
    }

    const releasePublishMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/releases\/([^/]+)\/publish$/);
    if (releasePublishMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await publishPaywallRelease({
        bindingId: releasePublishMatch[1],
        releaseId: releasePublishMatch[2],
        expectedCurrentReleaseId: body.expectedCurrentReleaseId ?? body.expected_current_release_id ?? null,
        actor,
        workspaceId,
      }));
      return true;
    }

    const rollbackMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/rollback$/);
    if (rollbackMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await publishPaywallRelease({
        bindingId: rollbackMatch[1],
        releaseId: body.targetReleaseId || body.target_release_id,
        expectedCurrentReleaseId: body.expectedCurrentReleaseId ?? body.expected_current_release_id ?? null,
        actor,
        workspaceId,
        action: "rollback",
      }));
      return true;
    }

    const promoteMatch = path.match(/^\/admin\/paywalls\/([^/]+)\/promote$/);
    if (promoteMatch && req.method === "POST") {
      if (auth.kind !== "admin") throw new ConfigError("Admin credential required", 403);
      const body = await readJson(req);
      sendJson(res, 201, await promotePaywallContent({
        targetBindingId: promoteMatch[1],
        sourceReleaseId: body.sourceReleaseId || body.source_release_id,
        actor,
        workspaceId,
      }));
      return true;
    }

    if (path === "/admin/v2/placements" && req.method === "GET") {
      const publicKey = requestUrl(req).searchParams.get("public_key")
        || requestUrl(req).searchParams.get("publicKey")
        || (auth.kind === "workspace" ? auth.publicKey : "");
      if (!publicKey) throw new ConfigError("Missing public_key", 422);
      sendJson(res, 200, await listEnvironmentPlacements(publicKey, workspaceId));
      return true;
    }

    if (path === "/admin/v2/placements" && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 201, await createPlacementIdentity({
        publicKey: body.publicKey || body.public_key || (auth.kind === "workspace" ? auth.publicKey : ""),
        trigger: body.trigger,
        workspaceId,
      }));
      return true;
    }

    const placementRevisionsMatch = path.match(/^\/admin\/placements\/([^/]+)\/revisions$/);
    if (placementRevisionsMatch && req.method === "GET") {
      sendJson(res, 200, await listPlacementRevisions(placementRevisionsMatch[1], workspaceId));
      return true;
    }
    if (placementRevisionsMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 201, await createPlacementRevision(placementRevisionsMatch[1], {
        status: body.status,
        defaultBindingId: body.defaultBindingId || body.default_binding_id,
        defaultVariantKey: body.defaultVariantKey || body.default_variant_key,
        statsigExperimentId: body.statsigExperimentId ?? body.statsig_experiment_id,
        targetingRules: body.targetingRules ?? body.targeting_rules,
        variants: normalizeVariants(body.variants),
        createdBy: actor,
      }, workspaceId));
      return true;
    }

    const placementDiffMatch = path.match(/^\/admin\/placements\/([^/]+)\/revisions\/([^/]+)\/diff$/);
    if (placementDiffMatch && req.method === "GET") {
      sendJson(res, 200, await getPlacementRevisionDiff(placementDiffMatch[1], placementDiffMatch[2], workspaceId));
      return true;
    }

    const placementPublishMatch = path.match(/^\/admin\/placements\/([^/]+)\/revisions\/([^/]+)\/publish$/);
    if (placementPublishMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await publishPlacementRevision({
        placementId: placementPublishMatch[1],
        revisionId: placementPublishMatch[2],
        expectedCurrentRevisionId: body.expectedCurrentRevisionId ?? body.expected_current_revision_id ?? null,
        actor,
        workspaceId,
      }));
      return true;
    }

    const placementRollbackMatch = path.match(/^\/admin\/placements\/([^/]+)\/rollback$/);
    if (placementRollbackMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await publishPlacementRevision({
        placementId: placementRollbackMatch[1],
        revisionId: body.targetRevisionId || body.target_revision_id,
        expectedCurrentRevisionId: body.expectedCurrentRevisionId ?? body.expected_current_revision_id ?? null,
        actor,
        workspaceId,
        action: "rollback",
      }));
      return true;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      sendJson(res, error.status, {
        error: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return true;
    }
    throw error;
  }
  return false;
}

/**
 * Render audits arrive from the dashboard's rendering harness. Only the verdict
 * and its reasons are kept; the harness's `details` payload is dropped so a
 * stored report stays a fixed, bounded shape.
 */
function normalizeViewports(value: unknown): ViewportAudit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const audits: ViewportAudit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const audit = item as Record<string, unknown>;
    const width = Number(audit.width);
    const height = Number(audit.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    audits.push({
      id: String(audit.id || `${audit.locale || "default"}:${width}`),
      deviceId: String(audit.deviceId || `${width}x${height}`),
      ...(audit.label ? { label: String(audit.label) } : {}),
      locale: String(audit.locale || "default"),
      width,
      height,
      passed: Boolean(audit.passed),
      failures: stringList(audit.failures),
      ...(audit.timedOut ? { timedOut: true } : {}),
    });
  }
  return audits;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 20);
}

function normalizeVariants(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((variant: any) => ({
    variantKey: variant.variantKey || variant.variant_key,
    bindingId: variant.bindingId || variant.binding_id,
    status: variant.status,
    weight: variant.weight,
    fallbackRank: variant.fallbackRank ?? variant.fallback_rank,
  }));
}

/**
 * A paywall document may legitimately be up to 512KB of HTML (the schema's hard
 * cap), and a candidate carries localization, products, and viewport probes on
 * top of that. The transport limit has to sit above the content limit or the
 * document size rule would never be the thing that rejects an oversized import.
 */
const MAX_CONFIG_BODY_BYTES = 2 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<any> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_CONFIG_BODY_BYTES);
  } catch (error) {
    if (error && (error as { name?: string }).name === "PayloadTooLargeError") throw error;
    throw new ConfigError("Could not read request body", 400);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ConfigError("Invalid JSON body", 400);
  }
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
