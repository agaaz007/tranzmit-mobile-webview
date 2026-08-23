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
import { getBaselineDecision, getVariantAssignment } from "./statsig.js";
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
  }> = [];
  const placements: ConfigResponse["placements"] = {};

  for (const row of routing) {
    if (row.status !== "active") {
      placements[row.trigger] = null;
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
    });
  }

  const releases = await getV2PublishedReleases(
    client.id,
    Array.from(new Set(selections.map((selection) => selection.bindingId)))
  );
  const traces: ResolutionTrace[] = [];
  for (const selection of selections) {
    const release = releases.get(selection.bindingId);
    traces.push(selection.trace);
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
  return { placements, traces, source: "v2" };
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
  return { placements, traces, source: "legacy" };
}

async function assignVariant(input: {
  defaultVariant: string;
  experimentId: string | null;
  targetingRules: unknown;
  identity: ResolvedIdentity;
  projectName: string | null;
  serverSecretEnvVar: string | null;
}): Promise<{ assignedVariantId: string; viaBaseline: boolean; experimentId: string | null }> {
  let assignedVariantId = input.defaultVariant;
  let viaBaseline = false;
  let experimentId: string | null = null;
  const projectConfig = {
    projectName: input.projectName,
    serverSecretEnvVar: input.serverSecretEnvVar,
  };
  const baselineRule = findBaselineRule(input.targetingRules);
  let baselineHandled = false;
  if (baselineRule?.statsig_experiment_id) {
    const decision = await getBaselineDecision(input.identity, baselineRule.statsig_experiment_id, projectConfig);
    if (decision && !decision.useAutotune) {
      assignedVariantId = decision.variantId || input.defaultVariant;
      baselineHandled = true;
      viaBaseline = true;
    }
  }
  if (!baselineHandled) {
    experimentId = resolveExperimentId(input.targetingRules, input.identity.traits, input.experimentId);
    if (experimentId) {
      assignedVariantId = await getVariantAssignment(
        input.identity,
        experimentId,
        input.defaultVariant,
        projectConfig
      );
    }
  }
  return { assignedVariantId, viaBaseline, experimentId };
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

function matchesTraits(when: TargetingRule["when"], traits: Record<string, unknown>): boolean {
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

function normalizeExperimentId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
