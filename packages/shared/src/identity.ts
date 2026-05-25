export interface TranzmitIdentity {
  userId?: string;
  identifiers?: Record<string, string>;
}

export interface ConfigRequest {
  publicKey: string;
  identity?: TranzmitIdentity;
  userId?: string;
  traits?: Record<string, unknown>;
  privateTraits?: Record<string, unknown>;
}

export interface IdentityStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const STABLE_ID_PREFIX = "tranzmit:stable_id:";
const memoryStableIds = new Map<string, string>();

export async function resolveIdentity(
  publicKey: string,
  input?: {
    userId?: string;
    identifiers?: Record<string, string>;
  },
  storage?: IdentityStorage
): Promise<TranzmitIdentity> {
  const identifiers = normalizeIdentifiers(input?.identifiers);
  if (!identifiers.stableID) {
    identifiers.stableID = await getOrCreateStableId(publicKey, storage);
  }

  const identity: TranzmitIdentity = { identifiers };
  if (input?.userId?.trim()) {
    identity.userId = input.userId.trim();
  }
  return identity;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => JSON.stringify(key) + ":" + stableJson(val))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function normalizeIdentifiers(input?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof key === "string" && typeof value === "string" && key.trim() && value.trim()) {
      out[key.trim()] = value.trim();
    }
  }
  return out;
}

async function getOrCreateStableId(publicKey: string, storage?: IdentityStorage): Promise<string> {
  const key = STABLE_ID_PREFIX + publicKey;
  try {
    const existing = await storage?.get(key);
    if (existing) return existing;
  } catch {
    // Storage can be unavailable in restricted environments.
  }

  const memory = memoryStableIds.get(publicKey);
  if (memory) return memory;

  const generated = generateStableId();
  memoryStableIds.set(publicKey, generated);

  try {
    await storage?.set(key, generated);
  } catch {
    // Keep the memory-backed ID for this process if persistence fails.
  }

  return generated;
}

function generateStableId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return "trz_" + crypto.randomUUID();
    }
  } catch {
    // Use the fallback below.
  }
  return "trz_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
}
