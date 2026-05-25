import type { ConfigRequest, EventBatch, TranzmitIdentity } from "@tranzmit/shared";

export interface ResolvedIdentity {
  userId?: string;
  identifiers: Record<string, string>;
  traits: Record<string, unknown>;
  privateTraits: Record<string, unknown>;
  storageUserId: string;
}

export function resolveConfigIdentity(input: ConfigRequest): ResolvedIdentity | null {
  return resolveIdentity(input.publicKey, input.identity, input.userId, input.traits, input.privateTraits);
}

export function resolveEventIdentity(input: EventBatch): ResolvedIdentity | null {
  return resolveIdentity(input.publicKey, input.identity, input.userId, input.traits, input.privateTraits);
}

export function publicIdentity(identity: ResolvedIdentity): TranzmitIdentity {
  return {
    ...(identity.userId ? { userId: identity.userId } : {}),
    identifiers: { ...identity.identifiers },
  };
}

function resolveIdentity(
  publicKey: string,
  identity?: TranzmitIdentity,
  legacyUserId?: string,
  traits?: Record<string, unknown>,
  privateTraits?: Record<string, unknown>
): ResolvedIdentity | null {
  const identifiers = normalizeStringRecord(identity?.identifiers);
  const userId = normalizeString(identity?.userId) || normalizeString(legacyUserId);
  const firstIdentifier = identifiers.stableID || Object.values(identifiers)[0];
  const storageUserId = userId || firstIdentifier;
  if (!storageUserId) return null;

  return {
    userId,
    identifiers,
    traits: normalizeTraits({ publicKey, ...(traits || {}) }),
    privateTraits: normalizeTraits(privateTraits || {}),
    storageUserId,
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringRecord(input?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = normalizeString(key);
    const normalizedValue = normalizeString(value);
    if (normalizedKey && normalizedValue) out[normalizedKey] = normalizedValue;
  }
  return out;
}

function normalizeTraits(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.trim()) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      out[key] = value;
    }
  }
  return out;
}
