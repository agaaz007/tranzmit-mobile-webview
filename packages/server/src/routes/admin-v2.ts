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
  listPlacementRevisions,
  promotePaywallContent,
  publishPaywallRelease,
  publishPlacementRevision,
  setEnvironmentConfigSource,
} from "../config-publish.js";
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

async function readJson(req: IncomingMessage): Promise<any> {
  try {
    const raw = await readBody(req);
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
