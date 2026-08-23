import { describe, expect, it } from "vitest";

function legacySpec(name: string, id = "legacy-id") {
  return {
    id,
    workspace_id: "client-test",
    name,
    spec: {},
    status: "active",
    version: 1,
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
    created_by: null,
  };
}

describe("V2 backfill paywall identity mapping", () => {
  it("maps HiAstro marriage-02 to trial-reminder and marriage-03 to marriage", async () => {
    const { __private } = await import("../src/backfill-v2.js");

    expect(__private.logicalPaywallKey(
      "hiastro",
      legacySpec("Response_HiAstro marriage-02") as any
    )).toBe("trial-reminder");
    expect(__private.logicalPaywallKey(
      "hiastro",
      legacySpec("HiAstro marriage -03") as any
    )).toBe("marriage");
  });

  it("returns the same stable identity on repeated backfill mapping passes", async () => {
    const { __private } = await import("../src/backfill-v2.js");
    const input = legacySpec("Response_marriage-02", "spec-marriage-02") as any;

    expect([
      __private.logicalPaywallKey("hiastro", input),
      __private.logicalPaywallKey("hiastro", input),
    ]).toEqual(["trial-reminder", "trial-reminder"]);
  });
});
