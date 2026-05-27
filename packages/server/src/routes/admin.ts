import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkspaceForPublicKey, query } from "../db.js";
import { readBody } from "../middleware/body-parser.js";
import { resolveAdminAuth, type AdminAuthContext } from "../middleware/auth.js";
import { validatePaywallSpec } from "../paywall-schema.js";
import {
  getStatsigProjectStatus,
  normalizeStatsigSecretEnvVar,
  isValidStatsigSecretEnvVar,
} from "../statsig.js";
import crypto from "node:crypto";

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function generateId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
}

function generatePublicKey(env: "live" | "test"): string {
  return `pk_${env}_${crypto.randomBytes(12).toString("hex")}`;
}

function generateSecretKey(env: "live" | "test"): string {
  return `sk_${env}_${crypto.randomBytes(18).toString("hex")}`;
}

function slugifyEnvVarSuffix(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "CLIENT";
}

function suggestStatsigEnvVar(clientName: string): string {
  return `STATSIG_SERVER_SECRET_${slugifyEnvVarSuffix(clientName)}`;
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

interface VariantInput {
  variantId?: string;
  variant_id?: string;
  spec?: unknown;
  enabled?: boolean;
  fallbackRank?: number;
  fallback_rank?: number;
}

type SdkStack = "react_native" | "flutter" | "swift";

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<void> {
  const auth = await resolveAdminAuth(req);
  if (!auth) { unauthorized(res); return; }

  // --- PAYWALL SPECS ---

  if (path === "/admin/specs" && req.method === "POST") {
    const body = await readJson(req);
    const workspace = await resolveWorkspace(auth, body.publicKey || body.public_key);
    if (!workspace) {
      sendJson(res, 400, { error: "Missing or invalid workspace" });
      return;
    }

    const validation = validatePaywallSpec(body.spec);
    if (!validation.valid) {
      sendJson(res, 400, { error: "Invalid PaywallSpec", errors: validation.errors });
      return;
    }

    if (!body.name || typeof body.name !== "string") {
      sendJson(res, 400, { error: "Missing name" });
      return;
    }

    const result = await query(
      `INSERT INTO paywall_specs (workspace_id, name, spec, status, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, workspace_id, name, spec, status, version, created_at, updated_at, created_by`,
      [
        workspace.id,
        body.name.trim(),
        JSON.stringify(body.spec),
        normalizeSpecStatus(body.status, "draft"),
        normalizeOptionalText(body.created_by ?? body.createdBy) || "api",
      ]
    );
    sendJson(res, 201, result.rows[0]);
    return;
  }

  if (path === "/admin/specs" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const status = normalizeOptionalText(url.searchParams.get("status"));
    const publicKey = normalizeOptionalText(url.searchParams.get("public_key") || url.searchParams.get("publicKey"));
    const workspace = await resolveWorkspace(auth, publicKey);
    const params: unknown[] = [];
    const filters: string[] = [];

    if (auth.kind === "workspace" || publicKey) {
      if (!workspace) {
        sendJson(res, 404, { error: "Workspace not found" });
        return;
      }
      params.push(workspace.id);
      filters.push(`workspace_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      filters.push(`status = $${params.length}`);
    }

    const result = await query(
      `SELECT id, workspace_id, name, spec, status, version, created_at, updated_at, created_by
       FROM paywall_specs
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY updated_at DESC`,
      params
    );
    sendJson(res, 200, result.rows);
    return;
  }

  const specIdMatch = path.match(/^\/admin\/specs\/([^/]+)$/);

  if (specIdMatch && req.method === "GET") {
    const spec = await getSpecForAuth(specIdMatch[1], auth);
    if (!spec) {
      sendJson(res, 404, { error: "Spec not found" });
      return;
    }
    sendJson(res, 200, spec);
    return;
  }

  if (specIdMatch && req.method === "PUT") {
    const body = await readJson(req);
    const spec = await getSpecForAuth(specIdMatch[1], auth);
    if (!spec) {
      sendJson(res, 404, { error: "Spec not found" });
      return;
    }

    if (body.spec !== undefined) {
      const validation = validatePaywallSpec(body.spec);
      if (!validation.valid) {
        sendJson(res, 400, { error: "Invalid PaywallSpec", errors: validation.errors });
        return;
      }
    }

    const nextSpecJson = body.spec === undefined ? null : JSON.stringify(body.spec);
    const result = await query(
      `UPDATE paywall_specs
       SET name = COALESCE($2, name),
           spec = COALESCE($3, spec),
           version = version + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING id, workspace_id, name, spec, status, version, created_at, updated_at, created_by`,
      [
        specIdMatch[1],
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
        nextSpecJson,
      ]
    );

    if (nextSpecJson !== null) {
      await query(
        `UPDATE placements
         SET spec = $2,
             updated_at = now()
         WHERE default_spec_id = $1`,
        [specIdMatch[1], nextSpecJson]
      );
      await query(
        `UPDATE placement_variants
         SET spec = $2
         WHERE spec_id = $1`,
        [specIdMatch[1], nextSpecJson]
      );
    }

    sendJson(res, 200, result.rows[0]);
    return;
  }

  const specStatusMatch = path.match(/^\/admin\/specs\/([^/]+)\/status$/);

  if (specStatusMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const spec = await getSpecForAuth(specStatusMatch[1], auth);
    if (!spec) {
      sendJson(res, 404, { error: "Spec not found" });
      return;
    }

    const status = normalizeSpecStatus(body.status);
    if (!status) {
      sendJson(res, 400, { error: "Invalid status" });
      return;
    }

    const result = await query(
      `UPDATE paywall_specs SET status = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, workspace_id, name, spec, status, version, created_at, updated_at, created_by`,
      [specStatusMatch[1], status]
    );
    sendJson(res, 200, result.rows[0]);
    return;
  }

  if (specIdMatch && req.method === "DELETE") {
    const spec = await getSpecForAuth(specIdMatch[1], auth);
    if (!spec) {
      sendJson(res, 404, { error: "Spec not found" });
      return;
    }
    const result = await query(
      `UPDATE paywall_specs SET status = 'archived', updated_at = now()
       WHERE id = $1
       RETURNING id, workspace_id, name, spec, status, version, created_at, updated_at, created_by`,
      [specIdMatch[1]]
    );
    sendJson(res, 200, result.rows[0]);
    return;
  }

  // --- BULK CONFIG ---

  if (path === "/admin/config/export" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const workspace = await resolveWorkspace(
      auth,
      normalizeOptionalText(url.searchParams.get("public_key") || url.searchParams.get("publicKey"))
    );
    if (!workspace) {
      sendJson(res, 400, { error: "Missing or invalid workspace" });
      return;
    }
    sendJson(res, 200, await exportWorkspaceConfig(workspace.id));
    return;
  }

  if (path === "/admin/config/import" && req.method === "POST") {
    const body = await readJson(req);
    const workspace = await resolveWorkspace(auth, body.publicKey || body.public_key);
    if (!workspace) {
      sendJson(res, 400, { error: "Missing or invalid workspace" });
      return;
    }
    const imported = await importWorkspaceConfig(workspace.id, body);
    sendJson(res, 200, imported);
    return;
  }

  // --- PLACEMENTS ---

  if (path === "/admin/placements" && req.method === "GET") {
    const result = await query<{
      id: string; public_key: string; trigger: string; enabled: boolean;
      variant_id: string; experiment_id: string | null; spec: unknown; created_at: string;
      client_name: string; statsig_project_name: string | null; statsig_server_secret_env_var: string | null;
      variants: unknown[];
    }>(
      `SELECT
         p.*,
         c.name AS client_name,
         c.statsig_project_name,
         COALESCE(NULLIF(c.statsig_server_secret_env_var, ''), 'STATSIG_SERVER_SECRET') AS statsig_server_secret_env_var,
         COALESCE(
           json_agg(
             json_build_object(
               'id', pv.id,
               'variant_id', pv.variant_id,
               'variant_key', COALESCE(pv.variant_key, pv.variant_id),
               'spec_id', pv.spec_id,
               'enabled', pv.enabled,
               'status', COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END),
               'weight', pv.weight,
               'fallback_rank', pv.fallback_rank,
               'spec', pv.spec,
               'created_at', pv.created_at
             )
             ORDER BY
               CASE WHEN pv.variant_id = p.variant_id THEN 0 ELSE 1 END,
               pv.fallback_rank ASC,
               pv.created_at ASC
           ) FILTER (WHERE pv.id IS NOT NULL),
           '[]'::json
         ) AS variants
       FROM placements p
       JOIN clients c ON c.public_key = p.public_key
       LEFT JOIN placement_variants pv ON pv.placement_id = p.id
       GROUP BY p.id, c.name, c.statsig_project_name, c.statsig_server_secret_env_var
       ORDER BY p.created_at DESC`
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.rows.map(withStatsigStatus)));
    return;
  }

  if (path === "/admin/placements" && req.method === "POST") {
    const body = await readJson(req);
    const workspace = await resolveWorkspace(auth, body.publicKey || body.public_key);
    const publicKey = workspace?.public_key || body.publicKey || body.public_key;
    const trigger = normalizeOptionalText(body.trigger);
    const defaultSpecId = normalizeOptionalText(body.default_spec_id ?? body.defaultSpecId);
    const statsigExperimentId = normalizeOptionalText(body.statsig_experiment_id ?? body.experimentId ?? body.experiment_id);
    const variantId = normalizeOptionalText(body.variantId ?? body.variant_id) || "default";

    if (!publicKey || !trigger || (!body.spec && !defaultSpecId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing publicKey, trigger, or spec/default_spec_id" }));
      return;
    }

    let spec = body.spec;
    if (defaultSpecId) {
      const defaultSpec = await getSpecForAuth(defaultSpecId, auth);
      if (!defaultSpec || (workspace && defaultSpec.workspace_id !== workspace.id)) {
        sendJson(res, 404, { error: "Default spec not found" });
        return;
      }
      spec = defaultSpec.spec;
    }

    const id = generateId("pl");
    const placement = await query<{ id: string }>(
      `INSERT INTO placements (
         id, public_key, trigger, enabled, status, variant_id, experiment_id,
         statsig_experiment_id, default_spec_id, targeting_rules, spec
       )
       VALUES ($1, $2, $3, true, 'active', $4, $5, $5, $6, $7, $8)
       ON CONFLICT (public_key, trigger) DO UPDATE SET
         variant_id = EXCLUDED.variant_id,
         experiment_id = EXCLUDED.experiment_id,
         statsig_experiment_id = EXCLUDED.statsig_experiment_id,
         default_spec_id = EXCLUDED.default_spec_id,
         targeting_rules = EXCLUDED.targeting_rules,
         spec = EXCLUDED.spec,
         enabled = true,
         status = 'active',
         updated_at = now()
       RETURNING id`,
      [
        id,
        publicKey,
        trigger,
        variantId,
        statsigExperimentId,
        defaultSpecId,
        JSON.stringify(Array.isArray(body.targeting_rules) ? body.targeting_rules : []),
        JSON.stringify(spec),
      ]
    );
    const placementId = placement.rows[0].id;
    if (body.variants !== undefined || body.spec !== undefined) {
      await upsertVariants(
        placementId,
        normalizeVariants(body.variants, variantId, spec)
      );
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: placementId, trigger, default_spec_id: defaultSpecId, status: "created" }));
    return;
  }

  const placementIdMatch = path.match(/^\/admin\/placements\/([^/]+)$/);
  const placementStatusMatch = path.match(/^\/admin\/placements\/([^/]+)\/status$/);
  const placementVariantsMatch = path.match(/^\/admin\/placements\/([^/]+)\/variants$/);
  const placementVariantMatch = path.match(/^\/admin\/placements\/([^/]+)\/variants\/([^/]+)$/);

  if (placementIdMatch && req.method === "GET") {
    const placement = await getPlacementForAuth(placementIdMatch[1], auth);
    if (!placement) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }
    const variants = await getPlacementVariantsForAuth(placementIdMatch[1], auth);
    sendJson(res, 200, { ...placement, variants });
    return;
  }

  if (placementIdMatch && req.method === "PUT") {
    const existing = await getPlacementForAuth(placementIdMatch[1], auth);
    if (!existing) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }

    const body = await readJson(req);
    const defaultSpecId = normalizeOptionalText(body.default_spec_id ?? body.defaultSpecId);
    const variantId = body.variant_id !== undefined || body.variantId !== undefined
      ? normalizeOptionalText(body.variant_id ?? body.variantId)
      : undefined;
    const statsigExperimentId = body.statsig_experiment_id !== undefined || body.experimentId !== undefined || body.experiment_id !== undefined
      ? normalizeOptionalText(body.statsig_experiment_id ?? body.experimentId ?? body.experiment_id)
      : undefined;
    let defaultSpec: Record<string, unknown> | null = null;

    if (defaultSpecId) {
      defaultSpec = await getSpecForAuth(defaultSpecId, auth);
      if (!defaultSpec || defaultSpec.workspace_id !== existing.workspace_id) {
        sendJson(res, 404, { error: "Default spec not found" });
        return;
      }
    }

    const result = await query(
      `UPDATE placements
       SET default_spec_id = COALESCE($2, default_spec_id),
           spec = COALESCE($3, spec),
           statsig_experiment_id = COALESCE($4, statsig_experiment_id),
           experiment_id = COALESCE($4, experiment_id),
           targeting_rules = COALESCE($5, targeting_rules),
           variant_id = COALESCE($6, variant_id),
           updated_at = now()
       WHERE id = $1
       RETURNING id, public_key, trigger, status, variant_id, default_spec_id, statsig_experiment_id, targeting_rules, created_at, updated_at`,
      [
        placementIdMatch[1],
        defaultSpecId,
        defaultSpec ? JSON.stringify(defaultSpec.spec) : null,
        statsigExperimentId,
        body.targeting_rules === undefined ? null : JSON.stringify(Array.isArray(body.targeting_rules) ? body.targeting_rules : []),
        variantId,
      ]
    );
    sendJson(res, 200, result.rows[0]);
    return;
  }

  if (placementStatusMatch && req.method === "PATCH") {
    const existing = await getPlacementForAuth(placementStatusMatch[1], auth);
    if (!existing) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }
    const body = await readJson(req);
    const status = normalizePlacementStatus(body.status);
    if (!status) {
      sendJson(res, 400, { error: "Invalid status" });
      return;
    }
    const result = await query(
      `UPDATE placements
       SET status = $2,
           enabled = $2 = 'active',
           updated_at = now()
       WHERE id = $1
       RETURNING id, public_key, trigger, status, default_spec_id, statsig_experiment_id, targeting_rules, created_at, updated_at`,
      [placementStatusMatch[1], status]
    );
    sendJson(res, 200, result.rows[0]);
    return;
  }

  if (placementVariantsMatch && req.method === "GET") {
    const existing = await getPlacementForAuth(placementVariantsMatch[1], auth);
    if (!existing) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }
    sendJson(res, 200, await getPlacementVariantsForAuth(placementVariantsMatch[1], auth));
    return;
  }

  if (placementVariantsMatch && req.method === "POST") {
    const existing = await getPlacementForAuth(placementVariantsMatch[1], auth);
    if (!existing) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }
    const body = await readJson(req);
    const variantKey = normalizeOptionalText(body.variant_key ?? body.variantKey);
    const specId = normalizeOptionalText(body.spec_id ?? body.specId);
    if (!variantKey || !specId) {
      sendJson(res, 400, { error: "Missing variant_key or spec_id" });
      return;
    }
    const spec = await getSpecForAuth(specId, auth);
    if (!spec || spec.workspace_id !== existing.workspace_id) {
      sendJson(res, 404, { error: "Spec not found" });
      return;
    }
    const result = await query(
      `INSERT INTO placement_variants (placement_id, variant_id, variant_key, spec_id, spec, enabled, status, weight, fallback_rank)
       VALUES ($1, $2, $2, $3, $4, true, 'active', $5, $6)
       ON CONFLICT (placement_id, variant_id) DO UPDATE SET
         variant_key = EXCLUDED.variant_key,
         spec_id = EXCLUDED.spec_id,
         spec = EXCLUDED.spec,
         weight = EXCLUDED.weight,
         status = 'active',
         enabled = true
       RETURNING id, placement_id, variant_key, spec_id, weight, status, created_at`,
      [
        placementVariantsMatch[1],
        variantKey,
        specId,
        JSON.stringify(spec.spec),
        Number.isFinite(Number(body.weight)) ? Number(body.weight) : 50,
        Number.isFinite(Number(body.fallback_rank ?? body.fallbackRank)) ? Number(body.fallback_rank ?? body.fallbackRank) : 0,
      ]
    );
    sendJson(res, 201, result.rows[0]);
    return;
  }

  if (placementVariantMatch && req.method === "PUT") {
    const existing = await getPlacementForAuth(placementVariantMatch[1], auth);
    if (!existing) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }
    const body = await readJson(req);
    const specId = normalizeOptionalText(body.spec_id ?? body.specId);
    if (!specId) {
      sendJson(res, 400, { error: "Missing spec_id" });
      return;
    }
    const spec = await getSpecForAuth(specId, auth);
    if (!spec || spec.workspace_id !== existing.workspace_id) {
      sendJson(res, 404, { error: "Spec not found" });
      return;
    }
    const result = await query(
      `UPDATE placement_variants
       SET spec_id = $3,
           spec = $4,
           weight = COALESCE($5, weight),
           status = COALESCE($6, status),
           enabled = COALESCE($6, status) = 'active'
       WHERE placement_id = $1 AND COALESCE(variant_key, variant_id) = $2
       RETURNING id, placement_id, variant_key, spec_id, weight, status, created_at`,
      [
        placementVariantMatch[1],
        decodeURIComponent(placementVariantMatch[2]),
        specId,
        JSON.stringify(spec.spec),
        Number.isFinite(Number(body.weight)) ? Number(body.weight) : null,
        normalizeVariantStatus(body.status),
      ]
    );
    if (!result.rows[0]) {
      sendJson(res, 404, { error: "Variant not found" });
      return;
    }
    sendJson(res, 200, result.rows[0]);
    return;
  }

  if (placementVariantMatch && req.method === "DELETE") {
    const existing = await getPlacementForAuth(placementVariantMatch[1], auth);
    if (!existing) {
      sendJson(res, 404, { error: "Placement not found" });
      return;
    }
    await query(
      "DELETE FROM placement_variants WHERE placement_id = $1 AND COALESCE(variant_key, variant_id) = $2",
      [placementVariantMatch[1], decodeURIComponent(placementVariantMatch[2])]
    );
    sendJson(res, 200, { placement_id: placementVariantMatch[1], variant_key: decodeURIComponent(placementVariantMatch[2]), status: "deleted" });
    return;
  }

  if (placementIdMatch && req.method === "PATCH") {
    const id = placementIdMatch[1];
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (body.enabled !== undefined) { sets.push(`enabled = $${paramIdx++}`); params.push(body.enabled); }
    if (body.spec !== undefined) { sets.push(`spec = $${paramIdx++}`); params.push(JSON.stringify(body.spec)); }
    if (body.variantId !== undefined) { sets.push(`variant_id = $${paramIdx++}`); params.push(body.variantId); }
    if (body.experimentId !== undefined) { sets.push(`experiment_id = $${paramIdx++}`); params.push(body.experimentId || null); }
    if (body.trigger !== undefined) { sets.push(`trigger = $${paramIdx++}`); params.push(body.trigger); }

    if (sets.length === 0 && body.variants === undefined) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Nothing to update" }));
      return;
    }

    if (sets.length > 0) {
      params.push(id);
      const updated = await query(`UPDATE placements SET ${sets.join(", ")} WHERE id = $${paramIdx}`, params);
      if (updated.rowCount === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Placement not found. Refresh the dashboard and try again." }));
        return;
      }
    } else if (body.variants !== undefined) {
      const existing = await query("SELECT 1 FROM placements WHERE id = $1", [id]);
      if (existing.rowCount === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Placement not found. Refresh the dashboard and try again." }));
        return;
      }
    }
    if (body.variants !== undefined || body.spec !== undefined || body.variantId !== undefined) {
      await upsertVariants(
        id,
        normalizeVariants(body.variants, body.variantId || "var_default", body.spec)
      );
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, status: "updated" }));
    return;
  }

  if (placementIdMatch && req.method === "DELETE") {
    const id = placementIdMatch[1];
    await query("DELETE FROM placements WHERE id = $1", [id]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, status: "deleted" }));
    return;
  }

  // --- CLIENTS ---

  if (path === "/admin/clients" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const sdkStack = normalizeSdkStack(url.searchParams.get("stack") || url.searchParams.get("sdk_stack"));
    const params: unknown[] = [];
    const filters: string[] = [];
    if (sdkStack) {
      params.push(sdkStack);
      filters.push(`sdk_stack = $${params.length}`);
    }
    const result = await query<{
      id: string;
      public_key: string;
      name: string;
      sdk_stack: SdkStack;
      statsig_project_name: string | null;
      statsig_server_secret_env_var: string | null;
      created_at: string;
    }>(
      `SELECT
         id,
         public_key,
         name,
         COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack,
         statsig_project_name,
         NULLIF(statsig_server_secret_env_var, '') AS statsig_server_secret_env_var,
         created_at
       FROM clients
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY created_at DESC`,
      params
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.rows.map(withStatsigStatus)));
    return;
  }

  if (path === "/admin/clients" && req.method === "POST") {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const env: "live" | "test" = body.env === "live" ? "live" : "test";
    if (!name) {
      sendJson(res, 400, { error: "Missing name" });
      return;
    }
    const statsigProjectName = normalizeOptionalText(body.statsigProjectName ?? body.statsig_project_name);
    const sdkStack = normalizeSdkStack(body.sdkStack ?? body.sdk_stack) || "react_native";
    const rawEnvVar = body.statsigServerSecretEnvVar ?? body.statsig_server_secret_env_var;
    // Statsig is fully optional. Only persist an env var if the caller opted in
    // (provided either a project name or an explicit env var). Otherwise leave NULL.
    let statsigServerSecretEnvVar: string | null;
    if (rawEnvVar) {
      statsigServerSecretEnvVar = normalizeStatsigSecretEnvVar(rawEnvVar);
      if (!isValidStatsigSecretEnvVar(statsigServerSecretEnvVar)) {
        sendJson(res, 400, { error: "Invalid Statsig server secret env var (must match [A-Z][A-Z0-9_]*)" });
        return;
      }
    } else if (statsigProjectName) {
      statsigServerSecretEnvVar = suggestStatsigEnvVar(name);
    } else {
      statsigServerSecretEnvVar = null;
    }

    const id = generateId("client");
    const publicKey = generatePublicKey(env);
    const secretKey = generateSecretKey(env);
    await query(
      `INSERT INTO clients (id, public_key, secret_key, name, sdk_stack, statsig_project_name, statsig_server_secret_env_var)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, publicKey, secretKey, name, sdkStack, statsigProjectName, statsigServerSecretEnvVar]
    );

    sendJson(res, 201, {
      ...withStatsigStatus({
        id,
        public_key: publicKey,
        name,
        sdk_stack: sdkStack,
        statsig_project_name: statsigProjectName,
        statsig_server_secret_env_var: statsigServerSecretEnvVar,
      }),
      secret_key: secretKey,
      env,
      setup: buildClientSetup({
        publicKey,
        secretKey,
        sdkStack,
        statsigProjectName,
        statsigServerSecretEnvVar,
      }),
    });
    return;
  }

  const clientSetupMatch = path.match(/^\/admin\/clients\/([^/]+)\/setup$/);
  if (clientSetupMatch && req.method === "GET") {
    const id = clientSetupMatch[1];
    const result = await query<{
      id: string; public_key: string; name: string;
      sdk_stack: SdkStack;
      statsig_project_name: string | null; statsig_server_secret_env_var: string | null;
    }>(
      `SELECT id, public_key, name, COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack, statsig_project_name,
              NULLIF(statsig_server_secret_env_var, '') AS statsig_server_secret_env_var
         FROM clients WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) {
      sendJson(res, 404, { error: "Client not found" });
      return;
    }
    sendJson(res, 200, {
      ...withStatsigStatus(row),
      setup: buildClientSetup({
        publicKey: row.public_key,
        secretKey: null,
        sdkStack: row.sdk_stack,
        statsigProjectName: row.statsig_project_name,
        statsigServerSecretEnvVar: row.statsig_server_secret_env_var,
      }),
    });
    return;
  }

  const clientIdMatch = path.match(/^\/admin\/clients\/([^/]+)$/);

  if (clientIdMatch && req.method === "PATCH") {
    const id = clientIdMatch[1];
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing name" }));
        return;
      }
      sets.push(`name = $${paramIdx++}`);
      params.push(name);
    }
    if (body.statsigProjectName !== undefined || body.statsig_project_name !== undefined) {
      sets.push(`statsig_project_name = $${paramIdx++}`);
      params.push(normalizeOptionalText(body.statsigProjectName ?? body.statsig_project_name));
    }
    if (body.sdkStack !== undefined || body.sdk_stack !== undefined) {
      const sdkStack = normalizeSdkStack(body.sdkStack ?? body.sdk_stack);
      if (!sdkStack) {
        sendJson(res, 400, { error: "Invalid SDK stack" });
        return;
      }
      sets.push(`sdk_stack = $${paramIdx++}`);
      params.push(sdkStack);
    }
    if (body.statsigServerSecretEnvVar !== undefined || body.statsig_server_secret_env_var !== undefined) {
      const value = normalizeStatsigSecretEnvVar(
        body.statsigServerSecretEnvVar ?? body.statsig_server_secret_env_var
      );
      if (!isValidStatsigSecretEnvVar(value)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid Statsig server secret env var" }));
        return;
      }
      sets.push(`statsig_server_secret_env_var = $${paramIdx++}`);
      params.push(value);
    }

    if (sets.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Nothing to update" }));
      return;
    }

    params.push(id);
    const result = await query<{
      id: string;
      public_key: string;
      name: string;
      sdk_stack: SdkStack;
      statsig_project_name: string | null;
      statsig_server_secret_env_var: string | null;
      created_at: string;
    }>(
      `UPDATE clients SET ${sets.join(", ")}
       WHERE id = $${paramIdx}
       RETURNING id, public_key, name, COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack, statsig_project_name, statsig_server_secret_env_var, created_at`,
      params
    );
    if (!result.rows[0]) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Client not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(withStatsigStatus(result.rows[0])));
    return;
  }

  if (clientIdMatch && req.method === "GET") {
    const result = await query<{
      id: string; public_key: string; name: string;
      sdk_stack: SdkStack;
      statsig_project_name: string | null; statsig_server_secret_env_var: string | null;
      created_at: string;
    }>(
      `SELECT id, public_key, name, COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack, statsig_project_name,
              COALESCE(NULLIF(statsig_server_secret_env_var, ''), 'STATSIG_SERVER_SECRET') AS statsig_server_secret_env_var,
              created_at
         FROM clients WHERE id = $1`,
      [clientIdMatch[1]]
    );
    if (!result.rows[0]) {
      sendJson(res, 404, { error: "Client not found" });
      return;
    }
    sendJson(res, 200, withStatsigStatus(result.rows[0]));
    return;
  }

  if (clientIdMatch && req.method === "DELETE") {
    const id = clientIdMatch[1];
    const existing = await query<{ public_key: string }>(
      "SELECT public_key FROM clients WHERE id = $1",
      [id]
    );
    if (!existing.rows[0]) {
      sendJson(res, 404, { error: "Client not found" });
      return;
    }
    await query("DELETE FROM clients WHERE id = $1", [id]);
    sendJson(res, 200, { id, status: "deleted" });
    return;
  }

  // --- EVENTS STATS ---

  if (path === "/admin/events/stats" && req.method === "GET") {
    const result = await query<{ event_name: string; count: string }>(
      `SELECT event_name, COUNT(*)::text as count FROM events
       GROUP BY event_name ORDER BY count DESC LIMIT 20`
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.rows));
    return;
  }

  if (path === "/admin/events/recent" && req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
    const result = await query<{
      id: string;
      public_key: string;
      user_id: string;
      session_id: string;
      event_name: string;
      properties: Record<string, unknown>;
      identity: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT
         id::text,
         public_key,
         user_id,
         session_id,
         event_name,
         properties,
         identity,
         created_at::text
       FROM events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.rows));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Admin route not found" }));
}

function normalizeVariants(input: unknown, defaultVariantId: string, defaultSpec: unknown): Required<VariantInput>[] {
  const rawVariants = Array.isArray(input) ? input : [];
  const variants = rawVariants
    .filter((variant): variant is VariantInput => Boolean(variant && typeof variant === "object"))
    .map((variant, index) => ({
      variantId: String(variant.variantId || variant.variant_id || "").trim(),
      spec: variant.spec,
      enabled: variant.enabled !== false,
      fallbackRank: Number(variant.fallbackRank ?? variant.fallback_rank ?? index),
      variant_id: "",
      fallback_rank: 0,
    }))
    .filter((variant) => variant.variantId && variant.spec !== undefined);

  if (!variants.some((variant) => variant.variantId === defaultVariantId) && defaultSpec !== undefined) {
    variants.unshift({
      variantId: defaultVariantId,
      spec: defaultSpec,
      enabled: true,
      fallbackRank: 0,
      variant_id: "",
      fallback_rank: 0,
    });
  }

  return variants;
}

async function upsertVariants(placementId: string, variants: Required<VariantInput>[]): Promise<void> {
  if (variants.length === 0) return;
  for (const variant of variants) {
    await query(
      `INSERT INTO placement_variants (placement_id, variant_id, spec, enabled, fallback_rank)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (placement_id, variant_id) DO UPDATE SET
         spec = EXCLUDED.spec,
         enabled = EXCLUDED.enabled,
         fallback_rank = EXCLUDED.fallback_rank`,
      [
        placementId,
        variant.variantId,
        JSON.stringify(variant.spec),
        variant.enabled,
        variant.fallbackRank,
      ]
    );
  }
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeSdkStack(value: unknown): SdkStack | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "rn" || normalized === "react_native" || normalized === "reactnative") {
    return "react_native";
  }
  if (normalized === "flutter") return "flutter";
  if (normalized === "swift" || normalized === "ios") return "swift";
  return null;
}

function withStatsigStatus<T extends {
  statsig_project_name?: string | null;
  statsig_server_secret_env_var?: string | null;
}>(row: T): T & {
  statsig_server_secret_env_var: string | null;
  statsig_enabled: boolean;
  statsig_configured: boolean;
  statsig_initialized: boolean;
} {
  const status = getStatsigProjectStatus({
    projectName: row.statsig_project_name,
    serverSecretEnvVar: row.statsig_server_secret_env_var,
  });
  return {
    ...row,
    statsig_project_name: status.projectName,
    statsig_server_secret_env_var: status.serverSecretEnvVar,
    statsig_enabled: status.enabled,
    statsig_configured: status.configured,
    statsig_initialized: status.initialized,
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function resolveWorkspace(
  auth: AdminAuthContext,
  publicKey?: unknown
): Promise<{ id: string; public_key: string; secret_key: string; name: string } | null> {
  if (auth.kind === "workspace" && auth.workspaceId && auth.publicKey && auth.secretKey) {
    return {
      id: auth.workspaceId,
      public_key: auth.publicKey,
      secret_key: auth.secretKey,
      name: "",
    };
  }

  const normalizedPublicKey = normalizeOptionalText(publicKey);
  if (!normalizedPublicKey) return null;
  return getWorkspaceForPublicKey(normalizedPublicKey);
}

async function getSpecForAuth(id: string, auth: AdminAuthContext): Promise<{
  id: string;
  workspace_id: string;
  name: string;
  spec: any;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
} | null> {
  const params: unknown[] = [id];
  const filters = ["id = $1"];
  if (auth.kind === "workspace") {
    params.push(auth.workspaceId);
    filters.push(`workspace_id = $${params.length}`);
  }
  const result = await query<{
    id: string;
    workspace_id: string;
    name: string;
    spec: any;
    status: string;
    version: number;
    created_at: string;
    updated_at: string;
    created_by: string | null;
  }>(
    `SELECT id, workspace_id, name, spec, status, version, created_at, updated_at, created_by
     FROM paywall_specs
     WHERE ${filters.join(" AND ")}`,
    params
  );
  return result.rows[0] || null;
}

async function getPlacementForAuth(id: string, auth: AdminAuthContext): Promise<{
  id: string;
  workspace_id: string;
  public_key: string;
  trigger: string;
  status: string;
  default_spec_id: string | null;
  statsig_experiment_id: string | null;
  targeting_rules: unknown;
  created_at: string;
  updated_at: string;
} | null> {
  const params: unknown[] = [id];
  const filters = ["p.id = $1"];
  if (auth.kind === "workspace") {
    params.push(auth.workspaceId);
    filters.push(`c.id = $${params.length}`);
  }
  const result = await query<{
    id: string;
    workspace_id: string;
    public_key: string;
    trigger: string;
    status: string;
    default_spec_id: string | null;
    statsig_experiment_id: string | null;
    targeting_rules: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       p.id,
       c.id AS workspace_id,
       p.public_key,
       p.trigger,
       COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) AS status,
       p.default_spec_id,
       COALESCE(p.statsig_experiment_id, p.experiment_id) AS statsig_experiment_id,
       p.targeting_rules,
       p.created_at,
       p.updated_at
     FROM placements p
     JOIN clients c ON c.public_key = p.public_key
     WHERE ${filters.join(" AND ")}`,
    params
  );
  return result.rows[0] || null;
}

async function getPlacementVariantsForAuth(placementId: string, auth: AdminAuthContext): Promise<unknown[]> {
  const placement = await getPlacementForAuth(placementId, auth);
  if (!placement) return [];
  const result = await query(
    `SELECT
       pv.id,
       pv.placement_id,
       COALESCE(pv.variant_key, pv.variant_id) AS variant_key,
       pv.spec_id,
       ps.name AS spec_name,
       COALESCE(pv.weight, 50) AS weight,
       COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END) AS status,
       pv.created_at
     FROM placement_variants pv
     LEFT JOIN paywall_specs ps ON ps.id = pv.spec_id
     WHERE pv.placement_id = $1
     ORDER BY pv.fallback_rank ASC, pv.created_at ASC`,
    [placementId]
  );
  return result.rows;
}

async function exportWorkspaceConfig(workspaceId: string): Promise<unknown> {
  const specs = await query(
    `SELECT id, name, spec, status, version, created_by, created_at, updated_at
     FROM paywall_specs
     WHERE workspace_id = $1
     ORDER BY name ASC`,
    [workspaceId]
  );
  const placements = await query(
    `SELECT
       p.id,
       p.trigger,
       COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) AS status,
       p.default_spec_id,
       COALESCE(p.statsig_experiment_id, p.experiment_id) AS statsig_experiment_id,
       p.targeting_rules,
       p.created_at,
       p.updated_at
     FROM placements p
     JOIN clients c ON c.public_key = p.public_key
     WHERE c.id = $1
     ORDER BY p.trigger ASC`,
    [workspaceId]
  );
  const variants = await query(
    `SELECT
       pv.id,
       pv.placement_id,
       COALESCE(pv.variant_key, pv.variant_id) AS variant_key,
       pv.spec_id,
       pv.weight,
       COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END) AS status,
       pv.created_at
     FROM placement_variants pv
     JOIN placements p ON p.id = pv.placement_id
     JOIN clients c ON c.public_key = p.public_key
     WHERE c.id = $1
     ORDER BY pv.placement_id ASC, pv.fallback_rank ASC`,
    [workspaceId]
  );

  return {
    exported_at: new Date().toISOString(),
    specs: specs.rows,
    placements: placements.rows,
    variants: variants.rows,
  };
}

async function importWorkspaceConfig(workspaceId: string, body: any): Promise<{ specs: number; placements: number; variants: number }> {
  const workspace = await query<{ public_key: string }>("SELECT public_key FROM clients WHERE id = $1", [workspaceId]);
  const publicKey = workspace.rows[0]?.public_key;
  if (!publicKey) return { specs: 0, placements: 0, variants: 0 };

  const specIdMap = new Map<string, string>();
  const placementIdMap = new Map<string, string>();

  for (const item of Array.isArray(body.specs) ? body.specs : []) {
    const validation = validatePaywallSpec(item.spec);
    if (!validation.valid) continue;
    const result = await query<{ id: string }>(
      `INSERT INTO paywall_specs (workspace_id, name, spec, status, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         spec = EXCLUDED.spec,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING id`,
      [
        workspaceId,
        String(item.name || "").trim(),
        JSON.stringify(item.spec),
        normalizeSpecStatus(item.status, "draft"),
        normalizeOptionalText(item.created_by ?? item.createdBy) || "import",
      ]
    );
    if (item.id) specIdMap.set(item.id, result.rows[0].id);
  }

  for (const item of Array.isArray(body.placements) ? body.placements : []) {
    const trigger = normalizeOptionalText(item.trigger);
    if (!trigger) continue;
    const defaultSpecId = item.default_spec_id ? specIdMap.get(item.default_spec_id) || item.default_spec_id : null;
    const defaultSpec = defaultSpecId ? await getSpecForAuth(defaultSpecId, { kind: "admin" }) : null;
    const result = await query<{ id: string }>(
      `INSERT INTO placements (id, public_key, trigger, enabled, status, variant_id, experiment_id, statsig_experiment_id, default_spec_id, targeting_rules, spec)
       VALUES ($1, $2, $3, $4, $5, 'default', $6, $6, $7, $8, $9)
       ON CONFLICT (public_key, trigger) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         status = EXCLUDED.status,
         experiment_id = EXCLUDED.experiment_id,
         statsig_experiment_id = EXCLUDED.statsig_experiment_id,
         default_spec_id = EXCLUDED.default_spec_id,
         targeting_rules = EXCLUDED.targeting_rules,
         spec = EXCLUDED.spec,
         updated_at = now()
       RETURNING id`,
      [
        item.id || generateId("pl"),
        publicKey,
        trigger,
        normalizePlacementStatus(item.status) === "active",
        normalizePlacementStatus(item.status) || "active",
        normalizeOptionalText(item.statsig_experiment_id),
        defaultSpecId,
        JSON.stringify(Array.isArray(item.targeting_rules) ? item.targeting_rules : []),
        JSON.stringify(defaultSpec?.spec || {}),
      ]
    );
    if (item.id) placementIdMap.set(item.id, result.rows[0].id);
  }

  for (const item of Array.isArray(body.variants) ? body.variants : []) {
    const placementId = placementIdMap.get(item.placement_id) || item.placement_id;
    const specId = specIdMap.get(item.spec_id) || item.spec_id;
    const variantKey = normalizeOptionalText(item.variant_key);
    if (!placementId || !specId || !variantKey) continue;
    const spec = await getSpecForAuth(specId, { kind: "admin" });
    if (!spec) continue;
    await query(
      `INSERT INTO placement_variants (placement_id, variant_id, variant_key, spec_id, spec, enabled, status, weight)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (placement_id, variant_id) DO UPDATE SET
         variant_key = EXCLUDED.variant_key,
         spec_id = EXCLUDED.spec_id,
         spec = EXCLUDED.spec,
         enabled = EXCLUDED.enabled,
         status = EXCLUDED.status,
         weight = EXCLUDED.weight`,
      [
        placementId,
        variantKey,
        specId,
        JSON.stringify(spec.spec),
        normalizeVariantStatus(item.status) !== "paused",
        normalizeVariantStatus(item.status) || "active",
        Number.isFinite(Number(item.weight)) ? Number(item.weight) : 50,
      ]
    );
  }

  return {
    specs: specIdMap.size,
    placements: placementIdMap.size,
    variants: Array.isArray(body.variants) ? body.variants.length : 0,
  };
}

function normalizeSpecStatus(value: unknown, fallback?: "draft" | "active" | "archived"): "draft" | "active" | "archived" | null {
  return value === "draft" || value === "active" || value === "archived" ? value : fallback || null;
}

function normalizePlacementStatus(value: unknown): "active" | "paused" | "archived" | null {
  return value === "active" || value === "paused" || value === "archived" ? value : null;
}

function normalizeVariantStatus(value: unknown): "active" | "paused" | null {
  return value === "active" || value === "paused" ? value : null;
}

function buildClientSetup(input: {
  publicKey: string;
  secretKey: string | null;
  sdkStack: SdkStack;
  statsigProjectName: string | null;
  statsigServerSecretEnvVar: string | null;
}): {
  publicKey: string;
  secretKey: string | null;
  sdkStack: SdkStack;
  statsigEnabled: boolean;
  statsigServerSecretEnvVar: string | null;
  sdkSnippet: string;
  sdkInstallTitle: string;
  railway: { variable: string; description: string } | null;
  reactNativeSnippet: string;
  configCurl: string;
  statsigSetup: {
    projectName: string | null;
    expectedParameter: string;
    experimentTip: string;
  } | null;
} {
  const reactNativeSnippet = `import { Button } from "react-native";
import { TranzmitProvider, useTranzmit } from "@tranzmit/react-native";

export default function App() {
  return (
    <TranzmitProvider
      publicKey="${input.publicKey}"
      apiBaseUrl="https://your-tranzmit-api.up.railway.app"
      userId={currentUser?.id}
    >
      <YourApp />
    </TranzmitProvider>
  );
}

function PaywallGate() {
  const { gate, reportConversion, refreshConfig } = useTranzmit();

  async function startNativePurchase(product) {
    // IMPORTANT: Tranzmit owns the paywall UI. Your app owns StoreKit/Play Billing.
    // Use product.id to start your native purchase, then report the conversion.
    await purchaseWithRevenueCatStoreKitOrPlayBilling(product.id);
    reportConversion({
      trigger: "upgrade_pro",
      productId: product.id,
      revenue: product.metadata?.priceAmount,
      currency: product.metadata?.currency || "USD",
    });
  }

  return (
    <Button
      title="Upgrade"
      onPress={() => gate("upgrade_pro", { onCTA: startNativePurchase })}
    />
  );
}

// Call refreshConfig() after saving a paywall in the dashboard during QA.
// In production the SDK also refreshes from cache using the server TTL.`;

  const flutterSnippet = `import 'package:flutter/material.dart';
import 'package:tranzmit_flutter/tranzmit_flutter.dart';

void main() {
  runApp(
    TranzmitProvider(
      config: const TranzmitConfig(
        publicKey: "${input.publicKey}",
        apiBaseUrl: "https://your-tranzmit-api.up.railway.app",
      ),
      child: const YourApp(),
    ),
  );
}

class PaywallGate extends StatelessWidget {
  const PaywallGate({super.key});

  @override
  Widget build(BuildContext context) {
    final tranzmit = Tranzmit.of(context);
    return ElevatedButton(
      onPressed: () => tranzmit.presentPlacement(
        "upgrade_pro",
        onCTA: (product) async {
          // IMPORTANT: Tranzmit owns the paywall UI. Your app owns StoreKit/Play Billing.
          // Use product.id to start your native purchase, then report the conversion.
          await purchaseWithStoreKitPlayBillingOrRevenueCat(product.id);
          tranzmit.reportConversion({
            'trigger': 'upgrade_pro',
            'productId': product.id,
            'revenue': 9.99,
            'currency': 'USD',
          });
        },
      ),
      child: const Text("Upgrade"),
    );
  }
}`;

  const swiftSnippet = `// Native Swift SDK support is planned. Use the public key below
// when adding the Swift package once it is available.
let tranzmitPublicKey = "${input.publicKey}"`;

  const sdkSnippet = input.sdkStack === "flutter"
    ? flutterSnippet
    : input.sdkStack === "swift"
      ? swiftSnippet
      : reactNativeSnippet;
  const sdkInstallTitle = input.sdkStack === "flutter"
    ? "Drop into the Flutter app"
    : input.sdkStack === "swift"
      ? "Prepare the Swift app"
      : "Drop into the React Native app";

  const configCurl = `curl -X POST https://your-tranzmit-api.up.railway.app/v1/config \\
  -H 'Content-Type: application/json' \\
  -d '{
    "public_key": "${input.publicKey}",
    "identity": {
      "userId": "user_123",
      "identifiers": { "stableID": "device_abc" }
    },
    "userTraits": { "plan": "free", "platform": "ios" }
  }'`;

  const statsigEnabled = Boolean(input.statsigServerSecretEnvVar);
  return {
    publicKey: input.publicKey,
    secretKey: input.secretKey,
    sdkStack: input.sdkStack,
    statsigEnabled,
    statsigServerSecretEnvVar: input.statsigServerSecretEnvVar,
    railway: statsigEnabled
      ? {
          variable: input.statsigServerSecretEnvVar as string,
          description: `Add ${input.statsigServerSecretEnvVar}=<server-secret-from-statsig.com> to Railway → Variables. The server will use this secret to evaluate experiments and forward events for this client.`,
        }
      : null,
    sdkSnippet,
    sdkInstallTitle,
    reactNativeSnippet,
    configCurl,
    statsigSetup: statsigEnabled
      ? {
          projectName: input.statsigProjectName,
          expectedParameter: "variant_id",
          experimentTip:
            "Create an experiment in Statsig with a string parameter named 'variant_id'. The values you return (e.g. control, test_1, test_2) must match a placement_variants row.variant_key inside Tranzmit.",
        }
      : null,
  };
}
