// ============================================================================
// Assignment: how a placement picked its variant, and the stamp that records it.
//
// Every `paywall_resolved` event carries an `assignment` block describing the
// decision for each resolved placement: which arm was served, which mechanism
// chose it, what every candidate's probability was, and which policy version
// produced it. A readout can only correct for what was logged, so this module
// never invents a probability: when the allocator does not expose one (Statsig
// Autotune, the Statsig baseline split), the value is null and
// `probability_source` says so.
//
// It also implements the opt-in `fixed_split` assignment mode: a deterministic
// weighted hash over the revision's stored variant weights, with an optional
// holdout, whose probabilities are exact by construction.
//
// Spec: 2026-08-05 "Stamp the assignment propensity onto paywall_resolved".
// Deviations are documented in docs/assignment-stamp.md.
// ============================================================================
import { createHash } from "node:crypto";
import type { ResolvedIdentity } from "./identity.js";
import type { StatsigEvaluationDetails, VariantAssignmentStatus } from "./statsig.js";

export const ASSIGNMENT_STAMP_SCHEMA_VERSION = 1 as const;
export const ASSIGNMENT_MODES = ["statsig", "fixed_split"] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];
export const MAX_HOLDOUT_PERCENT = 50;
export const MAX_VARIANT_WEIGHT = 100;

/** The spec's mechanism enum: tells an analysis whether a row is interventional evidence. */
export type AssignmentMechanism =
  | "fixed_uniform"
  | "fixed_weighted"
  | "adaptive_bandit"
  | "sticky_replay"
  | "holdout_forced"
  | "fallback_default";

/** Which code path made the decision. */
export type AssignmentAllocator =
  | "fixed_split_hash"
  | "statsig_baseline_holdout"
  | "statsig_autotune"
  | "static_default";

export type AssignmentUnitType = "user_id" | "stable_id" | "storage_id";

export type FallbackReason =
  | "no_eligible_variant"
  | "variant_not_in_routing"
  | "no_experiment_for_traits"
  | `statsig_${Exclude<VariantAssignmentStatus, "assigned">}`;

export interface AssignmentCandidate {
  variant_key: string;
  /** P(this arm served | the layer the unit landed in). null = not observable. */
  probability: number | null;
  /** Raw stored weight when weights drive serving; null when they do not. */
  weight: number | null;
  /** false = could not have been served to this unit; null = not observable. */
  eligible: boolean | null;
}

export interface StatsigEvaluationStamp {
  experiment_id: string;
  status: VariantAssignmentStatus;
  variant_id: string | null;
  use_autotune?: boolean | null;
  rule_id: string | null;
  group_name: string | null;
  reason: string | null;
  config_sync_time: number | null;
}

export interface AssignmentStamp {
  schema_version: typeof ASSIGNMENT_STAMP_SCHEMA_VERSION;
  /** Stable per unit x placement x revision ("legacy" for legacy routing). Join and dedupe key. */
  assignment_id: string;
  placement_id: string;
  revision_id: string | null;
  trigger: string;
  /** The served variant_key; always equals the value `resolved` reports for this trigger. */
  chosen: string;
  /** false when the chosen variant's paywall release was missing and the placement served null. */
  served: boolean;
  mechanism: AssignmentMechanism;
  allocator: AssignmentAllocator;
  policy_id: string;
  policy_version: string;
  is_holdout: boolean;
  /** P(unit lands in the holdout layer). 0 = no holdout exists; null = not observable. */
  holdout_probability: number | null;
  /** Describes candidates[].probability: "exact" (sums to 1) or "unknown" (all null). */
  probability_source: "exact" | "unknown";
  unit_type: AssignmentUnitType;
  candidates: AssignmentCandidate[];
  fallback_reason?: FallbackReason;
  statsig?: {
    baseline: StatsigEvaluationStamp | null;
    experiment: StatsigEvaluationStamp | null;
  };
}

/** Trait conditions, same semantics as targeting-rule `when`: every key must match; arrays are any-of. */
export type EligibilityRule = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Unit and ids
// ---------------------------------------------------------------------------

