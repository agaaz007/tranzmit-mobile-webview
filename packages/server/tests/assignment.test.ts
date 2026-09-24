import { describe, expect, it } from "vitest";
import {
  assignFixedSplit,
  assignmentEventProperties,
  assignmentId,
  assignmentStampEnabled,
  assignmentUnit,
  buildStatsigStamp,
  hashUnitInterval,
  normalizeAssignmentSettings,
  reconcileServedVariant,
  type AssignmentStamp,
  type FixedSplitInput,
  type StatsigResolution,
} from "../src/assignment.js";
import { mapIdentityToStatsigUser } from "../src/statsig.js";

const MECHANISMS = [
  "fixed_uniform", "fixed_weighted", "adaptive_bandit", "sticky_replay", "holdout_forced", "fallback_default",
];

function split(overrides: Partial<FixedSplitInput> = {}): FixedSplitInput {
  return {
    placementId: "pl_upgrade",
    revisionId: "rev-1",
    trigger: "upgrade_pro",
    salt: null,
    holdoutPercent: 0,
    defaultVariantKey: "control",
    variants: [
      { variantKey: "control", weight: 1 },
      { variantKey: "marriage-01", weight: 1 },
      { variantKey: "marriage-02", weight: 1 },
      { variantKey: "marriage-03", weight: 1 },
    ],
    traits: { intent: "marriage" },
    unit: "user-1",
    unitType: "user_id",
    ...overrides,
  };
}

function units(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `user-${index}`);
}

function probabilityOf(stamp: AssignmentStamp, variantKey: string): number | null | undefined {
  return stamp.candidates.find((candidate) => candidate.variant_key === variantKey)?.probability;
}

/**
 * Spec acceptance checks B-E, evaluated on one stamp. B only applies where the
 * stamp claims exact probabilities; for "unknown" every probability is null.
 */
function specViolations(stamp: AssignmentStamp, resolved: string): string[] {
  const violations: string[] = [];
  if (!MECHANISMS.includes(stamp.mechanism)) violations.push("E: mechanism not in enum");
  if (stamp.probability_source === "exact") {
    const sum = stamp.candidates.reduce((total, candidate) => total + Number(candidate.probability), 0);
    if (Math.abs(1 - sum) > 1e-6) violations.push(`B: probabilities sum to ${sum}`);
  } else if (stamp.candidates.some((candidate) => candidate.probability !== null)) {
    violations.push("B: unknown probability_source with a numeric probability");
  }
  const chosen = stamp.candidates.find((candidate) => candidate.variant_key === stamp.chosen);
  if (!chosen || chosen.eligible !== true) violations.push("C: chosen not an eligible candidate");
  const entry = resolved.split(",").map((item) => item.trim())
    .find((item) => item.startsWith(`${stamp.trigger}=`));
  const resolvedVariant = entry?.slice(stamp.trigger.length + 1).replace(/\s*\(baseline\)\s*$/, "");
  if (resolvedVariant !== stamp.chosen) violations.push(`D: resolved ${resolvedVariant} != chosen ${stamp.chosen}`);
  for (const candidate of stamp.candidates) {
    if (candidate.eligible === false && candidate.probability !== 0) violations.push("rule 2: ineligible arm with probability");
  }
  return violations;
}

