import type { ConfigResponse, PlacementConfig } from "@tranzmit/shared";
import { getPlacementsForKey } from "./db.js";
import {
  getConfigClient,
  getV2PublishedReleases,
  getV2PublishedRouting,
  type ConfigClient,
  type PublishedPlacementRouting,
} from "./config-store.js";
import type { ResolvedIdentity } from "./identity.js";
import { getBaselineDecision, getVariantAssignmentDetailed } from "./statsig.js";
import {
  assignFixedSplit,
  assignmentUnit,
  buildStatsigStamp,
  matchesTraits,
  reconcileServedVariant,
  type AssignmentStamp,
  type StatsigResolution,
} from "./assignment.js";
import {
  attachImmutableWebViewDocument,
  ensureWebViewSpec,
  type WebViewDocumentPayload,
} from "./webview-documents.js";
import { composePaywallSpec } from "./config-publish.js";

type TargetingRule = {
  type?: unknown;
  when?: Record<string, unknown>;
  statsig_experiment_id?: unknown;
  experiment_id?: unknown;
  experimentId?: unknown;
};

export interface ResolutionTrace {
  trigger: string;
  experimentId: string | null;
  viaBaseline: boolean;
  assignedVariantId: string;
  variant: string;
}

export interface ResolvedPlacements {
  placements: ConfigResponse["placements"];
  traces: ResolutionTrace[];
  /**
   * The assignment stamp for each trace, index-aligned with `traces`. null only
   * when building the stamp failed; serving never depends on it.
   */
  assignments: Array<AssignmentStamp | null>;
  source: "legacy" | "v2";
}

export async function resolveConfigPlacements(input: {
  publicKey: string;
  identity: ResolvedIdentity;
  apiBaseUrl: string;
  includeInline: boolean;
}): Promise<ResolvedPlacements> {
  const client = await getConfigClient(input.publicKey);
  if (client?.configSource === "v2") return resolveV2(input, client);
  return resolveLegacy(input);
}

async function resolveV2(
  input: {
    publicKey: string;
    identity: ResolvedIdentity;
    apiBaseUrl: string;
    includeInline: boolean;
  },
  client: ConfigClient
): Promise<ResolvedPlacements> {
  const routing = await getV2PublishedRouting(client.id);
  const selections: Array<{
    row: PublishedPlacementRouting;
    variantKey: string;
    bindingId: string;
    trace: ResolutionTrace;
    stamp: AssignmentStamp | null;
  }> = [];
  const placements: ConfigResponse["placements"] = {};
  const { unit, unitType } = assignmentUnit(input.identity);

  for (const row of routing) {
    if (row.status !== "active") {
      placements[row.trigger] = null;
      continue;
    }
    if (row.assignmentMode === "fixed_split") {
      // Native fixed split: Statsig (baseline and experiment) is never
      // consulted for this placement.
      const stamp = assignFixedSplit({
        placementId: row.placementId,
        revisionId: row.revisionId,
        trigger: row.trigger,
        salt: row.assignmentSalt ?? null,
        holdoutPercent: row.holdoutPercent ?? 0,
        defaultVariantKey: row.defaultVariantKey,
        variants: (row.variants || []).map((variant) => ({
          variantKey: variant.variantId,
          weight: variant.weight,
          eligibility: variant.eligibility ?? null,
        })),
        traits: input.identity.traits,
        unit,
        unitType,
      });
      const selected = selectV2Variant(row, stamp.chosen);
      selections.push({
        row,
        variantKey: selected.variantKey,
        bindingId: selected.bindingId,
        trace: {
          trigger: row.trigger,
          experimentId: null,
          viaBaseline: false,
          assignedVariantId: stamp.chosen,
          variant: selected.variantKey,
        },
        stamp: reconcileServedVariant(stamp, selected.variantKey),
      });
      continue;
    }
    const decision = await assignVariant({
      defaultVariant: row.defaultVariantKey,
      experimentId: row.experimentId,
      targetingRules: row.targetingRules,
      identity: input.identity,
      projectName: client.statsigProjectName,
      serverSecretEnvVar: client.statsigServerSecretEnvVar,
    });
    const selected = selectV2Variant(row, decision.assignedVariantId);
    selections.push({
      row,
      variantKey: selected.variantKey,
      bindingId: selected.bindingId,
      trace: {
        trigger: row.trigger,
        experimentId: decision.experimentId,
        viaBaseline: decision.viaBaseline,
        assignedVariantId: decision.assignedVariantId,
        variant: selected.variantKey,
      },
      stamp: safeStamp(row.trigger, () => reconcileServedVariant(buildStatsigStamp({
        placementId: row.placementId,
        revisionId: row.revisionId,
        trigger: row.trigger,
        defaultVariantKey: row.defaultVariantKey,
        variantKeys: (row.variants || []).map((variant) => variant.variantId),
        resolution: decision,
        unit,
        unitType,
      }), selected.variantKey)),
    });
  }

  const releases = await getV2PublishedReleases(
    client.id,
    Array.from(new Set(selections.map((selection) => selection.bindingId)))
  );
  const traces: ResolutionTrace[] = [];
  const assignments: Array<AssignmentStamp | null> = [];
  for (const selection of selections) {
    const release = releases.get(selection.bindingId);
    traces.push(selection.trace);
    assignments.push(selection.stamp ? { ...selection.stamp, served: Boolean(release) } : null);
    if (!release) {
      placements[selection.row.trigger] = null;
      continue;
    }
    const rawSpec = composePaywallSpec(release.content, release.products, release.checkout);
    const spec = attachImmutableWebViewDocument(
      rawSpec,
      release.documentPayload as unknown as WebViewDocumentPayload,
      {
        publicKey: input.publicKey,
        placementId: selection.row.placementId,
        variantKey: selection.variantKey,
        apiBaseUrl: input.apiBaseUrl,
        includeInline: input.includeInline,
        sdkStack: client.sdkStack,
      }
    );
    placements[selection.row.trigger] = placementConfig(
      selection.row.trigger,
      selection.row.placementId,
      selection.variantKey,
      spec
    );
  }
  return { placements, traces, assignments, source: "v2" };
}

