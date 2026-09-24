import { StatsigServer } from "statsig-node";
import type { DynamicConfig, StatsigUser } from "statsig-node";
import { query } from "./db.js";
import type { ResolvedIdentity } from "./identity.js";

export const DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR = "STATSIG_SERVER_SECRET";

export interface StatsigProjectConfig {
  projectName?: string | null;
  serverSecretEnvVar?: string | null;
}

interface StatsigClientState {
  server: StatsigServer;
  initialized: boolean;
  initPromise: Promise<void>;
}

const clients = new Map<string, StatsigClientState>();
const missingSecretWarnings = new Set<string>();
export const EVENT_PREFIX = "tranzmit_";

export function isConfigured(): boolean {
  return Boolean(process.env[DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR]);
}

export async function initStatsig(): Promise<void> {
  await getStatsigServer({
    serverSecretEnvVar: DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR,
  });
}

/**
 * What the Statsig SDK reports about one evaluation. Every field is read from
 * the SDK's evaluation result; nothing here is inferred. Statsig does not
 * expose the allocation probabilities behind an evaluation, so none are
 * reported.
 */
export interface StatsigEvaluationDetails {
  ruleId: string | null;
  groupName: string | null;
  /** EvaluationReason, e.g. "Network", "Unrecognized", "Uninitialized". */
  reason: string | null;
  /** Timestamp of the Statsig config specs used; changes whenever Statsig config changes. */
  configSyncTime: number | null;
}

export type VariantAssignmentStatus =
  /** The experiment returned a non-empty `variant_id`. */
  | "assigned"
  /** The experiment evaluated but returned no usable `variant_id` (not allocated, unrecognized, ...). */
  | "no_variant"
  /** No Statsig server for this project (secret missing, invalid, or init failed). */
  | "unavailable"
  /** The SDK threw during evaluation. */
  | "error";

export interface VariantAssignmentResult {
  /** Exactly what getVariantAssignment() returns. */
  variantId: string;
  status: VariantAssignmentStatus;
  /** The raw `variant_id` parameter Statsig returned, before any defaulting. */
  rawVariantId: string | null;
  details: StatsigEvaluationDetails | null;
}

export async function getVariantAssignment(
  identity: ResolvedIdentity,
  experimentId: string,
  defaultVariant: string,
  projectConfig?: StatsigProjectConfig
): Promise<string> {
  return (await getVariantAssignmentDetailed(identity, experimentId, defaultVariant, projectConfig)).variantId;
}

/**
 * Same Statsig evaluation and the same returned variant as
 * getVariantAssignment(), plus what the SDK reports about the evaluation so the
 * assignment can be stamped onto `paywall_resolved`. One getExperimentSync call,
 * so Statsig exposure logging is unchanged.
 */
export async function getVariantAssignmentDetailed(
  identity: ResolvedIdentity,
  experimentId: string,
  defaultVariant: string,
  projectConfig?: StatsigProjectConfig
): Promise<VariantAssignmentResult> {
  const server = await getStatsigServer(projectConfig);
  if (!server) {
    return { variantId: defaultVariant, status: "unavailable", rawVariantId: null, details: null };
  }

  let experiment: DynamicConfig;
  let variantId: string;
  try {
    experiment = server.getExperimentSync(mapIdentityToStatsigUser(identity), experimentId);
    variantId = (experiment.get("variant_id", defaultVariant) as string) || defaultVariant;
  } catch {
    return { variantId: defaultVariant, status: "error", rawVariantId: null, details: null };
  }
  // Reading metadata must never change the served variant, so it runs after
  // the variant is fixed and cannot throw into the path above.
  const rawVariantId = readStringParam(experiment, "variant_id");
  return {
    variantId,
    status: rawVariantId ? "assigned" : "no_variant",
    rawVariantId,
    details: readEvaluationDetails(experiment),
  };
}

/**
 * Result of consulting a "baseline" Statsig experiment that gates whether the
 * autotune (intent-based MAB) flow should run.
 *
 * Returns null when Statsig is unavailable (server down, secret missing,
 * experiment lookup throws). Callers MUST treat null as "fall through to the
 * existing/default flow" so a Statsig outage never breaks the customer's
 * paywall.
 */
export interface BaselineDecision {
  /** True when the user is in the autotune (intent → MAB) arm. */
  useAutotune: boolean;
  /** The control variant id to serve when autotune is false. */
  variantId: string | null;
  /** SDK evaluation metadata for the baseline experiment, when available. */
  details?: StatsigEvaluationDetails | null;
}