/**
 * The randomization unit. Identical to the Statsig userID mapping and to the
 * `events.user_id` column written for `paywall_resolved`, so a fixed split
 * randomizes the same unit Statsig did and joins on the same key. Anonymous
 * traffic falls back to the device stableID; `unit_type` records which.
 */
export function assignmentUnit(identity: Pick<ResolvedIdentity, "userId" | "identifiers" | "storageUserId">): {
  unit: string;
  unitType: AssignmentUnitType;
} {
  if (identity.userId) return { unit: identity.userId, unitType: "user_id" };
  const stableId = identity.identifiers?.stableID;
  if (stableId) return { unit: stableId, unitType: "stable_id" };
  return { unit: identity.storageUserId, unitType: "storage_id" };
}

export function assignmentId(placementId: string, revisionId: string | null, unit: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["assignment-id-v1", placementId, revisionId ?? "legacy", unit]))
    .digest("hex");
  return `asg_${digest.slice(0, 32)}`;
}

/**
 * Deterministic value strictly inside (0, 1) from SHA-256. 48 bits stay within
 * JavaScript's exact integer range; the half step keeps -log(u) finite.
 */
export function hashUnitInterval(parts: readonly string[]): number {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest();
  return (digest.readUIntBE(0, 6) + 0.5) / 0x1000000000000;
}

// ---------------------------------------------------------------------------
// Trait matching (shared with Statsig targeting rules)
// ---------------------------------------------------------------------------

export function matchesTraits(when: unknown, traits: Record<string, unknown>): boolean {
  if (!when || typeof when !== "object" || Array.isArray(when)) return false;
  const entries = Object.entries(when);
  if (entries.length === 0) return false;
  return entries.every(([key, expected]) => traitMatches(traits[key], expected));
}

function traitMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => traitMatches(actual, item));
  if (Array.isArray(actual)) return actual.some((item) => traitMatches(item, expected));
  if (!isComparableTrait(actual) || !isComparableTrait(expected)) return false;
  return actual === expected;
}

