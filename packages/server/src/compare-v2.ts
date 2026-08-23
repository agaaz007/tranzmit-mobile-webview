import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateLocalizationCoverage } from "@tranzmit/shared";
import { database, type DbExecutor } from "./config-store.js";
import {
  configuredPublicApiBaseUrl,
  hashDocument,
  sha256Integrity,
  webViewDocumentPayload,
} from "./webview-documents.js";
import { pool } from "./db.js";

type JsonRecord = Record<string, any>;

export interface ClientConfigComparison extends Record<string, unknown> {
  client_id: string;
  public_key: string;
  name: string;
  passed: boolean;
  legacy_hash: string;
  v2_hash: string;
}

interface ComparisonClient {
  id: string;
  public_key: string;
  name: string;
  sdk_stack: string;
}

export async function compareLegacyAndV2(publicKey?: string): Promise<{
  passed: boolean;
  environments: ClientConfigComparison[];
}> {
  configuredPublicApiBaseUrl();
  const clients = await database.query<ComparisonClient>(
    `SELECT id, public_key, name,
            COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack
       FROM clients
      WHERE ($1::text IS NULL OR public_key = $1)
      ORDER BY public_key`,
    [publicKey || null]
  );
  const environments: ClientConfigComparison[] = [];
  for (const client of clients.rows) {
    environments.push(await compareClient(client, database));
  }
  return {
    passed: environments.length > 0 && environments.every((environment) => environment.passed),
    environments,
  };
}

export async function compareLegacyAndV2Client(
  clientId: string,
  db: DbExecutor = database
): Promise<ClientConfigComparison | null> {
  configuredPublicApiBaseUrl();
  const result = await db.query<ComparisonClient>(
    `SELECT id, public_key, name,
            COALESCE(NULLIF(sdk_stack, ''), 'react_native') AS sdk_stack
       FROM clients WHERE id = $1`,
    [clientId]
  );
  return result.rows[0] ? compareClient(result.rows[0], db) : null;
}

async function compareClient(client: ComparisonClient, db: DbExecutor): Promise<ClientConfigComparison> {
  const legacy = await legacyCanonical(client, db);
  const v2 = await v2Canonical(client.id, db);
  const legacyJson = stableJson(legacy);
  const v2Json = stableJson(v2);
  const legacyValidationIssues = collectValidationIssues(legacy);
  const v2ValidationIssues = collectValidationIssues(v2);
  const passed = legacyJson === v2Json
    && legacyValidationIssues.length === 0
    && v2ValidationIssues.length === 0;
  return {
    client_id: client.id,
    public_key: client.public_key,
    name: client.name,
    passed,
    legacy_hash: sha256(legacyJson),
    v2_hash: sha256(v2Json),
    ...(legacyValidationIssues.length || v2ValidationIssues.length
      ? { validation_issues: { legacy: legacyValidationIssues, v2: v2ValidationIssues } }
      : {}),
    ...(legacyJson === v2Json ? {} : { legacy, v2 }),
  };
}