describe("hashing and ids", () => {
  it("hashes deterministically into the open unit interval", () => {
    const first = hashUnitInterval(["fixed-split-v1", "arm", "pl", "salt", "user-1", "control"]);
    expect(hashUnitInterval(["fixed-split-v1", "arm", "pl", "salt", "user-1", "control"])).toBe(first);
    expect(hashUnitInterval(["fixed-split-v1", "arm", "pl", "salt", "user-2", "control"])).not.toBe(first);
    // Field boundaries are unambiguous: ("ab","c") and ("a","bc") differ.
    expect(hashUnitInterval(["ab", "c"])).not.toBe(hashUnitInterval(["a", "bc"]));
    for (const unit of units(2000)) {
      const value = hashUnitInterval(["x", unit]);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("derives a stable assignment_id per unit x placement x revision", () => {
    const id = assignmentId("pl_upgrade", "rev-1", "user-1");
    expect(id).toMatch(/^asg_[0-9a-f]{32}$/);
    expect(assignmentId("pl_upgrade", "rev-1", "user-1")).toBe(id);
    expect(assignmentId("pl_upgrade", "rev-2", "user-1")).not.toBe(id);
    expect(assignmentId("pl_other", "rev-1", "user-1")).not.toBe(id);
    expect(assignmentId("pl_upgrade", "rev-1", "user-2")).not.toBe(id);
    expect(assignmentId("pl_upgrade", null, "user-1")).toBe(assignmentId("pl_upgrade", "legacy", "user-1"));
  });

  it("randomizes the same unit Statsig does and records which identifier it was", () => {
    const loggedIn = { userId: "u1", identifiers: { stableID: "s1" }, traits: {}, privateTraits: {}, storageUserId: "u1" };
    const anonymous = { identifiers: { stableID: "s1" }, traits: {}, privateTraits: {}, storageUserId: "s1" };
    const otherId = { identifiers: { deviceID: "d1" }, traits: {}, privateTraits: {}, storageUserId: "d1" };
    expect(assignmentUnit(loggedIn)).toEqual({ unit: "u1", unitType: "user_id" });
    expect(assignmentUnit(anonymous)).toEqual({ unit: "s1", unitType: "stable_id" });
    expect(assignmentUnit(otherId)).toEqual({ unit: "d1", unitType: "storage_id" });
    for (const identity of [loggedIn, anonymous, otherId]) {
      expect(assignmentUnit(identity).unit).toBe(mapIdentityToStatsigUser(identity).userID);
    }
  });
});

describe("fixed split assignment", () => {
  it("is deterministic and independent of variant order", () => {
    for (const unit of units(200)) {
      const forward = assignFixedSplit(split({ unit }));
      const again = assignFixedSplit(split({ unit }));
      const reversed = assignFixedSplit(split({ unit, variants: [...split().variants].reverse() }));
      expect(again.chosen).toBe(forward.chosen);
      expect(reversed.chosen).toBe(forward.chosen);
      expect(again.assignment_id).toBe(forward.assignment_id);
    }
  });

  it("logs exact, unrounded weight / total probabilities", () => {
    const uniform = assignFixedSplit(split({ variants: split().variants.slice(0, 3) }));
    expect(uniform.mechanism).toBe("fixed_uniform");
    expect(uniform.probability_source).toBe("exact");
    expect(uniform.candidates.map((candidate) => candidate.probability)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(probabilityOf(uniform, "control")).toBe(0.3333333333333333);

    const weighted = assignFixedSplit(split({
      variants: [
        { variantKey: "control", weight: 50 },
        { variantKey: "marriage-01", weight: 30 },
        { variantKey: "marriage-02", weight: 20 },
      ],
    }));
    expect(weighted.mechanism).toBe("fixed_weighted");
    expect(weighted.candidates).toEqual([
      { variant_key: "control", probability: 0.5, weight: 50, eligible: true },
      { variant_key: "marriage-01", probability: 0.3, weight: 30, eligible: true },
      { variant_key: "marriage-02", probability: 0.2, weight: 20, eligible: true },
    ]);
    expect(specViolations(weighted, `upgrade_pro=${weighted.chosen}`)).toEqual([]);
  });

  it("realizes the declared probabilities (spec check F)", () => {
    const counts = new Map<string, number>();
    let holdouts = 0;
    const population = units(20_000);
    let declared: AssignmentStamp | null = null;
    for (const unit of population) {
      const stamp = assignFixedSplit(split({
        unit,
        holdoutPercent: 10,
        variants: [
          { variantKey: "control", weight: 50 },
          { variantKey: "marriage-01", weight: 30 },
          { variantKey: "marriage-02", weight: 20 },
        ],
      }));
      if (stamp.is_holdout) {
        holdouts += 1;
        continue;
      }
      declared = stamp;
      counts.set(stamp.chosen, (counts.get(stamp.chosen) || 0) + 1);
    }
    expect(Math.abs(holdouts / population.length - 0.1)).toBeLessThan(0.01);
    const randomized = population.length - holdouts;
    for (const candidate of declared!.candidates) {
      const share = (counts.get(candidate.variant_key) || 0) / randomized;
      expect(Math.abs(share - Number(candidate.probability))).toBeLessThan(0.015);
    }
  });

  it("forces the default variant for holdout units and logs the holdout probability", () => {
    const population = units(4000).map((unit) => assignFixedSplit(split({ unit, holdoutPercent: 25 })));
    const holdout = population.filter((stamp) => stamp.is_holdout);
    expect(Math.abs(holdout.length / population.length - 0.25)).toBeLessThan(0.025);
    for (const stamp of holdout) {
      expect(stamp).toMatchObject({
        chosen: "control",
        mechanism: "holdout_forced",
        allocator: "fixed_split_hash",
        holdout_probability: 0.25,
        probability_source: "exact",
      });
      expect(probabilityOf(stamp, "control")).toBe(1);
      expect(stamp.candidates.filter((candidate) => candidate.variant_key !== "control")
        .every((candidate) => candidate.probability === 0 && candidate.eligible === false)).toBe(true);
      expect(specViolations(stamp, "upgrade_pro=control")).toEqual([]);
    }
    for (const stamp of population.filter((item) => !item.is_holdout)) {
      expect(stamp.holdout_probability).toBe(0.25);
      expect(stamp.mechanism).toBe("fixed_uniform");
    }

    expect(units(500).some((unit) => assignFixedSplit(split({ unit, holdoutPercent: 0 })).is_holdout)).toBe(false);
  });

  it("keeps holdout membership fixed when arm weights change", () => {
    for (const unit of units(1000)) {
      const before = assignFixedSplit(split({ unit, holdoutPercent: 20 }));
      const after = assignFixedSplit(split({
        unit,
        holdoutPercent: 20,
        revisionId: "rev-2",
        variants: [{ variantKey: "control", weight: 10 }, { variantKey: "marriage-01", weight: 90 }],
      }));
      expect(after.is_holdout).toBe(before.is_holdout);
    }
  });

  it("keeps assignments across revisions unless the salt changes", () => {
    let moved = 0;
    for (const unit of units(1000)) {
      const original = assignFixedSplit(split({ unit }));
      const republished = assignFixedSplit(split({ unit, revisionId: "rev-2" }));
      expect(republished.chosen).toBe(original.chosen);
      expect(republished.assignment_id).not.toBe(original.assignment_id);
      expect(republished.policy_version).toBe("rev:rev-2");
      if (assignFixedSplit(split({ unit, salt: "marriage-exp-2" })).chosen !== original.chosen) moved += 1;
    }
    expect(assignFixedSplit(split()).policy_id).toBe("fixed_split:pl_upgrade");
    expect(assignFixedSplit(split({ salt: "marriage-exp-2" })).policy_id).toBe("fixed_split:marriage-exp-2");
    // A new salt is a fresh randomization: about 3/4 of units land elsewhere with 4 equal arms.
    expect(moved).toBeGreaterThan(650);
  });

  it("only moves units into an added arm", () => {
    for (const unit of units(1000)) {
      const before = assignFixedSplit(split({ unit }));
      const after = assignFixedSplit(split({
        unit,
        variants: [...split().variants, { variantKey: "marriage-04", weight: 1 }],
      }));
      if (after.chosen !== "marriage-04") expect(after.chosen).toBe(before.chosen);
    }
  });

  it("filters ineligible arms, renormalizes over the rest, and keeps them in the candidate list", () => {
    const variants = [
      { variantKey: "control", weight: 1 },
      { variantKey: "marriage-01", weight: 1, eligibility: { intent: ["marriage"] } },
      { variantKey: "marriage-02", weight: 2, eligibility: { intent: "marriage" } },
      { variantKey: "career-01", weight: 1, eligibility: { intent: ["career"] } },
    ];
    const marriage = assignFixedSplit(split({ variants, traits: { intent: "marriage" } }));
    expect(marriage.candidates).toEqual([
      { variant_key: "control", probability: 0.25, weight: 1, eligible: true },
      { variant_key: "marriage-01", probability: 0.25, weight: 1, eligible: true },
      { variant_key: "marriage-02", probability: 0.5, weight: 2, eligible: true },
      { variant_key: "career-01", probability: 0, weight: 1, eligible: false },
    ]);
    expect(marriage.mechanism).toBe("fixed_weighted");

    const career = assignFixedSplit(split({ variants, traits: { intent: "career" } }));
    expect(career.candidates.map((candidate) => [candidate.variant_key, candidate.probability, candidate.eligible]))
      .toEqual([["control", 0.5], ["marriage-01", 0], ["marriage-02", 0], ["career-01", 0.5]]
        .map(([key, probability]) => [key, probability, probability !== 0]));
    expect(career.mechanism).toBe("fixed_uniform");

    const none = assignFixedSplit(split({ variants, traits: {} }));
    expect(probabilityOf(none, "control")).toBe(1);

    for (const unit of units(1000)) {
      const stamp = assignFixedSplit(split({ unit, variants, traits: { intent: "career" } }));
      expect(["control", "career-01"]).toContain(stamp.chosen);
      expect(specViolations(stamp, `upgrade_pro=${stamp.chosen}`)).toEqual([]);
    }
  });

  it("never serves a zero-weight arm and falls back to the default when nothing is eligible", () => {
    const zero = [
      { variantKey: "control", weight: 0 },
      { variantKey: "marriage-01", weight: 5, eligibility: { intent: ["marriage"] } },
    ];
    for (const unit of units(300)) {
      expect(assignFixedSplit(split({ unit, variants: zero })).chosen).toBe("marriage-01");
    }
    const stamp = assignFixedSplit(split({ variants: zero, traits: { intent: "career" } }));
    expect(stamp).toMatchObject({
      chosen: "control",
      mechanism: "fallback_default",
      fallback_reason: "no_eligible_variant",
      probability_source: "exact",
    });
    expect(stamp.candidates).toEqual([
      { variant_key: "control", probability: 1, weight: 0, eligible: true },
      { variant_key: "marriage-01", probability: 0, weight: 5, eligible: false },
    ]);
  });

  it("stamps every field the spec requires", () => {
    const stamp = assignFixedSplit(split({ holdoutPercent: 10, salt: "exp-1" }));
    expect(stamp).toEqual({
      schema_version: 1,
      assignment_id: assignmentId("pl_upgrade", "rev-1", "user-1"),
      placement_id: "pl_upgrade",
      revision_id: "rev-1",
      trigger: "upgrade_pro",
      chosen: stamp.chosen,
      served: true,
      mechanism: stamp.is_holdout ? "holdout_forced" : "fixed_uniform",
      allocator: "fixed_split_hash",
      policy_id: "fixed_split:exp-1",
      policy_version: "rev:rev-1",
      is_holdout: stamp.is_holdout,
      holdout_probability: 0.1,
      probability_source: "exact",
      unit_type: "user_id",
      candidates: expect.any(Array),
    });
  });
});

describe("Statsig-path stamps", () => {
  const details = { ruleId: "rule_x", groupName: "Group X", reason: "Network", configSyncTime: 1780000000000 };

  function statsig(resolution: Partial<StatsigResolution>, variantKeys = ["control", "marriage-01", "marriage-02"]) {
    return buildStatsigStamp({
      placementId: "pl_upgrade",
      revisionId: "rev-7",
      trigger: "upgrade_pro",
      defaultVariantKey: "control",
      variantKeys,
      resolution: {
        assignedVariantId: "control",
        viaBaseline: false,
        experimentId: null,
        baselineExperimentId: null,
        baseline: null,
        experiment: null,
        ...resolution,
      },
      unit: "user-1",
      unitType: "user_id",
    });
  }

  it("baseline holdout: forced control, exact conditional probability, unknown holdout share", () => {
    const stamp = statsig({
      viaBaseline: true,
      baselineExperimentId: "hiastro_baseline",
      baseline: { useAutotune: false, variantId: "control", details },
    });
    expect(stamp).toMatchObject({
      mechanism: "holdout_forced",
      allocator: "statsig_baseline_holdout",
      policy_id: "hiastro_baseline",
      policy_version: "rev:rev-7|statsig_lcut:1780000000000",
      is_holdout: true,
      holdout_probability: null,
      probability_source: "exact",
      statsig: {
        baseline: {
          experiment_id: "hiastro_baseline",
          status: "assigned",
          use_autotune: false,
          variant_id: "control",
          rule_id: "rule_x",
          group_name: "Group X",
          reason: "Network",
          config_sync_time: 1780000000000,
        },
        experiment: null,
      },
    });
    expect(stamp.candidates).toEqual([
      { variant_key: "control", probability: 1, weight: null, eligible: true },
      { variant_key: "marriage-01", probability: 0, weight: null, eligible: false },
      { variant_key: "marriage-02", probability: 0, weight: null, eligible: false },
    ]);
    expect(specViolations(stamp, "upgrade_pro=control (baseline)")).toEqual([]);
  });

  it("autotune: adaptive, probabilities and weights null, never invented", () => {
    const stamp = statsig({
      assignedVariantId: "marriage-02",
      experimentId: "paywall_intent_marriage",
      baselineExperimentId: "hiastro_baseline",
      baseline: { useAutotune: true, variantId: null, details },
      experiment: { status: "assigned", rawVariantId: "marriage-02", details: { ...details, ruleId: "autotune_rule" } },
    });
    expect(stamp).toMatchObject({
      chosen: "marriage-02",
      mechanism: "adaptive_bandit",
      allocator: "statsig_autotune",
      policy_id: "paywall_intent_marriage",
      is_holdout: false,
      holdout_probability: null,
      probability_source: "unknown",
      statsig: { experiment: { experiment_id: "paywall_intent_marriage", rule_id: "autotune_rule", variant_id: "marriage-02" } },
    });
    expect(stamp.candidates).toEqual([
      { variant_key: "control", probability: null, weight: null, eligible: null },
      { variant_key: "marriage-01", probability: null, weight: null, eligible: null },
      { variant_key: "marriage-02", probability: null, weight: null, eligible: true },
    ]);
    expect(specViolations(stamp, "upgrade_pro=marriage-02")).toEqual([]);

    const noBaseline = statsig({
      assignedVariantId: "marriage-02",
      experimentId: "paywall_intent_marriage",
      experiment: { status: "assigned", rawVariantId: "marriage-02", details: null },
    });
    expect(noBaseline.holdout_probability).toBe(0);
    expect(noBaseline.policy_version).toBe("rev:rev-7|statsig_lcut:unknown");
  });

  it("Statsig failures are fallback_default with the failure named", () => {
    for (const status of ["unavailable", "error", "no_variant"] as const) {
      const stamp = statsig({
        experimentId: "paywall_intent_marriage",
        experiment: { status, rawVariantId: null, details: null },
      });
      expect(stamp).toMatchObject({
        chosen: "control",
        mechanism: "fallback_default",
        allocator: "statsig_autotune",
        fallback_reason: `statsig_${status}`,
        probability_source: "exact",
      });
      expect(specViolations(stamp, "upgrade_pro=control")).toEqual([]);
    }

    const noExperiment = statsig({
      baselineExperimentId: "hiastro_baseline",
      baseline: null,
    });
    expect(noExperiment).toMatchObject({
      mechanism: "fallback_default",
      fallback_reason: "no_experiment_for_traits",
      statsig: { baseline: { experiment_id: "hiastro_baseline", status: "unavailable", use_autotune: null } },
    });
  });

  it("a placement with no Statsig configuration is a static default with probability 1", () => {
    const stamp = statsig({}, ["control"]);
    expect(stamp).toMatchObject({
      mechanism: "fixed_uniform",
      allocator: "static_default",
      policy_id: "static:pl_upgrade",
      policy_version: "rev:rev-7",
      holdout_probability: 0,
      probability_source: "exact",
      candidates: [{ variant_key: "control", probability: 1, weight: null, eligible: true }],
    });
    expect(JSON.parse(JSON.stringify(stamp))).not.toHaveProperty("statsig");
    expect(specViolations(stamp, "upgrade_pro=control")).toEqual([]);

    const legacy = buildStatsigStamp({
      placementId: "pl_legacy",
      revisionId: null,
      trigger: "onboarding",
      defaultVariantKey: "var_default",
      variantKeys: [],
      resolution: {
        assignedVariantId: "var_default", viaBaseline: false, experimentId: null,
        baselineExperimentId: null, baseline: null, experiment: null,
      },
      unit: "user-1",
      unitType: "user_id",
    });
    expect(legacy).toMatchObject({ revision_id: null, policy_version: "legacy", chosen: "var_default" });
    expect(legacy.candidates).toEqual([{ variant_key: "var_default", probability: 1, weight: null, eligible: true }]);
  });

  it("records the served default when the allocator asked for an arm the routing lacks", () => {
    const requested = statsig({
      assignedVariantId: "arm-not-in-routing",
      experimentId: "paywall_intent_marriage",
      experiment: { status: "assigned", rawVariantId: "arm-not-in-routing", details },
    });
    const stamp = reconcileServedVariant(requested, "control");
    expect(stamp).toMatchObject({
      chosen: "control",
      mechanism: "fallback_default",
      fallback_reason: "variant_not_in_routing",
      probability_source: "exact",
      statsig: { experiment: { variant_id: "arm-not-in-routing" } },
    });
    expect(probabilityOf(stamp, "control")).toBe(1);
    expect(probabilityOf(stamp, "arm-not-in-routing")).toBe(0);
    expect(specViolations(stamp, "upgrade_pro=control")).toEqual([]);
    expect(reconcileServedVariant(stamp, "control")).toBe(stamp);
  });
});

describe("event properties and rollout flag", () => {
  it("puts the first trigger in `assignment` and the rest in `other_assignments`", () => {
    const first = assignFixedSplit(split());
    const second = assignFixedSplit(split({ placementId: "pl_kundli", trigger: "kundli_report" }));
    expect(assignmentEventProperties([first])).toEqual({ assignment: first });
    expect(assignmentEventProperties([first, second])).toEqual({ assignment: first, other_assignments: [second] });
    expect(assignmentEventProperties([])).toEqual({ assignment: null });
  });

  it("stamps everywhere by default, nowhere when off, and only allowlisted keys otherwise", () => {
    expect(assignmentStampEnabled("pk_live_a", undefined)).toBe(true);
    expect(assignmentStampEnabled("pk_live_a", "")).toBe(true);
    expect(assignmentStampEnabled("pk_live_a", "on")).toBe(true);
    expect(assignmentStampEnabled("pk_live_a", "off")).toBe(false);
    expect(assignmentStampEnabled("pk_live_a", "pk_live_a, pk_test_b")).toBe(true);
    expect(assignmentStampEnabled("pk_live_c", "pk_live_a,pk_test_b")).toBe(false);
  });
});

describe("revision assignment settings validation", () => {
  const variants = [
    { variantKey: "control", status: "active", weight: 50 },
    { variantKey: "marriage-02", status: "active", weight: 50, eligibility: { intent: ["marriage"] } },
  ];

  function errorsFor(input: Record<string, unknown>): string[] {
    const result = normalizeAssignmentSettings({ defaultVariantKey: "control", variants, ...input } as any);
    return result.ok ? [] : result.errors.map((error) => error.path);
  }

  it("defaults to statsig and leaves statsig revisions untouched", () => {
    expect(normalizeAssignmentSettings({
      defaultVariantKey: "control",
      variants: [{ variantKey: "control", weight: 200 }],
    })).toEqual({ ok: true, value: { mode: "statsig", holdoutPercent: 0, salt: null, eligibility: [null] } });
    expect(normalizeAssignmentSettings({
      assignmentMode: "statsig",
      holdoutPercent: 0,
      assignmentSalt: null,
      defaultVariantKey: "control",
      variants: [{ variantKey: "control" }],
    })).toMatchObject({ ok: true });
  });

  it("rejects fixed_split-only settings on statsig revisions instead of ignoring them", () => {
    expect(errorsFor({ assignmentMode: "statsig", holdoutPercent: 10 })).toContain("/holdoutPercent");
    expect(errorsFor({ assignmentSalt: "x" })).toContain("/assignmentSalt");
    expect(errorsFor({})).toContain("/variants/1/eligibility");
    expect(errorsFor({ assignmentMode: "bandit" })).toEqual(["/assignmentMode"]);
  });

  it("accepts a valid fixed split", () => {
    expect(normalizeAssignmentSettings({
      assignmentMode: "fixed_split",
      holdoutPercent: 12.5,
      assignmentSalt: "marriage-exp-2026-09",
      targetingRules: [],
      statsigExperimentId: null,
      defaultVariantKey: "control",
      variants,
    })).toEqual({
      ok: true,
      value: {
        mode: "fixed_split",
        holdoutPercent: 12.5,
        salt: "marriage-exp-2026-09",
        eligibility: [null, { intent: ["marriage"] }],
      },
    });
  });

  it("enforces weights >= 0, an eligible arm, and a 0-50% holdout", () => {
    const fixed = { assignmentMode: "fixed_split" };
    const withWeights = (...weights: unknown[]) => errorsFor({
      ...fixed,
      variants: weights.map((weight, index) => ({ variantKey: index ? `v${index}` : "control", weight })),
    });
    expect(withWeights(-1, 5)).toEqual(["/variants/0/weight"]);
    expect(withWeights(12.5, 5)).toEqual(["/variants/0/weight"]);
    expect(withWeights(101, 5)).toEqual(["/variants/0/weight"]);
    expect(withWeights(undefined, 5)).toEqual(["/variants/0/weight"]);
    expect(withWeights("50", 5)).toEqual(["/variants/0/weight"]);
    expect(withWeights(0, 0)).toEqual(["/variants"]);
    expect(withWeights(0, 5)).toEqual([]);
    expect(errorsFor({
      ...fixed,
      variants: [{ variantKey: "control", weight: 0 }, { variantKey: "v1", status: "paused", weight: 5 }],
    })).toEqual(["/variants"]);

    expect(errorsFor({ ...fixed, holdoutPercent: 50 })).toEqual([]);
    expect(errorsFor({ ...fixed, holdoutPercent: 50.01 })).toEqual(["/holdoutPercent"]);
    expect(errorsFor({ ...fixed, holdoutPercent: -1 })).toEqual(["/holdoutPercent"]);
    expect(errorsFor({ ...fixed, holdoutPercent: 12.345 })).toEqual(["/holdoutPercent"]);
    expect(errorsFor({ ...fixed, holdoutPercent: "10" })).toEqual(["/holdoutPercent"]);
    expect(errorsFor({ ...fixed, holdoutPercent: Number.NaN })).toEqual(["/holdoutPercent"]);
  });

  it("rejects Statsig routing and malformed eligibility on fixed_split revisions", () => {
    const fixed = { assignmentMode: "fixed_split" };
    expect(errorsFor({ ...fixed, statsigExperimentId: "paywall_intent_marriage" })).toEqual(["/statsigExperimentId"]);
    expect(errorsFor({ ...fixed, targetingRules: [{ type: "baseline", statsig_experiment_id: "b" }] }))
      .toEqual(["/targetingRules"]);
    expect(errorsFor({ ...fixed, assignmentSalt: "has space" })).toEqual(["/assignmentSalt"]);
    const eligibility = (rule: unknown) => errorsFor({
      ...fixed,
      variants: [{ variantKey: "control", weight: 1 }, { variantKey: "v1", weight: 1, eligibility: rule }],
    });
    expect(eligibility({})).toEqual(["/variants/1/eligibility"]);
    expect(eligibility(["marriage"])).toEqual(["/variants/1/eligibility"]);
    expect(eligibility({ intent: [] })).toEqual(["/variants/1/eligibility"]);
    expect(eligibility({ intent: { nested: true } })).toEqual(["/variants/1/eligibility"]);
    expect(eligibility({ intent: ["marriage", "love"], country: "IN" })).toEqual([]);
    expect(errorsFor({
      ...fixed,
      variants: [{ variantKey: "control", weight: 1, eligibility: { intent: "marriage" } }, { variantKey: "v1", weight: 1 }],
    })).toEqual(["/variants/0/eligibility"]);
  });
});
