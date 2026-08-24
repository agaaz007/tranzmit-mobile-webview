import pg from "pg";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
process.env.PUBLIC_API_BASE_URL ||= "https://api.example.test";

describe.runIf(Boolean(connectionString))("Paywall Publishing V2 PostgreSQL invariants", () => {
  let database: pg.Pool;
  let applicationPool: pg.Pool | undefined;

  beforeAll(() => {
    database = new pg.Pool({ connectionString, max: 2 });
  });

  afterAll(async () => {
    await applicationPool?.end();
    await database.end();
  });

  it("enforces project/environment ownership, immutable records, and legacy freeze", async () => {
    await resetDatabase(database);
    await seedClients(database, [
      ["hi-test", "pk_test_hi", "Hi test", "hiastro", "test"],
      ["hi-live", "pk_live_hi", "Hi live", "hiastro", "live"],
      ["in-test", "pk_test_in", "Influish test", "influish", "test"],
    ]);

    await database.query(
      `INSERT INTO paywalls (id, project_key, paywall_key, display_name)
       VALUES ('pw-hi','hiastro','trial-reminder','Trial reminder'),
              ('pw-in','influish','intro-offer','Intro offer')`
    );
    await database.query(
      `INSERT INTO paywall_environment_bindings (id, client_id, project_key, paywall_id)
       VALUES ('bind-hi-test','hi-test','hiastro','pw-hi'),
              ('bind-hi-live','hi-live','hiastro','pw-hi'),
              ('bind-in-test','in-test','influish','pw-in')`
    );
    await insertContent(database, "content-hi", "pw-hi", "hiastro", 1, "hi");
    await insertContent(database, "content-in", "pw-in", "influish", 1, "in");
    await insertRelease(database, "release-hi-test", "bind-hi-test", "hi-test", "hiastro", "pw-hi", "content-hi");

    await expect(database.query(
      `INSERT INTO paywall_environment_releases (
         id, binding_id, client_id, project_key, paywall_id, release_number,
         content_revision_id, products, created_by
       ) VALUES ('release-cross-project','bind-hi-test','hi-test','hiastro','pw-hi',2,
                 'content-in','[]'::jsonb,'test')`
    )).rejects.toMatchObject({ code: "23503" });

    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, spec, targeting_rules
       ) VALUES ('placement-hi','pk_test_hi','hi-test','hiastro','upgrade_pro',false,
                 'paused',NULL,NULL,'[]'::jsonb)`
    );
    await expect(database.query(
      `INSERT INTO placement_revisions (
         id, placement_id, client_id, project_key, revision_number, status,
         default_binding_id, default_variant_key, targeting_rules
       ) VALUES ('routing-cross-env','placement-hi','hi-test','hiastro',1,'active',
                 'bind-hi-live','control','[]'::jsonb)`
    )).rejects.toMatchObject({ code: "23503" });

    await database.query(
      `INSERT INTO placement_revisions (
         id, placement_id, client_id, project_key, revision_number, status,
         default_binding_id, default_variant_key, targeting_rules
       ) VALUES ('routing-hi','placement-hi','hi-test','hiastro',1,'active',
                 'bind-hi-test','control','[]'::jsonb)`
    );
    await expect(database.query(
      `INSERT INTO placement_revision_variants (
         placement_revision_id, placement_id, client_id, project_key,
         variant_key, binding_id, status, weight, fallback_rank
       ) VALUES ('routing-hi','placement-hi','hi-test','hiastro','control',
                 'bind-hi-live','active',100,0)`
    )).rejects.toMatchObject({ code: "23503" });

    await expect(database.query(
      "UPDATE paywall_content_revisions SET content = '{}'::jsonb WHERE id = 'content-hi'"
    )).rejects.toMatchObject({ code: "55000" });

    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status)
       VALUES ('legacy-spec','hi-test','Legacy', $1::jsonb, 'active')`,
      [JSON.stringify(validSpec("Legacy"))]
    );
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status)
       VALUES ('legacy-spec-in','in-test','Movable', $1::jsonb, 'active')`,
      [JSON.stringify(validSpec("Movable"))]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules
       ) VALUES ('placement-in','pk_test_in','in-test','influish','move_probe',true,
                 'active','control','legacy-spec-in',$1::jsonb,'[]'::jsonb)`,
      [JSON.stringify(validSpec("Movable"))]
    );
    await database.query(
      `INSERT INTO placement_variants (
         id, placement_id, variant_id, variant_key, enabled, status,
         fallback_rank, weight, spec
       ) VALUES ('variant-hi','placement-hi','control','control',true,'active',0,100,$1::jsonb),
                ('variant-in','placement-in','control','control',true,'active',0,100,$2::jsonb)`,
      [JSON.stringify(validSpec("Legacy")), JSON.stringify(validSpec("Movable"))]
    );
    await database.query("UPDATE clients SET config_source = 'v2' WHERE id = 'hi-test'");
    await expect(database.query(
      "UPDATE paywall_specs SET name = 'Mutated' WHERE id = 'legacy-spec'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE placements SET trigger = 'mutated' WHERE id = 'placement-hi'"
    )).rejects.toMatchObject({ code: "55000" });

    // A frozen row cannot be made writable by moving it out of the V2 client,
    // and an editable row cannot be moved into the V2 client to bypass insert checks.
    await expect(database.query(
      "UPDATE paywall_specs SET workspace_id = 'in-test' WHERE id = 'legacy-spec'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE paywall_specs SET workspace_id = 'hi-test' WHERE id = 'legacy-spec-in'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      `UPDATE placements
          SET public_key = 'pk_test_in', client_id = 'in-test', project_key = 'influish'
        WHERE id = 'placement-hi'`
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      `UPDATE placements
          SET public_key = 'pk_test_hi', client_id = 'hi-test', project_key = 'hiastro'
        WHERE id = 'placement-in'`
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE placement_variants SET placement_id = 'placement-in' WHERE id = 'variant-hi'"
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE placement_variants SET placement_id = 'placement-hi' WHERE id = 'variant-in'"
    )).rejects.toMatchObject({ code: "55000" });

    await database.query(
      "UPDATE placements SET current_revision_id = 'routing-hi' WHERE id = 'placement-hi'"
    );
    expect((await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-hi'"
    )).rows[0].current_revision_id).toBe("routing-hi");
  });

  it("backfills all manifest environments idempotently without replacing later pointers", async () => {
    await resetDatabase(database);
    const clients = [
      ["hi-live", "pk_live_310bc7653631b8b924afbad3", "Hiastro-production", "hiastro", "live"],
      ["hi-test", "pk_test_320da03ab659ffc56d58acd2", "hiastro-tesitng", "hiastro", "test"],
      ["in-test", "pk_test_2a8a5f07d4b9fcf1cc77e024", "Influish Demo", "influish", "test"],
      ["in-live", "pk_live_a1323f76d397778b6ed5eb04", "Influish Production", "influish", "live"],
    ] as const;
    await seedClients(database, clients);

    const legacyRows = [
      ["spec-hi-02", "hi-live", "Response_marriage-02", "pk_live_310bc7653631b8b924afbad3"],
      ["spec-hi-03", "hi-test", "HiAstro marriage -03", "pk_test_320da03ab659ffc56d58acd2"],
      ["spec-in-trial", "in-test", "3-Day Free Trial", "pk_test_2a8a5f07d4b9fcf1cc77e024"],
      ["spec-in-annual", "in-live", "Annual Pro", "pk_live_a1323f76d397778b6ed5eb04"],
    ] as const;
    for (const [specId, clientId, name, publicKey] of legacyRows) {
      const spec = validSpec(name);
      await database.query(
        `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
         VALUES ($1,$2,$3,$4::jsonb,'active','fixture')`,
        [specId, clientId, name, JSON.stringify(spec)]
      );
      await database.query(
        `INSERT INTO placements (
           id, public_key, trigger, enabled, status, variant_id, default_spec_id,
           targeting_rules, spec, client_id, project_key
         ) SELECT $1,$2,'upgrade_pro',true,'active','default',$3,'[]'::jsonb,$4::jsonb,
                  id,project_key
             FROM clients WHERE id = $5`,
        [`placement-${clientId}`, publicKey, specId, JSON.stringify(spec), clientId]
      );
      await database.query(
        `INSERT INTO events (public_key, user_id, session_id, event_name, properties, identity)
         VALUES ($1,'fixture-user','fixture-session','impression','{}'::jsonb,'{}'::jsonb)`,
        [publicKey]
      );
    }

    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    applicationPool = (await import("../src/db.js")).pool;
    const first = await backfillPaywallPublishingV2();
    expect(first).toMatchObject({ clients: 4, legacy_specs: 4, placements: 4 });
    const { compareLegacyAndV2 } = await import("../src/compare-v2.js");
    const comparison = await compareLegacyAndV2();
    expect(comparison.passed, JSON.stringify(comparison.environments, null, 2)).toBe(true);
    expect((await database.query(
      "SELECT paywall_key FROM paywalls WHERE project_key = 'hiastro' ORDER BY paywall_key"
    )).rows.map((row) => row.paywall_key)).toEqual(["marriage", "trial-reminder"]);

    const binding = (await database.query<{
      binding_id: string;
      paywall_id: string;
      current_release_id: string;
    }>(
      `SELECT b.id AS binding_id, b.paywall_id, b.current_release_id
         FROM paywall_environment_bindings b
         JOIN paywalls p ON p.id = b.paywall_id
        WHERE b.client_id = 'hi-live' AND p.paywall_key = 'trial-reminder'`
    )).rows[0];
    const placement = (await database.query<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-hi-live'"
    )).rows[0];

    await database.query(
      `INSERT INTO paywall_content_revisions (
         id, paywall_id, project_key, revision_number, content, content_hash,
         document_cache_key, document_revision, document_hash, document_payload,
         document_integrity, created_by
       )
       SELECT 'manual-content', paywall_id, project_key, 2, content, 'manual-content-hash',
              'manual:doc', 'doc-manual', 'manual-document-hash',
              jsonb_set(document_payload, '{cacheKey}', '"manual:doc"'::jsonb),
              document_integrity, 'manual'
         FROM paywall_content_revisions
        WHERE paywall_id = $1 AND revision_number = 1`,
      [binding.paywall_id]
    );
    await database.query(
      `INSERT INTO paywall_environment_releases (
         id, binding_id, client_id, project_key, paywall_id, release_number,
         content_revision_id, products, checkout, created_by
       )
       SELECT 'manual-release', id, client_id, project_key, paywall_id, 2,
              'manual-content', '[{"id":"live-product"}]'::jsonb,
              '{"provider":{"live":true}}'::jsonb, 'manual'
         FROM paywall_environment_bindings WHERE id = $1`,
      [binding.binding_id]
    );
    await database.query(
      "UPDATE paywall_environment_bindings SET current_release_id = 'manual-release' WHERE id = $1",
      [binding.binding_id]
    );

    await database.query(
      `INSERT INTO placement_revisions (
         id, placement_id, client_id, project_key, revision_number, status,
         default_binding_id, default_variant_key, statsig_experiment_id,
         targeting_rules, created_by
       )
       SELECT 'manual-routing', placement_id, client_id, project_key, 2, status,
              default_binding_id, default_variant_key, statsig_experiment_id,
              targeting_rules, 'manual'
         FROM placement_revisions WHERE id = $1`,
      [placement.current_revision_id]
    );
    await database.query(
      `INSERT INTO placement_revision_variants (
         placement_revision_id, placement_id, client_id, project_key,
         variant_key, binding_id, status, weight, fallback_rank
       )
       SELECT 'manual-routing', placement_id, client_id, project_key,
              variant_key, binding_id, status, weight, fallback_rank
         FROM placement_revision_variants WHERE placement_revision_id = $1`,
      [placement.current_revision_id]
    );
    await database.query(
      "UPDATE placements SET current_revision_id = 'manual-routing' WHERE id = 'placement-hi-live'"
    );

    const beforeSecondRun = await v2Counts(database);
    await backfillPaywallPublishingV2();
    expect(await v2Counts(database)).toEqual(beforeSecondRun);
    expect((await database.query(
      "SELECT current_release_id FROM paywall_environment_bindings WHERE id = $1",
      [binding.binding_id]
    )).rows[0].current_release_id).toBe("manual-release");
    expect((await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-hi-live'"
    )).rows[0].current_revision_id).toBe("manual-routing");
    expect(Number((await database.query("SELECT COUNT(*) FROM events")).rows[0].count)).toBe(4);
  });

  it("preserves var_default through a real no-variant backfill and resolver cutover", async () => {
    await resetDatabase(database);
    await seedManifestClients(database);
    const spec = validSpec("Default fixture");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
       VALUES ('spec-no-variants','hi-live','Default fixture',$1::jsonb,'active','fixture')`,
      [JSON.stringify(spec)]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules
       ) VALUES (
         'placement-no-variants','pk_live_310bc7653631b8b924afbad3','hi-live','hiastro',
         'upgrade_pro',true,'active',NULL,'spec-no-variants',$1::jsonb,'[]'::jsonb
       )`,
      [JSON.stringify(spec)]
    );

    const { resolveConfigPlacements } = await import("../src/config-resolver.js");
    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    const { setEnvironmentConfigSource } = await import("../src/config-publish.js");
    applicationPool = (await import("../src/db.js")).pool;
    const resolveInput = {
      publicKey: "pk_live_310bc7653631b8b924afbad3",
      identity: {
        userId: "fixture-user",
        identifiers: { stableID: "fixture-stable" },
        traits: {},
      } as any,
      apiBaseUrl: "https://api.example.test",
      includeInline: false,
    };

    const legacy = await resolveConfigPlacements(resolveInput);
    expect(legacy.placements.upgrade_pro?.variantId).toBe("var_default");

    await backfillPaywallPublishingV2();
    expect((await database.query(
      `SELECT pr.default_variant_key
         FROM placements p
         JOIN placement_revisions pr ON pr.id = p.current_revision_id
        WHERE p.id = 'placement-no-variants'`
    )).rows[0].default_variant_key).toBe("var_default");

    await setEnvironmentConfigSource({
      clientId: "hi-live",
      source: "v2",
      expectedSource: "legacy",
      actor: "integration-cutover",
    });
    const v2 = await resolveConfigPlacements(resolveInput);
    expect(v2.placements.upgrade_pro?.variantId).toBe("var_default");
  });

  it("reconverges a changed legacy spec and synthesizes an active default for paused-only variants", async () => {
    await resetDatabase(database);
    await seedManifestClients(database);

    const original = validSpec("Original default");
    const paused = validSpec("Paused experiment");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
       VALUES ('spec-default','hi-live','General default',$1::jsonb,'active','fixture'),
              ('spec-paused','hi-live','Paused experiment',$2::jsonb,'active','fixture')`,
      [JSON.stringify(original), JSON.stringify(paused)]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules
       ) VALUES (
         'placement-paused-only','pk_live_310bc7653631b8b924afbad3','hi-live','hiastro',
         'upgrade_pro',true,'active','paused-control','spec-default',$1::jsonb,'[]'::jsonb
       )`,
      [JSON.stringify(original)]
    );
    await database.query(
      `INSERT INTO placement_variants (
         id, placement_id, variant_id, variant_key, enabled, status,
         fallback_rank, weight, spec_id, spec
       ) VALUES (
         'paused-control','placement-paused-only','paused-control','paused-control',
         false,'paused',0,100,'spec-paused',$1::jsonb
       )`,
      [JSON.stringify(paused)]
    );

    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    const { compareLegacyAndV2 } = await import("../src/compare-v2.js");
    applicationPool = (await import("../src/db.js")).pool;
    await backfillPaywallPublishingV2();

    const firstRouting = (await database.query<{
      revision_id: string;
      variant_key: string;
      status: string;
      legacy_spec_id: string;
    }>(
      `SELECT pr.id AS revision_id, prv.variant_key, prv.status, r.legacy_spec_id
         FROM placements p
         JOIN placement_revisions pr ON pr.id = p.current_revision_id
         JOIN placement_revision_variants prv ON prv.placement_revision_id = pr.id
         JOIN paywall_environment_bindings b ON b.id = prv.binding_id
         JOIN paywall_environment_releases r ON r.id = b.current_release_id
        WHERE p.id = 'placement-paused-only'`
    )).rows;
    expect(firstRouting).toEqual([{
      revision_id: expect.any(String),
      variant_key: "paused-control",
      status: "active",
      legacy_spec_id: "spec-default",
    }]);

    const firstPublished = (await database.query<{
      binding_id: string;
      release_id: string;
      content_revision_id: string;
      content: any;
    }>(
      `SELECT b.id AS binding_id, r.id AS release_id, r.content_revision_id, cr.content
         FROM paywall_environment_bindings b
         JOIN paywalls p ON p.id = b.paywall_id
         JOIN paywall_environment_releases r ON r.id = b.current_release_id
         JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
        WHERE b.client_id = 'hi-live' AND p.paywall_key = 'general-default'`
    )).rows[0];
    expect(firstPublished.content.localization.translations.en.headline).toBe("Original default");
    expect((await compareLegacyAndV2("pk_live_310bc7653631b8b924afbad3")).passed).toBe(true);

    const revised = validSpec("Revised default");
    await database.query(
      `UPDATE paywall_specs
          SET spec = $2::jsonb, version = version + 1, updated_at = updated_at + interval '1 second'
        WHERE id = $1`,
      ["spec-default", JSON.stringify(revised)]
    );
    await backfillPaywallPublishingV2();

    const secondPublished = (await database.query<{
      release_id: string;
      content_revision_id: string;
      content: any;
    }>(
      `SELECT r.id AS release_id, r.content_revision_id, cr.content
         FROM paywall_environment_bindings b
         JOIN paywall_environment_releases r ON r.id = b.current_release_id
         JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
        WHERE b.id = $1`,
      [firstPublished.binding_id]
    )).rows[0];
    expect(secondPublished.release_id).not.toBe(firstPublished.release_id);
    expect(secondPublished.content_revision_id).not.toBe(firstPublished.content_revision_id);
    expect(secondPublished.content.localization.translations.en.headline).toBe("Revised default");
    expect((await database.query(
      "SELECT content FROM paywall_content_revisions WHERE id = $1",
      [firstPublished.content_revision_id]
    )).rows[0].content.localization.translations.en.headline).toBe("Original default");
    expect(Number((await database.query(
      "SELECT COUNT(*) FROM paywall_content_revisions WHERE paywall_id = (SELECT paywall_id FROM paywall_environment_bindings WHERE id = $1)",
      [firstPublished.binding_id]
    )).rows[0].count)).toBe(2);
    expect(Number((await database.query(
      "SELECT COUNT(*) FROM paywall_environment_releases WHERE binding_id = $1",
      [firstPublished.binding_id]
    )).rows[0].count)).toBe(2);
    expect((await database.query(
      `SELECT from_pointer_id, to_pointer_id
         FROM config_audit_log
        WHERE entity_type = 'paywall'
          AND action = 'backfill'
          AND to_pointer_id = $1
        ORDER BY id DESC LIMIT 1`,
      [secondPublished.release_id]
    )).rows[0]).toEqual({
      from_pointer_id: firstPublished.release_id,
      to_pointer_id: secondPublished.release_id,
    });
    expect((await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-paused-only'"
    )).rows[0].current_revision_id).toBe(firstRouting[0].revision_id);
    expect((await compareLegacyAndV2("pk_live_310bc7653631b8b924afbad3")).passed).toBe(true);

    // Create a newer backfill-owned routing pointer, then deliberately roll
    // both pointers back through the real publish APIs. A later backfill must
    // respect the latest manual rollback even though its targets originated
    // from an older backfill.
    await database.query(
      `UPDATE placements
          SET targeting_rules = '[{"when":{"intent":"marriage"},"statsig_experiment_id":"exp-marriage"}]'::jsonb
        WHERE id = 'placement-paused-only'`
    );
    await backfillPaywallPublishingV2();
    const newerRoutingId = (await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-paused-only'"
    )).rows[0].current_revision_id;
    expect(newerRoutingId).not.toBe(firstRouting[0].revision_id);
    expect((await database.query(
      `SELECT from_pointer_id, to_pointer_id
         FROM config_audit_log
        WHERE entity_type = 'placement'
          AND entity_id = 'placement-paused-only'
          AND action = 'backfill'
          AND to_pointer_id = $1
        ORDER BY id DESC LIMIT 1`,
      [newerRoutingId]
    )).rows[0]).toEqual({
      from_pointer_id: firstRouting[0].revision_id,
      to_pointer_id: newerRoutingId,
    });

    const { publishPaywallRelease, publishPlacementRevision } = await import("../src/config-publish.js");
    await publishPlacementRevision({
      placementId: "placement-paused-only",
      revisionId: firstRouting[0].revision_id,
      expectedCurrentRevisionId: newerRoutingId,
      actor: "integration-rollback",
      action: "rollback",
    });
    await publishPaywallRelease({
      bindingId: firstPublished.binding_id,
      releaseId: firstPublished.release_id,
      expectedCurrentReleaseId: secondPublished.release_id,
      actor: "integration-rollback",
      action: "rollback",
    });

    const beforeRerun = await v2Counts(database);
    await backfillPaywallPublishingV2();
    expect(await v2Counts(database)).toEqual(beforeRerun);
    expect((await database.query(
      "SELECT current_release_id FROM paywall_environment_bindings WHERE id = $1",
      [firstPublished.binding_id]
    )).rows[0].current_release_id).toBe(firstPublished.release_id);
    expect((await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-paused-only'"
    )).rows[0].current_revision_id).toBe(firstRouting[0].revision_id);
  });

  it("backfills an active placement with an archived default as paused routing", async () => {
    await resetDatabase(database);
    await seedManifestClients(database);
    const archived = validSpec("Archived default");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
       VALUES ('spec-archived-default','hi-live','Archived default',$1::jsonb,'archived','fixture')`,
      [JSON.stringify(archived)]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules
       ) VALUES (
         'placement-archived-default','pk_live_310bc7653631b8b924afbad3','hi-live','hiastro',
         'upgrade_pro',true,'active','control','spec-archived-default',$1::jsonb,'[]'::jsonb
       )`,
      [JSON.stringify(archived)]
    );

    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    const { compareLegacyAndV2 } = await import("../src/compare-v2.js");
    applicationPool = (await import("../src/db.js")).pool;
    await backfillPaywallPublishingV2();

    expect((await database.query(
      `SELECT pr.status
         FROM placements p
         JOIN placement_revisions pr ON pr.id = p.current_revision_id
        WHERE p.id = 'placement-archived-default'`
    )).rows[0].status).toBe("paused");
    expect((await compareLegacyAndV2("pk_live_310bc7653631b8b924afbad3")).passed).toBe(true);
  });

  it("rejects a cross-environment legacy default and rolls back every V2 write", async () => {
    await resetDatabase(database);
    await seedManifestClients(database);
    const crossEnvironmentSpec = validSpec("Cross-environment default");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
       VALUES ('spec-cross-environment','hi-test','Cross environment',$1::jsonb,'active','fixture')`,
      [JSON.stringify(crossEnvironmentSpec)]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules
       ) VALUES (
         'placement-cross-environment','pk_live_310bc7653631b8b924afbad3','hi-live','hiastro',
         'upgrade_pro',true,'active','control','spec-cross-environment',$1::jsonb,'[]'::jsonb
       )`,
      [JSON.stringify(crossEnvironmentSpec)]
    );

    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    applicationPool = (await import("../src/db.js")).pool;
    await expect(backfillPaywallPublishingV2()).rejects.toThrow(
      "references missing or cross-environment default spec spec-cross-environment"
    );
    expect(await v2Counts(database)).toEqual({
      paywalls: 0,
      paywall_content_revisions: 0,
      paywall_environment_bindings: 0,
      paywall_environment_releases: 0,
      placement_revisions: 0,
      placement_revision_variants: 0,
      config_audit_log: 0,
    });
    expect(Number((await database.query(
      "SELECT COUNT(*) FROM paywall_specs WHERE id = 'spec-cross-environment'"
    )).rows[0].count)).toBe(1);
  });

  it("promotes test content into a live candidate without changing live billing", async () => {
    await resetDatabase(database);
    await seedClients(database, [
      ["hi-test", "pk_test_hi", "Hi test", "hiastro", "test"],
      ["hi-live", "pk_live_hi", "Hi live", "hiastro", "live"],
    ]);
    await database.query(
      `INSERT INTO paywalls (id, project_key, paywall_key, display_name)
       VALUES ('pw-promote','hiastro','marriage','Marriage')`
    );
    await database.query(
      `INSERT INTO paywall_environment_bindings (id, client_id, project_key, paywall_id)
       VALUES ('binding-test','hi-test','hiastro','pw-promote'),
              ('binding-live','hi-live','hiastro','pw-promote')`
    );
    await insertContent(database, "content-test", "pw-promote", "hiastro", 1, "Test content");
    await insertContent(database, "content-live", "pw-promote", "hiastro", 2, "Live content");

    const sourceProducts = [{ id: "test-product", name: "Test billing", price: "₹1" }];
    const liveProducts = [{ id: "live-product", name: "Live billing", price: "₹999" }];
    const sourceCheckout = { provider: { planId: "test-plan" } };
    const liveCheckout = { provider: { planId: "live-plan" }, ui: { enabled: true } };
    await insertReleaseWithBilling(
      database, "release-test", "binding-test", "hi-test", "hiastro",
      "pw-promote", "content-test", 1, sourceProducts, sourceCheckout
    );
    await insertReleaseWithBilling(
      database, "release-live", "binding-live", "hi-live", "hiastro",
      "pw-promote", "content-live", 1, liveProducts, liveCheckout
    );
    await database.query(
      `UPDATE paywall_environment_bindings
          SET current_release_id = CASE id
            WHEN 'binding-test' THEN 'release-test'
            WHEN 'binding-live' THEN 'release-live'
          END
        WHERE id IN ('binding-test', 'binding-live')`
    );

    const { promotePaywallContent } = await import("../src/config-publish.js");
    applicationPool = (await import("../src/db.js")).pool;
    const candidate = await promotePaywallContent({
      targetBindingId: "binding-live",
      sourceReleaseId: "release-test",
      actor: "integration-test",
    });

    const stored = (await database.query<{
      content_revision_id: string;
      products: any[];
      checkout: any;
    }>(
      `SELECT content_revision_id, products, checkout
         FROM paywall_environment_releases
        WHERE id = $1`,
      [candidate.id]
    )).rows[0];
    expect(stored).toEqual({
      content_revision_id: "content-test",
      products: liveProducts,
      checkout: liveCheckout,
    });
    expect((await database.query(
      "SELECT current_release_id FROM paywall_environment_bindings WHERE id = 'binding-live'"
    )).rows[0].current_release_id).toBe("release-live");
  });

  it("cuts an environment over with comparator-backed CAS and can roll it back", async () => {
    await resetDatabase(database);
    await seedManifestClients(database);
    const spec = validSpec("Cutover fixture");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
       VALUES ('spec-cutover','hi-live','Cutover fixture',$1::jsonb,'active','fixture')`,
      [JSON.stringify(spec)]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules
       ) VALUES (
         'placement-cutover','pk_live_310bc7653631b8b924afbad3','hi-live','hiastro',
         'upgrade_pro',true,'active','control','spec-cutover',$1::jsonb,'[]'::jsonb
       )`,
      [JSON.stringify(spec)]
    );

    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    const { setEnvironmentConfigSource } = await import("../src/config-publish.js");
    applicationPool = (await import("../src/db.js")).pool;
    await backfillPaywallPublishingV2();

    const cutover = await setEnvironmentConfigSource({
      clientId: "hi-live",
      source: "v2",
      expectedSource: "legacy",
      actor: "integration-cutover",
    });
    expect(cutover).toMatchObject({
      client_id: "hi-live",
      config_source: "v2",
      comparison: { passed: true },
    });
    expect((await database.query(
      "SELECT config_source FROM clients WHERE id = 'hi-live'"
    )).rows[0].config_source).toBe("v2");
    expect(await cutoverAuditCount(database, "hi-live")).toBe(1);

    await expect(setEnvironmentConfigSource({
      clientId: "hi-live",
      source: "v2",
      expectedSource: "legacy",
      actor: "stale-cutover",
    })).rejects.toMatchObject({ status: 409 });
    expect(await cutoverAuditCount(database, "hi-live")).toBe(1);

    const rollback = await setEnvironmentConfigSource({
      clientId: "hi-live",
      source: "legacy",
      expectedSource: "v2",
      actor: "integration-rollback",
    });
    expect(rollback).toMatchObject({ client_id: "hi-live", config_source: "legacy" });
    expect((await database.query(
      "SELECT config_source FROM clients WHERE id = 'hi-live'"
    )).rows[0].config_source).toBe("legacy");
    expect(await cutoverAuditCount(database, "hi-live")).toBe(2);
  });

  it("writes publish audits only after paywall and placement pointer CAS succeeds", async () => {
    await resetDatabase(database);
    await seedClients(database, [
      ["hi-test", "pk_test_hi", "Hi test", "hiastro", "test"],
    ]);
    await database.query(
      `INSERT INTO paywalls (id, project_key, paywall_key, display_name)
       VALUES ('pw-cas','hiastro','cas-paywall','CAS paywall')`
    );
    await database.query(
      `INSERT INTO paywall_environment_bindings (id, client_id, project_key, paywall_id)
       VALUES ('binding-cas','hi-test','hiastro','pw-cas')`
    );
    await insertContent(database, "content-cas-current", "pw-cas", "hiastro", 1, "CAS current");
    await insertContent(database, "content-cas-candidate", "pw-cas", "hiastro", 2, "CAS candidate");
    const products = [{ id: "cas-product", name: "CAS billing", price: "₹999" }];
    const checkout = { provider: { planId: "cas-plan" } };
    await insertReleaseWithBilling(
      database, "release-cas-current", "binding-cas", "hi-test", "hiastro",
      "pw-cas", "content-cas-current", 1, products, checkout
    );
    await insertReleaseWithBilling(
      database, "release-cas-candidate", "binding-cas", "hi-test", "hiastro",
      "pw-cas", "content-cas-candidate", 2, products, checkout
    );
    await database.query(
      "UPDATE paywall_environment_bindings SET current_release_id = 'release-cas-current' WHERE id = 'binding-cas'"
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, spec, targeting_rules
       ) VALUES ('placement-cas','pk_test_hi','hi-test','hiastro','upgrade_pro',false,
                 'paused',NULL,NULL,'[]'::jsonb)`
    );
    await database.query(
      `INSERT INTO placement_revisions (
         id, placement_id, client_id, project_key, revision_number, status,
         default_binding_id, default_variant_key, targeting_rules, created_by
       ) VALUES
         ('routing-cas-current','placement-cas','hi-test','hiastro',1,'active',
          'binding-cas','control','[]'::jsonb,'fixture'),
         ('routing-cas-candidate','placement-cas','hi-test','hiastro',2,'active',
          'binding-cas','control','[]'::jsonb,'fixture')`
    );
    await database.query(
      `INSERT INTO placement_revision_variants (
         id, placement_revision_id, placement_id, client_id, project_key,
         variant_key, binding_id, status, weight, fallback_rank
       ) VALUES
         ('routing-current-control','routing-cas-current','placement-cas','hi-test','hiastro',
          'control','binding-cas','active',100,0),
         ('routing-candidate-control','routing-cas-candidate','placement-cas','hi-test','hiastro',
          'control','binding-cas','active',100,0)`
    );
    await database.query(
      "UPDATE placements SET current_revision_id = 'routing-cas-current' WHERE id = 'placement-cas'"
    );

    const { publishPaywallRelease, publishPlacementRevision } = await import("../src/config-publish.js");
    applicationPool = (await import("../src/db.js")).pool;

    await expect(publishPaywallRelease({
      bindingId: "binding-cas",
      releaseId: "release-cas-candidate",
      expectedCurrentReleaseId: "release-cas-current",
      actor: "unvalidated-publisher",
    })).rejects.toMatchObject({ status: 428 });
    expect(await publishAuditCount(database, "paywall", "pw-cas")).toBe(0);

    await recordPassingPreflight(database, "binding-cas", "release-cas-candidate");
    await expect(publishPaywallRelease({
      bindingId: "binding-cas",
      releaseId: "release-cas-candidate",
      expectedCurrentReleaseId: "release-stale",
      actor: "stale-publisher",
    })).rejects.toMatchObject({ status: 409 });
    expect(await publishAuditCount(database, "paywall", "pw-cas")).toBe(0);
    expect((await database.query(
      "SELECT current_release_id FROM paywall_environment_bindings WHERE id = 'binding-cas'"
    )).rows[0].current_release_id).toBe("release-cas-current");

    await publishPaywallRelease({
      bindingId: "binding-cas",
      releaseId: "release-cas-candidate",
      expectedCurrentReleaseId: "release-cas-current",
      actor: "integration-publisher",
    });
    expect(await publishAuditCount(database, "paywall", "pw-cas")).toBe(1);
    expect((await database.query(
      "SELECT current_release_id FROM paywall_environment_bindings WHERE id = 'binding-cas'"
    )).rows[0].current_release_id).toBe("release-cas-candidate");

    await expect(publishPlacementRevision({
      placementId: "placement-cas",
      revisionId: "routing-cas-candidate",
      expectedCurrentRevisionId: "routing-stale",
      actor: "stale-publisher",
    })).rejects.toMatchObject({ status: 409 });
    expect(await publishAuditCount(database, "placement", "placement-cas")).toBe(0);
    expect((await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-cas'"
    )).rows[0].current_revision_id).toBe("routing-cas-current");

    await publishPlacementRevision({
      placementId: "placement-cas",
      revisionId: "routing-cas-candidate",
      expectedCurrentRevisionId: "routing-cas-current",
      actor: "integration-publisher",
    });
    expect(await publishAuditCount(database, "placement", "placement-cas")).toBe(1);
    expect((await database.query(
      "SELECT current_revision_id FROM placements WHERE id = 'placement-cas'"
    )).rows[0].current_revision_id).toBe("routing-cas-candidate");
  });

  it("round-trips exported inline legacy config over HTTP and preserves omitted fields", async () => {
    await resetDatabase(database);
    await seedClients(database, [
      ["hi-test", "pk_test_roundtrip", "Hi round trip", "hiastro", "test"],
    ]);
    applicationPool = (await import("../src/db.js")).pool;
    process.env.ADMIN_SECRET = "integration-admin-secret";

    const placementSpec = validSpec("Inline placement");
    const blueSpec = validSpec("Inline blue");
    const greenSpec = validSpec("Inline green");
    const originalRules = [{ when: { intent: "marriage" }, variant: "offer-blue" }];
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, experiment_id, statsig_experiment_id, default_spec_id,
         targeting_rules, spec
       ) VALUES (
         'placement-roundtrip','pk_test_roundtrip','hi-test','hiastro','upgrade_pro',
         true,'active','offer-blue',NULL,NULL,NULL,$1::jsonb,$2::jsonb
       )`,
      [JSON.stringify(originalRules), JSON.stringify(placementSpec)]
    );
    await database.query(
      `INSERT INTO placement_variants (
         id, placement_id, variant_id, variant_key, spec_id, spec,
         enabled, status, weight, fallback_rank
       ) VALUES
         ('variant-blue','placement-roundtrip','offer-blue','offer-blue',NULL,$1::jsonb,
          true,'active',65,7),
         ('variant-green','placement-roundtrip','offer-green','offer-green',NULL,$2::jsonb,
          false,'paused',35,13)`,
      [JSON.stringify(blueSpec), JSON.stringify(greenSpec)]
    );

    const exportedResponse = await adminJsonRequest(
      "/admin/config/export?public_key=pk_test_roundtrip",
      "GET"
    );
    expect(exportedResponse.status).toBe(200);
    const exported = exportedResponse.body as {
      specs: any[];
      placements: any[];
      variants: any[];
    };
    expect(exported.placements).toHaveLength(1);
    expect(exported.placements[0]).toMatchObject({
      id: "placement-roundtrip",
      variant_id: "offer-blue",
      default_spec_id: null,
      statsig_experiment_id: null,
      spec: placementSpec,
    });
    expect(exported.variants.map((variant) => ({
      variant_key: variant.variant_key,
      spec_id: variant.spec_id,
      fallback_rank: variant.fallback_rank,
    }))).toEqual([
      { variant_key: "offer-blue", spec_id: null, fallback_rank: 7 },
      { variant_key: "offer-green", spec_id: null, fallback_rank: 13 },
    ]);

    const mutatedSpec = validSpec("Mutated before restore");
    await database.query(
      `UPDATE placements
          SET enabled = false, status = 'paused', variant_id = 'mutated-default',
              experiment_id = 'exp-mutated', statsig_experiment_id = 'exp-mutated',
              targeting_rules = '[{"mutated":true}]'::jsonb, spec = $1::jsonb
        WHERE id = 'placement-roundtrip'`,
      [JSON.stringify(mutatedSpec)]
    );
    await database.query(
      `UPDATE placement_variants
          SET enabled = true, status = 'active', weight = 1, fallback_rank = 99,
              spec = $1::jsonb
        WHERE placement_id = 'placement-roundtrip'`,
      [JSON.stringify(mutatedSpec)]
    );

    const restoredResponse = await adminJsonRequest("/admin/config/import", "POST", {
      ...exported,
      publicKey: "pk_test_roundtrip",
    });
    expect(restoredResponse).toMatchObject({
      status: 200,
      body: { specs: 0, placements: 1, variants: 2 },
    });
    const restoredPlacement = (await database.query(
      `SELECT status, enabled, variant_id, default_spec_id, statsig_experiment_id,
              targeting_rules, spec
         FROM placements WHERE id = 'placement-roundtrip'`
    )).rows[0];
    expect(restoredPlacement).toEqual({
      status: "active",
      enabled: true,
      variant_id: "offer-blue",
      default_spec_id: null,
      statsig_experiment_id: null,
      targeting_rules: originalRules,
      spec: placementSpec,
    });
    expect((await database.query(
      `SELECT variant_key, spec_id, status, enabled, weight, fallback_rank, spec
         FROM placement_variants
        WHERE placement_id = 'placement-roundtrip'
        ORDER BY variant_key`
    )).rows).toEqual([
      {
        variant_key: "offer-blue",
        spec_id: null,
        status: "active",
        enabled: true,
        weight: 65,
        fallback_rank: 7,
        spec: blueSpec,
      },
      {
        variant_key: "offer-green",
        spec_id: null,
        status: "paused",
        enabled: false,
        weight: 35,
        fallback_rank: 13,
        spec: greenSpec,
      },
    ]);

    const preservedSpec = validSpec("Preserved omitted fields");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by)
       VALUES ('spec-preserve','hi-test','Preserve target',$1::jsonb,'active','fixture')`,
      [JSON.stringify(preservedSpec)]
    );
    await database.query(
      `UPDATE placements
          SET enabled = false, status = 'paused', variant_id = 'preserve-key',
              experiment_id = 'exp-preserve', statsig_experiment_id = 'exp-preserve',
              default_spec_id = 'spec-preserve', targeting_rules = '[{"preserve":true}]'::jsonb,
              spec = $1::jsonb
        WHERE id = 'placement-roundtrip'`,
      [JSON.stringify(preservedSpec)]
    );
    await database.query(
      `UPDATE placement_variants
          SET enabled = false, status = 'paused', weight = 23,
              fallback_rank = CASE variant_key WHEN 'offer-blue' THEN 41 ELSE 42 END
        WHERE placement_id = 'placement-roundtrip'`
    );

    const omitted = structuredClone(exported);
    delete omitted.placements[0].status;
    delete omitted.placements[0].variant_id;
    delete omitted.placements[0].default_spec_id;
    delete omitted.placements[0].statsig_experiment_id;
    delete omitted.placements[0].targeting_rules;
    delete omitted.placements[0].spec;
    for (const variant of omitted.variants) {
      delete variant.status;
      delete variant.weight;
      delete variant.fallback_rank;
    }
    const omittedResponse = await adminJsonRequest("/admin/config/import", "POST", {
      ...omitted,
      publicKey: "pk_test_roundtrip",
    });
    expect(omittedResponse.status).toBe(200);
    expect((await database.query(
      `SELECT status, enabled, variant_id, default_spec_id, statsig_experiment_id,
              targeting_rules, spec
         FROM placements WHERE id = 'placement-roundtrip'`
    )).rows[0]).toEqual({
      status: "paused",
      enabled: false,
      variant_id: "preserve-key",
      default_spec_id: "spec-preserve",
      statsig_experiment_id: "exp-preserve",
      targeting_rules: [{ preserve: true }],
      spec: preservedSpec,
    });
    expect((await database.query(
      `SELECT variant_key, status, enabled, weight, fallback_rank
         FROM placement_variants
        WHERE placement_id = 'placement-roundtrip'
        ORDER BY variant_key`
    )).rows).toEqual([
      { variant_key: "offer-blue", status: "paused", enabled: false, weight: 23, fallback_rank: 41 },
      { variant_key: "offer-green", status: "paused", enabled: false, weight: 23, fallback_rank: 42 },
    ]);
  });

  it("rolls back an HTTP import when a later placement primary-key conflict fails", async () => {
    await resetDatabase(database);
    await seedClients(database, [
      ["hi-test", "pk_test_import_rollback", "Hi import rollback", "hiastro", "test"],
    ]);
    applicationPool = (await import("../src/db.js")).pool;
    process.env.ADMIN_SECRET = "integration-admin-secret";
    const existingSpec = validSpec("Existing placement");
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, spec, targeting_rules
       ) VALUES (
         'placement-pk-conflict','pk_test_import_rollback','hi-test','hiastro',
         'existing_trigger',true,'active','control',$1::jsonb,'[]'::jsonb
       )`,
      [JSON.stringify(existingSpec)]
    );

    const response = await adminJsonRequest("/admin/config/import", "POST", {
      publicKey: "pk_test_import_rollback",
      specs: [{
        id: "spec-written-before-conflict",
        name: "Must roll back",
        status: "active",
        spec: validSpec("Must roll back"),
      }],
      placements: [{
        id: "placement-pk-conflict",
        trigger: "different_trigger",
        status: "active",
        variant_id: "control",
        spec: validSpec("Conflicting placement"),
      }],
      variants: [],
    });
    expect(response.status).toBe(500);
    expect(Number((await database.query(
      "SELECT COUNT(*) FROM paywall_specs WHERE workspace_id = 'hi-test' AND name = 'Must roll back'"
    )).rows[0].count)).toBe(0);
    expect((await database.query(
      "SELECT trigger FROM placements WHERE id = 'placement-pk-conflict'"
    )).rows[0].trigger).toBe("existing_trigger");
  });

  it("compares equal-rank variants deterministically by variant key", async () => {
    await resetDatabase(database);
    await seedManifestClients(database);
    const alpha = validSpec("Alpha variant");
    const beta = validSpec("Beta variant");
    await database.query(
      `INSERT INTO paywall_specs (id, workspace_id, name, spec, status, created_by, created_at)
       VALUES
         ('spec-alpha','hi-live','Alpha paywall',$1::jsonb,'active','fixture','2026-01-01T00:00:00Z'),
         ('spec-beta','hi-live','Beta paywall',$2::jsonb,'active','fixture','2026-01-01T00:00:00Z')`,
      [JSON.stringify(alpha), JSON.stringify(beta)]
    );
    await database.query(
      `INSERT INTO placements (
         id, public_key, client_id, project_key, trigger, enabled, status,
         variant_id, default_spec_id, spec, targeting_rules, created_at
       ) VALUES (
         'placement-equal-rank','pk_live_310bc7653631b8b924afbad3','hi-live','hiastro',
         'upgrade_pro',true,'active','alpha','spec-alpha',$1::jsonb,'[]'::jsonb,
         '2026-01-01T00:00:00Z'
       )`,
      [JSON.stringify(alpha)]
    );
    await database.query(
      `INSERT INTO placement_variants (
         id, placement_id, variant_id, variant_key, enabled, status,
         fallback_rank, weight, spec_id, spec, created_at
       ) VALUES
         ('legacy-a','placement-equal-rank','beta','beta',true,'active',0,50,
          'spec-beta',$2::jsonb,'2026-01-01T00:00:00Z'),
         ('legacy-z','placement-equal-rank','alpha','alpha',true,'active',0,50,
          'spec-alpha',$1::jsonb,'2026-01-01T00:00:00Z')`,
      [JSON.stringify(alpha), JSON.stringify(beta)]
    );

    const { backfillPaywallPublishingV2 } = await import("../src/backfill-v2.js");
    const { compareLegacyAndV2 } = await import("../src/compare-v2.js");
    applicationPool = (await import("../src/db.js")).pool;
    await backfillPaywallPublishingV2();
    expect((await compareLegacyAndV2("pk_live_310bc7653631b8b924afbad3")).passed).toBe(true);

    const mapping = (await database.query<{
      variant_key: string;
      binding_id: string;
      current_revision_id: string;
    }>(
      `SELECT prv.variant_key, prv.binding_id, p.current_revision_id
         FROM placements p
         JOIN placement_revision_variants prv
           ON prv.placement_revision_id = p.current_revision_id
        WHERE p.id = 'placement-equal-rank'`
    )).rows;
    const bindingByVariant = new Map(mapping.map((row) => [row.variant_key, row.binding_id]));
    await database.query(
      `INSERT INTO placement_revisions (
         id, placement_id, client_id, project_key, revision_number, status,
         default_binding_id, default_variant_key, targeting_rules, created_by
       ) VALUES (
         'routing-equal-rank','placement-equal-rank','hi-live','hiastro',2,'active',
         $1,'alpha','[]'::jsonb,'fixture'
       )`,
      [bindingByVariant.get("alpha")]
    );
    await database.query(
      `INSERT INTO placement_revision_variants (
         id, placement_revision_id, placement_id, client_id, project_key,
         variant_key, binding_id, status, weight, fallback_rank, created_at
       ) VALUES
         ('v2-a','routing-equal-rank','placement-equal-rank','hi-live','hiastro',
          'alpha',$1,'active',50,0,'2026-01-01T00:00:00Z'),
         ('v2-z','routing-equal-rank','placement-equal-rank','hi-live','hiastro',
          'beta',$2,'active',50,0,'2026-01-01T00:00:00Z')`,
      [bindingByVariant.get("alpha"), bindingByVariant.get("beta")]
    );
    await database.query(
      "UPDATE placements SET current_revision_id = 'routing-equal-rank' WHERE id = 'placement-equal-rank'"
    );

    const comparison = await compareLegacyAndV2("pk_live_310bc7653631b8b924afbad3");
    expect(comparison.passed, JSON.stringify(comparison.environments, null, 2)).toBe(true);
  });
});

async function resetDatabase(database: pg.Pool): Promise<void> {
  await database.query(
    `TRUNCATE TABLE
       config_audit_log,
       placement_revision_variants,
       placement_revisions,
       paywall_environment_releases,
       paywall_environment_bindings,
       paywall_content_revisions,
       paywalls,
       placement_variants,
       placements,
       paywall_specs,
       clients,
       events
     RESTART IDENTITY CASCADE`
  );
}

async function seedClients(
  database: pg.Pool,
  clients: ReadonlyArray<readonly [string, string, string, string, "test" | "live"]>
): Promise<void> {
  for (const [id, publicKey, name, projectKey, environmentKind] of clients) {
    await database.query(
      `INSERT INTO clients (
         id, public_key, secret_key, name, project_key, environment_kind,
         management_status, config_source, sdk_stack
       ) VALUES ($1,$2,$3,$4,$5,$6,'editable','legacy','react_native')`,
      [id, publicKey, `secret-${id}`, name, projectKey, environmentKind]
    );
  }
}

async function seedManifestClients(database: pg.Pool): Promise<void> {
  await seedClients(database, [
    ["hi-live", "pk_live_310bc7653631b8b924afbad3", "Hiastro-production", "hiastro", "live"],
    ["hi-test", "pk_test_320da03ab659ffc56d58acd2", "hiastro-tesitng", "hiastro", "test"],
    ["in-test", "pk_test_2a8a5f07d4b9fcf1cc77e024", "Influish Demo", "influish", "test"],
    ["in-live", "pk_live_a1323f76d397778b6ed5eb04", "Influish Production", "influish", "live"],
  ]);
}

async function cutoverAuditCount(database: pg.Pool, clientId: string): Promise<number> {
  return Number((await database.query(
    `SELECT COUNT(*) FROM config_audit_log
      WHERE client_id = $1 AND entity_type = 'migration' AND action = 'cutover'`,
    [clientId]
  )).rows[0].count);
}

/**
 * Publishing requires a recorded passing check for the exact bytes and
 * products. These tests are about SQL invariants rather than the checks
 * themselves, so they record the verdict directly.
 */
async function recordPassingPreflight(
  database: pg.Pool,
  bindingId: string,
  releaseId: string
): Promise<void> {
  const { productsFingerprint } = await import("../src/config-publish.js");
  const release = await database.query(
    `SELECT r.client_id, r.products, r.checkout, cr.content_hash
       FROM paywall_environment_releases r
       JOIN paywall_content_revisions cr ON cr.id = r.content_revision_id
      WHERE r.id = $1 AND r.binding_id = $2`,
    [releaseId, bindingId]
  );
  const row = release.rows[0];
  await database.query(
    `INSERT INTO paywall_release_preflights (
       release_id, binding_id, client_id, content_hash, products_hash, status, report, checked_by
     ) VALUES ($1, $2, $3, $4, $5, 'pass', $6, 'integration')
     ON CONFLICT (release_id, content_hash, products_hash) DO UPDATE SET status = 'pass'`,
    [
      releaseId,
      bindingId,
      row.client_id,
      row.content_hash,
      productsFingerprint(row.products, row.checkout),
      JSON.stringify({ status: "pass", checks: [] }),
    ]
  );
}

async function publishAuditCount(
  database: pg.Pool,
  entityType: "paywall" | "placement",
  entityId: string
): Promise<number> {
  return Number((await database.query(
    `SELECT COUNT(*) FROM config_audit_log
      WHERE entity_type = $1 AND entity_id = $2 AND action = 'publish'`,
    [entityType, entityId]
  )).rows[0].count);
}

async function adminJsonRequest(
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<{ status: number; body: any }> {
  const { handleAdmin } = await import("../src/routes/admin.js");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    void handleAdmin(req, res, url.pathname).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "request failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Connection": "close",
        "x-admin-secret": "integration-admin-secret",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function insertContent(
  database: pg.Pool,
  id: string,
  paywallId: string,
  projectKey: string,
  revisionNumber: number,
  suffix: string
): Promise<void> {
  const spec = validSpec(suffix);
  const { products: _products, checkout: _checkout, ...content } = spec;
  const payload = {
    html: spec.document.html,
    cacheKey: `fixture:${suffix}`,
    revision: `doc-${suffix}`,
    integrity: `sha256-${suffix}`,
  };
  await database.query(
    `INSERT INTO paywall_content_revisions (
       id, paywall_id, project_key, revision_number, content, content_hash,
       document_cache_key, document_revision, document_hash, document_payload,
       document_integrity, created_by
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,'fixture')`,
    [
      id,
      paywallId,
      projectKey,
      revisionNumber,
      JSON.stringify(content),
      `content-${suffix}`,
      payload.cacheKey,
      payload.revision,
      `document-${suffix}`,
      JSON.stringify(payload),
      payload.integrity,
    ]
  );
}

async function insertReleaseWithBilling(
  database: pg.Pool,
  id: string,
  bindingId: string,
  clientId: string,
  projectKey: string,
  paywallId: string,
  contentRevisionId: string,
  releaseNumber: number,
  products: unknown[],
  checkout: Record<string, unknown>
): Promise<void> {
  await database.query(
    `INSERT INTO paywall_environment_releases (
       id, binding_id, client_id, project_key, paywall_id, release_number,
       content_revision_id, products, checkout, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'fixture')`,
    [
      id,
      bindingId,
      clientId,
      projectKey,
      paywallId,
      releaseNumber,
      contentRevisionId,
      JSON.stringify(products),
      JSON.stringify(checkout),
    ]
  );
}

async function insertRelease(
  database: pg.Pool,
  id: string,
  bindingId: string,
  clientId: string,
  projectKey: string,
  paywallId: string,
  contentRevisionId: string
): Promise<void> {
  await database.query(
    `INSERT INTO paywall_environment_releases (
       id, binding_id, client_id, project_key, paywall_id, release_number,
       content_revision_id, products, created_by
     ) VALUES ($1,$2,$3,$4,$5,1,$6,'[]'::jsonb,'fixture')`,
    [id, bindingId, clientId, projectKey, paywallId, contentRevisionId]
  );
}

async function v2Counts(database: pg.Pool): Promise<Record<string, number>> {
  const tables = [
    "paywalls",
    "paywall_content_revisions",
    "paywall_environment_bindings",
    "paywall_environment_releases",
    "placement_revisions",
    "placement_revision_variants",
    "config_audit_log",
  ];
  const result: Record<string, number> = {};
  for (const table of tables) {
    result[table] = Number((await database.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count);
  }
  return result;
}

function validSpec(label: string): any {
  return {
    renderer: "webview",
    document: { html: `<main><h1>{{headline}}</h1><p>${label}</p></main>` },
    localization: {
      defaultLocale: "en",
      translations: { en: { headline: label }, hi: { headline: label } },
    },
    products: [{ id: `product-${label.toLowerCase().replace(/\W+/g, "-")}`, name: label, price: "₹999" }],
    cta: { text: "Continue" },
    dismiss: { enabled: true },
  };
}