async function resolveLegacy(input: {
  publicKey: string;
  identity: ResolvedIdentity;
  apiBaseUrl: string;
  includeInline: boolean;
}): Promise<ResolvedPlacements> {
  const rows = await getPlacementsForKey(input.publicKey);
  const placements: ConfigResponse["placements"] = {};
  const traces: ResolutionTrace[] = [];
  const assignments: Array<AssignmentStamp | null> = [];
  const { unit, unitType } = assignmentUnit(input.identity);

  for (const row of rows) {
    const defaultVariant = row.default_variant_id || "var_default";
    const status = row.status || (row.enabled ? "active" : "paused");
    if (!row.enabled || status !== "active" || !row.spec) {
      placements[row.trigger] = null;
      continue;
    }
    const decision = await assignVariant({
      defaultVariant,
      experimentId: row.experiment_id,
      targetingRules: row.targeting_rules,
      identity: input.identity,
      projectName: row.statsig_project_name,
      serverSecretEnvVar: row.statsig_server_secret_env_var,
    });
    const selected = selectLegacyVariant(row.variants, decision.assignedVariantId, defaultVariant);
    const variantKey = selected.variantId || defaultVariant;
    traces.push({
      trigger: row.trigger,
      experimentId: decision.experimentId,
      viaBaseline: decision.viaBaseline,
      assignedVariantId: decision.assignedVariantId,
      variant: variantKey,
    });
    assignments.push(safeStamp(row.trigger, () => reconcileServedVariant(buildStatsigStamp({
      placementId: row.id,
      revisionId: null,
      trigger: row.trigger,
      defaultVariantKey: defaultVariant,
      variantKeys: (row.variants || []).map((variant) => variant.variant_id),
      resolution: decision,
      unit,
      unitType,
    }), variantKey)));
    const selectedSpec = ensureWebViewSpec(selected.spec ?? row.spec, {
      publicKey: input.publicKey,
      placementId: row.id,
      variantKey,
      apiBaseUrl: input.apiBaseUrl,
      includeInline: input.includeInline,
      sdkStack: row.sdk_stack,
    });
    placements[row.trigger] = placementConfig(row.trigger, row.id, variantKey, selectedSpec);
  }
  return { placements, traces, assignments, source: "legacy" };
}

function safeStamp(trigger: string, build: () => AssignmentStamp): AssignmentStamp | null {
  try {
    return build();
  } catch (error) {
    console.warn(`[tz.assignment] stamp for ${trigger} failed:`, error);
    return null;
  }
}

