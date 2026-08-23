import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  database,
  withTransaction,
  type DbExecutor,
} from "./config-store.js";
import {
  ConfigError,
  composePaywallSpec,
  splitPaywallSpec,
  validatePublishableSpec,
  __private as publishPrivate,
} from "./config-publish.js";
import { pool } from "./db.js";
import { configuredPublicApiBaseUrl } from "./webview-documents.js";

type JsonRecord = Record<string, any>;

const CLIENT_MANIFEST = new Map<string, {
  projectKey: string;
  environmentKind: "test" | "live";
  managementStatus: "editable" | "legacy_locked";
}>([
  ["pk_live_310bc7653631b8b924afbad3", {
    projectKey: "hiastro", environmentKind: "live", managementStatus: "editable",
  }],
  ["pk_test_320da03ab659ffc56d58acd2", {
    projectKey: "hiastro", environmentKind: "test", managementStatus: "editable",
  }],
  ["pk_test_2a8a5f07d4b9fcf1cc77e024", {
    projectKey: "influish", environmentKind: "test", managementStatus: "legacy_locked",
  }],
  ["pk_live_a1323f76d397778b6ed5eb04", {
    projectKey: "influish", environmentKind: "live", managementStatus: "legacy_locked",
  }],
]);

interface ClientRow {
  id: string;
  public_key: string;
  name: string;
  project_key: string;
  environment_kind: "test" | "live";
  management_status: "editable" | "legacy_locked";
}

