import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const legacyMigrations = [
  "001_initial.sql",
  "002_variant_identity.sql",
  "003_client_statsig_projects.sql",
  "004_paywall_specs.sql",
  "005_optional_statsig.sql",
  "006_client_sdk_stack.sql",
] as const;
const v2Migration = "007_paywall_publishing_v2.sql";
const allMigrations = [...legacyMigrations, v2Migration] as const;

describe.runIf(Boolean(connectionString))("Paywall Publishing V2 production upgrade", () => {
  const schemaName = `v2_upgrade_${randomUUID().replaceAll("-", "")}`;
  const quotedSchemaName = quoteIdentifier(schemaName);
  let database: pg.Client;

  beforeAll(async () => {
    database = new pg.Client({ connectionString });
    await database.connect();

    // The production migrations require pgcrypto. Keep the extension in the
    // shared public schema and every fixture table in a unique disposable
    // schema so this test cannot modify existing application rows.
    await database.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await database.query(`CREATE SCHEMA ${quotedSchemaName}`);
    await database.query(`SET search_path TO ${quotedSchemaName}, public`);
  });

  afterAll(async () => {
    if (!database) return;
    await database.query("RESET search_path");
    await database.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
    await database.end();
  });

  it("upgrades populated 001-006 data without loss and is idempotent", async () => {
    expect(await applyPendingMigrations(database, legacyMigrations)).toEqual(legacyMigrations);
    await seedLegacyProductionShape(database);

    const beforeUpgrade = await legacySnapshot(database);
    expect(beforeUpgrade).toMatchObject({
      clients: { length: 4 },
      paywallSpecs: { length: 4 },
      placements: { length: 4 },
      placementVariants: { length: 4 },
      events: { length: 5 },
    });

    expect(await applyPendingMigrations(database, allMigrations)).toEqual([v2Migration]);
    expect(await legacySnapshot(database)).toEqual(beforeUpgrade);

    expect((await database.query(
      `SELECT id, project_key, environment_kind, management_status, config_source
         FROM clients
        ORDER BY id`
    )).rows).toEqual([
      {
        id: "hi-live",
        project_key: "hiastro",
        environment_kind: "live",
        management_status: "editable",
        config_source: "legacy",
      },
      {
        id: "hi-test",
        project_key: "hiastro",
        environment_kind: "test",
        management_status: "editable",
        config_source: "legacy",
      },
      {
        id: "in-live",
        project_key: "influish",
        environment_kind: "live",
        management_status: "legacy_locked",
        config_source: "legacy",
      },
      {
        id: "in-test",
        project_key: "influish",
        environment_kind: "test",
        management_status: "legacy_locked",
        config_source: "legacy",
      },
    ]);

    expect((await database.query(
      `SELECT id, client_id, project_key, current_revision_id
         FROM placements
        ORDER BY id`
    )).rows).toEqual([
      { id: "placement-hi-live", client_id: "hi-live", project_key: "hiastro", current_revision_id: null },
      { id: "placement-hi-test", client_id: "hi-test", project_key: "hiastro", current_revision_id: null },
      { id: "placement-in-live", client_id: "in-live", project_key: "influish", current_revision_id: null },
      { id: "placement-in-test", client_id: "in-test", project_key: "influish", current_revision_id: null },
    ]);

    await expect(database.query(
      "UPDATE clients SET environment_kind = 'staging' WHERE id = 'hi-test'"
    )).rejects.toMatchObject({ code: "23514" });

    await database.query(
      `INSERT INTO paywalls (id, project_key, paywall_key, display_name)
       VALUES ('fk-probe','influish','fk-probe','FK probe')`
    );
    await expect(database.query(
      `INSERT INTO paywall_environment_bindings (id, client_id, project_key, paywall_id)
       VALUES ('cross-project-binding','hi-live','influish','fk-probe')`
    )).rejects.toMatchObject({ code: "23503" });

    const requiredConstraints = [
      ["clients_config_source_check", "c"],
      ["clients_environment_kind_check", "c"],
      ["clients_management_status_check", "c"],
      ["paywall_environment_bindings_client_fk", "f"],
      ["paywall_environment_bindings_current_release_fk", "f"],
      ["paywall_environment_bindings_paywall_fk", "f"],
      ["placements_client_project_fk", "f"],
      ["placements_current_revision_fk", "f"],
      ["placements_public_client_project_fk", "f"],
    ];
    expect((await database.query(
      `SELECT constraint_name AS name, constraint_type AS type, validated
         FROM (
           SELECT c.conname AS constraint_name,
                  c.contype::text AS constraint_type,
                  c.convalidated AS validated
             FROM pg_constraint c
             JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE n.nspname = $1
              AND c.conname = ANY($2::text[])
         ) constraints
        ORDER BY name`,
      [schemaName, requiredConstraints.map(([name]) => name)]
    )).rows).toEqual(requiredConstraints.map(([name, type]) => ({
      name,
      type,
      validated: true,
    })));

    await database.query("UPDATE clients SET config_source = 'v2' WHERE id = 'hi-live'");
    await expect(database.query(
      "UPDATE paywall_specs SET name = 'mutated' WHERE id = 'spec-hi-live'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE placements SET trigger = 'mutated' WHERE id = 'placement-hi-live'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE placement_variants SET weight = 40 WHERE id = 'variant-hi-live'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE paywall_specs SET name = 'mutated' WHERE id = 'spec-in-live'"
    )).rejects.toMatchObject({ code: "55000" });

    const afterFirstRun = await postUpgradeSnapshot(database);
    expect(await applyPendingMigrations(database, allMigrations)).toEqual([]);
    expect(await postUpgradeSnapshot(database)).toEqual(afterFirstRun);
    expect((await database.query(
      "SELECT id FROM schema_migrations ORDER BY id"
    )).rows.map((row) => row.id)).toEqual(allMigrations);
  });
});