function isComparableTrait(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// ---------------------------------------------------------------------------
// Fixed split
// ---------------------------------------------------------------------------

export interface FixedSplitVariant {
  variantKey: string;
  weight: number;
  eligibility?: EligibilityRule | null;
}

export interface FixedSplitInput {
  placementId: string;
  revisionId: string;
  trigger: string;
  /** Hash salt; null uses the placement id so assignments survive unrelated revisions. */
  salt: string | null;
  holdoutPercent: number;
  defaultVariantKey: string;
  /** Active routing variants in routing order. */
  variants: FixedSplitVariant[];
  traits: Record<string, unknown>;
  unit: string;
  unitType: AssignmentUnitType;
}

/**
 * Two independent deterministic draws per unit:
 *   1. Holdout layer: u < holdoutPercent/100 serves the default variant.
 *   2. Split layer: weighted rendezvous (exponential race) over the eligible
 *      positive-weight variants, so P(v) = w_v / sum(eligible w) exactly, and
 *      adding, removing or reordering arms only moves units into or out of the
 *      arms that changed.
 * Eligibility filters the arm set; it never reweights silently: every routing
 * variant is listed with its eligibility and the renormalized probability.
 */
export function assignFixedSplit(input: FixedSplitInput): AssignmentStamp {
  const salt = input.salt || input.placementId;
  const holdoutProbability = clampHoldout(input.holdoutPercent) / 100;
  const variants = withDefaultVariant(input.variants, input.defaultVariantKey);
  const base = {
    schema_version: ASSIGNMENT_STAMP_SCHEMA_VERSION,
    assignment_id: assignmentId(input.placementId, input.revisionId, input.unit),
    placement_id: input.placementId,
    revision_id: input.revisionId,
    trigger: input.trigger,
    served: true,
    allocator: "fixed_split_hash" as const,
    policy_id: `fixed_split:${salt}`,
    policy_version: `rev:${input.revisionId}`,
    holdout_probability: holdoutProbability,
    probability_source: "exact" as const,
    unit_type: input.unitType,
  };

  const holdoutDraw = hashUnitInterval(["fixed-split-v1", "holdout", input.placementId, salt, input.unit]);
  if (holdoutDraw < holdoutProbability) {
    return {
      ...base,
      chosen: input.defaultVariantKey,
      mechanism: "holdout_forced",
      is_holdout: true,
      candidates: forcedCandidates(variants, input.defaultVariantKey, true),
    };
  }

  const eligible = variants.filter((variant) => isEligible(variant, input.traits));
  const totalWeight = eligible.reduce((sum, variant) => sum + variant.weight, 0);
  if (eligible.length === 0 || totalWeight <= 0) {
    return {
      ...base,
      chosen: input.defaultVariantKey,
      mechanism: "fallback_default",
      fallback_reason: "no_eligible_variant",
      is_holdout: false,
      candidates: forcedCandidates(variants, input.defaultVariantKey, true),
    };
  }

  let chosen = eligible[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const variant of eligible) {
    const draw = hashUnitInterval(["fixed-split-v1", "arm", input.placementId, salt, input.unit, variant.variantKey]);
    const score = -Math.log(draw) / variant.weight;
    if (score < bestScore) {
      bestScore = score;
      chosen = variant;
    }
  }
  const eligibleKeys = new Set(eligible.map((variant) => variant.variantKey));
  const uniform = eligible.every((variant) => variant.weight === eligible[0].weight);
  return {
    ...base,
    chosen: chosen.variantKey,
    mechanism: uniform ? "fixed_uniform" : "fixed_weighted",
    is_holdout: false,
    candidates: variants.map((variant) => eligibleKeys.has(variant.variantKey)
      ? { variant_key: variant.variantKey, probability: variant.weight / totalWeight, weight: variant.weight, eligible: true }
      : { variant_key: variant.variantKey, probability: 0, weight: variant.weight, eligible: false }),
  };
}

function isEligible(variant: FixedSplitVariant, traits: Record<string, unknown>): boolean {
  if (!(variant.weight > 0)) return false;
  if (variant.eligibility == null) return true;
  return matchesTraits(variant.eligibility, traits);
}

function withDefaultVariant(variants: FixedSplitVariant[], defaultVariantKey: string): FixedSplitVariant[] {
  if (variants.some((variant) => variant.variantKey === defaultVariantKey)) return variants;
  return [{ variantKey: defaultVariantKey, weight: 0, eligibility: null }, ...variants];
}

function clampHoldout(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), MAX_HOLDOUT_PERCENT) : 0;
}

function forcedCandidates(
  variants: Array<{ variantKey: string; weight: number | null }>,
  chosen: string,
  includeWeights: boolean
): AssignmentCandidate[] {
  return variants.map((variant) => ({
    variant_key: variant.variantKey,
    probability: variant.variantKey === chosen ? 1 : 0,
    weight: includeWeights ? variant.weight : null,
    eligible: variant.variantKey === chosen,
  }));
}

// ---------------------------------------------------------------------------
// Statsig paths (baseline holdout, Autotune/experiment, static default)
// ---------------------------------------------------------------------------

export interface StatsigResolution {
  /** The variant the Statsig flow asked to serve (before routing fallback). */
  assignedVariantId: string;
  viaBaseline: boolean;
  experimentId: string | null;
  baselineExperimentId: string | null;
  baseline: {
    /** null = baseline lookup returned nothing (Statsig unavailable or threw). */
    useAutotune: boolean | null;
    variantId: string | null;
    details: StatsigEvaluationDetails | null;
  } | null;
  experiment: {
    status: VariantAssignmentStatus;
    rawVariantId: string | null;
    details: StatsigEvaluationDetails | null;
  } | null;
}