async function assignVariant(input: {
  defaultVariant: string;
  experimentId: string | null;
  targetingRules: unknown;
  identity: ResolvedIdentity;
  projectName: string | null;
  serverSecretEnvVar: string | null;
}): Promise<StatsigResolution> {
  let assignedVariantId = input.defaultVariant;
  let viaBaseline = false;
  let experimentId: string | null = null;
  let baseline: StatsigResolution["baseline"] = null;
  let experiment: StatsigResolution["experiment"] = null;
  const projectConfig = {
    projectName: input.projectName,
    serverSecretEnvVar: input.serverSecretEnvVar,
  };
  const baselineRule = findBaselineRule(input.targetingRules);
  let baselineHandled = false;
  if (baselineRule?.statsig_experiment_id) {
    const decision = await getBaselineDecision(input.identity, baselineRule.statsig_experiment_id, projectConfig);
    baseline = decision
      ? { useAutotune: decision.useAutotune, variantId: decision.variantId, details: decision.details ?? null }
      : null;
    if (decision && !decision.useAutotune) {
      assignedVariantId = decision.variantId || input.defaultVariant;
      baselineHandled = true;
      viaBaseline = true;
    }
  }
  if (!baselineHandled) {
    experimentId = resolveExperimentId(input.targetingRules, input.identity.traits, input.experimentId);
    if (experimentId) {
      const result = await getVariantAssignmentDetailed(
        input.identity,
        experimentId,
        input.defaultVariant,
        projectConfig
      );
      assignedVariantId = result.variantId;
      experiment = { status: result.status, rawVariantId: result.rawVariantId, details: result.details };
    }
  }
  return {
    assignedVariantId,
    viaBaseline,
    experimentId,
    baselineExperimentId: baselineRule?.statsig_experiment_id ?? null,
    baseline,
    experiment,
  };
}

function selectV2Variant(row: PublishedPlacementRouting, assignedVariantId: string) {
  const variants = row.variants || [];
  const selected = variants.find((variant) => variant.variantId === assignedVariantId)
    || variants.find((variant) => variant.variantId === row.defaultVariantKey)
    || variants[0];
  if (selected) return { variantKey: selected.variantId, bindingId: selected.bindingId };
  return { variantKey: row.defaultVariantKey, bindingId: row.defaultBindingId };
}

function selectLegacyVariant(
  variants: Array<{ variant_id: string; spec: unknown }> | undefined,
  assignedVariantId: string,
  defaultVariant: string
): { variantId: string; spec: unknown } {
  const available = variants || [];
  const selected = available.find((variant) => variant.variant_id === assignedVariantId)
    || available.find((variant) => variant.variant_id === defaultVariant)
    || available[0];
  return selected
    ? { variantId: selected.variant_id, spec: selected.spec }
    : { variantId: defaultVariant, spec: undefined };
}

function placementConfig(trigger: string, placementId: string, variantKey: string, spec: unknown) {
  return {
    trigger,
    enabled: true,
    placementId,
    placement_id: placementId,
    variantId: variantKey,
    variantKey,
    variant_key: variantKey,
    spec: spec as PlacementConfig["spec"],
  };
}

export function resolveExperimentId(
  targetingRules: unknown,
  traits: Record<string, unknown>,
  fallbackExperimentId: string | null
): string | null {
  for (const rule of normalizeTargetingRules(targetingRules)) {
    if (rule.type === "baseline") continue;
    if (!matchesTraits(rule.when, traits)) continue;
    const id = normalizeExperimentId(rule.statsig_experiment_id ?? rule.experiment_id ?? rule.experimentId);
    if (id) return id;
  }
  return fallbackExperimentId;
}

function findBaselineRule(targetingRules: unknown): { statsig_experiment_id: string | null } | null {
  for (const rule of normalizeTargetingRules(targetingRules)) {
    if (rule.type !== "baseline") continue;
    const id = normalizeExperimentId(rule.statsig_experiment_id ?? rule.experiment_id ?? rule.experimentId);
    if (id) return { statsig_experiment_id: id };
  }
  return null;
}

function normalizeTargetingRules(value: unknown): TargetingRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TargetingRule => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function normalizeExperimentId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
