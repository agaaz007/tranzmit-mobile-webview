// End-to-end verification of the inferred-fallback detector against a REAL
// Postgres (not mocks). Seeds synthetic events with backdated timestamps
// covering every allocation scenario, runs the actual sweep twice, and
// asserts what got flagged, with which variant, and what didn't.
//
// Usage:
//   DATABASE_URL=postgresql://tzverify@localhost:55433/tzverify \
//     npx tsx packages/server/scripts/verify-fallback-detector.mjs
//
// Safe: touches only the DATABASE_URL you point it at. Never call this with
// the production URL.

import { query } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { runFallbackDetectorSweep } from "../src/fallback-detector.js";

const PK = "pk_test_detector_verify";
if (!process.env.DATABASE_URL || /railway|rlwy|proxy\.rlwy/.test(process.env.DATABASE_URL)) {
  console.error("Refusing to run: DATABASE_URL missing or looks like a Railway/production URL.");
  process.exit(1);
}
// Forwarding would try to reach Statsig; keep the harness hermetic.
process.env.FALLBACK_DETECTOR_STATSIG = "0";

async function seed(name, userId, events) {
  for (const e of events) {
    await query(
      `INSERT INTO events (public_key, user_id, session_id, event_name, properties, identity, created_at)
       VALUES ($1, $2, 'verify-harness', $3, $4, '{}', now() - make_interval(mins => $5))`,
      [PK, userId, e.name, JSON.stringify(e.props ?? {}), e.minsAgo]
    );
  }
  return { name, userId };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function flaggedFor(userId) {
  const r = await query(
    `SELECT properties FROM events
     WHERE public_key = $1 AND user_id = $2 AND event_name = 'paywall_fallback_inferred'`,
    [PK, userId]
  );
  return r.rows;
}

async function main() {
  console.log("== migrations ==");
  await runMigrations();
  await query(`DELETE FROM events WHERE public_key = $1`, [PK]);

  console.log("== seeding scenarios ==");
  // S1: resolved to a TEST variant 20 min ago, never sent page_view -> MUST be
  // flagged with variant 'original' (the incident case).
  await seed("S1", "u_dead_original", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=original", intent: "(none)" }, minsAgo: 20 },
  ]);
  // S2: resolved 20 min ago, page_view arrived 2 min later -> healthy init,
  // must NOT be flagged (no false positive).
  await seed("S2", "u_healthy_intro", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=intro_offer" }, minsAgo: 20 },
    { name: "page_view", props: {}, minsAgo: 18 },
  ]);
  // S3: cache-hit pattern — page_view fires BEFORE the background refresh's
  // resolve (user rendered from cache). Must NOT be flagged.
  await seed("S3", "u_cachehit", [
    { name: "page_view", props: {}, minsAgo: 22 },
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=original" }, minsAgo: 20 },
  ]);
  // S4: control user dead init -> flagged with variant 'control' (this is the
  // baseline-noise cohort; allocation must say control, not a test variant).
  await seed("S4", "u_dead_control", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=control" }, minsAgo: 20 },
  ]);
  // S5: baseline-suffix parsing — 'control (baseline)' must allocate to
  // variant 'control'.
  await seed("S5", "u_dead_baseline", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=control (baseline)" }, minsAgo: 20 },
  ]);
  // S6: resolve too RECENT (5 min ago) — page_view may still be in flight;
  // must NOT be flagged yet (window is 15-25 min).
  await seed("S6", "u_too_recent", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=original" }, minsAgo: 5 },
  ]);
  // S7: resolve too OLD (40 min ago) — outside the sweep window; must not be
  // flagged by THIS sweep (prevents unbounded rescans).
  await seed("S7", "u_too_old", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=original" }, minsAgo: 40 },
  ]);
  // S8: page_view arrived LATE (12 min after resolve, outside the +10min
  // lookahead) -> flagged. Documents the known edge: very slow-but-eventual
  // inits count as fallbacks (upper bound semantics).
  await seed("S8", "u_slow_init", [
    { name: "paywall_resolved", props: { resolved: "upgrade_pro=intro_offer" }, minsAgo: 22 },
    { name: "page_view", props: {}, minsAgo: 10 },
  ]);

  console.log("== sweep #1 ==");
  const s1 = await runFallbackDetectorSweep();
  console.log("== sweep #2 (dedup) ==");
  const s2 = await runFallbackDetectorSweep();

  console.log("== assertions ==");
  const f1 = await flaggedFor("u_dead_original");
  check("S1 dead test-variant user IS flagged", f1.length === 1, `rows=${f1.length}`);
  check(
    "S1 allocated to the RIGHT variant (original)",
    f1[0]?.properties?.variant === "original" && f1[0]?.properties?.trigger === "upgrade_pro",
    `variant=${f1[0]?.properties?.variant} trigger=${f1[0]?.properties?.trigger}`
  );

  const f2 = await flaggedFor("u_healthy_intro");
  check("S2 healthy user NOT flagged (no false positive)", f2.length === 0, `rows=${f2.length}`);

  const f3 = await flaggedFor("u_cachehit");
  check("S3 cache-hit user (page_view before resolve) NOT flagged", f3.length === 0, `rows=${f3.length}`);

  const f4 = await flaggedFor("u_dead_control");
  check("S4 dead control user flagged AS control (baseline cohort intact)",
    f4.length === 1 && f4[0]?.properties?.variant === "control",
    `variant=${f4[0]?.properties?.variant}`);

  const f5 = await flaggedFor("u_dead_baseline");
  check("S5 '(baseline)' suffix stripped -> variant 'control'",
    f5.length === 1 && f5[0]?.properties?.variant === "control",
    `variant=${f5[0]?.properties?.variant}`);

  const f6 = await flaggedFor("u_too_recent");
  check("S6 too-recent resolve (5m) not flagged yet", f6.length === 0, `rows=${f6.length}`);

  const f7 = await flaggedFor("u_too_old");
  check("S7 out-of-window resolve (40m) not flagged", f7.length === 0, `rows=${f7.length}`);

  const f8 = await flaggedFor("u_slow_init");
  check("S8 late page_view (12m) IS flagged (documented upper-bound edge)",
    f8.length === 1, `rows=${f8.length}`);

  const totalFlagged = await query(
    `SELECT count(*)::int AS n FROM events WHERE public_key = $1 AND event_name = 'paywall_fallback_inferred'`,
    [PK]
  );
  check("dedup: sweep #2 inserted nothing", s2.inserted === 0,
    `sweep1 inserted=${s1.inserted}, sweep2 inserted=${s2.inserted}, total rows=${totalFlagged.rows[0].n}`);
  check("total inferred events = exactly the 4 dead-init users", totalFlagged.rows[0].n === 4,
    `total=${totalFlagged.rows[0].n}`);

  // Show-rate SQL against the same seeded data (mirrors /admin/metrics/show-rate).
  console.log("== show-rate query over seeded data ==");
  const sr = await query(
    `WITH resolved AS (
       SELECT split_part(split_part(pair, '=', 2), ' (', 1) AS variant, COUNT(DISTINCT user_id) AS resolved_users
       FROM events, LATERAL regexp_split_to_table(properties->>'resolved', ',\\s*') AS pair
       WHERE public_key = $1 AND event_name = 'paywall_resolved' AND position('=' in pair) > 0
       GROUP BY 1),
     fallbacks AS (
       SELECT properties->>'variant' AS variant, COUNT(DISTINCT user_id) AS inferred_fallback_users
       FROM events WHERE public_key = $1 AND event_name = 'paywall_fallback_inferred' GROUP BY 1)
     SELECT r.variant, r.resolved_users, COALESCE(f.inferred_fallback_users, 0) AS inferred_fallback_users
     FROM resolved r LEFT JOIN fallbacks f USING (variant) ORDER BY 1`,
    [PK]
  );
  for (const row of sr.rows) {
    console.log(`  ${row.variant.padEnd(12)} resolved=${row.resolved_users} inferred_fallbacks=${row.inferred_fallback_users}`);
  }
  const byVariant = Object.fromEntries(sr.rows.map((r) => [r.variant, r]));
  check("show-rate: control resolved=2 fallbacks=2 (S4+S5, incl. baseline-suffix)",
    Number(byVariant.control?.resolved_users) === 2 && Number(byVariant.control?.inferred_fallback_users) === 2);
  check("show-rate: original resolved=4 fallbacks=1 (only S1; S3/S6/S7 excluded)",
    Number(byVariant.original?.resolved_users) === 4 && Number(byVariant.original?.inferred_fallback_users) === 1);
  check("show-rate: intro_offer resolved=2 fallbacks=1 (S8 only)",
    Number(byVariant.intro_offer?.resolved_users) === 2 && Number(byVariant.intro_offer?.inferred_fallback_users) === 1);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${results.length} total)`);
  // process.exit tears down the pg pool; no explicit close needed here.
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