async function legacyCanonical(client: ComparisonClient, db: DbExecutor) {
  const placements = await db.query<{
    id: string;
    trigger: string;
    status: "active" | "paused" | "archived";
    variant_id: string | null;
    statsig_experiment_id: string | null;
    targeting_rules: unknown;
    default_spec: JsonRecord | null;
  }>(
    `SELECT p.id, p.trigger,
            COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) AS status,
            p.variant_id,
            COALESCE(p.statsig_experiment_id, p.experiment_id) AS statsig_experiment_id,
            p.targeting_rules,
            CASE WHEN p.default_spec_id IS NOT NULL THEN ps.spec ELSE p.spec END AS default_spec
       FROM placements p
       LEFT JOIN paywall_specs ps
         ON ps.id = p.default_spec_id
        AND ps.status <> 'archived'
      WHERE p.client_id = $1
      ORDER BY p.trigger`,
    [client.id]
  );
  const variants = await db.query<{
    placement_id: string;
    variant_key: string;
    weight: number;
    fallback_rank: number;
    spec: JsonRecord;
    created_at: string;
  }>(
    `SELECT pv.placement_id, COALESCE(pv.variant_key, pv.variant_id) AS variant_key,
            COALESCE(pv.weight, 50) AS weight,
            COALESCE(pv.fallback_rank, 0) AS fallback_rank,
            CASE WHEN pv.spec_id IS NOT NULL THEN ps.spec ELSE pv.spec END AS spec,
            pv.created_at::text
       FROM placement_variants pv
       JOIN placements p ON p.id = pv.placement_id
       LEFT JOIN paywall_specs ps
         ON ps.id = pv.spec_id
        AND ps.status <> 'archived'
      WHERE p.client_id = $1
        AND COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END) = 'active'
        AND (pv.spec_id IS NULL OR ps.id IS NOT NULL)
      ORDER BY pv.placement_id, pv.fallback_rank, pv.created_at, pv.id`,
    [client.id]
  );
  const byPlacement = groupBy(variants.rows, (variant) => variant.placement_id);
  return placements.rows
    .filter((placement) => placement.status !== "archived")
    .map((placement) => {
      if (placement.status !== "active" || !placement.default_spec) {
        return { trigger: placement.trigger, served: false };
      }
      const active = byPlacement.get(placement.id) || [];
      const effective = active.find((variant) => variant.variant_key === placement.variant_id) || active[0];
      const defaultVariantKey = effective?.variant_key || placement.variant_id || "var_default";
      const normalized = active.length > 0
        ? active.map((variant) => ({
            variant_key: variant.variant_key,
            weight: variant.weight,
            fallback_rank: variant.fallback_rank,
            spec: legacySpecSummary(
              variant.spec,
              client,
              placement.id,
              variant.variant_key
            ),
          }))
        : [{
            variant_key: defaultVariantKey,
            weight: 100,
            fallback_rank: 0,
            spec: legacySpecSummary(
              placement.default_spec,
              client,
              placement.id,
              defaultVariantKey
            ),
          }];
      normalized.sort((left, right) => left.variant_key.localeCompare(right.variant_key));
      return {
        trigger: placement.trigger,
        served: true,
        default_variant_key: defaultVariantKey,
        statsig_experiment_id: placement.statsig_experiment_id,
        targeting_rules: placement.targeting_rules || [],
        variants: normalized,
      };
    });
}

async function v2Canonical(clientId: string, db: DbExecutor) {
  const result = await db.query<{
    placement_id: string;
    trigger: string;
    placement_status: "active" | "paused" | "archived";
    default_variant_key: string;
    statsig_experiment_id: string | null;
    targeting_rules: unknown;
    variant_key: string | null;
    weight: number | null;
    fallback_rank: number | null;
    content: JsonRecord | null;
    content_hash: string | null;
    document_hash: string | null;
    document_cache_key: string | null;
    document_revision: string | null;
    document_integrity: string | null;
    document_payload: JsonRecord | null;
    products: unknown[] | null;
    checkout: JsonRecord | null;
  }>(
    `SELECT p.id AS placement_id, p.trigger, pr.status AS placement_status,
            pr.default_variant_key, pr.statsig_experiment_id, pr.targeting_rules,
            prv.variant_key, prv.weight, prv.fallback_rank,
            cr.content, cr.content_hash, cr.document_hash,
            cr.document_cache_key, cr.document_revision, cr.document_integrity,
            cr.document_payload, r.products, r.checkout
       FROM placements p
       JOIN placement_revisions pr ON pr.id = p.current_revision_id
       LEFT JOIN placement_revision_variants prv
         ON prv.placement_revision_id = pr.id AND prv.status = 'active'
       LEFT JOIN paywall_environment_bindings b ON b.id = prv.binding_id
       LEFT JOIN paywall_environment_releases r ON r.id = b.current_release_id
       LEFT JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
      WHERE p.client_id = $1 AND pr.status <> 'archived'
      ORDER BY p.trigger, prv.fallback_rank, prv.created_at, prv.id`,
    [clientId]
  );
  const groups = groupBy(result.rows, (row) => row.placement_id);
  return Array.from(groups.values()).map((rows) => {
    const first = rows[0];
    if (first.placement_status !== "active") {
      return { trigger: first.trigger, served: false };
    }
    return {
      trigger: first.trigger,
      served: true,
      default_variant_key: first.default_variant_key,
      statsig_experiment_id: first.statsig_experiment_id,
      targeting_rules: first.targeting_rules || [],
      variants: rows.map((row) => ({
        variant_key: row.variant_key,
        weight: row.weight,
        fallback_rank: row.fallback_rank,
        spec: v2SpecSummary(row),
      })).sort((left, right) => String(left.variant_key).localeCompare(String(right.variant_key))),
    };
  }).sort((left, right) => left.trigger.localeCompare(right.trigger));
}

function legacySpecSummary(
  spec: JsonRecord,
  client: ComparisonClient,
  placementId: string,
  variantKey: string
) {
  const normalized = ensureBackfillBaseUrl(spec);
  const split = splitPaywallSpec(normalized);
  const payload = webViewDocumentPayload(normalized, {
    publicKey: client.public_key,
    placementId,
    variantKey,
    apiBaseUrl: publicApiBaseUrl(),
    includeInline: true,
    sdkStack: client.sdk_stack,
  });
  return commonSpecSummary(normalized, split.products, split.checkout, {
    contentHash: sha256(stableJson(split.content)),
    documentHash: hashDocument(payload),
  });
}