export async function getBaselineDecision(
  identity: ResolvedIdentity,
  experimentId: string,
  projectConfig?: StatsigProjectConfig
): Promise<BaselineDecision | null> {
  const server = await getStatsigServer(projectConfig);
  if (!server) return null;
  try {
    const experiment = server.getExperimentSync(mapIdentityToStatsigUser(identity), experimentId);
    const rawAutotune = experiment.get("use_autotune", false as unknown);
    // Statsig sometimes serializes booleans as strings ("true" / "false") in
    // dynamic configs. Normalize defensively so a misconfigured experiment
    // doesn't silently keep all traffic in the baseline arm forever.
    const useAutotune = rawAutotune === true || rawAutotune === "true";
    const rawVariantId = experiment.get("variant_id", null as unknown);
    const variantId =
      typeof rawVariantId === "string" && rawVariantId.trim() ? rawVariantId.trim() : null;
    return { useAutotune, variantId, details: readEvaluationDetails(experiment) };
  } catch (err) {
    console.warn(`[Tranzmit] Baseline experiment "${experimentId}" lookup failed:`, err);
    return null;
  }
}

export async function logStatsigEvents(batch: {
  publicKey: string;
  identity: ResolvedIdentity;
  sessionId: string;
  events: Array<{ event: string; timestamp: number; properties?: Record<string, unknown> }>;
}): Promise<void> {
  let projectConfig: StatsigProjectConfig;
  try {
    projectConfig = await getProjectConfigForPublicKey(batch.publicKey);
  } catch (err) {
    console.warn("[Tranzmit] Statsig project lookup failed:", err);
    return;
  }
  const server = await getStatsigServer(projectConfig);
  if (!server) return;

  const user = mapIdentityToStatsigUser(batch.identity);

  for (const evt of batch.events) {
    if (!evt.event || typeof evt.event !== "string") continue;
    try {
      const metadata = normalizeMetadata({
        ...(evt.properties || {}),
        publicKey: batch.publicKey,
        sessionId: batch.sessionId,
        sdkEventName: evt.event,
        sdkTimestamp: evt.timestamp,
      });
      server.logEvent(user, EVENT_PREFIX + evt.event, valueForEvent(evt), metadata);
    } catch (err) {
      console.warn("[Tranzmit] Statsig event logging failed:", err);
    }
  }
}

export function isInitialized(): boolean {
  return Array.from(clients.values()).some((client) => client.initialized);
}

export async function shutdownStatsig(timeoutMs = 5000): Promise<void> {
  await Promise.allSettled(
    Array.from(clients.values()).map((client) => client.server.shutdownAsync(timeoutMs))
  );
  clients.clear();
  missingSecretWarnings.clear();
}

export function normalizeStatsigSecretEnvVar(raw?: string | null): string {
  const value = raw?.trim();
  return value || DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR;
}

export function isValidStatsigSecretEnvVar(raw: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(raw);
}

export function getStatsigProjectStatus(projectConfig?: StatsigProjectConfig): {
  projectName: string | null;
  serverSecretEnvVar: string | null;
  enabled: boolean;
  configured: boolean;
  initialized: boolean;
} {
  const projectName = projectConfig?.projectName?.trim() || null;
  const rawEnvVar = projectConfig?.serverSecretEnvVar?.trim() || null;
  const enabled = Boolean(projectName || rawEnvVar);
  // When the workspace has not opted in to Statsig, leave the env var null so
  // dashboards and SDK consumers can clearly distinguish "off" from "missing secret".
  if (!enabled) {
    return {
      projectName: null,
      serverSecretEnvVar: null,
      enabled: false,
      configured: false,
      initialized: false,
    };
  }
  const serverSecretEnvVar = normalizeStatsigSecretEnvVar(rawEnvVar);
  return {
    projectName,
    serverSecretEnvVar,
    enabled: true,
    configured: isValidStatsigSecretEnvVar(serverSecretEnvVar) && Boolean(process.env[serverSecretEnvVar]),
    initialized: clients.get(serverSecretEnvVar)?.initialized === true,
  };
}

export async function getProjectConfigForPublicKey(publicKey: string): Promise<StatsigProjectConfig> {
  const result = await query<{
    statsig_project_name: string | null;
    statsig_server_secret_env_var: string | null;
  }>(
    `SELECT statsig_project_name, statsig_server_secret_env_var
     FROM clients
     WHERE public_key = $1`,
    [publicKey]
  );
  const row = result.rows[0];
  return {
    projectName: row?.statsig_project_name || null,
    serverSecretEnvVar: row?.statsig_server_secret_env_var || DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR,
  };
}

