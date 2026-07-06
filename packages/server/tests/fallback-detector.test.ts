// The Flutter SDK only fires `page_view` after a fully successful init
// (config POST + hosted-document fetch), so a `paywall_resolved` with no
// nearby page_view means the user saw the customer app's fallback paywall.
// These tests pin the sweep's SQL contract (windows, NOT EXISTS page_view,
// re-run-safe dedup), the inserted event shape, Statsig forwarding, and the
// off-by-default startup gate.
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let candidateRows: Array<Record<string, unknown>> = [];
let scannedCount = 0;
let insertShouldFail = false;

vi.mock("../src/db.js", () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    if (/COUNT\(\*\)::int AS scanned/i.test(sql)) return { rows: [{ scanned: scannedCount }] };
    if (/INSERT INTO events/i.test(sql)) {
      if (insertShouldFail) throw new Error("insert failed");
      return { rows: [] };
    }
    if (/event_name = 'paywall_resolved'/i.test(sql)) return { rows: candidateRows };
    return { rows: [] };
  }),
}));

const logEvent = vi.fn();
vi.mock("../src/statsig.js", () => ({
  EVENT_PREFIX: "tranzmit_",
  getProjectConfigForPublicKey: vi.fn(async () => ({
    projectName: "influish",
    serverSecretEnvVar: "STATSIG_SERVER_SECRET",
  })),
  getStatsigServer: vi.fn(async () => ({ logEvent })),
}));

function candidateSql(): string | undefined {
  return queryCalls.find((call) => /NOT EXISTS/i.test(call.sql))?.sql;
}

function insertCalls(): Array<{ sql: string; params: unknown[] }> {
  return queryCalls.filter((call) => /INSERT INTO events/i.test(call.sql));
}

beforeEach(() => {
  queryCalls.length = 0;
  candidateRows = [];
  scannedCount = 0;
  insertShouldFail = false;
  logEvent.mockClear();
  delete process.env.FALLBACK_DETECTOR_ENABLED;
  delete process.env.FALLBACK_DETECTOR_STATSIG;
});

