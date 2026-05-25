import { StatsigServer } from "statsig-node";
import type { StatsigUser } from "statsig-node";
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
const EVENT_PREFIX = "tranzmit_";

export function isConfigured(): boolean {
  return Boolean(process.env[DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR]);
}

export async function initStatsig(): Promise<void> {
  await getStatsigServer({
    serverSecretEnvVar: DEFAULT_STATSIG_SERVER_SECRET_ENV_VAR,
  });
}

export async function getVariantAssignment(
  identity: ResolvedIdentity,
  experimentId: string,
  defaultVariant: string,
  projectConfig?: StatsigProjectConfig
): Promise<string> {
  const server = await getStatsigServer(projectConfig);
  if (!server) return defaultVariant;

  try {
    const experiment = server.getExperimentSync(toStatsigUser(identity), experimentId);
    return (experiment.get("variant_id", defaultVariant) as string) || defaultVariant;
  } catch {
    return defaultVariant;
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

  const user = toStatsigUser(batch.identity);

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

async function getProjectConfigForPublicKey(publicKey: string): Promise<StatsigProjectConfig> {
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

async function getStatsigServer(projectConfig?: StatsigProjectConfig): Promise<StatsigServer | null> {
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

function toStatsigUser(identity: ResolvedIdentity): StatsigUser {
  const customIDs: Record<string, string> = {
    ...identity.identifiers,
  };
  if (identity.userId) customIDs.tranzmitUserID = identity.userId;

  const user: StatsigUser = Object.keys(customIDs).length > 0
    ? { customIDs }
    : { userID: identity.storageUserId };

  if (identity.userId) user.userID = identity.userId;
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
