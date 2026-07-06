// ============================================================================
// Server-side inferred-fallback observability.
//
// The Flutter SDK fires the client `page_view` event ONLY after a fully
// successful init (config POST + hosted-document fetch). The server logs a
// `paywall_resolved` event at /v1/config time. A user who resolves but never
// sends page_view shortly after had their document fetch fail (init died) and
// saw the customer app's fallback paywall — invisible today. This sweep scans
// a settled window of resolves, flags the ones with no nearby page_view, and
// records a synthetic `paywall_fallback_inferred` event per (user, resolve).
//
// No SDK change is possible (customer app is live), so this is entirely
// server-side and OFF unless FALLBACK_DETECTOR_ENABLED=1: the deploy is inert
// until explicitly enabled.
// ============================================================================
import { query } from "./db.js";
import {
  EVENT_PREFIX,
  getProjectConfigForPublicKey,
  getStatsigServer,
} from "./statsig.js";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;

const FALLBACK_EVENT_NAME = "paywall_fallback_inferred";

// Canonical ISO-8601 rendering of the resolve timestamp, computed IN SQL so
// the value we insert into properties.resolved_at is byte-identical to the
// value the dedup NOT EXISTS re-derives on every subsequent sweep. Deriving it
// in JS from a pg-parsed Date would risk millisecond/formatting drift and
// broken dedup.
const RESOLVED_AT_ISO_SQL = `to_char(%ALIAS%.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const CANDIDATES_SQL = `
  SELECT
    r.public_key,
    r.user_id,
    r.properties,
    ${RESOLVED_AT_ISO_SQL.replace("%ALIAS%", "r")} AS resolved_at
  FROM events r
  WHERE r.event_name = 'paywall_resolved'
    -- Only sweep resolves old enough that a slow init would have finished
    -- (page_view window closes at +10min), and young enough that we have not
    -- swept them before minus dedup (25min lookback, 5min sweep interval).
    AND r.created_at BETWEEN now() - interval '25 minutes' AND now() - interval '15 minutes'
    -- Init completed: the SDK sent page_view near the resolve.
    AND NOT EXISTS (
      SELECT 1 FROM events pv
      WHERE pv.event_name = 'page_view'
        AND pv.public_key = r.public_key
        AND pv.user_id = r.user_id
        AND pv.created_at BETWEEN r.created_at - interval '5 minutes'
                              AND r.created_at + interval '10 minutes'
    )
    -- Dedup: a previous sweep already flagged this exact resolve.
    AND NOT EXISTS (
      SELECT 1 FROM events f
      WHERE f.event_name = '${FALLBACK_EVENT_NAME}'
        AND f.public_key = r.public_key
        AND f.user_id = r.user_id
        AND f.properties->>'resolved_at' = ${RESOLVED_AT_ISO_SQL.replace("%ALIAS%", "r")}
    )
  ORDER BY r.created_at ASC
`;

const SCANNED_COUNT_SQL = `
  SELECT COUNT(*)::int AS scanned
  FROM events
  WHERE event_name = 'paywall_resolved'
    AND created_at BETWEEN now() - interval '25 minutes' AND now() - interval '15 minutes'