interface LegacySpecRow {
  id: string;
  workspace_id: string;
  name: string;
  spec: JsonRecord;
  status: "draft" | "active" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface LegacyPlacementRow {
  id: string;
  client_id: string;
  project_key: string;
  public_key: string;
  trigger: string;
  status: "active" | "paused" | "archived";
  variant_id: string | null;
  default_spec_id: string | null;
  statsig_experiment_id: string | null;
  targeting_rules: unknown;
  spec: JsonRecord | null;
  created_at: string;
}

interface LegacyVariantRow {
  id: string;
  placement_id: string;
  variant_key: string;
  spec_id: string | null;
  spec: JsonRecord | null;
  status: "active" | "paused";
  weight: number;
  fallback_rank: number;
  created_at: string;
}

interface MigratedSpec {
  bindingId: string;
  paywallId: string;
  releaseId: string;
  valid: boolean;
  legacyStatus: "draft" | "active" | "archived";
}

export async function backfillPaywallPublishingV2(): Promise<Record<string, unknown>> {
  // Resolve this before opening a transaction so a missing canonical origin
  // cannot leave a long-running backfill transaction sitting idle.
  configuredPublicApiBaseUrl();
  // The events table is production history, not part of the config migration.
  // Snapshot it before taking any client/config locks, then verify it after the
  // atomic config transaction has committed so neither large scan extends the
  // lock window.
  const eventSnapshot = await captureEventSnapshot(database);
  const result = await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tranzmit-v2-backfill'))");
    const clients = await loadAndVerifyClients(db);
    const specs = await loadSpecs(db);
    const placements = await loadPlacements(db);
    const variants = await loadVariants(db);
    const variantsByPlacement = groupBy(variants, (variant) => variant.placement_id);
    const specById = new Map(specs.map((spec) => [spec.id, spec]));
    const referenced = referencedSpecPriority(placements, variantsByPlacement);
    const blockingSpecIds = servedLegacySpecIds(placements, variantsByPlacement, specById);
    const migrated = new Map<string, MigratedSpec>();
    const bindings = new Map<string, string>();
    const validationFailures: Array<Record<string, unknown>> = [];

    for (const spec of specs) {
      const client = clients.get(spec.workspace_id)!;
      const paywallKey = logicalPaywallKey(client.project_key, spec);
      const paywall = await ensurePaywall(db, client.project_key, paywallKey, spec.name);
      const bindingId = await ensureBinding(db, client, paywall.id);
      bindings.set(`${client.id}:${paywallKey}`, bindingId);
      const preparedSpec = withBackfillBaseUrl(spec.spec);
      let valid = true;
      try {
        validatePublishableSpec(preparedSpec);
      } catch (error) {
        valid = false;
        validationFailures.push({
          client: client.public_key,
          legacy_spec_id: spec.id,
          name: spec.name,
          blocking: blockingSpecIds.has(spec.id),
          error: error instanceof Error ? error.message : String(error),
          details: error instanceof ConfigError ? error.details : undefined,
        });
      }
      const release = await publishPrivate.createPaywallReleaseInTransaction(db, bindingId, {
        spec: preparedSpec,
        createdBy: "legacy-backfill",
      }, undefined, {
        allowLocked: true,
        skipValidation: !valid,
        legacy: legacyProvenance(spec),
      });
      migrated.set(spec.id, {
        bindingId,
        paywallId: paywall.id,
        releaseId: String(release.id),
        valid,
        legacyStatus: spec.status,
      });
    }

    const pointerChoices = new Map<string, { releaseId: string; paywallId: string; priority: number; source: string }>();
    for (const [specId, priority] of referenced) {
      const item = migrated.get(specId);
      if (!item || !item.valid || item.legacyStatus !== "active") continue;
      const current = pointerChoices.get(item.bindingId);
      if (!current || priority > current.priority) {
        pointerChoices.set(item.bindingId, {
          releaseId: item.releaseId,
          paywallId: item.paywallId,
          priority,
          source: specId,
        });
      } else if (current.releaseId !== item.releaseId && priority === current.priority) {
        await insertMigrationAudit(db, clients.get(specById.get(specId)!.workspace_id)!, "binding_conflict", {
          binding_id: item.bindingId,
          kept_legacy_spec_id: current.source,
          conflicting_legacy_spec_id: specId,
        });
      }
    }

    const referencedBindingIds = new Set(
      Array.from(referenced.keys())
        .map((specId) => migrated.get(specId)?.bindingId)
        .filter((bindingId): bindingId is string => Boolean(bindingId))
    );
    for (const bindingId of referencedBindingIds) {
      if (pointerChoices.has(bindingId)) continue;
      const cleared = await db.query<{
        client_id: string;
        project_key: string;
        paywall_id: string;
        previous_release_id: string;
      }>(
        `WITH previous AS (
           SELECT b.id, b.client_id, b.project_key, b.paywall_id,
                  b.current_release_id AS previous_release_id
             FROM paywall_environment_bindings b
            WHERE b.id = $1
              AND b.current_release_id IS NOT NULL
              AND 'backfill' = (
                SELECT audit.action FROM config_audit_log audit
                 WHERE audit.client_id = b.client_id
                   AND audit.entity_type = 'paywall'
                   AND audit.entity_id = b.paywall_id
                   AND audit.action IN ('backfill', 'publish', 'rollback')
                   AND audit.to_pointer_id IS NOT DISTINCT FROM b.current_release_id
                 ORDER BY audit.id DESC
                 LIMIT 1
              )
         ), updated AS (
           UPDATE paywall_environment_bindings b
              SET current_release_id = NULL, updated_at = now()
             FROM previous
            WHERE b.id = previous.id
           RETURNING previous.client_id, previous.project_key,
                     previous.paywall_id, previous.previous_release_id
         ) SELECT * FROM updated`,
        [bindingId]
      );
      if (cleared.rows[0]) {
        await db.query(
          `INSERT INTO config_audit_log (
             project_key, client_id, entity_type, entity_id, action,
             from_pointer_id, to_pointer_id, actor, metadata
           ) VALUES ($1,$2,'paywall',$3,'backfill_unpublish',$4,NULL,'legacy-backfill','{}'::jsonb)`,
          [
            cleared.rows[0].project_key,
            cleared.rows[0].client_id,
            cleared.rows[0].paywall_id,
            cleared.rows[0].previous_release_id,
          ]
        );
      }
    }

    for (const [bindingId, choice] of pointerChoices) {
      const owner = await db.query<{
        client_id: string;
        project_key: string;
        current_release_id: string | null;
      }>(
        `SELECT client_id, project_key, current_release_id
           FROM paywall_environment_bindings WHERE id = $1`,
        [bindingId]
      );
      // Match publish lock ordering and retain the exact pointer being
      // replaced so the backfill audit remains a complete history.
      await db.query("SELECT id FROM clients WHERE id = $1 FOR SHARE", [owner.rows[0].client_id]);
      const lockedPointer = await db.query<{ current_release_id: string | null }>(
        "SELECT current_release_id FROM paywall_environment_bindings WHERE id = $1 FOR UPDATE",
        [bindingId]
      );
      const previousReleaseId = lockedPointer.rows[0]?.current_release_id ?? null;
      const pointerUpdate = await db.query(
        `UPDATE paywall_environment_bindings
            SET current_release_id = $2, updated_at = now()
          WHERE id = $1
            AND current_release_id IS DISTINCT FROM $2
            AND (
              current_release_id IS NULL
              OR 'backfill' = (
                SELECT audit.action FROM config_audit_log audit
                 WHERE audit.client_id = paywall_environment_bindings.client_id
                   AND audit.entity_type = 'paywall'
                   AND audit.entity_id = paywall_environment_bindings.paywall_id
                   AND audit.action IN ('backfill', 'publish', 'rollback')
                   AND audit.to_pointer_id IS NOT DISTINCT FROM paywall_environment_bindings.current_release_id
                 ORDER BY audit.id DESC
                 LIMIT 1
              )
            )
          RETURNING current_release_id`,
        [bindingId, choice.releaseId]
      );
      if (pointerUpdate.rowCount) await db.query(
         `INSERT INTO config_audit_log (
           project_key, client_id, entity_type, entity_id, action,
           from_pointer_id, to_pointer_id, actor, metadata
         )
         VALUES ($1,$2,'paywall',$3,'backfill',$4,$5,'legacy-backfill',$6)`,
        [
          owner.rows[0].project_key,
          owner.rows[0].client_id,
          choice.paywallId,
          previousReleaseId,
          choice.releaseId,
          JSON.stringify({ legacy_spec_id: choice.source }),
        ]
      );
    }

    let placementRevisionCount = 0;
    for (const placement of placements) {
      const client = clients.get(placement.client_id)!;
      const legacyVariants = variantsByPlacement.get(placement.id) || [];
      const legacyDefaultSpec = placement.default_spec_id
        ? specById.get(placement.default_spec_id)
        : undefined;
      if (placement.default_spec_id && (
        !legacyDefaultSpec || legacyDefaultSpec.workspace_id !== placement.client_id
      )) {
        throw new Error(
          `Placement ${placement.id} references missing or cross-environment default spec ${placement.default_spec_id}`
        );
      }
      const legacyDefaultIsServed = placement.status === "active" && (
        placement.default_spec_id
          ? Boolean(legacyDefaultSpec && legacyDefaultSpec.status !== "archived")
          : Boolean(placement.spec)
      );
      // Legacy resolution returns this placement as unserved before looking at
      // variants when its default spec is missing or archived. Preserve that
      // behavior in V2 instead of activating a routing graph whose default
      // binding intentionally has no published release.
      const routingStatus = placement.status === "active" && !legacyDefaultIsServed
        ? "paused"
        : placement.status;
      const mappedVariants: Array<{
        variant: LegacyVariantRow;
        bindingId: string;
      }> = [];
      for (const variant of legacyVariants) {
        const legacySpec = variant.spec_id ? specById.get(variant.spec_id) : undefined;
        if (legacySpec && legacySpec.status !== "active") continue;
        const mapping = variant.spec_id
          ? migrated.get(variant.spec_id)
          : await migrateInlineSpec(
              db,
              client,
              placement,
              variant.variant_key,
              variant.spec,
              bindings,
              validationFailures,
              {
                entity: "variant",
                entityId: variant.id,
                blocking: legacyDefaultIsServed && variant.status === "active",
              }
            );
        if (!mapping) throw new Error(`Missing migrated variant ${variant.id}`);
        mappedVariants.push({ variant, bindingId: mapping.bindingId });
      }

      const activeVariants = mappedVariants.filter(({ variant }) => variant.status === "active");
      const defaultMatch = activeVariants.find(({ variant }) => variant.variant_key === placement.variant_id);
      const effectiveVariant = defaultMatch || activeVariants[0];
      let defaultVariantKey = effectiveVariant?.variant.variant_key || placement.variant_id || "var_default";
      let defaultBindingId: string | undefined = effectiveVariant?.bindingId;
      if (!defaultBindingId && placement.default_spec_id) {
        defaultBindingId = migrated.get(placement.default_spec_id)?.bindingId;
      }
      if (!defaultBindingId && !placement.default_spec_id) {
        const inline = await migrateInlineSpec(
          db,
          client,
          placement,
          defaultVariantKey,
          placement.spec,
          bindings,
          validationFailures,
          {
            entity: "placement",
            entityId: placement.id,
            blocking: placement.status === "active" && !placement.default_spec_id,
          }
        );
        defaultBindingId = inline?.bindingId;
      }
      if (!defaultBindingId) throw new Error(`Placement ${placement.id} has no migratable default`);

      if (activeVariants.length === 0) {
        for (let index = mappedVariants.length - 1; index >= 0; index -= 1) {
          if (mappedVariants[index].variant.variant_key === defaultVariantKey) {
            mappedVariants.splice(index, 1);
          }
        }
        mappedVariants.push({
          bindingId: defaultBindingId,
          variant: {
            id: `backfill-${placement.id}`,
            placement_id: placement.id,
            variant_key: defaultVariantKey,
            spec_id: placement.default_spec_id,
            spec: placement.spec,
            status: "active",
            weight: 100,
            fallback_rank: 0,
            created_at: placement.created_at,
          },
        });
      }

      const routingFingerprint = sha256(stableJson({
        placement_id: placement.id,
        status: routingStatus,
        default_binding_id: defaultBindingId,
        default_variant_key: defaultVariantKey,
        statsig_experiment_id: placement.statsig_experiment_id,
        targeting_rules: placement.targeting_rules,
        variants: mappedVariants.map(({ variant, bindingId }) => ({
          variant_key: variant.variant_key,
          binding_id: bindingId,
          status: variant.status,
          weight: variant.weight,
          fallback_rank: variant.fallback_rank,
        })),
      }));
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM placement_revisions
          WHERE placement_id = $1 AND legacy_fingerprint = $2`,
        [placement.id, routingFingerprint]
      );
      let revisionId = existing.rows[0]?.id;
      if (!revisionId) {
        const revision = await db.query<{ id: string }>(
          `INSERT INTO placement_revisions (
             placement_id, client_id, project_key, revision_number, status,
             default_binding_id, default_variant_key, statsig_experiment_id,
             targeting_rules, legacy_fingerprint, created_by
           )
           SELECT $1,$2,$3,COALESCE(MAX(revision_number),0)+1,$4,$5,$6,$7,$8,$9,'legacy-backfill'
             FROM placement_revisions WHERE placement_id = $1
           RETURNING id`,
          [
            placement.id,
            placement.client_id,
            placement.project_key,
            routingStatus,
            defaultBindingId,
            defaultVariantKey,
            placement.statsig_experiment_id,
            JSON.stringify(Array.isArray(placement.targeting_rules) ? placement.targeting_rules : []),
            routingFingerprint,
          ]
        );
        revisionId = revision.rows[0].id;
        for (const { variant, bindingId } of mappedVariants) {
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
              variant.variant_key,
              bindingId,
              variant.status,
              variant.weight,
              variant.fallback_rank,
            ]
          );
        }
        placementRevisionCount += 1;
      }
      await db.query("SELECT id FROM clients WHERE id = $1 FOR SHARE", [placement.client_id]);
      const lockedRouting = await db.query<{ current_revision_id: string | null }>(
        "SELECT current_revision_id FROM placements WHERE id = $1 FOR UPDATE",
        [placement.id]
      );
      const previousRevisionId = lockedRouting.rows[0]?.current_revision_id ?? null;
      const routingUpdate = await db.query(
        `UPDATE placements
            SET current_revision_id = $2
          WHERE id = $1
            AND current_revision_id IS DISTINCT FROM $2
            AND (
              current_revision_id IS NULL
              OR 'backfill' = (
                SELECT audit.action FROM config_audit_log audit
                 WHERE audit.client_id = placements.client_id
                   AND audit.entity_type = 'placement'
                   AND audit.entity_id = placements.id
                   AND audit.action IN ('backfill', 'publish', 'rollback')
                   AND audit.to_pointer_id IS NOT DISTINCT FROM placements.current_revision_id
                 ORDER BY audit.id DESC
                 LIMIT 1
              )
            )
          RETURNING current_revision_id`,
        [placement.id, revisionId]
      );
      if (routingUpdate.rowCount) await db.query(
         `INSERT INTO config_audit_log (
           project_key, client_id, entity_type, entity_id, action,
           from_pointer_id, to_pointer_id, actor, metadata
         )
         VALUES ($1,$2,'placement',$3,'backfill',$4,$5,'legacy-backfill',$6)`,
        [
          placement.project_key,
          placement.client_id,
          placement.id,
          previousRevisionId,
          revisionId,
          JSON.stringify({
            legacy_default_variant: placement.variant_id,
            effective_default_variant: defaultVariantKey,
            legacy_fingerprint: routingFingerprint,
          }),
        ]
      );
    }

    await recordInlineMismatches(db, clients);
    for (const client of clients.values()) {
      await insertMigrationAudit(db, client, "backfill_complete", {
        blocking_validation_failures: validationFailures.filter(
          (item) => item.client === client.public_key && item.blocking === true
        ).length,
        retained_validation_warnings: validationFailures.filter(
          (item) => item.client === client.public_key && item.blocking !== true
        ).length,
        event_snapshot: eventSnapshot.get(client.public_key),
      });
    }

    return {
      clients: clients.size,
      legacy_specs: specs.length,
      paywall_releases: migrated.size,
      placements: placements.length,
      placement_revisions_created: placementRevisionCount,
      validation_failures: validationFailures,
      blocking_validation_failures: validationFailures.filter((item) => item.blocking === true),
      retained_validation_warnings: validationFailures.filter((item) => item.blocking !== true),
      config_source_changed: false,
      events_changed: false,
    };
  });
  await verifyEventSnapshot(database, eventSnapshot);
  return result;
}

async function loadAndVerifyClients(db: DbExecutor): Promise<Map<string, ClientRow>> {
  const result = await db.query<ClientRow>(
    `SELECT id, public_key, name, project_key, environment_kind, management_status
       FROM clients ORDER BY public_key`
  );
  const unexpected = result.rows.filter((client) => !CLIENT_MANIFEST.has(client.public_key));
  const missing = Array.from(CLIENT_MANIFEST.keys()).filter(
    (publicKey) => !result.rows.some((client) => client.public_key === publicKey)
  );
  if (unexpected.length || missing.length) {
    throw new Error(`Client manifest mismatch: unexpected=${unexpected.map((row) => row.public_key)} missing=${missing}`);
  }
  for (const client of result.rows) {
    const manifest = CLIENT_MANIFEST.get(client.public_key)!;
    await db.query(
      `UPDATE clients
          SET project_key = $2, environment_kind = $3, management_status = $4
        WHERE id = $1`,
      [client.id, manifest.projectKey, manifest.environmentKind, manifest.managementStatus]
    );
    client.project_key = manifest.projectKey;
    client.environment_kind = manifest.environmentKind;
    client.management_status = manifest.managementStatus;
  }
  return new Map(result.rows.map((client) => [client.id, client]));
}

async function loadSpecs(db: DbExecutor): Promise<LegacySpecRow[]> {
  const result = await db.query<LegacySpecRow>(
    `SELECT id, workspace_id, name, spec, status, version,
            created_at::text, updated_at::text, created_by
       FROM paywall_specs ORDER BY workspace_id, created_at, id`
  );
  return result.rows;
}

async function loadPlacements(db: DbExecutor): Promise<LegacyPlacementRow[]> {
  const result = await db.query<LegacyPlacementRow>(
    `SELECT p.id, p.client_id, p.project_key, p.public_key, p.trigger,
            COALESCE(p.status, CASE WHEN p.enabled THEN 'active' ELSE 'paused' END) AS status,
            p.variant_id, p.default_spec_id,
            COALESCE(p.statsig_experiment_id, p.experiment_id) AS statsig_experiment_id,
            p.targeting_rules, p.spec, p.created_at::text
       FROM placements p ORDER BY p.client_id, p.created_at, p.id`
  );
  return result.rows;
}

async function loadVariants(db: DbExecutor): Promise<LegacyVariantRow[]> {
  const result = await db.query<LegacyVariantRow>(
    `SELECT pv.id, pv.placement_id, COALESCE(pv.variant_key, pv.variant_id) AS variant_key,
            pv.spec_id, pv.spec,
            COALESCE(pv.status, CASE WHEN pv.enabled THEN 'active' ELSE 'paused' END) AS status,
            COALESCE(pv.weight, 50) AS weight,
            COALESCE(pv.fallback_rank, 0) AS fallback_rank,
            pv.created_at::text
       FROM placement_variants pv
       ORDER BY pv.placement_id, pv.fallback_rank, pv.created_at, pv.id`
  );
  return result.rows;
}

function referencedSpecPriority(
  placements: LegacyPlacementRow[],
  variantsByPlacement: Map<string, LegacyVariantRow[]>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const placement of placements) {
    const variants = variantsByPlacement.get(placement.id) || [];
    for (const variant of variants) {
      if (variant.spec_id) result.set(variant.spec_id, Math.max(result.get(variant.spec_id) || 0, variant.status === "active" ? 3 : 2));
    }
    if (placement.default_spec_id) {
      result.set(placement.default_spec_id, Math.max(result.get(placement.default_spec_id) || 0, variants.some((v) => v.status === "active") ? 1 : 3));
    }
  }
  return result;
}

function servedLegacySpecIds(
  placements: LegacyPlacementRow[],
  variantsByPlacement: Map<string, LegacyVariantRow[]>,
  specById: Map<string, LegacySpecRow>
): Set<string> {
  const result = new Set<string>();
  for (const placement of placements) {
    if (placement.status !== "active") continue;
    const defaultSpec = placement.default_spec_id
      ? specById.get(placement.default_spec_id)
      : undefined;
    const hasDefault = placement.default_spec_id
      ? Boolean(defaultSpec && defaultSpec.status !== "archived")
      : Boolean(placement.spec);
    if (!hasDefault) continue;
    if (defaultSpec) result.add(defaultSpec.id);
    for (const variant of variantsByPlacement.get(placement.id) || []) {
      if (variant.status !== "active" || !variant.spec_id) continue;
      const variantSpec = specById.get(variant.spec_id);
      if (variantSpec && variantSpec.status !== "archived") result.add(variantSpec.id);
    }
  }
  return result;
}

async function ensurePaywall(db: DbExecutor, projectKey: string, paywallKey: string, displayName: string) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO paywalls (project_key, paywall_key, display_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (project_key, paywall_key) DO UPDATE
       SET paywall_key = paywalls.paywall_key
     RETURNING id`,
    [projectKey, paywallKey, displayName]
  );
  return result.rows[0];
}

async function ensureBinding(db: DbExecutor, client: ClientRow, paywallId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO paywall_environment_bindings (client_id, project_key, paywall_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (client_id, paywall_id) DO UPDATE
       SET client_id = paywall_environment_bindings.client_id
     RETURNING id`,
    [client.id, client.project_key, paywallId]
  );
  return result.rows[0].id;
}

async function migrateInlineSpec(
  db: DbExecutor,
  client: ClientRow,
  placement: LegacyPlacementRow,
  variantKey: string,
  spec: JsonRecord | null,
  bindings: Map<string, string>,
  validationFailures: Array<Record<string, unknown>>,
  source: { entity: "placement" | "variant"; entityId: string; blocking: boolean }
): Promise<MigratedSpec | null> {
  if (!spec) return null;
  const paywallKey = `legacy-inline-${slug(placement.trigger)}-${slug(variantKey)}`;
  const paywall = await ensurePaywall(db, client.project_key, paywallKey, `${placement.trigger} ${variantKey}`);
  const mapKey = `${client.id}:${paywallKey}`;
  const bindingId = bindings.get(mapKey) || await ensureBinding(db, client, paywall.id);
  bindings.set(mapKey, bindingId);
  const legacyId = `inline:${placement.id}:${variantKey}`;
  const prepared = withBackfillBaseUrl(spec);
  const provenance = buildLegacyProvenance({
    id: legacyId,
    name: `${placement.trigger} ${variantKey}`,
    status: placement.status,
    version: 1,
    updatedAt: placement.created_at,
    spec: prepared,
  });
  let valid = true;
  try {
    validatePublishableSpec(prepared);
  } catch (error) {
    valid = false;
    const failure = {
      client: client.public_key,
      legacy_inline_id: legacyId,
      placement_id: placement.id,
      variant_key: variantKey,
      source_entity: source.entity,
      source_entity_id: source.entityId,
      blocking: source.blocking,
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof ConfigError ? error.details : undefined,
    };
    if (!validationFailures.some((item) => item.legacy_inline_id === legacyId)) {
      validationFailures.push(failure);
    }
  }
  const release = await publishPrivate.createPaywallReleaseInTransaction(db, bindingId, {
    spec: prepared,
    createdBy: "legacy-backfill",
  }, undefined, {
    allowLocked: true,
    skipValidation: !valid,
    legacy: provenance,
  });
  const releaseId = String(release.id);
  if (valid) {
    await db.query("SELECT id FROM clients WHERE id = $1 FOR SHARE", [client.id]);
    const lockedPointer = await db.query<{ current_release_id: string | null }>(
      "SELECT current_release_id FROM paywall_environment_bindings WHERE id = $1 FOR UPDATE",
      [bindingId]
    );
    const previousReleaseId = lockedPointer.rows[0]?.current_release_id ?? null;
    const pointerUpdate = await db.query(
      `UPDATE paywall_environment_bindings
          SET current_release_id = $2, updated_at = now()
        WHERE id = $1
          AND current_release_id IS DISTINCT FROM $2
          AND (
            current_release_id IS NULL
            OR 'backfill' = (
              SELECT audit.action FROM config_audit_log audit
               WHERE audit.client_id = paywall_environment_bindings.client_id
                 AND audit.entity_type = 'paywall'
                 AND audit.entity_id = paywall_environment_bindings.paywall_id
                 AND audit.action IN ('backfill', 'publish', 'rollback')
                 AND audit.to_pointer_id IS NOT DISTINCT FROM paywall_environment_bindings.current_release_id
               ORDER BY audit.id DESC
               LIMIT 1
            )
          )
        RETURNING current_release_id`,
      [bindingId, releaseId]
    );
    if (pointerUpdate.rowCount) await db.query(
      `INSERT INTO config_audit_log (
         project_key, client_id, entity_type, entity_id, action,
         from_pointer_id, to_pointer_id, actor, metadata
       )
       VALUES ($1,$2,'paywall',$3,'backfill',$4,$5,'legacy-backfill',$6)`,
      [
        client.project_key,
        client.id,
        paywall.id,
        previousReleaseId,
        releaseId,
        JSON.stringify({ legacy_spec_id: legacyId }),
      ]
    );
  }
  return { bindingId, paywallId: paywall.id, releaseId, valid, legacyStatus: "active" };
}

function legacyProvenance(spec: LegacySpecRow) {
  return buildLegacyProvenance({
    id: spec.id,
    name: spec.name,
    status: spec.status,
    version: spec.version,
    updatedAt: spec.updated_at,
    spec: withBackfillBaseUrl(spec.spec),
  });
}

function buildLegacyProvenance(input: {
  id: string;
  name: string;
  status: string;
  version: number;
  updatedAt: string;
  spec: JsonRecord;
}) {
  const fingerprint = sha256(stableJson({
    id: input.id,
    name: input.name,
    status: input.status,
    version: input.version,
    updated_at: input.updatedAt,
    spec: input.spec,
  }));
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    version: input.version,
    updatedAt: input.updatedAt,
    fingerprint,
  };
}

function logicalPaywallKey(projectKey: string, spec: LegacySpecRow): string {
  if (spec.status === "archived" && /probe/i.test(spec.name)) return `legacy-${spec.id}`;
  if (projectKey === "hiastro") {
    const normalized = spec.name
      .replace(/^Response_+/i, "")
      .replace(/^HiAstro[ _-]*/i, "")
      .trim();
    const key = slug(normalized);
    if (key === "marriage-02") return "trial-reminder";
    if (key === "marriage-03") return "marriage";
    return key || `legacy-${spec.id}`;
  }

  const name = spec.name.toLowerCase();
  if (name.includes("3-day free trial")) return "3-day-free-trial";
  if (name.includes("annual pro")) return "annual-pro";
  if (name.includes("intro offer")) return "intro-offer";
  if (name.includes("inpass original")) return "inpass-original";
  if (name.includes("grow_followers") || name.includes("grow your followers") || name.includes("production paywall 1")) {
    return "grow-followers";
  }
  if (name.includes("autodm") || name.includes("stay active in every dm") || name.includes("production paywall 2")) {
    return "autodm-pro";
  }
  return `legacy-${spec.id}`;
}

function withBackfillBaseUrl(spec: JsonRecord): JsonRecord {
  const copy = structuredClone(spec);
  const document = copy.document;
  if (!document || typeof document !== "object" || typeof document.html !== "string") return copy;
  // The legacy resolver always supplied the API origin as baseUrl. Persist it
  // explicitly so the immutable V2 payload preserves those exact semantics.
  if (!document.baseUrl) {
    document.baseUrl = configuredPublicApiBaseUrl();
  }
  return copy;
}

async function recordInlineMismatches(db: DbExecutor, clients: Map<string, ClientRow>) {
  const result = await db.query<{
    client_id: string;
    entity_type: "placement" | "variant";
    entity_id: string;
    spec_id: string;
  }>(
    `SELECT p.client_id, 'placement'::text AS entity_type, p.id AS entity_id, p.default_spec_id AS spec_id
       FROM placements p JOIN paywall_specs ps ON ps.id = p.default_spec_id
      WHERE p.default_spec_id IS NOT NULL AND p.spec IS DISTINCT FROM ps.spec
     UNION ALL
     SELECT p.client_id, 'variant'::text, pv.id, pv.spec_id
       FROM placement_variants pv
       JOIN placements p ON p.id = pv.placement_id
       JOIN paywall_specs ps ON ps.id = pv.spec_id
      WHERE pv.spec_id IS NOT NULL AND pv.spec IS DISTINCT FROM ps.spec`
  );
  for (const mismatch of result.rows) {
    await insertMigrationAudit(db, clients.get(mismatch.client_id)!, "inline_mismatch", mismatch);
  }
}

async function captureEventSnapshot(db: DbExecutor) {
  const result = await db.query<{
    public_key: string;
    count: string;
    max_id: string | null;
  }>(
    `SELECT public_key, COUNT(*)::text AS count, MAX(id)::text AS max_id
       FROM events GROUP BY public_key`
  );
  return new Map(result.rows.map((row) => [row.public_key, row]));
}

async function verifyEventSnapshot(
  db: DbExecutor,
  snapshot: Map<string, { public_key: string; count: string; max_id: string | null }>
) {
  for (const [publicKey, before] of snapshot) {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events
        WHERE public_key = $1 AND ($2::bigint IS NULL OR id <= $2::bigint)`,
      [publicKey, before.max_id]
    );
    if (result.rows[0].count !== before.count) {
      throw new Error(`Event invariant failed for ${publicKey}: ${result.rows[0].count} != ${before.count}`);
    }
  }
}

async function insertMigrationAudit(db: DbExecutor, client: ClientRow, action: string, metadata: unknown) {
  const encoded = JSON.stringify(metadata);
  await db.query(
    `INSERT INTO config_audit_log (
       project_key, client_id, entity_type, entity_id, action, actor, metadata
     )
     SELECT $1,$2,'migration',$2,$3,'legacy-backfill',$4
      WHERE NOT EXISTS (
        SELECT 1 FROM config_audit_log
         WHERE client_id = $2
           AND entity_type = 'migration'
           AND action = $3
           AND metadata = $4::jsonb
      )`,
    [client.project_key, client.id, action, encoded]
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) || []), item]);
  return groups;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  backfillPaywallPublishingV2()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .then(() => pool.end())
    .catch((error) => {
      console.error("[Tranzmit] V2 backfill failed:", error);
      pool.end().finally(() => process.exit(1));
    });
}

export const __private = {
  logicalPaywallKey,
  referencedSpecPriority,
  withBackfillBaseUrl,
};
