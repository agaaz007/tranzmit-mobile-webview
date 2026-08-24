import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin API is consumed across repos: the behaviour-md dashboard's Live tab
 * reads these fields to render release history. Dropping one is a silent
 * breakage — the dashboard keeps rendering, it just quietly shows something
 * less true, and no test in either repo fails.
 *
 * `legacy_updated_at` is the case that already bit us. A backfilled release's
 * `created_at` is the migration run, not the day the paywall was pushed, so the
 * HiAstro catalogue read as "released 23 August" when it actually shipped in
 * June. The original timestamp is preserved on the content revision; this pins
 * it to the response so a future tidy-up of the query cannot drop it silently.
 */
const source = readFileSync(
  resolve(__dirname, "../src/config-store.ts"),
  "utf8"
);

function environmentPaywallQuery(): string {
  const start = source.indexOf("export async function getEnvironmentPaywall");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("export async function", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("getEnvironmentPaywall response contract", () => {
  const query = environmentPaywallQuery();

  it("exposes the original push date for backfilled releases", () => {
    expect(query).toContain("'legacy_updated_at', cr.legacy_updated_at");
  });

  it("still exposes the fields the dashboard renders release history from", () => {
    for (const field of [
      "'id', r.id",
      "'release_number', r.release_number",
      "'content_hash', cr.content_hash",
      "'products', r.products",
      "'created_by', r.created_by",
      "'created_at', r.created_at",
      "'is_current', r.id = b.current_release_id",
    ]) {
      expect(query, `${field} is consumed by the Live tab`).toContain(field);
    }
  });
});
