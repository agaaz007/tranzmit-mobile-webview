import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database (TEST_DATABASE_URL). Both tests use
// their own throwaway schemas, so they never race the other integration files
// that truncate the public schema. The first upgrades a schema from 007 to 008;
// the second migrates a schema 001-008 and points the application pool at it
// (via search_path) to drive the admin write path and the resolver.

const connectionString = process.env.TEST_DATABASE_URL;
process.env.PUBLIC_API_BASE_URL ||= "https://api.example.test";
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const e2eSchema = `fixed_split_e2e_${randomUUID().replaceAll("-", "")}`;
const e2eConnectionString = connectionString ? withSearchPath(connectionString, e2eSchema) : undefined;
// The application pool (src/db.js) is created on first import, which only
// happens inside the end-to-end test below.
if (e2eConnectionString) process.env.DATABASE_URL = e2eConnectionString;
const through007 = [
  "001_initial.sql",
  "002_variant_identity.sql",
  "003_client_statsig_projects.sql",
  "004_paywall_specs.sql",
  "005_optional_statsig.sql",
  "006_client_sdk_stack.sql",
  "007_paywall_publishing_v2.sql",
];
const fixedSplitMigration = "008_fixed_split_assignment.sql";

describe.runIf(Boolean(connectionString))("fixed-split assignment on PostgreSQL", () => {
  let rootDatabase: pg.Pool;
  let applicationPool: pg.Pool | undefined;
  let e2eDatabase: pg.Pool | undefined;

  beforeAll(() => {
    rootDatabase = new pg.Pool({ connectionString, max: 2 });
  });

  afterAll(async () => {
    await applicationPool?.end();
    await e2eDatabase?.end();
    await rootDatabase.query(`DROP SCHEMA IF EXISTS "${e2eSchema}" CASCADE`);
    await rootDatabase.end();
  });

  it("upgrades existing 007 revisions to statsig mode idempotently and enforces the new constraints", async () => {
    const schema = `fixed_split_${randomUUID().replaceAll("-", "")}`;
    const client = await rootDatabase.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      for (const file of through007) await client.query(await migrationSql(file));

      await client.query(
        `INSERT INTO clients (id, public_key, secret_key, name, project_key, environment_kind,
                              management_status, config_source, sdk_stack)
         VALUES ('hi-live','pk_live_fs','sk','HiAstro live','hiastro','live','editable','legacy','react_native')`
      );
      await client.query(
        `INSERT INTO paywalls (id, project_key, paywall_key, display_name)
         VALUES ('pw','hiastro','upgrade','Upgrade')`
      );
      await client.query(
        `INSERT INTO paywall_environment_bindings (id, client_id, project_key, paywall_id)
         VALUES ('bind','hi-live','hiastro','pw')`
      );
      await client.query(
        `INSERT INTO placements (id, public_key, client_id, project_key, trigger, enabled, status,
                                 variant_id, spec, targeting_rules)
         VALUES ('pl','pk_live_fs','hi-live','hiastro','upgrade_pro',false,'paused',NULL,NULL,'[]'::jsonb)`
      );
      await client.query(
        `INSERT INTO placement_revisions (id, placement_id, client_id, project_key, revision_number,
                                          status, default_binding_id, default_variant_key,
                                          statsig_experiment_id, targeting_rules)
         VALUES ('rev-old','pl','hi-live','hiastro',1,'active','bind','control','paywall_intent_marriage',
                 '[{"type":"baseline","statsig_experiment_id":"hiastro_baseline"}]'::jsonb)`
      );
      await client.query(
        `INSERT INTO placement_revision_variants (id, placement_revision_id, placement_id, client_id,
                                                  project_key, variant_key, binding_id, status, weight)
         VALUES ('prv-old','rev-old','pl','hi-live','hiastro','control','bind','active',100)`
      );
      const before = (await client.query(
        "SELECT to_jsonb(pr) AS row FROM placement_revisions pr WHERE id = 'rev-old'"
      )).rows[0].row;

      await client.query(await migrationSql(fixedSplitMigration));
      // Idempotent: the file can be applied again without error or change.
      await client.query(await migrationSql(fixedSplitMigration));

      const after = (await client.query(
        "SELECT to_jsonb(pr) AS row FROM placement_revisions pr WHERE id = 'rev-old'"
      )).rows[0].row;
      expect(after).toEqual({ ...before, assignment_mode: "statsig", holdout_percent: 0, assignment_salt: null });
      expect((await client.query(
        "SELECT eligibility FROM placement_revision_variants WHERE id = 'prv-old'"
      )).rows).toEqual([{ eligibility: null }]);

      // Revisions stay append-only after the new columns land.
      await expect(client.query(
        "UPDATE placement_revisions SET assignment_mode = 'fixed_split' WHERE id = 'rev-old'"
      )).rejects.toMatchObject({ code: "55000" });

      const insertRevision = (id: number, columns: string) => client.query(
        `INSERT INTO placement_revisions (placement_id, client_id, project_key, revision_number, status,
                                          default_binding_id, default_variant_key, assignment_mode,
                                          holdout_percent, assignment_salt)
         VALUES ('pl','hi-live','hiastro',${id},'active','bind','control',${columns})`
      );
      await expect(insertRevision(2, "'bandit', 0, NULL")).rejects.toMatchObject({ code: "23514" });
      await expect(insertRevision(3, "'fixed_split', 50.01, NULL")).rejects.toMatchObject({ code: "23514" });
      await expect(insertRevision(4, "'fixed_split', -1, NULL")).rejects.toMatchObject({ code: "23514" });
      await expect(insertRevision(5, "'statsig', 10, NULL")).rejects.toMatchObject({ code: "23514" });
      await expect(insertRevision(6, "'statsig', 0, 'salt'")).rejects.toMatchObject({ code: "23514" });
      await expect(insertRevision(7, "'fixed_split', 10, 'has space'")).rejects.toMatchObject({ code: "23514" });
      await insertRevision(8, "'fixed_split', 12.5, 'marriage-exp-2026-09'");
      await expect(client.query(
        `INSERT INTO placement_revision_variants (placement_revision_id, placement_id, client_id,
                                                  project_key, variant_key, binding_id, weight, eligibility)
         SELECT id, 'pl', 'hi-live', 'hiastro', 'v', 'bind', 1, '["marriage"]'::jsonb
           FROM placement_revisions WHERE revision_number = 8`
      )).rejects.toMatchObject({ code: "23514" });

      const constraints = (await client.query(
        `SELECT conname, convalidated FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = $1 AND conname IN (
            'placement_revisions_assignment_mode_check',
            'placement_revisions_holdout_percent_check',
            'placement_revisions_assignment_salt_check',
            'placement_revision_variants_eligibility_check')
          ORDER BY conname`,
        [schema]
      )).rows;
      expect(constraints).toEqual([
        { conname: "placement_revision_variants_eligibility_check", convalidated: true },
        { conname: "placement_revisions_assignment_mode_check", convalidated: true },
        { conname: "placement_revisions_assignment_salt_check", convalidated: true },
        { conname: "placement_revisions_holdout_percent_check", convalidated: true },
      ]);
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  });

  it("creates, publishes and serves a fixed-split revision through the application code", async () => {
    await rootDatabase.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await rootDatabase.query(`CREATE SCHEMA "${e2eSchema}"`);
    e2eDatabase = new pg.Pool({ connectionString: e2eConnectionString, max: 2 });
    const migrator = await e2eDatabase.connect();
    try {
      for (const file of [...through007, fixedSplitMigration]) await migrator.query(await migrationSql(file));
    } finally {
      migrator.release();
    }
    const database = e2eDatabase;
    expect((await database.query("SELECT current_schema() AS schema")).rows[0].schema).toBe(e2eSchema);
    await database.query(
      `INSERT INTO clients (id, public_key, secret_key, name, project_key, environment_kind,
                            management_status, config_source, sdk_stack)
       VALUES ('hi-test','pk_test_fs','sk','HiAstro test','hiastro','test','editable','legacy','react_native')`
    );
    for (const key of ["control", "marriage-02", "marriage-03"]) {
      await seedPublishedPaywall(database, key);
    }
    await database.query(
      `INSERT INTO placements (id, public_key, client_id, project_key, trigger, enabled, status,
                               variant_id, spec, targeting_rules)
       VALUES ('pl-upgrade','pk_test_fs','hi-test','hiastro','upgrade_pro',false,'paused',NULL,NULL,'[]'::jsonb)`
    );

    const { createPlacementRevision, publishPlacementRevision } = await import("../src/config-publish.js");
    const { getV2PublishedRouting } = await import("../src/config-store.js");
    const { resolveConfigPlacements } = await import("../src/config-resolver.js");
    applicationPool = (await import("../src/db.js")).pool;

    await expect(createPlacementRevision("pl-upgrade", {
      status: "active",
      defaultBindingId: "bind-control",
      defaultVariantKey: "control",
      assignmentMode: "fixed_split",
      holdoutPercent: 60,
      variants: [{ variantKey: "control", bindingId: "bind-control", weight: 1 }],
    })).rejects.toMatchObject({ status: 422 });

    const revision = await createPlacementRevision("pl-upgrade", {
      status: "active",
      defaultBindingId: "bind-control",
      defaultVariantKey: "control",
      assignmentMode: "fixed_split",
      holdoutPercent: 10,
      assignmentSalt: "marriage-exp-2026-09",
      createdBy: "integration",
      variants: [
        { variantKey: "control", bindingId: "bind-control", weight: 50 },
        { variantKey: "marriage-02", bindingId: "bind-marriage-02", weight: 25, eligibility: { intent: ["marriage"] } },
        { variantKey: "marriage-03", bindingId: "bind-marriage-03", weight: 25, eligibility: { intent: ["marriage"] } },
      ],
    });
    expect(revision).toMatchObject({ assignment_mode: "fixed_split", holdout_percent: "10.00", assignment_salt: "marriage-exp-2026-09" });
    await publishPlacementRevision({
      placementId: "pl-upgrade",
      revisionId: String(revision.id),
      expectedCurrentRevisionId: null,
      actor: "integration",
    });
    await database.query("UPDATE clients SET config_source = 'v2' WHERE id = 'hi-test'");

    const [routing] = await getV2PublishedRouting("hi-test");
    expect(routing).toMatchObject({
      revisionId: revision.id,
      assignmentMode: "fixed_split",
      holdoutPercent: 10,
      assignmentSalt: "marriage-exp-2026-09",
    });
    expect(routing.variants.map((variant) => [variant.variantId, variant.weight, variant.eligibility])).toEqual([
      ["control", 50, null],
      ["marriage-02", 25, { intent: ["marriage"] }],
      ["marriage-03", 25, { intent: ["marriage"] }],
    ]);

    const counts = new Map<string, number>();
    let holdouts = 0;
    const population = 2000;
    for (let index = 0; index < population; index += 1) {
      const resolved = await resolveConfigPlacements({
        publicKey: "pk_test_fs",
        identity: {
          userId: `user-${index}`,
          identifiers: {},
          traits: { intent: "marriage" },
          privateTraits: {},
          storageUserId: `user-${index}`,
        },
        apiBaseUrl: "https://api.example.test",
        includeInline: false,
      });
      const stamp = resolved.assignments[0]!;
      expect(resolved.placements.upgrade_pro?.variantId).toBe(stamp.chosen);
      expect(stamp.served).toBe(true);
      if (stamp.is_holdout) {
        holdouts += 1;
        expect(stamp.chosen).toBe("control");
        continue;
      }
      expect(stamp.candidates.map((candidate) => candidate.probability)).toEqual([0.5, 0.25, 0.25]);
      counts.set(stamp.chosen, (counts.get(stamp.chosen) || 0) + 1);
    }
    expect(Math.abs(holdouts / population - 0.1)).toBeLessThan(0.03);
    const randomized = population - holdouts;
    expect(Math.abs((counts.get("control") || 0) / randomized - 0.5)).toBeLessThan(0.04);
    expect(Math.abs((counts.get("marriage-02") || 0) / randomized - 0.25)).toBeLessThan(0.04);
    expect(Math.abs((counts.get("marriage-03") || 0) / randomized - 0.25)).toBeLessThan(0.04);

    // A fixed_split revision written outside the API with no positive weight cannot be published.
    await database.query(
      `INSERT INTO placement_revisions (id, placement_id, client_id, project_key, revision_number, status,
                                        default_binding_id, default_variant_key, assignment_mode)
       VALUES ('rev-zero','pl-upgrade','hi-test','hiastro',99,'active','bind-control','control','fixed_split')`
    );
    await database.query(
      `INSERT INTO placement_revision_variants (placement_revision_id, placement_id, client_id, project_key,
                                                variant_key, binding_id, weight)
       VALUES ('rev-zero','pl-upgrade','hi-test','hiastro','control','bind-control',0)`
    );
    await expect(publishPlacementRevision({
      placementId: "pl-upgrade",
      revisionId: "rev-zero",
      expectedCurrentRevisionId: String(revision.id),
      actor: "integration",
    })).rejects.toMatchObject({ status: 422 });
  }, 60_000);
});