function v2SpecSummary(row: {
  content: JsonRecord | null;
  content_hash: string | null;
  document_hash: string | null;
  document_cache_key: string | null;
  document_revision: string | null;
  document_integrity: string | null;
  document_payload: JsonRecord | null;
  products: unknown[] | null;
  checkout: JsonRecord | null;
}) {
  if (!row.content || !row.content_hash || !row.document_hash) {
    return { missing_published_release: true };
  }
  const spec = {
    ...row.content,
    products: row.products || [],
    ...(row.checkout ? { checkout: row.checkout } : {}),
  };
  const storageIssues: string[] = [];
  const payload = row.document_payload || {};
  if (sha256(stableJson(row.content)) !== row.content_hash) storageIssues.push("content_hash_mismatch");
  if (hashDocument(payload) !== row.document_hash) storageIssues.push("document_hash_mismatch");
  if (payload.cacheKey !== row.document_cache_key) storageIssues.push("document_cache_key_mismatch");
  if (String(payload.revision ?? "") !== String(row.document_revision ?? "")) {
    storageIssues.push("document_revision_mismatch");
  }
  const expectedIntegrity = sha256Integrity(typeof payload.html === "string" ? payload.html : "");
  if (row.document_integrity !== expectedIntegrity || payload.integrity !== expectedIntegrity) {
    storageIssues.push("document_integrity_mismatch");
  }
  return {
    ...commonSpecSummary(spec, row.products || [], row.checkout, {
      contentHash: row.content_hash,
      documentHash: row.document_hash,
    }),
    ...(storageIssues.length ? { storage_issues: storageIssues } : {}),
  };
}

function commonSpecSummary(
  spec: JsonRecord,
  products: unknown[],
  checkout: JsonRecord | null,
  hashes: { contentHash: string; documentHash: string }
) {
  const localization = spec.localization;
  const translations = localization && typeof localization === "object" && localization.translations
    ? localization.translations
    : {};
  const coverage = validateLocalizationCoverage(spec);
  return {
    content_hash: hashes.contentHash,
    document_hash: hashes.documentHash,
    locales: Object.keys(translations).sort(),
    default_locale: localization?.defaultLocale || null,
    localization_issues: coverage.issues,
    // Products are part of the served configuration, not just routing metadata.
    // Preserve array order while stableJson canonicalizes every nested object key,
    // so changes to price/copy/defaults/features/metadata cannot pass cutover merely
    // because the billing product IDs stayed the same.
    products: structuredClone(products),
    checkout,
  };
}

function splitPaywallSpec(spec: unknown): {
  content: JsonRecord;
  products: unknown[];
  checkout: JsonRecord | null;
} {
  const source = cloneRecord(spec);
  const products = Array.isArray(source.products) ? structuredClone(source.products) : [];
  const checkout = isRecord(source.checkout) ? structuredClone(source.checkout) : null;
  delete source.products;
  delete source.checkout;
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

function ensureBackfillBaseUrl(spec: JsonRecord): JsonRecord {
  const copy = structuredClone(spec);
  const document = copy.document;
  if (isRecord(document) && typeof document.html === "string" && !document.baseUrl) {
    document.baseUrl = publicApiBaseUrl();
  }
  return copy;
}

function publicApiBaseUrl(): string {
  return configuredPublicApiBaseUrl();
}

function collectValidationIssues(value: unknown): Array<{
  trigger: string;
  variant_key: string;
  issues: unknown[];
}> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ trigger: string; variant_key: string; issues: unknown[] }> = [];
  for (const placement of value) {
    if (!isRecord(placement) || !Array.isArray(placement.variants)) continue;
    for (const variant of placement.variants) {
      if (!isRecord(variant) || !isRecord(variant.spec)) continue;
      const issues = Array.isArray(variant.spec.localization_issues)
        ? variant.spec.localization_issues
        : [];
      if (issues.length > 0) {
        result.push({
          trigger: String(placement.trigger || ""),
          variant_key: String(variant.variant_key || ""),
          issues,
        });
      }
    }
  }
  return result;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) || []), item]);
  return groups;
}

function cloneRecord(value: unknown): JsonRecord {
  return isRecord(value) ? structuredClone(value) : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  compareLegacyAndV2(process.argv[2])
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.passed ? 0 : 1;
    })
    .then(() => pool.end())
    .catch((error) => {
      console.error("[Tranzmit] V2 comparison failed:", error);
      pool.end().finally(() => process.exit(1));
    });
}
