import type { TranzmitConfig } from "./types.js";
import type { TranzmitIdentity } from "@tranzmit/shared";

export const DEFAULT_API_BASE_URL = "https://tranzmit-api-production.up.railway.app";
const STABLE_ID_PREFIX = "tranzmit:stable_id:";
const memoryStableIds = new Map<string, string>();

export function hasBrowserDOM(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function getDocument(): Document | null {
  if (typeof document === "undefined") return null;
  return document;
}

export function getCurrentUrl(): string | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.location?.href;
  } catch {
    return undefined;
  }
}

export function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return null;
  }

  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    return null;
  }

  return null;
}

export function resolveApiBaseUrl(explicit?: string): string {
  if (explicit?.trim()) return explicit.replace(/\/$/, "");

  try {
    const currentScript = getDocument()?.currentScript as HTMLScriptElement | null;
    if (currentScript?.src) {
      return new URL(currentScript.src).origin;
    }
  } catch {
    // Fall through to hosted production API.
  }

  return DEFAULT_API_BASE_URL;
}

export function resolveIdentity(config: TranzmitConfig): TranzmitIdentity {
  const identifiers = normalizeIdentifiers(config.identifiers);
  if (!identifiers.stableID) {
    identifiers.stableID = getOrCreateStableId(config.publicKey);
  }

  const identity: TranzmitIdentity = { identifiers };
  if (config.userId?.trim()) {
    identity.userId = config.userId.trim();
  }
  return identity;
}

export function initKey(config: TranzmitConfig): string {
  const identity = resolveIdentity(config);
  return JSON.stringify({
    publicKey: config.publicKey,
    identity,
    apiBaseUrl: resolveApiBaseUrl(config.apiBaseUrl),
    userTraits: config.userTraits || {},
    privateTraits: config.privateTraits || {},
  });
}

export function configCacheKey(config: TranzmitConfig, identity = resolveIdentity(config)): string {
  return hashString(stableJson({
    publicKey: config.publicKey,
    identity,
    userTraits: config.userTraits || {},
    privateTraits: config.privateTraits || {},
  }));
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

function getOrCreateStableId(publicKey: string): string {
  const key = STABLE_ID_PREFIX + publicKey;
  const storage = getStorage();
  try {
    const existing = storage?.getItem(key);
    if (existing) return existing;
  } catch {
    // Fall through to memory-backed ID.
  }

  const memory = memoryStableIds.get(publicKey);
  if (memory) return memory;

  const generated = generateStableId();
  memoryStableIds.set(publicKey, generated);
  try {
    storage?.setItem(key, generated);
  } catch {
    // Storage can be disabled in private browser modes.
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

function stableJson(value: unknown): string {
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

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