describe("runFallbackDetectorSweep", () => {
  it("inserts paywall_fallback_inferred for a resolve without a nearby page_view", async () => {
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    scannedCount = 7;
    candidateRows = [
      {
        public_key: "pk_test_valid",
        user_id: "u_cellular",
        properties: { resolved: "upgrade_pro=intro_offer", intent: "(none)" },
        resolved_at: "2026-07-06T13:05:00.123Z",
      },
    ];

    const summary = await runFallbackDetectorSweep();

    expect(summary).toEqual({ scanned: 7, flagged: 1, inserted: 1 });
    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("'paywall_fallback_inferred'");
    expect(inserts[0].sql).toContain("'server-detector'");
    expect(inserts[0].params[0]).toBe("pk_test_valid");
    expect(inserts[0].params[1]).toBe("u_cellular");
    expect(JSON.parse(inserts[0].params[2] as string)).toEqual({
      variant: "intro_offer",
      trigger: "upgrade_pro",
      resolved_at: "2026-07-06T13:05:00.123Z",
      reason: "init_incomplete",
    });
  });

  it("selects only resolves in the settled 25-15 minute window with no page_view in -5/+10 minutes", async () => {
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    await runFallbackDetectorSweep();

    const sql = candidateSql();
    expect(sql).toBeDefined();
    expect(sql).toContain("event_name = 'paywall_resolved'");
    expect(sql).toMatch(/BETWEEN now\(\) - interval '25 minutes' AND now\(\) - interval '15 minutes'/);
    // The page_view exclusion: same public_key + user_id, near the resolve.
    expect(sql).toMatch(/NOT EXISTS[\s\S]*event_name = 'page_view'[\s\S]*pv\.public_key = r\.public_key[\s\S]*pv\.user_id = r\.user_id/);
    expect(sql).toMatch(/r\.created_at - interval '5 minutes'/);
    expect(sql).toMatch(/r\.created_at \+ interval '10 minutes'/);
    // No candidates -> nothing inserted.
    expect(insertCalls()).toHaveLength(0);
  });

  it("dedup: excludes resolves already flagged, keyed on the exact SQL-rendered resolved_at", async () => {
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    scannedCount = 3;
    candidateRows = [
      {
        public_key: "pk_test_valid",
        user_id: "u_1",
        properties: { resolved: "upgrade_pro=original" },
        resolved_at: "2026-07-06T13:00:00.000Z",
      },
    ];
    await runFallbackDetectorSweep();

    const sql = candidateSql();
    expect(sql).toMatch(/NOT EXISTS[\s\S]*event_name = 'paywall_fallback_inferred'[\s\S]*f\.properties->>'resolved_at'/);
    // Re-run safety: the dedup compares against the SAME to_char() rendering
    // the sweep selects AND inserts, so the value round-trips byte-identically.
    const isoRenderings = sql!.match(/to_char\(r\.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/g);
    expect(isoRenderings?.length).toBe(2);
    const insert = insertCalls()[0];
    expect(JSON.parse(insert.params[2] as string).resolved_at).toBe("2026-07-06T13:00:00.000Z");
  });

  it("re-running with the same candidates does not double-insert once the DB dedup filters them", async () => {
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    scannedCount = 1;
    candidateRows = [
      {
        public_key: "pk_test_valid",
        user_id: "u_1",
        properties: { resolved: "upgrade_pro=original" },
        resolved_at: "2026-07-06T13:00:00.000Z",
      },
    ];
    const first = await runFallbackDetectorSweep();
    expect(first.inserted).toBe(1);

    // Second sweep: the NOT EXISTS dedup now filters the row out in SQL.
    candidateRows = [];
    const second = await runFallbackDetectorSweep();
    expect(second).toEqual({ scanned: 1, flagged: 0, inserted: 0 });
    expect(insertCalls()).toHaveLength(1);
  });

  it("forwards each inserted event to Statsig with prefixed name and metadata", async () => {
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    candidateRows = [
      {
        public_key: "pk_test_valid",
        user_id: "u_cellular",
        properties: { resolved: "upgrade_pro=intro_offer (baseline)" },
        resolved_at: "2026-07-06T13:05:00.123Z",
      },
    ];
    await runFallbackDetectorSweep();

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      { userID: "u_cellular" },
      "tranzmit_paywall_fallback_inferred",
      null,
      { variant: "intro_offer", trigger: "upgrade_pro", reason: "init_incomplete" }
    );
  });

  it("skips Statsig forwarding when FALLBACK_DETECTOR_STATSIG=0 but still inserts", async () => {
    process.env.FALLBACK_DETECTOR_STATSIG = "0";
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    candidateRows = [
      {
        public_key: "pk_test_valid",
        user_id: "u_1",
        properties: { resolved: "upgrade_pro=original" },
        resolved_at: "2026-07-06T13:00:00.000Z",
      },
    ];
    const summary = await runFallbackDetectorSweep();

    expect(summary.inserted).toBe(1);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("Statsig forwarding failures do not break the sweep", async () => {
    const statsig = await import("../src/statsig.js");
    vi.mocked(statsig.getStatsigServer).mockRejectedValueOnce(new Error("statsig down"));
    const { runFallbackDetectorSweep } = await import("../src/fallback-detector.js");
    candidateRows = [
      {
        public_key: "pk_test_valid",
        user_id: "u_1",
        properties: { resolved: "upgrade_pro=original" },
        resolved_at: "2026-07-06T13:00:00.000Z",
      },
    ];
    const summary = await runFallbackDetectorSweep();
    expect(summary.inserted).toBe(1);
  });
});

describe("parseResolvedProperty", () => {
  it("parses trigger/variant, baseline suffixes, and multi-placement strings", async () => {
    const { parseResolvedProperty } = await import("../src/fallback-detector.js");
    expect(parseResolvedProperty("upgrade_pro=original")).toEqual({ trigger: "upgrade_pro", variant: "original" });
    expect(parseResolvedProperty("upgrade_pro=control (baseline)")).toEqual({ trigger: "upgrade_pro", variant: "control" });
    expect(parseResolvedProperty("upgrade_pro=intro_offer, other=x")).toEqual({ trigger: "upgrade_pro", variant: "intro_offer" });
    expect(parseResolvedProperty("")).toBeNull();
    expect(parseResolvedProperty(undefined)).toBeNull();
  });
});

describe("startFallbackDetector", () => {
  it("is disabled by default: returns null and runs no queries", async () => {
    const { startFallbackDetector } = await import("../src/fallback-detector.js");
    expect(startFallbackDetector()).toBeNull();
    expect(queryCalls).toHaveLength(0);
  });

  it("returns an interval when FALLBACK_DETECTOR_ENABLED=1", async () => {
    process.env.FALLBACK_DETECTOR_ENABLED = "1";
    const { startFallbackDetector } = await import("../src/fallback-detector.js");
    const interval = startFallbackDetector();
    expect(interval).not.toBeNull();
    clearInterval(interval as NodeJS.Timeout);
  });
});