export function buildStatsigStamp(input: {
  placementId: string;
  revisionId: string | null;
  trigger: string;
  defaultVariantKey: string;
  /** Routing variant keys in routing order. */
  variantKeys: string[];
  resolution: StatsigResolution;
  unit: string;
  unitType: AssignmentUnitType;
}): AssignmentStamp {
  const { resolution } = input;
  const variants = uniqueKeys([...input.variantKeys, resolution.assignedVariantId])
    .map((variantKey) => ({ variantKey, weight: null }));
  const baselineStamp = resolution.baselineExperimentId
    ? {
        experiment_id: resolution.baselineExperimentId,
        status: resolution.baseline ? "assigned" as const : "unavailable" as const,
        variant_id: resolution.baseline?.variantId ?? null,
        use_autotune: resolution.baseline?.useAutotune ?? null,
        ...detailsStamp(resolution.baseline?.details ?? null),
      }
    : null;
  const experimentStamp = resolution.experimentId && resolution.experiment
    ? {
        experiment_id: resolution.experimentId,
        status: resolution.experiment.status,
        variant_id: resolution.experiment.rawVariantId,
        ...detailsStamp(resolution.experiment.details),
      }
    : null;
  const configSyncTime = experimentStamp?.config_sync_time ?? baselineStamp?.config_sync_time ?? null;
  const routingVersion = input.revisionId ? `rev:${input.revisionId}` : "legacy";
  const base = {
    schema_version: ASSIGNMENT_STAMP_SCHEMA_VERSION,
    assignment_id: assignmentId(input.placementId, input.revisionId, input.unit),
    placement_id: input.placementId,
    revision_id: input.revisionId,
    trigger: input.trigger,
    chosen: resolution.assignedVariantId,
    served: true,
    policy_version: `${routingVersion}|statsig_lcut:${configSyncTime ?? "unknown"}`,
    // Statsig's baseline split is configured in the Statsig console and is not
    // exposed by the SDK, so the holdout probability is unknown whenever a
    // baseline rule exists. Without one there is no holdout layer at all.
    holdout_probability: resolution.baselineExperimentId ? null : 0,
    unit_type: input.unitType,
    statsig: { baseline: baselineStamp, experiment: experimentStamp },
  };

  if (resolution.viaBaseline) {
    return {
      ...base,
      mechanism: "holdout_forced",
      allocator: "statsig_baseline_holdout",
      policy_id: resolution.baselineExperimentId || "statsig_baseline",
      is_holdout: true,
      probability_source: "exact",
      candidates: forcedCandidates(variants, resolution.assignedVariantId, false),
    };
  }

  if (resolution.experimentId) {
    const status = resolution.experiment?.status ?? "unavailable";
    if (status === "assigned") {
      return {
        ...base,
        mechanism: "adaptive_bandit",
        allocator: "statsig_autotune",
        policy_id: resolution.experimentId,
        is_holdout: false,
        probability_source: "unknown",
        candidates: variants.map((variant) => ({
          variant_key: variant.variantKey,
          probability: null,
          weight: null,
          eligible: variant.variantKey === resolution.assignedVariantId ? true : null,
        })),
      };
    }
    return {
      ...base,
      mechanism: "fallback_default",
      allocator: "statsig_autotune",
      policy_id: resolution.experimentId,
      fallback_reason: `statsig_${status}`,
      is_holdout: false,
      probability_source: "exact",
      candidates: forcedCandidates(variants, resolution.assignedVariantId, false),
    };
  }

  if (resolution.baselineExperimentId) {
    // The baseline sent this unit to the autotune arm (or was unavailable), but
    // no experiment exists for its traits, so the default was served.
    return {
      ...base,
      mechanism: "fallback_default",
      allocator: "statsig_autotune",
      policy_id: resolution.baselineExperimentId,
      fallback_reason: "no_experiment_for_traits",
      is_holdout: false,
      probability_source: "exact",
      candidates: forcedCandidates(variants, resolution.assignedVariantId, false),
    };
  }

  // No Statsig configuration: the placement always serves its default.
  return {
    ...base,
    mechanism: "fixed_uniform",
    allocator: "static_default",
    policy_id: `static:${input.placementId}`,
    policy_version: routingVersion,
    is_holdout: false,
    holdout_probability: 0,
    probability_source: "exact",
    candidates: forcedCandidates(variants, resolution.assignedVariantId, false),
    statsig: undefined,
  };
}

function detailsStamp(details: StatsigEvaluationDetails | null) {
  return {
    rule_id: details?.ruleId ?? null,
    group_name: details?.groupName ?? null,
    reason: details?.reason ?? null,
    config_sync_time: details?.configSyncTime ?? null,
  };
}

function uniqueKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.filter((key) => typeof key === "string" && key)));
}

/**
 * Makes the stamp describe what was actually served. The resolver serves its
 * default when an allocator asks for an arm the routing does not contain; the
 * stamp then records that fallback instead of the requested arm, so `chosen`
 * always agrees with `resolved`.
 */
export function reconcileServedVariant(stamp: AssignmentStamp, servedVariantKey: string): AssignmentStamp {
  if (stamp.chosen === servedVariantKey) return stamp;
  const keys = uniqueKeys([...stamp.candidates.map((candidate) => candidate.variant_key), servedVariantKey]);
  const weights = new Map(stamp.candidates.map((candidate) => [candidate.variant_key, candidate.weight]));
  return {
    ...stamp,
    chosen: servedVariantKey,
    mechanism: "fallback_default",
    fallback_reason: "variant_not_in_routing",
    probability_source: "exact",
    candidates: keys.map((variantKey) => ({
      variant_key: variantKey,
      probability: variantKey === servedVariantKey ? 1 : 0,
      weight: weights.get(variantKey) ?? null,
      eligible: variantKey === servedVariantKey,
    })),
  };
}

// ---------------------------------------------------------------------------
// Event stamping
// ---------------------------------------------------------------------------

/**
 * Rollout switch for the stamp (spec section 5). Unset or "on" stamps every
 * environment; "off" stamps none; any other value is a comma-separated
 * allowlist of public keys.
 */
export function assignmentStampEnabled(publicKey: string, raw = process.env.PAYWALL_ASSIGNMENT_STAMP): boolean {
  const value = (raw ?? "").trim();
  if (!value || ["on", "all", "1", "true"].includes(value.toLowerCase())) return true;
  if (["off", "none", "0", "false"].includes(value.toLowerCase())) return false;
  return value.split(",").map((item) => item.trim()).filter(Boolean).includes(publicKey);
}

/**
 * The `paywall_resolved` properties added by the stamp. `assignment` is the
 * decision for the first resolved trigger (the same trigger `resolved` lists
 * first); decisions for any further triggers go to `other_assignments` in the
 * same order, so no decision is logged twice.
 */
export function assignmentEventProperties(stamps: Array<AssignmentStamp | null>): Record<string, unknown> {
  const [primary = null, ...others] = stamps;
  return {
    assignment: primary,
    ...(others.length > 0 ? { other_assignments: others } : {}),
  };
}

// ---------------------------------------------------------------------------
// Revision settings validation (admin API)
// ---------------------------------------------------------------------------

export interface AssignmentSettingsInput {
  assignmentMode?: unknown;
  holdoutPercent?: unknown;
  assignmentSalt?: unknown;
  statsigExperimentId?: unknown;
  targetingRules?: unknown;
  defaultVariantKey?: unknown;
  variants: Array<{
    variantKey?: unknown;
    status?: unknown;
    weight?: unknown;
    eligibility?: unknown;
  }>;
}

export interface AssignmentSettings {
  mode: AssignmentMode;
  holdoutPercent: number;
  salt: string | null;
  /** Per input variant, in input order. */
  eligibility: Array<EligibilityRule | null>;
}

export type AssignmentSettingsIssue = { path: string; message: string };

