import { createHash, randomBytes } from "node:crypto";
import {
  extractRelativeAssetReferences,
  validateLocalizationCoverage,
  type PaywallSpec,
} from "@tranzmit/shared";
import { validatePaywallSpec } from "./paywall-schema.js";
import {
  database,
  getEnvironmentPaywall,
  withTransaction,
  type DbExecutor,
} from "./config-store.js";
import {
  exactWebViewDocumentPayload,
  hashDocument,
  sha256Integrity,
} from "./webview-documents.js";
import { compareLegacyAndV2Client } from "./compare-v2.js";

type JsonRecord = Record<string, any>;

interface LegacyProvenance {
  id: string;
  name: string;
  status: string;
  version: number;
  updatedAt: string;
  fingerprint: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface CreateReleaseInput {
  spec?: unknown;
  contentRevisionId?: string;
  products?: unknown;
  checkout?: unknown;
  createdBy?: string;
}

export interface PlacementRevisionInput {
  status: "active" | "paused" | "archived";
  defaultBindingId: string;
  defaultVariantKey: string;
  statsigExperimentId?: string | null;
  targetingRules?: unknown;
  variants: Array<{
    variantKey: string;
    bindingId: string;
    status?: "active" | "paused";
    weight?: number;
    fallbackRank?: number;
  }>;
  createdBy?: string;
}

export function splitPaywallSpec(spec: unknown): {
  content: JsonRecord;
  products: unknown[];
  checkout: JsonRecord | null;
} {
  const source = cloneRecord(spec);
  const products = Array.isArray(source.products) ? structuredClone(source.products) : [];
  const checkout = isRecord(source.checkout) ? structuredClone(source.checkout) : null;
  delete source.products;
  delete source.checkout;

  // These are delivery metadata, not author-owned content. They are rebuilt
  // from the immutable document bytes when a content revision is created.
  delete source.revision;
  delete source.cacheKey;
  if (isRecord(source.document)) {
    delete source.document.url;
    delete source.document.integrity;
    delete source.document.cacheTtlSeconds;
  }
  if (isRecord(source.metadata)) {
    delete source.metadata.documentDelivery;
    if (Object.keys(source.metadata).length === 0) delete source.metadata;
  }

  return { content: source, products, checkout };
}

export function composePaywallSpec(
  content: unknown,
  products: unknown,
  checkout: unknown
): JsonRecord {
  const spec = cloneRecord(content);
  spec.products = Array.isArray(products) ? structuredClone(products) : [];
  if (isRecord(checkout)) spec.checkout = structuredClone(checkout);
  else delete spec.checkout;
  return spec;
}

export function validatePublishableSpec(spec: unknown): {
  spec: JsonRecord;
  warnings: unknown[];
  tokens: string[];
} {
  const validation = validatePaywallSpec(spec);
  const localization = validateLocalizationCoverage(spec as Pick<PaywallSpec, "document" | "localization">);
  const errors: Array<{ path: string; message: string; keyword: string }> = [
    ...validation.errors,
  ];

  const document = isRecord((spec as JsonRecord)?.document) ? (spec as JsonRecord).document : {};
  const html = typeof document.html === "string" ? document.html : "";
  if (!html) {
    errors.push({
      path: "/document/html",
      message: "V2 publishing requires exact inline document HTML",
      keyword: "document",
    });
  }
  if (typeof document.integrity === "string" && html && document.integrity !== sha256Integrity(html)) {
    errors.push({
      path: "/document/integrity",
      message: "Document integrity does not match the uploaded HTML",
      keyword: "integrity",
    });
  }
  const unresolvedAssets = extractRelativeAssetReferences(
    html,
    typeof document.css === "string" ? document.css : undefined
  );
  if (!document.baseUrl && unresolvedAssets.length > 0) {
    errors.push({
      path: "/document/baseUrl",
      message: `Relative document assets require an explicit baseUrl: ${unresolvedAssets.join(", ")}`,
      keyword: "assets",
    });
  }
  const productIds = new Set(
    (Array.isArray((spec as JsonRecord)?.products) ? (spec as JsonRecord).products : [])
      .map((product: unknown) => isRecord(product) && typeof product.id === "string" ? product.id : null)
      .filter((id: string | null): id is string => Boolean(id))
  );
  for (const productId of extractLiteralProductIds(html)) {
    if (!productIds.has(productId)) {
      errors.push({
        path: "/document/html",
        message: `Document references unknown Billing Product ID "${productId}"`,
        keyword: "productReference",
      });
    }
  }

  if (errors.length > 0) {
    throw new ConfigError("Paywall cannot be published", 422, { errors });
  }
  return {
    spec: cloneRecord(spec),
    warnings: validation.warnings,
    tokens: localization.tokens,
  };
}

export async function createPaywallBinding(input: {
  publicKey: string;
  paywallKey: string;
  displayName: string;
  actor: string;
  workspaceId?: string;
}): Promise<Record<string, unknown>> {
  const paywallKey = normalizeKey(input.paywallKey);
  const displayName = normalizeText(input.displayName);
  if (!paywallKey || !displayName) throw new ConfigError("Missing paywallKey or displayName", 422);

  return withTransaction(async (db) => {
    const client = await getClientByPublicKey(db, input.publicKey, input.workspaceId, true);
    assertEditable(client);
    const paywall = await db.query<{ id: string }>(
      `INSERT INTO paywalls (project_key, paywall_key, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_key, paywall_key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             updated_at = now()
       RETURNING id`,
      [client.project_key, paywallKey, displayName]
    );
    const binding = await db.query<Record<string, unknown>>(
      `INSERT INTO paywall_environment_bindings (client_id, project_key, paywall_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, paywall_id) DO UPDATE SET updated_at = now()
       RETURNING id AS binding_id, client_id, project_key, paywall_id, current_release_id`,
      [client.id, client.project_key, paywall.rows[0].id]
    );
    return {
      ...binding.rows[0],
      public_key: client.public_key,
      paywall_key: paywallKey,
      display_name: displayName,
    };
  });
}

export async function createPaywallRelease(
  bindingId: string,
  input: CreateReleaseInput,
  workspaceId?: string
): Promise<Record<string, unknown>> {
  return withTransaction((db) => createPaywallReleaseInTransaction(db, bindingId, input, workspaceId));
}

async function createPaywallReleaseInTransaction(
  db: DbExecutor,
  bindingId: string,
  input: CreateReleaseInput,
  workspaceId?: string,
  options: {
    allowLocked?: boolean;
    skipValidation?: boolean;
    legacy?: LegacyProvenance;
  } = {}
): Promise<Record<string, unknown>> {
  const binding = await getBindingForUpdate(db, bindingId, workspaceId);
  if (!options.allowLocked) assertEditable(binding);

  const current = binding.current_release_id
    ? await getRelease(db, binding.current_release_id, binding.id)
    : null;
  let contentRevisionId = normalizeText(input.contentRevisionId);
  let products = input.products;
  let checkout = input.checkout;
  let warnings: unknown[] = [];
  let tokens: string[] = [];

  if (input.spec !== undefined) {
    if (!options.skipValidation) {
      const validation = validatePublishableSpec(input.spec);
      warnings = validation.warnings;
      tokens = validation.tokens;
    }
    const split = splitPaywallSpec(input.spec);
    products = split.products;
    checkout = split.checkout;
    contentRevisionId = await insertContentRevision(db, binding, split.content, input.createdBy, options.legacy);
  }

  if (!contentRevisionId) {
    throw new ConfigError("Provide spec or contentRevisionId", 422);
  }
  const content = await db.query<{ content: JsonRecord }>(
    `SELECT content FROM paywall_content_revisions
      WHERE id = $1 AND paywall_id = $2 AND project_key = $3`,
    [contentRevisionId, binding.paywall_id, binding.project_key]
  );
  if (!content.rows[0]) throw new ConfigError("Content revision not found", 404);

  if (products === undefined) products = current?.products;
  if (checkout === undefined) checkout = current?.checkout;
  if (!options.skipValidation) {
    const validation = validatePublishableSpec(composePaywallSpec(content.rows[0].content, products, checkout));
    if (warnings.length === 0) warnings = validation.warnings;
    if (tokens.length === 0) tokens = validation.tokens;
  }

  await db.query("SELECT id FROM paywall_environment_bindings WHERE id = $1 FOR UPDATE", [binding.id]);
  const next = await db.query<{ release_number: number }>(
    `SELECT COALESCE(MAX(release_number), 0) + 1 AS release_number
       FROM paywall_environment_releases
      WHERE binding_id = $1`,
    [binding.id]
  );
  const release = await db.query<Record<string, unknown>>(
    `INSERT INTO paywall_environment_releases (
       binding_id, client_id, project_key, paywall_id, release_number,
       content_revision_id, products, checkout, legacy_spec_id,
       legacy_fingerprint, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (binding_id, legacy_spec_id, legacy_fingerprint)
       DO UPDATE SET legacy_fingerprint = EXCLUDED.legacy_fingerprint
     RETURNING id, binding_id, release_number, content_revision_id, products, checkout, created_by, created_at`,
    [
      binding.id,
      binding.client_id,
      binding.project_key,
      binding.paywall_id,
      Number(next.rows[0].release_number),
      contentRevisionId,
      JSON.stringify(Array.isArray(products) ? products : []),
      isRecord(checkout) ? JSON.stringify(checkout) : null,
      options.legacy?.id || null,
      options.legacy?.fingerprint || null,
      normalizeText(input.createdBy) || "api",
    ]
  );
  return { ...release.rows[0], warnings, localization_tokens: tokens };
}

export async function getPaywallReleaseDiff(
  bindingId: string,
  releaseId: string,
  workspaceId?: string
): Promise<Record<string, unknown>> {
  const binding = await getBindingForUpdate(database, bindingId, workspaceId, false);
  const candidate = await getReleaseWithContent(database, releaseId, binding.id);
  if (!candidate) throw new ConfigError("Release not found", 404);
  const current = binding.current_release_id
    ? await getReleaseWithContent(database, binding.current_release_id, binding.id)
    : null;
  const affected = await database.query<{ placement_id: string; trigger: string; variant_key: string }>(
    `SELECT p.id AS placement_id, p.trigger, prv.variant_key
       FROM placements p
       JOIN placement_revisions pr ON pr.id = p.current_revision_id
       JOIN placement_revision_variants prv ON prv.placement_revision_id = pr.id
      WHERE p.client_id = $1 AND prv.binding_id = $2
      UNION
     SELECT p.id, p.trigger, pr.default_variant_key
       FROM placements p
       JOIN placement_revisions pr ON pr.id = p.current_revision_id
      WHERE p.client_id = $1 AND pr.default_binding_id = $2
      ORDER BY trigger, variant_key`,
    [binding.client_id, binding.id]
  );
  return {
    binding_id: binding.id,
    environment: binding.environment_kind,
    current: releaseSummary(current),
    candidate: releaseSummary(candidate),
    affected_variants: affected.rows,
  };
}

export async function publishPaywallRelease(input: {
  bindingId: string;
  releaseId: string;
  expectedCurrentReleaseId?: string | null;
  actor: string;
  workspaceId?: string;
  action?: "publish" | "rollback";
}): Promise<Record<string, unknown>> {
  return withTransaction(async (db) => {
    const binding = await getBindingForUpdate(db, input.bindingId, input.workspaceId);
    assertEditable(binding);
    const release = await getReleaseWithContent(db, input.releaseId, binding.id);
    if (!release) throw new ConfigError("Release not found", 404);
    validatePublishableSpec(composePaywallSpec(release.content, release.products, release.checkout));

    const expected = input.expectedCurrentReleaseId ?? null;
    const updated = await db.query(
      `UPDATE paywall_environment_bindings
          SET current_release_id = $2, updated_at = now()
        WHERE id = $1
          AND current_release_id IS NOT DISTINCT FROM $3`,
      [binding.id, input.releaseId, expected]
    );
    if (updated.rowCount !== 1) {
      throw new ConfigError("Published release changed; refresh the diff and try again", 409, {
        expected_current_release_id: expected,
        actual_current_release_id: binding.current_release_id,
      });
    }
    await insertAudit(db, {
      binding,
      entityType: "paywall",
      entityId: binding.paywall_id,
      action: input.action || "publish",
      from: expected,
      to: input.releaseId,
      actor: input.actor,
    });
    return {
      binding_id: binding.id,
      previous_release_id: expected,
      current_release_id: input.releaseId,
      action: input.action || "publish",
    };
  });
}

export async function promotePaywallContent(input: {
  targetBindingId: string;
  sourceReleaseId: string;
  actor: string;
  workspaceId?: string;
}): Promise<Record<string, unknown>> {
  return withTransaction(async (db) => {
    const target = await getBindingForUpdate(db, input.targetBindingId, input.workspaceId);
    assertEditable(target);
    if (target.environment_kind !== "live") {
      throw new ConfigError("Promotion target must be a live environment", 422);
    }
    if (!target.current_release_id) {
      throw new ConfigError("Target environment needs an existing billing binding before promotion", 422);
    }
    const source = await db.query<{
      id: string;
      content_revision_id: string;
      paywall_id: string;
      project_key: string;
      binding_id: string;
      client_id: string;
      environment_kind: "test" | "live";
    }>(
      `SELECT r.id, r.content_revision_id, r.paywall_id, r.project_key,
              r.binding_id, b.client_id,
              c.environment_kind
         FROM paywall_environment_releases r
         JOIN paywall_environment_bindings b ON b.id = r.binding_id
         JOIN clients c ON c.id = b.client_id
        WHERE r.id = $1`,
      [input.sourceReleaseId]
    );
    const sourceRelease = source.rows[0];
    if (!sourceRelease
        || sourceRelease.project_key !== target.project_key
        || sourceRelease.paywall_id !== target.paywall_id
        || sourceRelease.environment_kind !== "test"
        || sourceRelease.client_id === target.client_id) {
      throw new ConfigError("Source release is not the same project paywall", 404);
    }
    // Hold the published test pointer through candidate creation. Otherwise a
    // concurrent test publish could move it after the check and make a stale
    // release appear promotable. Follow the global client -> pointer lock order
    // used by every publish path.
    await db.query("SELECT id FROM clients WHERE id = $1 FOR SHARE", [sourceRelease.client_id]);
    const lockedSource = await db.query<{ current_release_id: string | null }>(
      `SELECT current_release_id
         FROM paywall_environment_bindings
        WHERE id = $1 AND client_id = $2
        FOR UPDATE`,
      [sourceRelease.binding_id, sourceRelease.client_id]
    );
    if (lockedSource.rows[0]?.current_release_id !== sourceRelease.id) {
      throw new ConfigError("Source release is no longer published; refresh and try again", 409, {
        expected_current_release_id: sourceRelease.id,
        actual_current_release_id: lockedSource.rows[0]?.current_release_id ?? null,
      });
    }
    const current = await getRelease(db, target.current_release_id, target.id);
    if (!current) throw new ConfigError("Target billing binding not found", 422);

    const candidate = await createPaywallReleaseInTransaction(db, target.id, {
      contentRevisionId: sourceRelease.content_revision_id,
      products: current.products,
      checkout: current.checkout,
      createdBy: input.actor,
    }, input.workspaceId);
    await insertAudit(db, {
      binding: target,
      entityType: "paywall",
      entityId: target.paywall_id,
      action: "promote",
      from: input.sourceReleaseId,
      to: null,
      actor: input.actor,
      metadata: { candidate_release_id: candidate.id },
    });
    return candidate;
  });
}

export async function createPlacementRevision(
  placementId: string,
  input: PlacementRevisionInput,
  workspaceId?: string
): Promise<Record<string, unknown>> {
  return withTransaction(async (db) => {
    const placement = await getPlacementForUpdate(db, placementId, workspaceId);
    assertEditable(placement);
    validatePlacementInput(input);

    const bindingIds = Array.from(new Set([
      input.defaultBindingId,
      ...input.variants.map((variant) => variant.bindingId),
    ]));
    const owned = await db.query<{ id: string }>(
      `SELECT id FROM paywall_environment_bindings
        WHERE client_id = $1 AND project_key = $2 AND id = ANY($3::text[])`,
      [placement.client_id, placement.project_key, bindingIds]
    );
    if (owned.rows.length !== bindingIds.length) {
      throw new ConfigError("Every placement binding must belong to this environment", 422);
    }
    const next = await db.query<{ revision_number: number }>(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
         FROM placement_revisions WHERE placement_id = $1`,
      [placement.id]
    );
    const revision = await db.query<Record<string, unknown>>(
      `INSERT INTO placement_revisions (
         placement_id, client_id, project_key, revision_number, status,
         default_binding_id, default_variant_key, statsig_experiment_id,
         targeting_rules, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, placement_id, revision_number, status, default_binding_id,
                 default_variant_key, statsig_experiment_id, targeting_rules,
                 created_by, created_at`,
      [
        placement.id,
        placement.client_id,
        placement.project_key,
        Number(next.rows[0].revision_number),
        input.status,
        input.defaultBindingId,
        normalizeKey(input.defaultVariantKey),
        normalizeText(input.statsigExperimentId),
        JSON.stringify(Array.isArray(input.targetingRules) ? input.targetingRules : []),
        normalizeText(input.createdBy) || "api",
      ]
    );
    const revisionId = String(revision.rows[0].id);
    for (const variant of input.variants) {
      await db.query(
        `INSERT INTO placement_revision_variants (
           placement_revision_id, placement_id, client_id, project_key,
           variant_key, binding_id, status, weight, fallback_rank
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          revisionId,
          placement.id,
          placement.client_id,
          placement.project_key,
          normalizeKey(variant.variantKey),
          variant.bindingId,
          variant.status || "active",
          normalizeWeight(variant.weight),
          normalizeRank(variant.fallbackRank),
        ]
      );
    }
    return { ...revision.rows[0], variants: input.variants };
  });
}

export async function createPlacementIdentity(input: {
  publicKey: string;
  trigger: string;
  workspaceId?: string;
}): Promise<Record<string, unknown>> {
  const trigger = normalizeText(input.trigger);
  if (!trigger) throw new ConfigError("Missing trigger", 422);
  return withTransaction(async (db) => {
    const client = await getClientByPublicKey(db, input.publicKey, input.workspaceId, true);
    assertEditable(client);
    const result = await db.query<Record<string, unknown>>(
      `INSERT INTO placements (
         public_key, client_id, project_key, trigger, enabled, status,
         variant_id, spec, targeting_rules
       ) VALUES ($1,$2,$3,$4,false,'paused',NULL,NULL,'[]'::jsonb)
       ON CONFLICT (public_key, trigger) DO UPDATE SET updated_at = now()
       RETURNING id AS placement_id, client_id, project_key, trigger,
                 current_revision_id, created_at, updated_at`,
      [client.public_key, client.id, client.project_key, trigger]
    );
    return result.rows[0];
  });
}

export async function publishPlacementRevision(input: {
  placementId: string;
  revisionId: string;
  expectedCurrentRevisionId?: string | null;
  actor: string;
  workspaceId?: string;
  action?: "publish" | "rollback";
}): Promise<Record<string, unknown>> {
  return withTransaction(async (db) => {
    const placement = await getPlacementForUpdate(db, input.placementId, input.workspaceId);
    assertEditable(placement);
    const revision = await db.query<{ id: string }>(
      `SELECT id FROM placement_revisions WHERE id = $1 AND placement_id = $2`,
      [input.revisionId, placement.id]
    );
    if (!revision.rows[0]) throw new ConfigError("Placement revision not found", 404);
    await assertPlacementRevisionReady(db, placement, input.revisionId);
    const expected = input.expectedCurrentRevisionId ?? null;
    const updated = await db.query(
      `UPDATE placements SET current_revision_id = $2, updated_at = now()
        WHERE id = $1 AND current_revision_id IS NOT DISTINCT FROM $3`,
      [placement.id, input.revisionId, expected]
    );
    if (updated.rowCount !== 1) {
      throw new ConfigError("Published routing changed; refresh and try again", 409, {
        expected_current_revision_id: expected,
        actual_current_revision_id: placement.current_revision_id,
      });
    }
    await insertAudit(db, {
      binding: placement,
      entityType: "placement",
      entityId: placement.id,
      action: input.action || "publish",
      from: expected,
      to: input.revisionId,
      actor: input.actor,
    });
    return {
      placement_id: placement.id,
      previous_revision_id: expected,
      current_revision_id: input.revisionId,
      action: input.action || "publish",
    };
  });
}

export async function getPlacementRevisionDiff(
  placementId: string,
  revisionId: string,
  workspaceId?: string
): Promise<Record<string, unknown>> {
  const placement = await getPlacementForUpdate(database, placementId, workspaceId, false);
  const revisions = await database.query<Record<string, unknown>>(
    `SELECT pr.*,
            COALESCE(json_agg(json_build_object(
              'variant_key', prv.variant_key,
              'binding_id', prv.binding_id,
              'status', prv.status,
              'weight', prv.weight,
              'fallback_rank', prv.fallback_rank
            ) ORDER BY prv.fallback_rank, prv.variant_key)
            FILTER (WHERE prv.id IS NOT NULL), '[]'::json) AS variants
       FROM placement_revisions pr
       LEFT JOIN placement_revision_variants prv ON prv.placement_revision_id = pr.id
      WHERE pr.placement_id = $1
        AND pr.id = ANY($2::text[])
      GROUP BY pr.id`,
    [placement.id, [revisionId, placement.current_revision_id].filter(Boolean)]
  );
  const byId = new Map(revisions.rows.map((row) => [String(row.id), row]));
  const candidate = byId.get(revisionId);
  if (!candidate) throw new ConfigError("Placement revision not found", 404);
  return {
    placement_id: placement.id,
    current: placement.current_revision_id ? byId.get(placement.current_revision_id) || null : null,
    candidate,
  };
}

export async function listPlacementRevisions(
  placementId: string,
  workspaceId?: string
): Promise<Record<string, unknown>> {
  const placement = await getPlacementForUpdate(database, placementId, workspaceId, false);
  const result = await database.query<Record<string, unknown>>(
    `SELECT pr.*,
            COALESCE(json_agg(json_build_object(
              'variant_key', prv.variant_key,
              'binding_id', prv.binding_id,
              'status', prv.status,
              'weight', prv.weight,
              'fallback_rank', prv.fallback_rank
            ) ORDER BY prv.fallback_rank, prv.variant_key)
            FILTER (WHERE prv.id IS NOT NULL), '[]'::json) AS variants,
            pr.id = $2 AS is_current
       FROM placement_revisions pr
       LEFT JOIN placement_revision_variants prv ON prv.placement_revision_id = pr.id
      WHERE pr.placement_id = $1
      GROUP BY pr.id
      ORDER BY pr.revision_number DESC`,
    [placement.id, placement.current_revision_id]
  );
  return { placement, revisions: result.rows };
}

export async function getPaywallDetails(bindingId: string, workspaceId?: string) {
  const paywall = await getEnvironmentPaywall(bindingId, workspaceId);
  if (!paywall) throw new ConfigError("Paywall binding not found", 404);
  return paywall;
}

export async function setEnvironmentConfigSource(input: {
  clientId: string;
  source: "legacy" | "v2";
  expectedSource: "legacy" | "v2";
  actor: string;
}): Promise<Record<string, unknown>> {
  if (!(["legacy", "v2"] as const).includes(input.source)) {
    throw new ConfigError("Invalid config source", 422);
  }
  if (!(["legacy", "v2"] as const).includes(input.expectedSource)) {
    throw new ConfigError("Invalid expected config source", 422);
  }
  return withTransaction(async (db) => {
    const result = await db.query<{
      id: string;
      project_key: string;
      config_source: "legacy" | "v2";
    }>(
      `SELECT id, project_key, config_source FROM clients WHERE id = $1 FOR UPDATE`,
      [input.clientId]
    );
    const client = result.rows[0];
    if (!client) throw new ConfigError("Environment not found", 404);
    let comparison: Awaited<ReturnType<typeof compareLegacyAndV2Client>> = null;
    if (input.source === "v2") {
      const incomplete = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM placements
          WHERE client_id = $1
            AND COALESCE(status, CASE WHEN enabled THEN 'active' ELSE 'paused' END) <> 'archived'
            AND current_revision_id IS NULL`,
        [client.id]
      );
      if (Number(incomplete.rows[0]?.count || 0) > 0) {
        throw new ConfigError("Every served placement needs a published V2 routing revision", 422);
      }
      const activeRevisions = await db.query<{ id: string; client_id: string; project_key: string }>(
        `SELECT pr.id, p.client_id, p.project_key
           FROM placements p
           JOIN placement_revisions pr ON pr.id = p.current_revision_id
          WHERE p.client_id = $1 AND pr.status = 'active'`,
        [client.id]
      );
      for (const revision of activeRevisions.rows) {
        await assertPlacementRevisionReady(db, {
          client_id: revision.client_id,
          project_key: revision.project_key,
        }, revision.id);
      }
      comparison = await compareLegacyAndV2Client(client.id, db);
      if (!comparison?.passed) {
        throw new ConfigError("Legacy/V2 comparison failed; cutover was not applied", 422, {
          comparison,
        });
      }
    }
    const updated = await db.query(
      `UPDATE clients SET config_source = $2, updated_at = now()
        WHERE id = $1 AND config_source = $3`,
      [client.id, input.source, input.expectedSource]
    );
    if (updated.rowCount !== 1) {
      throw new ConfigError("Environment source changed; refresh and try again", 409, {
        expected_source: input.expectedSource,
        actual_source: client.config_source,
      });
    }
    await db.query(
      `INSERT INTO config_audit_log (
         project_key, client_id, entity_type, entity_id, action,
         from_pointer_id, to_pointer_id, actor, metadata
       ) VALUES ($1,$2,'migration',$2,'cutover',$3,$4,$5,$6)`,
      [
        client.project_key,
        client.id,
        input.expectedSource,
        input.source,
        normalizeText(input.actor) || "api",
        JSON.stringify({
          comparison_passed: comparison?.passed ?? null,
          legacy_hash: comparison?.legacy_hash ?? null,
          v2_hash: comparison?.v2_hash ?? null,
        }),
      ]
    );
    return {
      client_id: client.id,
      config_source: input.source,
      ...(comparison ? { comparison } : {}),
    };
  });
}

export async function importLegacyWorkspaceConfig(
  workspaceId: string,
  body: any,
  actor = "import"
): Promise<{ specs: number; placements: number; variants: number }> {
  const normalized = normalizeLegacyImport(body);
  return withTransaction(async (db) => {
    const workspace = await db.query<{
      id: string;
      public_key: string;
      management_status: "editable" | "legacy_locked";
      config_source: "legacy" | "v2";
    }>(
      `SELECT id, public_key, management_status, config_source
         FROM clients WHERE id = $1 FOR UPDATE`,
      [workspaceId]
    );
    const client = workspace.rows[0];
    if (!client) throw new ConfigError("Workspace not found", 404);
    if (client.management_status !== "editable" || client.config_source !== "legacy") {
      throw new ConfigError("Legacy configuration is read-only for this environment", 423);
    }

    await validateLegacyReferences(db, workspaceId, normalized);
    const specIdMap = new Map<string, string>();
    const placementIdMap = new Map<string, string>();

    for (const item of normalized.specs) {
      const result = await db.query<{ id: string }>(
        `INSERT INTO paywall_specs (workspace_id, name, spec, status, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, name) DO UPDATE SET
           version = CASE
             WHEN paywall_specs.spec IS DISTINCT FROM EXCLUDED.spec
               OR paywall_specs.status IS DISTINCT FROM EXCLUDED.status
             THEN paywall_specs.version + 1
             ELSE paywall_specs.version
           END,
           updated_at = CASE
             WHEN paywall_specs.spec IS DISTINCT FROM EXCLUDED.spec
               OR paywall_specs.status IS DISTINCT FROM EXCLUDED.status
             THEN now()
             ELSE paywall_specs.updated_at
           END,
           spec = EXCLUDED.spec,
           status = EXCLUDED.status
         RETURNING id`,
        [workspaceId, item.name, JSON.stringify(item.spec), item.status, item.createdBy || actor]
      );
      if (item.id) specIdMap.set(item.id, result.rows[0].id);
    }

    for (const item of normalized.placements) {
      const defaultSpecId = item.defaultSpecId
        ? specIdMap.get(item.defaultSpecId) || item.defaultSpecId
        : null;
      const defaultSpec = defaultSpecId
        ? await db.query<{ spec: JsonRecord }>(
            "SELECT spec FROM paywall_specs WHERE id = $1 AND workspace_id = $2",
            [defaultSpecId, workspaceId]
          )
        : null;
      const placementSpec = item.specPresent
        ? item.spec
        : defaultSpecId
          ? defaultSpec?.rows[0]?.spec || null
          : null;
      const result = await db.query<{ id: string }>(
        `INSERT INTO placements (
           id, public_key, client_id, project_key, trigger, enabled, status,
           variant_id, experiment_id, statsig_experiment_id, default_spec_id,
           targeting_rules, spec
         )
         SELECT $1, c.public_key, c.id, c.project_key, $2, $3, $4,
                $5, $8, $8, $10,
                CASE WHEN $13 THEN $12::jsonb ELSE '[]'::jsonb END,
                $14::jsonb
           FROM clients c WHERE c.id = $16
         ON CONFLICT (public_key, trigger) DO UPDATE SET
           enabled = CASE WHEN $7 THEN EXCLUDED.enabled ELSE placements.enabled END,
           status = CASE WHEN $7 THEN EXCLUDED.status ELSE placements.status END,
           variant_id = CASE WHEN $6 THEN EXCLUDED.variant_id ELSE placements.variant_id END,
           experiment_id = CASE WHEN $9 THEN EXCLUDED.experiment_id ELSE placements.experiment_id END,
           statsig_experiment_id = CASE WHEN $9 THEN EXCLUDED.statsig_experiment_id ELSE placements.statsig_experiment_id END,
           default_spec_id = CASE WHEN $11 THEN EXCLUDED.default_spec_id ELSE placements.default_spec_id END,
           targeting_rules = CASE WHEN $13 THEN EXCLUDED.targeting_rules ELSE placements.targeting_rules END,
           spec = CASE
             WHEN $15 THEN EXCLUDED.spec
             WHEN $11 AND EXCLUDED.default_spec_id IS NOT NULL THEN EXCLUDED.spec
             ELSE placements.spec
           END,
           updated_at = now()
         RETURNING id`,
        [
          item.id || `pl_${cryptoRandomId()}`,
          item.trigger,
          item.status === "active",
          item.status,
          item.defaultVariantKey,
          item.defaultVariantPresent,
          item.statusPresent,
          item.statsigExperimentId,
          item.statsigExperimentPresent,
          defaultSpecId,
          item.defaultSpecPresent,
          JSON.stringify(item.targetingRules),
          item.targetingRulesPresent,
          placementSpec === null ? null : JSON.stringify(placementSpec),
          item.specPresent,
          workspaceId,
        ]
      );
      if (item.id) placementIdMap.set(item.id, result.rows[0].id);
    }

    for (const item of normalized.variants) {
      const placementId = placementIdMap.get(item.placementId) || item.placementId;
      const specId = item.specId ? specIdMap.get(item.specId) || item.specId : null;
      const referencedSpec = specId
        ? await db.query<{ spec: JsonRecord }>(
            `SELECT ps.spec
               FROM paywall_specs ps
              WHERE ps.id = $1 AND ps.workspace_id = $2`,
            [specId, workspaceId]
          )
        : null;
      const variantSpec = referencedSpec?.rows[0]?.spec || item.spec;
      if (!variantSpec) throw new ConfigError("Variant spec not found", 422);
      await db.query(
        `INSERT INTO placement_variants (
           placement_id, variant_id, variant_key, spec_id, spec,
           enabled, status, weight, fallback_rank
         ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (placement_id, variant_id) DO UPDATE SET
           variant_key = EXCLUDED.variant_key,
           spec_id = EXCLUDED.spec_id,
           spec = EXCLUDED.spec,
           enabled = CASE WHEN $9 THEN EXCLUDED.enabled ELSE placement_variants.enabled END,
           status = CASE WHEN $9 THEN EXCLUDED.status ELSE placement_variants.status END,
           weight = CASE WHEN $10 THEN EXCLUDED.weight ELSE placement_variants.weight END,
           fallback_rank = CASE WHEN $11 THEN EXCLUDED.fallback_rank ELSE placement_variants.fallback_rank END`,
        [
          placementId,
          item.variantKey,
          specId,
          JSON.stringify(variantSpec),
          item.status !== "paused",
          item.status,
          item.weight,
          item.fallbackRank,
          item.statusPresent,
          item.weightPresent,
          item.fallbackRankPresent,
        ]
      );
    }

    return {
      specs: normalized.specs.length,
      placements: normalized.placements.length,
      variants: normalized.variants.length,
    };
  });
}

async function insertContentRevision(
  db: DbExecutor,
  binding: BindingRow,
  content: JsonRecord,
  createdBy?: string,
  legacy?: LegacyProvenance
): Promise<string> {
  if (legacy?.id) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM paywall_content_revisions
        WHERE paywall_id = $1 AND legacy_spec_id = $2 AND legacy_fingerprint = $3`,
      [binding.paywall_id, legacy.id, legacy.fingerprint]
    );
    if (existing.rows[0]) return existing.rows[0].id;
  }
  await db.query("SELECT id FROM paywalls WHERE id = $1 FOR UPDATE", [binding.paywall_id]);
  const next = await db.query<{ revision_number: number }>(
    `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
       FROM paywall_content_revisions WHERE paywall_id = $1`,
    [binding.paywall_id]
  );
  const payload = exactWebViewDocumentPayload(content);
  const documentHash = hashDocument(payload);
  const result = await db.query<{ id: string }>(
    `INSERT INTO paywall_content_revisions (
       paywall_id, project_key, revision_number, content, content_hash,
       document_cache_key, document_revision, document_hash, document_payload,
       document_integrity, legacy_spec_id, legacy_version, legacy_updated_at,
       legacy_fingerprint, legacy_status, legacy_name, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      binding.paywall_id,
      binding.project_key,
      Number(next.rows[0].revision_number),
      JSON.stringify(content),
      sha256Hex(stableJson(content)),
      payload.cacheKey,
      String(payload.revision),
      documentHash,
      JSON.stringify(payload),
      payload.integrity,
      legacy?.id || null,
      legacy?.version || null,
      legacy?.updatedAt || null,
      legacy?.fingerprint || null,
      legacy?.status || null,
      legacy?.name || null,
      normalizeText(createdBy) || (legacy ? "legacy-backfill" : "api"),
    ]
  );
  return result.rows[0].id;
}

interface BindingRow {
  id: string;
  client_id: string;
  project_key: string;
  paywall_id: string;
  current_release_id: string | null;
  public_key: string;
  environment_kind: "test" | "live";
  management_status: "editable" | "legacy_locked";
}

async function getBindingForUpdate(
  db: DbExecutor,
  bindingId: string,
  workspaceId?: string,
  lock = true
): Promise<BindingRow> {
  if (lock) {
    // Client is the global lock-order boundary for cutover. Take it before the
    // binding row so a publish that started just before cutover cannot hold the
    // pointer row while the comparator observes an older committed value.
    const owner = await db.query<{ id: string }>(
      `SELECT c.id
         FROM paywall_environment_bindings b
         JOIN clients c ON c.id = b.client_id
        WHERE b.id = $1
          AND ($2::text IS NULL OR b.client_id = $2)
        FOR SHARE OF c`,
      [bindingId, workspaceId || null]
    );
    if (!owner.rows[0]) throw new ConfigError("Paywall binding not found", 404);
  }
  const result = await db.query<BindingRow>(
    `SELECT b.id, b.client_id, b.project_key, b.paywall_id, b.current_release_id,
            c.public_key, c.environment_kind, c.management_status
       FROM paywall_environment_bindings b
       JOIN clients c ON c.id = b.client_id
      WHERE b.id = $1
        AND ($2::text IS NULL OR b.client_id = $2)
      ${lock ? "FOR UPDATE OF b" : ""}`,
    [bindingId, workspaceId || null]
  );
  if (!result.rows[0]) throw new ConfigError("Paywall binding not found", 404);
  return result.rows[0];
}

interface PlacementRow {
  id: string;
  client_id: string;
  project_key: string;
  current_revision_id: string | null;
  trigger: string;
  management_status: "editable" | "legacy_locked";
}

async function getPlacementForUpdate(
  db: DbExecutor,
  placementId: string,
  workspaceId?: string,
  lock = true
): Promise<PlacementRow> {
  if (lock) {
    const owner = await db.query<{ id: string }>(
      `SELECT c.id
         FROM placements p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
          AND ($2::text IS NULL OR p.client_id = $2)
        FOR SHARE OF c`,
      [placementId, workspaceId || null]
    );
    if (!owner.rows[0]) throw new ConfigError("Placement not found", 404);
  }
  const result = await db.query<PlacementRow>(
    `SELECT p.id, p.client_id, p.project_key, p.current_revision_id, p.trigger,
            c.management_status
       FROM placements p
       JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
        AND ($2::text IS NULL OR p.client_id = $2)
      ${lock ? "FOR UPDATE OF p" : ""}`,
    [placementId, workspaceId || null]
  );
  if (!result.rows[0]) throw new ConfigError("Placement not found", 404);
  return result.rows[0];
}

async function getClientByPublicKey(
  db: DbExecutor,
  publicKey: string,
  workspaceId?: string,
  lock = false
) {
  const result = await db.query<{
    id: string;
    public_key: string;
    project_key: string;
    environment_kind: "test" | "live";
    management_status: "editable" | "legacy_locked";
  }>(
    `SELECT id, public_key, project_key, environment_kind, management_status
       FROM clients
      WHERE public_key = $1
        AND ($2::text IS NULL OR id = $2)
      ${lock ? "FOR UPDATE" : ""}`,
    [publicKey, workspaceId || null]
  );
  if (!result.rows[0]) throw new ConfigError("Environment not found", 404);
  return result.rows[0];
}

async function getRelease(db: DbExecutor, releaseId: string, bindingId: string) {
  const result = await db.query<{
    id: string;
    products: unknown[];
    checkout: JsonRecord | null;
  }>(
    `SELECT id, products, checkout FROM paywall_environment_releases
      WHERE id = $1 AND binding_id = $2`,
    [releaseId, bindingId]
  );
  return result.rows[0] || null;
}

async function getReleaseWithContent(db: DbExecutor, releaseId: string, bindingId: string) {
  const result = await db.query<{
    id: string;
    release_number: number;
    content_revision_id: string;
    products: unknown[];
    checkout: JsonRecord | null;
    created_by: string;
    created_at: string;
    content: JsonRecord;
    content_hash: string;
    document_cache_key: string;
    document_hash: string;
  }>(
    `SELECT r.id, r.release_number, r.content_revision_id, r.products, r.checkout,
            r.created_by, r.created_at, cr.content, cr.content_hash,
            cr.document_cache_key, cr.document_hash
       FROM paywall_environment_releases r
       JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
      WHERE r.id = $1 AND r.binding_id = $2`,
    [releaseId, bindingId]
  );
  return result.rows[0] || null;
}

async function assertPlacementRevisionReady(
  db: DbExecutor,
  owner: { client_id: string; project_key: string },
  revisionId: string
): Promise<void> {
  const revision = await db.query<{
    status: "active" | "paused" | "archived";
    default_binding_id: string;
    default_variant_key: string;
    default_variant_binding_id: string | null;
    default_variant_status: "active" | "paused" | null;
  }>(
    `SELECT pr.status, pr.default_binding_id, pr.default_variant_key,
            default_variant.binding_id AS default_variant_binding_id,
            default_variant.status AS default_variant_status
       FROM placement_revisions pr
       LEFT JOIN placement_revision_variants default_variant
         ON default_variant.placement_revision_id = pr.id
        AND default_variant.variant_key = pr.default_variant_key
      WHERE pr.id = $1 AND pr.client_id = $2 AND pr.project_key = $3`,
    [revisionId, owner.client_id, owner.project_key]
  );
  const row = revision.rows[0];
  if (!row) throw new ConfigError("Placement revision not found", 404);
  if (row.status !== "active") return;
  if (row.default_variant_status !== "active" || row.default_variant_binding_id !== row.default_binding_id) {
    throw new ConfigError("Published routing has an invalid default variant binding", 422);
  }

  const releases = await db.query<{
    binding_id: string;
    current_release_id: string | null;
    content: JsonRecord | null;
    products: unknown[] | null;
    checkout: JsonRecord | null;
  }>(
    `WITH requested AS (
       SELECT pr.default_binding_id AS binding_id
         FROM placement_revisions pr WHERE pr.id = $1
       UNION
       SELECT prv.binding_id
         FROM placement_revision_variants prv
        WHERE prv.placement_revision_id = $1 AND prv.status = 'active'
     )
     SELECT requested.binding_id, b.current_release_id, cr.content, r.products, r.checkout
       FROM requested
       LEFT JOIN paywall_environment_bindings b
         ON b.id = requested.binding_id
        AND b.client_id = $2
        AND b.project_key = $3
       LEFT JOIN paywall_environment_releases r ON r.id = b.current_release_id
       LEFT JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id`,
    [revisionId, owner.client_id, owner.project_key]
  );
  for (const release of releases.rows) {
    if (!release.current_release_id || !release.content) {
      throw new ConfigError("Every active routing binding needs a published paywall release", 422, {
        binding_id: release.binding_id,
      });
    }
    validatePublishableSpec(composePaywallSpec(release.content, release.products, release.checkout));
  }
}

function releaseSummary(release: Awaited<ReturnType<typeof getReleaseWithContent>> | null) {
  if (!release) return null;
  const localization = isRecord(release.content.localization) ? release.content.localization : null;
  const translations = isRecord(localization?.translations) ? localization?.translations : {};
  return {
    release_id: release.id,
    release_number: release.release_number,
    content_revision_id: release.content_revision_id,
    content_hash: release.content_hash,
    document_cache_key: release.document_cache_key,
    document_hash: release.document_hash,
    default_locale: localization?.defaultLocale || null,
    locales: Object.keys(translations).sort(),
    product_ids: Array.isArray(release.products)
      ? release.products.map((product) => isRecord(product) ? product.id : null).filter(Boolean)
      : [],
    checkout: release.checkout,
    created_by: release.created_by,
    created_at: release.created_at,
  };
}

async function insertAudit(db: DbExecutor, input: {
  binding: { client_id: string; project_key: string };
  entityType: "paywall" | "placement" | "migration";
  entityId: string;
  action: string;
  from: string | null;
  to: string | null;
  actor: string;
  metadata?: unknown;
}) {
  await db.query(
    `INSERT INTO config_audit_log (
       project_key, client_id, entity_type, entity_id, action,
       from_pointer_id, to_pointer_id, actor, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.binding.project_key,
      input.binding.client_id,
      input.entityType,
      input.entityId,
      input.action,
      input.from,
      input.to,
      normalizeText(input.actor) || "api",
      JSON.stringify(input.metadata || {}),
    ]
  );
}

function validatePlacementInput(input: PlacementRevisionInput) {
  if (!input || !["active", "paused", "archived"].includes(input.status)) {
    throw new ConfigError("Invalid placement status", 422);
  }
  if (!normalizeText(input.defaultBindingId) || !normalizeKey(input.defaultVariantKey)) {
    throw new ConfigError("Missing defaultBindingId or defaultVariantKey", 422);
  }
  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    throw new ConfigError("Placement needs at least one variant", 422);
  }
  const keys = input.variants.map((variant) => normalizeKey(variant.variantKey));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw new ConfigError("Variant keys must be present and unique", 422);
  }
  if (!input.variants.some((variant) => normalizeKey(variant.variantKey) === normalizeKey(input.defaultVariantKey))) {
    throw new ConfigError("Default variant must be included in variants", 422);
  }
  const defaultVariant = input.variants.find(
    (variant) => normalizeKey(variant.variantKey) === normalizeKey(input.defaultVariantKey)
  );
  if (defaultVariant?.bindingId !== input.defaultBindingId) {
    throw new ConfigError("Default variant binding must match defaultBindingId", 422);
  }
  if (defaultVariant?.status === "paused") {
    throw new ConfigError("Default placement variant must be active", 422);
  }
  if (input.variants.some((variant) => variant.status !== undefined && !["active", "paused"].includes(variant.status))) {
    throw new ConfigError("Invalid placement variant status", 422);
  }
  if (input.variants.some((variant) => !normalizeText(variant.bindingId))) {
    throw new ConfigError("Every placement variant needs a bindingId", 422);
  }
}

interface NormalizedLegacyImport {
  specs: Array<{
    id: string | null;
    name: string;
    spec: JsonRecord;
    status: "draft" | "active" | "archived";
    createdBy: string | null;
  }>;
  placements: Array<{
    id: string | null;
    trigger: string;
    status: "active" | "paused" | "archived";
    statusPresent: boolean;
    defaultVariantKey: string;
    defaultVariantPresent: boolean;
    defaultSpecId: string | null;
    defaultSpecPresent: boolean;
    statsigExperimentId: string | null;
    statsigExperimentPresent: boolean;
    targetingRules: unknown[];
    targetingRulesPresent: boolean;
    spec: JsonRecord | null;
    specPresent: boolean;
  }>;
  variants: Array<{
    placementId: string;
    specId: string | null;
    spec: JsonRecord | null;
    variantKey: string;
    status: "active" | "paused";
    statusPresent: boolean;
    weight: number;
    weightPresent: boolean;
    fallbackRank: number;
    fallbackRankPresent: boolean;
  }>;
}

function normalizeLegacyImport(body: any): NormalizedLegacyImport {
  const issues: Array<{ path: string; message: string }> = [];
  const rawSpecs = body?.specs === undefined ? [] : body.specs;
  const rawPlacements = body?.placements === undefined ? [] : body.placements;
  const rawVariants = body?.variants === undefined ? [] : body.variants;
  if (!Array.isArray(rawSpecs)) issues.push({ path: "/specs", message: "Must be an array" });
  if (!Array.isArray(rawPlacements)) issues.push({ path: "/placements", message: "Must be an array" });
  if (!Array.isArray(rawVariants)) issues.push({ path: "/variants", message: "Must be an array" });

  const specs: NormalizedLegacyImport["specs"] = [];
  for (const [index, item] of (Array.isArray(rawSpecs) ? rawSpecs : []).entries()) {
    const path = `/specs/${index}`;
    const name = normalizeText(item?.name);
    const status = item?.status ?? "draft";
    if (!name) issues.push({ path: `${path}/name`, message: "Missing name" });
    if (!["draft", "active", "archived"].includes(status)) {
      issues.push({ path: `${path}/status`, message: "Invalid status" });
    }
    const specValidation = validatePaywallSpec(item?.spec);
    if (!specValidation.valid) {
      for (const error of specValidation.errors) {
        issues.push({
          path: `${path}/spec${error.path === "/" ? "" : error.path}`,
          message: error.message,
        });
      }
    }
    if (name && ["draft", "active", "archived"].includes(status)) {
      specs.push({
        id: normalizeText(item?.id),
        name,
        spec: cloneRecord(item?.spec),
        status,
        createdBy: normalizeText(item?.created_by ?? item?.createdBy),
      });
    }
  }

  const placements: NormalizedLegacyImport["placements"] = [];
  for (const [index, item] of (Array.isArray(rawPlacements) ? rawPlacements : []).entries()) {
    const path = `/placements/${index}`;
    const trigger = normalizeText(item?.trigger);
    const statusPresent = hasAnyOwn(item, ["status"]);
    const status = item?.status ?? "active";
    const defaultVariantPresent = hasAnyOwn(item, ["variant_id", "variantId", "default_variant_key"]);
    const defaultVariantKey = normalizeKey(firstOwn(item, ["variant_id", "variantId", "default_variant_key"])) || "default";
    const defaultSpecPresent = hasAnyOwn(item, ["default_spec_id", "defaultSpecId"]);
    const defaultSpecId = normalizeText(firstOwn(item, ["default_spec_id", "defaultSpecId"]));
    const statsigExperimentPresent = hasAnyOwn(item, [
      "statsig_experiment_id", "statsigExperimentId", "experiment_id", "experimentId",
    ]);
    const statsigExperimentId = normalizeText(firstOwn(item, [
      "statsig_experiment_id", "statsigExperimentId", "experiment_id", "experimentId",
    ]));
    const targetingRulesPresent = hasAnyOwn(item, ["targeting_rules", "targetingRules"]);
    const rawTargetingRules = firstOwn(item, ["targeting_rules", "targetingRules"]);
    const specPresent = hasAnyOwn(item, ["spec"]);
    const inlineSpec = item?.spec == null ? null : cloneRecord(item.spec);
    if (!trigger) issues.push({ path: `${path}/trigger`, message: "Missing trigger" });
    if (!["active", "paused", "archived"].includes(status)) {
      issues.push({ path: `${path}/status`, message: "Invalid status" });
    }
    if (targetingRulesPresent && !Array.isArray(rawTargetingRules)) {
      issues.push({ path: `${path}/targeting_rules`, message: "Must be an array" });
    }
    if (defaultVariantPresent && !normalizeKey(firstOwn(item, ["variant_id", "variantId", "default_variant_key"]))) {
      issues.push({ path: `${path}/variant_id`, message: "Invalid variant_id" });
    }
    if (specPresent && item?.spec !== null) {
      const validation = validatePaywallSpec(item?.spec);
      if (!validation.valid) {
        for (const error of validation.errors) {
          issues.push({
            path: `${path}/spec${error.path === "/" ? "" : error.path}`,
            message: error.message,
          });
        }
      }
    }
    if (trigger && ["active", "paused", "archived"].includes(status)) {
      placements.push({
        id: normalizeText(item?.id),
        trigger,
        status,
        statusPresent,
        defaultVariantKey,
        defaultVariantPresent,
        defaultSpecId,
        defaultSpecPresent,
        statsigExperimentId,
        statsigExperimentPresent,
        targetingRules: Array.isArray(rawTargetingRules) ? rawTargetingRules : [],
        targetingRulesPresent,
        spec: inlineSpec,
        specPresent,
      });
    }
  }

  const variants: NormalizedLegacyImport["variants"] = [];
  for (const [index, item] of (Array.isArray(rawVariants) ? rawVariants : []).entries()) {
    const path = `/variants/${index}`;
    const placementId = normalizeText(item?.placement_id);
    const specId = normalizeText(item?.spec_id);
    const specPresent = hasAnyOwn(item, ["spec"]);
    const inlineSpec = item?.spec == null ? null : cloneRecord(item.spec);
    const variantKey = normalizeKey(item?.variant_key);
    const statusPresent = hasAnyOwn(item, ["status"]);
    const status = item?.status ?? "active";
    const weightPresent = hasAnyOwn(item, ["weight"]);
    const fallbackRankPresent = hasAnyOwn(item, ["fallback_rank", "fallbackRank"]);
    if (!placementId) issues.push({ path: `${path}/placement_id`, message: "Missing placement_id" });
    if (!specId && !inlineSpec) issues.push({ path: `${path}/spec_id`, message: "Provide spec_id or inline spec" });
    if (!variantKey) issues.push({ path: `${path}/variant_key`, message: "Invalid variant_key" });
    if (!["active", "paused"].includes(status)) issues.push({ path: `${path}/status`, message: "Invalid status" });
    if (specPresent && item?.spec !== null) {
      const validation = validatePaywallSpec(item.spec);
      if (!validation.valid) {
        for (const error of validation.errors) {
          issues.push({
            path: `${path}/spec${error.path === "/" ? "" : error.path}`,
            message: error.message,
          });
        }
      }
    }
    if (placementId && (specId || inlineSpec) && variantKey && ["active", "paused"].includes(status)) {
      variants.push({
        placementId,
        specId,
        spec: inlineSpec,
        variantKey,
        status,
        statusPresent,
        weight: normalizeWeight(item?.weight),
        weightPresent,
        fallbackRank: normalizeRank(item?.fallback_rank ?? item?.fallbackRank),
        fallbackRankPresent,
      });
    }
  }

  for (const [label, values] of [
    ["spec", specs.map((item) => item.id).filter(Boolean)],
    ["placement", placements.map((item) => item.id).filter(Boolean)],
    ["spec name", specs.map((item) => item.name)],
    ["placement trigger", placements.map((item) => item.trigger)],
    ["placement variant", variants.map((item) => `${item.placementId}\u0000${item.variantKey}`)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      issues.push({ path: "/", message: `Duplicate ${label} values in import` });
    }
  }
  if (issues.length > 0) throw new ConfigError("Invalid config import", 422, { errors: issues });
  return { specs, placements, variants };
}

async function validateLegacyReferences(
  db: DbExecutor,
  workspaceId: string,
  input: NormalizedLegacyImport
) {
  const importedSpecIds = new Set(input.specs.map((item) => item.id).filter((id): id is string => Boolean(id)));
  const importedPlacementIds = new Set(input.placements.map((item) => item.id).filter((id): id is string => Boolean(id)));
  const requiredSpecIds = Array.from(new Set([
    ...input.placements.map((item) => item.defaultSpecId),
    ...input.variants.map((item) => item.specId),
  ].filter((id): id is string => typeof id === "string" && id.length > 0 && !importedSpecIds.has(id))));
  const requiredPlacementIds = Array.from(new Set(
    input.variants.map((item) => item.placementId).filter((id) => !importedPlacementIds.has(id))
  ));
  const importedTriggers = Array.from(new Set(input.placements.map((item) => item.trigger)));

  const existingSpecs = requiredSpecIds.length
    ? await db.query<{ id: string }>(
        "SELECT id FROM paywall_specs WHERE workspace_id = $1 AND id = ANY($2::text[])",
        [workspaceId, requiredSpecIds]
      )
    : { rows: [] as Array<{ id: string }> };
  const existingPlacements = requiredPlacementIds.length
    ? await db.query<{ id: string }>(
        `SELECT p.id FROM placements p
          WHERE p.client_id = $1 AND p.id = ANY($2::text[])`,
        [workspaceId, requiredPlacementIds]
      )
    : { rows: [] as Array<{ id: string }> };
  const existingPlacementState = importedTriggers.length
    ? await db.query<{
        trigger: string;
        status: "active" | "paused" | "archived";
        default_spec_id: string | null;
        has_inline_spec: boolean;
      }>(
        `SELECT trigger,
                COALESCE(status, CASE WHEN enabled THEN 'active' ELSE 'paused' END) AS status,
                default_spec_id, spec IS NOT NULL AS has_inline_spec
           FROM placements
          WHERE client_id = $1
            AND trigger = ANY($2::text[])`,
        [workspaceId, importedTriggers]
      )
    : { rows: [] as Array<{
        trigger: string;
        status: "active" | "paused" | "archived";
        default_spec_id: string | null;
        has_inline_spec: boolean;
      }> };
  const foundSpecs = new Set(existingSpecs.rows.map((row) => row.id));
  const foundPlacements = new Set(existingPlacements.rows.map((row) => row.id));
  const missingSpecs = requiredSpecIds.filter((id) => !foundSpecs.has(id));
  const missingPlacements = requiredPlacementIds.filter((id) => !foundPlacements.has(id));
  const placementStateByTrigger = new Map(existingPlacementState.rows.map((row) => [row.trigger, row]));
  const missingDefaultTriggers = input.placements.filter((item) => {
    const existing = placementStateByTrigger.get(item.trigger);
    const effectiveStatus = item.statusPresent ? item.status : existing?.status || item.status;
    if (effectiveStatus !== "active") return false;
    const hasDefault = item.defaultSpecPresent
      ? Boolean(item.defaultSpecId)
      : Boolean(existing?.default_spec_id);
    const hasInline = item.specPresent
      ? Boolean(item.spec)
      : Boolean(existing?.has_inline_spec);
    return !hasDefault && !hasInline;
  }).map((item) => item.trigger);
  if (missingSpecs.length || missingPlacements.length || missingDefaultTriggers.length) {
    throw new ConfigError("Config import contains missing or cross-environment references", 422, {
      missing_spec_ids: missingSpecs,
      missing_placement_ids: missingPlacements,
      active_placements_missing_default: missingDefaultTriggers,
    });
  }
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function assertEditable(value: { management_status: string }) {
  if (value.management_status !== "editable") {
    throw new ConfigError("This environment is locked for legacy ownership", 423);
  }
}

function cloneRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return structuredClone(value);
}

function extractLiteralProductIds(html: string): string[] {
  const ids = new Set<string>();
  const openingTag = /<[A-Za-z][^<>]*>/g;
  for (const match of html.matchAll(openingTag)) {
    // Some legacy documents contain runtime-inserted markup inside JS strings,
    // so accept escaped quote wrappers while still requiring action and product
    // attributes to be co-located on the same CTA tag.
    const tag = match[0].replace(/\\(["'])/g, "$1");
    if (extractTagAttribute(tag, "data-tranzmit-action")?.toLowerCase() !== "cta") continue;
    const value = (extractTagAttribute(tag, "data-product-id") || "").trim();
    if (value && !value.includes("{{")) ids.add(value);
  }
  return Array.from(ids).sort();
}

function extractTagAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attribute = new RegExp(
    `\\s${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = tag.match(attribute);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasAnyOwn(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function firstOwn(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return undefined;
  const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(value, candidate));
  return key === undefined ? undefined : value[key];
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizeKey(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text || !/^[A-Za-z0-9._-]{1,128}$/.test(text)) return null;
  return text;
}

function normalizeWeight(value: unknown): number {
  const number = Number(value ?? 50);
  if (!Number.isFinite(number)) return 50;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeRank(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const __private = {
  createPaywallReleaseInTransaction,
  insertContentRevision,
  stableJson,
};