function withSearchPath(url: string, schema: string): string {
  const options = encodeURIComponent(`-c search_path=${schema},public`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

async function migrationSql(file: string): Promise<string> {
  return readFile(resolve(migrationsDirectory, file), "utf8");
}

async function seedPublishedPaywall(database: pg.Pool, key: string): Promise<void> {
  const html = `<main><h1>{{headline}}</h1><p>${key}</p></main>`;
  const content = {
    renderer: "webview",
    document: { html },
    localization: { defaultLocale: "en", translations: { en: { headline: key } } },
    cta: { text: "Continue" },
    dismiss: { enabled: true },
  };
  const payload = { html, cacheKey: `fixture:${key}`, revision: `doc-${key}`, integrity: `sha256-${key}` };
  await database.query(
    `INSERT INTO paywalls (id, project_key, paywall_key, display_name) VALUES ($1,'hiastro',$2,$2)`,
    [`pw-${key}`, key]
  );
  await database.query(
    `INSERT INTO paywall_content_revisions (
       id, paywall_id, project_key, revision_number, content, content_hash, document_cache_key,
       document_revision, document_hash, document_payload, document_integrity, created_by
     ) VALUES ($1,$2,'hiastro',1,$3::jsonb,$4,$5,$6,$7,$8::jsonb,$9,'fixture')`,
    [`content-${key}`, `pw-${key}`, JSON.stringify(content), `content-${key}`, payload.cacheKey,
      payload.revision, `document-${key}`, JSON.stringify(payload), payload.integrity]
  );
  await database.query(
    `INSERT INTO paywall_environment_bindings (id, client_id, project_key, paywall_id)
     VALUES ($1,'hi-test','hiastro',$2)`,
    [`bind-${key}`, `pw-${key}`]
  );
  await database.query(
    `INSERT INTO paywall_environment_releases (
       id, binding_id, client_id, project_key, paywall_id, release_number, content_revision_id, products, created_by
     ) VALUES ($1,$2,'hi-test','hiastro',$3,1,$4,$5::jsonb,'fixture')`,
    [`release-${key}`, `bind-${key}`, `pw-${key}`, `content-${key}`,
      JSON.stringify([{ id: "pro_yearly", name: "Pro", price: "₹999" }])]
  );
  await database.query(
    "UPDATE paywall_environment_bindings SET current_release_id = $1 WHERE id = $2",
    [`release-${key}`, `bind-${key}`]
  );
}