export function normalizeAssignmentSettings(
  input: AssignmentSettingsInput
): { ok: true; value: AssignmentSettings } | { ok: false; errors: AssignmentSettingsIssue[] } {
  const errors: AssignmentSettingsIssue[] = [];
  const rawMode = input.assignmentMode ?? "statsig";
  if (!ASSIGNMENT_MODES.includes(rawMode as AssignmentMode)) {
    return { ok: false, errors: [{ path: "/assignmentMode", message: "Must be 'statsig' or 'fixed_split'" }] };
  }
  const mode = rawMode as AssignmentMode;
  const variants = Array.isArray(input.variants) ? input.variants : [];

  if (mode === "statsig") {
    if (input.holdoutPercent != null && input.holdoutPercent !== 0) {
      errors.push({ path: "/holdoutPercent", message: "Only fixed_split revisions take a holdout; Statsig owns the split in statsig mode" });
    }
    if (input.assignmentSalt != null) {
      errors.push({ path: "/assignmentSalt", message: "Only fixed_split revisions take an assignment salt" });
    }
    variants.forEach((variant, index) => {
      if (variant?.eligibility != null) {
        errors.push({ path: `/variants/${index}/eligibility`, message: "Variant eligibility only applies to fixed_split revisions" });
      }
    });
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, value: { mode, holdoutPercent: 0, salt: null, eligibility: variants.map(() => null) } };
  }

  if (typeof input.statsigExperimentId === "string" && input.statsigExperimentId.trim()) {
    errors.push({ path: "/statsigExperimentId", message: "fixed_split revisions do not consult Statsig; remove the experiment id" });
  }
  if (Array.isArray(input.targetingRules) ? input.targetingRules.length > 0 : input.targetingRules != null) {
    errors.push({ path: "/targetingRules", message: "fixed_split revisions ignore Statsig targeting rules; express intent targeting as variant eligibility" });
  }

  const holdoutPercent = input.holdoutPercent ?? 0;
  if (typeof holdoutPercent !== "number" || !Number.isFinite(holdoutPercent)) {
    errors.push({ path: "/holdoutPercent", message: "Must be a number" });
  } else if (holdoutPercent < 0 || holdoutPercent > MAX_HOLDOUT_PERCENT) {
    errors.push({ path: "/holdoutPercent", message: `Must be between 0 and ${MAX_HOLDOUT_PERCENT}` });
  } else if (Math.abs(holdoutPercent * 100 - Math.round(holdoutPercent * 100)) > 1e-9) {
    errors.push({ path: "/holdoutPercent", message: "At most two decimal places (it is stored exactly as NUMERIC(5,2))" });
  }

  let salt: string | null = null;
  if (input.assignmentSalt != null) {
    if (typeof input.assignmentSalt !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.assignmentSalt)) {
      errors.push({ path: "/assignmentSalt", message: "Must be 1-128 characters of A-Z a-z 0-9 . _ : -" });
    } else {
      salt = input.assignmentSalt;
    }
  }

  const eligibility: Array<EligibilityRule | null> = [];
  let positiveActive = 0;
  variants.forEach((variant, index) => {
    const path = `/variants/${index}`;
    const weight = variant?.weight;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > MAX_VARIANT_WEIGHT) {
      errors.push({ path: `${path}/weight`, message: `fixed_split needs an explicit integer weight between 0 and ${MAX_VARIANT_WEIGHT}` });
    } else if (weight > 0 && (variant.status ?? "active") === "active") {
      positiveActive += 1;
    }
    const rule = variant?.eligibility;
    if (rule == null) {
      eligibility.push(null);
      return;
    }
    const ruleError = eligibilityRuleError(rule);
    if (ruleError) {
      errors.push({ path: `${path}/eligibility`, message: ruleError });
    } else if (variant.variantKey === input.defaultVariantKey) {
      errors.push({ path: `${path}/eligibility`, message: "The default variant serves the holdout and every fallback, so it cannot be restricted" });
    }
    eligibility.push(rule as EligibilityRule);
  });
  if (positiveActive === 0) {
    errors.push({ path: "/variants", message: "fixed_split needs at least one active variant with weight > 0" });
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { mode, holdoutPercent: holdoutPercent as number, salt, eligibility } };
}

function eligibilityRuleError(rule: unknown): string | null {
  if (typeof rule !== "object" || Array.isArray(rule) || rule === null) {
    return "Must be an object of trait conditions, e.g. {\"intent\": [\"marriage\"]}";
  }
  const entries = Object.entries(rule);
  if (entries.length === 0) return "Must name at least one trait; omit eligibility to make the variant eligible for everyone";
  for (const [key, value] of entries) {
    if (!key.trim()) return "Trait names must be non-empty";
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || !values.every(isComparableTrait)) {
      return `Trait "${key}" must be a string, number, boolean, or a non-empty array of them`;
    }
  }
  return null;
}