export async function getStatsigServer(projectConfig?: StatsigProjectConfig): Promise<StatsigServer | null> {
  const serverSecretEnvVar = normalizeStatsigSecretEnvVar(projectConfig?.serverSecretEnvVar);
  if (!isValidStatsigSecretEnvVar(serverSecretEnvVar)) {
    console.warn(`[Tranzmit] Invalid Statsig server secret env var "${serverSecretEnvVar}", using default variants`);
    return null;
  }

  const serverSecret = process.env[serverSecretEnvVar];
  if (!serverSecret) {
    if (!missingSecretWarnings.has(serverSecretEnvVar)) {
      missingSecretWarnings.add(serverSecretEnvVar);
      console.warn(`[Tranzmit] ${serverSecretEnvVar} not set, using default variants for that Statsig project`);
    }
    return null;
  }

  const existing = clients.get(serverSecretEnvVar);
  if (existing) {
    try {
      await existing.initPromise;
      return existing.initialized ? existing.server : null;
    } catch (err) {
      console.warn(`[Tranzmit] Statsig initialization failed for ${serverSecretEnvVar}:`, err);
      return null;
    }
  }

  const server = new StatsigServer(serverSecret);
  const state: StatsigClientState = {
    server,
    initialized: false,
    initPromise: server.initializeAsync().then(() => {
      state.initialized = true;
    }).catch((err) => {
      clients.delete(serverSecretEnvVar);
      throw err;
    }),
  };
  clients.set(serverSecretEnvVar, state);

  try {
    await state.initPromise;
    return state.server;
  } catch (err) {
    console.warn(`[Tranzmit] Statsig initialization failed for ${serverSecretEnvVar}:`, err);
    return null;
  }
}

export function mapIdentityToStatsigUser(identity: ResolvedIdentity): StatsigUser {
  const customIDs: Record<string, string> = {
    ...identity.identifiers,
  };
  if (identity.userId) customIDs.tranzmitUserID = identity.userId;

  // Statsig experiments that randomize on "User ID" need userID set on every
  // request. Logged-in apps pass the real app user id; logged-out installs
  // fall back to stableID so anonymous traffic still buckets consistently.
  const statsigUserId =
    identity.userId ??
    identity.identifiers.stableID ??
    identity.storageUserId;

  const user: StatsigUser = {
    userID: statsigUserId,
    ...(Object.keys(customIDs).length > 0 ? { customIDs } : {}),
  };
  user.custom = normalizeStatsigValues(identity.traits);
  const privateAttributes = normalizeStatsigValues(identity.privateTraits);
  if (Object.keys(privateAttributes).length > 0) {
    user.privateAttributes = privateAttributes;
  }

  const email = stringTrait(identity.traits.email);
  const ip = stringTrait(identity.traits.ip);
  const userAgent = stringTrait(identity.traits.userAgent);
  const country = stringTrait(identity.traits.country);
  const locale = stringTrait(identity.traits.locale);
  const appVersion = stringTrait(identity.traits.appVersion);
  if (email) user.email = email;
  if (ip) user.ip = ip;
  if (userAgent) user.userAgent = userAgent;
  if (country) user.country = country;
  if (locale) user.locale = locale;
  if (appVersion) user.appVersion = appVersion;

  return user;
}

function normalizeStatsigValues(input: Record<string, unknown>): NonNullable<StatsigUser["custom"]> {
  const out: NonNullable<StatsigUser["custom"]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      out[key] = value as string | number | boolean | string[];
    }
  }
  return out;
}

function readStringParam(experiment: DynamicConfig, key: string): string | null {
  try {
    const value = experiment.value?.[key];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function readEvaluationDetails(experiment: DynamicConfig): StatsigEvaluationDetails | null {
  try {
    const evaluation = experiment.getEvaluationDetails?.() ?? null;
    const configSyncTime = Number(evaluation?.configSyncTime);
    return {
      ruleId: experiment.getRuleID?.() || null,
      groupName: experiment.getGroupName?.() || null,
      reason: evaluation?.reason ? String(evaluation.reason) : null,
      configSyncTime: Number.isFinite(configSyncTime) && configSyncTime > 0 ? configSyncTime : null,
    };
  } catch {
    return null;
  }
}

function stringTrait(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

function valueForEvent(evt: { event: string; properties?: Record<string, unknown> }): string | number | null {
  if (evt.event !== "conversion") return null;
  const revenue = evt.properties?.revenue;
  return typeof revenue === "number" ? revenue : null;
}