`;

interface CandidateRow {
  public_key: string;
  user_id: string;
  properties: Record<string, unknown> | null;
  resolved_at: string;
}

/**
 * Parses the `paywall_resolved` properties.resolved string, e.g.
 * "upgrade_pro=original" or "upgrade_pro=control (baseline)". Multi-placement
 * strings are comma-joined; the first entry is the paywall placement.
 */
export function parseResolvedProperty(resolved: unknown): { trigger: string; variant: string } | null {
  if (typeof resolved !== "string") return null;
  const first = resolved.split(",")[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const trigger = first.slice(0, eq).trim();
  const variant = first.slice(eq + 1).replace(/\s*\(baseline\)\s*$/, "").trim();
  if (!trigger || !variant) return null;
  return { trigger, variant };
}

function statsigForwardingEnabled(): boolean {
  return process.env.FALLBACK_DETECTOR_STATSIG !== "0";
}

async function forwardToStatsig(input: {
  publicKey: string;
  userId: string;
  variant: string;
  trigger: string;
}): Promise<void> {
  // Forwarding failures must never break the sweep — the DB row is the source
  // of truth; Statsig is best-effort observability.
  try {
    const projectConfig = await getProjectConfigForPublicKey(input.publicKey);
    const server = await getStatsigServer(projectConfig);
    if (!server) return;
    server.logEvent(
      { userID: input.userId },
      EVENT_PREFIX + FALLBACK_EVENT_NAME,
      null,
      {
        variant: input.variant,
        trigger: input.trigger,
        reason: "init_incomplete",
      }
    );
  } catch (err) {
    console.warn("[Tranzmit] Fallback detector Statsig forwarding failed:", err);
  }
}

// The dedup is check-then-insert with no DB unique constraint, so overlapping
// sweeps could double-insert. setInterval doesn't await the previous run and
// Statsig forwarding can stretch a sweep past the interval — skip re-entry.
let sweepInFlight = false;

export async function runFallbackDetectorSweep(): Promise<{
  scanned: number;
  flagged: number;
  inserted: number;
}> {
  let scanned = 0;
  let flagged = 0;
  let inserted = 0;
  if (sweepInFlight) {
    console.warn("[Tranzmit] Fallback detector sweep skipped: previous sweep still running");
    return { scanned, flagged, inserted };
  }
  sweepInFlight = true;
  try {
    const scannedResult = await query<{ scanned: number }>(SCANNED_COUNT_SQL);
    scanned = Number(scannedResult.rows[0]?.scanned ?? 0);

    const candidates = await query<CandidateRow>(CANDIDATES_SQL);
    flagged = candidates.rows.length;

    for (const row of candidates.rows) {
      const parsed = parseResolvedProperty(row.properties?.resolved);
      const properties = {
        variant: parsed?.variant ?? "(unknown)",
        trigger: parsed?.trigger ?? "(unknown)",
        resolved_at: row.resolved_at,
        reason: "init_incomplete",
      };
      try {
        await query(
          `INSERT INTO events (public_key, user_id, session_id, event_name, properties, identity)
           VALUES ($1, $2, 'server-detector', '${FALLBACK_EVENT_NAME}', $3, '{}')`,
          [row.public_key, row.user_id, JSON.stringify(properties)]
        );
        inserted += 1;
      } catch (err) {
        console.warn("[Tranzmit] Fallback detector insert failed:", err);
        continue;
      }

      if (statsigForwardingEnabled()) {
        await forwardToStatsig({
          publicKey: row.public_key,
          userId: row.user_id,
          variant: properties.variant,
          trigger: properties.trigger,
        });
      }
    }
  } catch (err) {
    console.warn("[Tranzmit] Fallback detector sweep failed:", err);
  } finally {
    sweepInFlight = false;
  }

  console.log(
    `[Tranzmit] Fallback detector sweep: scanned=${scanned} flagged=${flagged} inserted=${inserted}`
  );
  return { scanned, flagged, inserted };
}

/**
 * Starts the periodic sweep. OFF unless FALLBACK_DETECTOR_ENABLED=1 so the
 * deploy is inert until explicitly enabled. Timers are unref'd so they never
 * keep the process alive during shutdown.
 */
export function startFallbackDetector(): NodeJS.Timeout | null {
  if (process.env.FALLBACK_DETECTOR_ENABLED !== "1") {
    console.log(
      "[Tranzmit] Fallback detector disabled (set FALLBACK_DETECTOR_ENABLED=1 to enable)"
    );
    return null;
  }

  setTimeout(() => {
    void runFallbackDetectorSweep();
  }, INITIAL_DELAY_MS).unref();

  const interval = setInterval(() => {
    void runFallbackDetectorSweep();
  }, SWEEP_INTERVAL_MS);
  interval.unref();

  console.log(
    `[Tranzmit] Fallback detector enabled (first sweep in ${INITIAL_DELAY_MS / 1000}s, every ${SWEEP_INTERVAL_MS / 60000}min)`
  );
  return interval;
}
