import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { pool, query as poolQuery } from "./db.js";

export interface DbExecutor {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export const database: DbExecutor = {
  query: (text, params) => poolQuery(text, params),
};

export async function withTransaction<T>(work: (db: DbExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(clientExecutor(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function clientExecutor(client: PoolClient): DbExecutor {
  return { query: (text, params) => client.query(text, params) };
}

export type EnvironmentKind = "test" | "live";
export type ManagementStatus = "editable" | "legacy_locked";
export type ConfigSource = "legacy" | "v2";

export interface ConfigClient {
  id: string;
  publicKey: string;
  projectKey: string;
  environmentKind: EnvironmentKind;
  managementStatus: ManagementStatus;
  configSource: ConfigSource;
  sdkStack: string;
  statsigProjectName: string | null;
  statsigServerSecretEnvVar: string | null;
}

export interface PublishedPlacementRouting {
  placementId: string;
  revisionId: string;
  trigger: string;
  status: "active" | "paused" | "archived";
  defaultVariantKey: string;
  defaultBindingId: string;
  experimentId: string | null;
  targetingRules: unknown;
  variants: Array<{
    id: string;
    variantId: string;
    bindingId: string;
    status: "active" | "paused";
    fallbackRank: number;
    weight: number;
  }>;
}

export interface PublishedReleaseSpec {
  bindingId: string;
  releaseId: string;
  contentRevisionId: string;
  content: Record<string, unknown>;
  products: unknown[];
  checkout: Record<string, unknown> | null;
  documentPayload: Record<string, unknown>;
}

export interface ImmutableDocument {
  cacheKey: string;
  revision: string;
  documentHash: string;
  integrity: string;
  payload: Record<string, unknown>;
}

export async function getConfigClient(
  publicKey: string,
  db: DbExecutor = database
): Promise<ConfigClient | null> {
  const result = await db.query<{
    id: string;
    public_key: string;
    project_key: string;
    environment_kind: EnvironmentKind;
    management_status: ManagementStatus;
    config_source: ConfigSource;
    sdk_stack: string;
    statsig_project_name: string | null;
    statsig_server_secret_env_var: string | null;
  }>(
    `SELECT id, public_key, project_key, environment_kind, management_status,
            config_source, COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack,
            statsig_project_name, statsig_server_secret_env_var
       FROM clients
      WHERE public_key = $1`,
    [publicKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    publicKey: row.public_key,
    projectKey: row.project_key,
    environmentKind: row.environment_kind,
    managementStatus: row.management_status,
    configSource: row.config_source,
    sdkStack: row.sdk_stack,
    statsigProjectName: row.statsig_project_name,
    statsigServerSecretEnvVar: row.statsig_server_secret_env_var,
  };
}

export async function getV2PublishedRouting(
  clientId: string,
  db: DbExecutor = database
): Promise<PublishedPlacementRouting[]> {
  const result = await db.query<{
    placement_id: string;
    revision_id: string;
    trigger: string;
    status: "active" | "paused" | "archived";
    default_variant_key: string;
    default_binding_id: string;
    statsig_experiment_id: string | null;
    targeting_rules: unknown;
    variants: Array<{
      id: string;
      variant_id: string;
      binding_id: string;
      status: "active" | "paused";
      fallback_rank: number;
      weight: number;
    }>;
  }>(
    `SELECT
       p.id AS placement_id,
       pr.id AS revision_id,
       p.trigger,
       pr.status,
       pr.default_variant_key,
       pr.default_binding_id,
       pr.statsig_experiment_id,
       pr.targeting_rules,
       COALESCE(
         json_agg(
           json_build_object(
             'id', prv.id,
             'variant_id', prv.variant_key,
             'binding_id', prv.binding_id,
             'status', prv.status,
             'fallback_rank', prv.fallback_rank,
             'weight', prv.weight
           )
           ORDER BY
             CASE WHEN prv.variant_key = pr.default_variant_key THEN 0 ELSE 1 END,
             prv.fallback_rank ASC,
             prv.created_at ASC
         ) FILTER (WHERE prv.id IS NOT NULL AND prv.status = 'active'),
         '[]'::json
       ) AS variants
     FROM placements p
     JOIN placement_revisions pr ON pr.id = p.current_revision_id
     LEFT JOIN placement_revision_variants prv ON prv.placement_revision_id = pr.id
     WHERE p.client_id = $1
       AND pr.status <> 'archived'
     GROUP BY p.id, pr.id
     ORDER BY p.created_at DESC`,
    [clientId]
  );

  return result.rows.map((row) => ({
    placementId: row.placement_id,
    revisionId: row.revision_id,
    trigger: row.trigger,
    status: row.status,
    defaultVariantKey: row.default_variant_key,
    defaultBindingId: row.default_binding_id,
    experimentId: row.statsig_experiment_id,
    targetingRules: row.targeting_rules,
    variants: (row.variants || []).map((variant) => ({
      id: variant.id,
      variantId: variant.variant_id,
      bindingId: variant.binding_id,
      status: variant.status,
      fallbackRank: Number(variant.fallback_rank) || 0,
      weight: Number(variant.weight) || 0,
    })),
  }));
}

export async function getV2PublishedReleases(
  clientId: string,
  bindingIds: string[],
  db: DbExecutor = database
): Promise<Map<string, PublishedReleaseSpec>> {
  if (bindingIds.length === 0) return new Map();
  const result = await db.query<{
    binding_id: string;
    release_id: string;
    content_revision_id: string;
    content: Record<string, unknown>;
    products: unknown[];
    checkout: Record<string, unknown> | null;
    document_payload: Record<string, unknown>;
  }>(
    `SELECT
       b.id AS binding_id,
       r.id AS release_id,
       r.content_revision_id,
       cr.content,
       r.products,
       r.checkout,
       cr.document_payload
     FROM paywall_environment_bindings b
     JOIN paywall_environment_releases r ON r.id = b.current_release_id
     JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
     WHERE b.client_id = $1
       AND b.id = ANY($2::text[])`,
    [clientId, bindingIds]
  );
  return new Map(result.rows.map((row) => [row.binding_id, {
    bindingId: row.binding_id,
    releaseId: row.release_id,
    contentRevisionId: row.content_revision_id,
    content: row.content,
    products: row.products || [],
    checkout: row.checkout,
    documentPayload: row.document_payload,
  }]));
}

export async function getPublishedDocument(
  clientId: string,
  cacheKey: string,
  db: DbExecutor = database
): Promise<ImmutableDocument | null> {
  const result = await db.query<{
    document_cache_key: string;
    document_revision: string;
    document_hash: string;
    document_integrity: string;
    document_payload: Record<string, unknown>;
  }>(
    `SELECT DISTINCT ON (cr.document_cache_key)
       cr.document_cache_key,
       cr.document_revision,
       cr.document_hash,
       cr.document_integrity,
       cr.document_payload
     FROM config_audit_log audit
     JOIN paywall_environment_releases r
       ON r.id = audit.to_pointer_id
      AND r.client_id = audit.client_id
      AND r.project_key = audit.project_key
      AND r.paywall_id = audit.entity_id
     JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
     WHERE audit.client_id = $1
       AND audit.entity_type = 'paywall'
       AND audit.action IN ('publish', 'rollback', 'backfill')
       AND cr.document_cache_key = $2
     ORDER BY cr.document_cache_key, audit.created_at DESC`,
    [clientId, cacheKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    cacheKey: row.document_cache_key,
    revision: row.document_revision,
    documentHash: row.document_hash,
    integrity: row.document_integrity,
    payload: row.document_payload,
  };
}

export async function listConfigEnvironments(
  workspaceId?: string,
  db: DbExecutor = database
): Promise<unknown[]> {
  const result = await db.query(
    `SELECT id, public_key, name, project_key, environment_kind,
            management_status, config_source,
            COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack,
            created_at, updated_at
       FROM clients
      WHERE ($1::text IS NULL OR id = $1)
      ORDER BY project_key, environment_kind`,
    [workspaceId || null]
  );
  return result.rows;
}

export async function listEnvironmentPaywalls(
  publicKey: string,
  workspaceId?: string,
  db: DbExecutor = database
): Promise<unknown[]> {
  const result = await db.query(
    `SELECT
       b.id AS binding_id,
       b.client_id,
       p.id AS paywall_id,
       p.paywall_key,
       p.display_name,
       p.status,
       b.current_release_id,
       current_release.release_number AS current_release_number,
       current_release.content_revision_id,
       content.content_hash,
       content.document_cache_key,
       b.updated_at
     FROM clients c
     JOIN paywall_environment_bindings b ON b.client_id = c.id
     JOIN paywalls p ON p.id = b.paywall_id
     LEFT JOIN paywall_environment_releases current_release ON current_release.id = b.current_release_id
     LEFT JOIN paywall_content_revisions content ON content.id = current_release.content_revision_id
     WHERE c.public_key = $1
       AND ($2::text IS NULL OR c.id = $2)
     ORDER BY p.display_name, p.paywall_key`,
    [publicKey, workspaceId || null]
  );
  return result.rows;
}

export async function getEnvironmentPaywall(
  bindingId: string,
  workspaceId?: string,
  db: DbExecutor = database
): Promise<Record<string, unknown> | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT
       b.id AS binding_id,
       b.client_id,
       b.project_key,
       b.paywall_id,
       b.current_release_id,
       c.public_key,
       c.environment_kind,
       c.management_status,
       p.paywall_key,
       p.display_name,
       COALESCE(
         json_agg(
           json_build_object(
             'id', r.id,
             'release_number', r.release_number,
             'content_revision_id', r.content_revision_id,
             'content', cr.content,
             'content_hash', cr.content_hash,
             'document_cache_key', cr.document_cache_key,
             'products', r.products,
             'checkout', r.checkout,
             'created_by', r.created_by,
             'created_at', r.created_at,
             'is_current', r.id = b.current_release_id
           ) ORDER BY r.release_number DESC
         ) FILTER (WHERE r.id IS NOT NULL),
         '[]'::json
       ) AS releases
     FROM paywall_environment_bindings b
     JOIN clients c ON c.id = b.client_id
     JOIN paywalls p ON p.id = b.paywall_id
     LEFT JOIN paywall_environment_releases r ON r.binding_id = b.id
     LEFT JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
     WHERE b.id = $1
       AND ($2::text IS NULL OR b.client_id = $2)
     GROUP BY b.id, c.id, p.id`,
    [bindingId, workspaceId || null]
  );
  return result.rows[0] || null;
}

export async function listEnvironmentPlacements(
  publicKey: string,
  workspaceId?: string,
  db: DbExecutor = database
): Promise<unknown[]> {
  const result = await db.query(
    `SELECT p.id AS placement_id, p.trigger, p.current_revision_id,
            c.id AS client_id, c.project_key, c.environment_kind,
            c.management_status, c.config_source,
            pr.revision_number AS current_revision_number,
            pr.status, pr.default_variant_key, pr.default_binding_id,
            pr.statsig_experiment_id, pr.targeting_rules,
            COALESCE(json_agg(json_build_object(
              'variant_key', prv.variant_key,
              'binding_id', prv.binding_id,
              'status', prv.status,
              'weight', prv.weight,
              'fallback_rank', prv.fallback_rank
            ) ORDER BY prv.fallback_rank, prv.variant_key)
            FILTER (WHERE prv.id IS NOT NULL), '[]'::json) AS variants
       FROM clients c
       JOIN placements p ON p.client_id = c.id
       LEFT JOIN placement_revisions pr ON pr.id = p.current_revision_id
       LEFT JOIN placement_revision_variants prv ON prv.placement_revision_id = pr.id
      WHERE c.public_key = $1
        AND ($2::text IS NULL OR c.id = $2)
      GROUP BY p.id, c.id, pr.id
      ORDER BY p.trigger`,
    [publicKey, workspaceId || null]
  );
  return result.rows;
}