async function applyPendingMigrations(
  database: pg.Client,
  migrationFiles: readonly string[]
): Promise<string[]> {
  const applied: string[] = [];
  await database.query("BEGIN");
  try {
    await database.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    for (const migrationFile of migrationFiles) {
      const existing = await database.query(
        "SELECT 1 FROM schema_migrations WHERE id = $1",
        [migrationFile]
      );
      if (existing.rowCount) continue;

      await database.query(await readFile(resolve(migrationsDirectory, migrationFile), "utf8"));
      await database.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migrationFile]);
      applied.push(migrationFile);
    }
    await database.query("COMMIT");
    return applied;
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

async function seedLegacyProductionShape(database: pg.Client): Promise<void> {
  const clients = [
    ["hi-live", "pk_live_upgrade_hi", "Hiastro-production", "sk-hi-live"],
    ["hi-test", "pk_test_upgrade_hi", "hiastro-tesitng", "sk-hi-test"],
    ["in-live", "pk_live_upgrade_in", "Influish Production", "sk-in-live"],
    ["in-test", "pk_test_upgrade_in", "Influish Demo", "sk-in-test"],
  ] as const;

  await database.query("BEGIN");
  try {
    for (const [index, [id, publicKey, name, secretKey]] of clients.entries()) {
      const createdAt = `2026-08-20T10:0${index}:00.000Z`;
      const spec = fixtureSpec(`${name} paywall`);
      await database.query(
        `INSERT INTO clients (
           id, public_key, name, created_at, statsig_project_name,
           statsig_server_secret_env_var, secret_key, updated_at, sdk_stack
         ) VALUES ($1,$2,$3,$4,NULL,NULL,$5,$4,'react_native')`,
        [id, publicKey, name, createdAt, secretKey]
      );
      await database.query(
        `INSERT INTO paywall_specs (
           id, workspace_id, name, spec, status, version,
           created_at, updated_at, created_by
         ) VALUES ($1,$2,$3,$4::jsonb,'active',1,$5,$5,'upgrade-fixture')`,
        [`spec-${id}`, id, `${name} spec`, JSON.stringify(spec), createdAt]
      );
      await database.query(
        `INSERT INTO placements (
           id, public_key, trigger, enabled, variant_id, experiment_id, spec,
           created_at, status, default_spec_id, statsig_experiment_id,
           targeting_rules, updated_at
         ) VALUES ($1,$2,'upgrade_pro',true,'control',NULL,$3::jsonb,$4,
                   'active',$5,NULL,'[]'::jsonb,$4)`,
        [`placement-${id}`, publicKey, JSON.stringify(spec), createdAt, `spec-${id}`]
      );
      await database.query(
        `INSERT INTO placement_variants (
           id, placement_id, variant_id, enabled, fallback_rank, spec,
           created_at, variant_key, spec_id, weight, status
         ) VALUES ($1,$2,'control',true,0,$3::jsonb,$4,'control',$5,100,'active')`,
        [`variant-${id}`, `placement-${id}`, JSON.stringify(spec), createdAt, `spec-${id}`]
      );
      await database.query(
        `INSERT INTO events (
           public_key, user_id, session_id, event_name, properties, created_at, identity
         ) VALUES ($1,$2,$3,'impression',$4::jsonb,$5,$6::jsonb)`,
        [
          publicKey,
          `user-${id}`,
          `session-${id}`,
          JSON.stringify({ trigger: "upgrade_pro", variant_id: "control" }),
          createdAt,
          JSON.stringify({ stableID: `stable-${id}` }),
        ]
      );
    }

    await database.query(
      `INSERT INTO events (
         public_key, user_id, session_id, event_name, properties, created_at, identity
       ) VALUES (
         'pk_live_upgrade_hi','user-hi-live','session-hi-live','conversion',
         '{"product_id":"annual","revenue":999,"currency":"INR"}'::jsonb,
         '2026-08-20T10:10:00.000Z','{"stableID":"stable-hi-live"}'::jsonb
       )`
    );
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

async function legacySnapshot(database: pg.Client): Promise<Record<string, unknown[]>> {
  return {
    clients: (await database.query(
      `SELECT id, public_key, name, created_at::text, statsig_project_name,
              statsig_server_secret_env_var, secret_key, updated_at::text, sdk_stack
         FROM clients ORDER BY id`
    )).rows,
    paywallSpecs: (await database.query(
      `SELECT id, workspace_id, name, spec::text, status, version,
              created_at::text, updated_at::text, created_by
         FROM paywall_specs ORDER BY id`
    )).rows,
    placements: (await database.query(
      `SELECT id, public_key, trigger, enabled, variant_id, experiment_id,
              spec::text, created_at::text, status, default_spec_id,
              statsig_experiment_id, targeting_rules::text, updated_at::text
         FROM placements ORDER BY id`
    )).rows,
    placementVariants: (await database.query(
      `SELECT id, placement_id, variant_id, enabled, fallback_rank, spec::text,
              created_at::text, variant_key, spec_id, weight, status
         FROM placement_variants ORDER BY id`
    )).rows,
    events: (await database.query(
      `SELECT id::text, public_key, user_id, session_id, event_name,
              properties::text, created_at::text, identity::text
         FROM events ORDER BY id`
    )).rows,
  };
}

async function postUpgradeSnapshot(database: pg.Client): Promise<Record<string, unknown[]>> {
  return {
    migrations: (await database.query(
      "SELECT id, applied_at::text FROM schema_migrations ORDER BY id"
    )).rows,
    clients: (await database.query(
      `SELECT id, project_key, environment_kind, management_status, config_source
         FROM clients ORDER BY id`
    )).rows,
    placements: (await database.query(
      "SELECT id, client_id, project_key, current_revision_id FROM placements ORDER BY id"
    )).rows,
    v2Counts: (await database.query(
      `SELECT
         (SELECT count(*)::text FROM paywalls) AS paywalls,
         (SELECT count(*)::text FROM paywall_content_revisions) AS content_revisions,
         (SELECT count(*)::text FROM paywall_environment_bindings) AS bindings,
         (SELECT count(*)::text FROM paywall_environment_releases) AS releases,
         (SELECT count(*)::text FROM placement_revisions) AS placement_revisions,
         (SELECT count(*)::text FROM placement_revision_variants) AS routing_variants,
         (SELECT count(*)::text FROM config_audit_log) AS audit_rows`
    )).rows,
    legacy: [await legacySnapshot(database)],
  };
}

function fixtureSpec(headline: string): Record<string, unknown> {
  return {
    renderer: "webview",
    products: [{ id: "annual", name: "Annual", price: "₹999" }],
    document: {
      html: "<!doctype html><html><body><h1>{{headline}}</h1></body></html>",
      revision: "upgrade-fixture-v1",
    },
    localization: {
      defaultLocale: "en",
      translations: { en: { headline } },
    },
  };
}

function quoteIdentifier(value: string): string {
  if (!/^v2_upgrade_[a-f0-9]{32}$/.test(value)) {
    throw new Error("Unsafe PostgreSQL fixture schema name");
  }
  return `"${value}"`;
}
