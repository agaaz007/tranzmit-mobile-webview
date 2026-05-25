import type { ConfigResponse } from "@tranzmit/shared";
import type { TranzmitIdentity } from "@tranzmit/shared";
import type { TranzmitConfig } from "./types.js";
import { configCacheKey, getStorage, resolveApiBaseUrl, resolveIdentity } from "./runtime.js";

const STORAGE_KEY_PREFIX = "tranzmit:config:";

function storageKey(config: TranzmitConfig, identity?: TranzmitIdentity): string {
  return STORAGE_KEY_PREFIX + config.publicKey + ":" + configCacheKey(config, identity);
}

export function getCachedConfig(config: TranzmitConfig, identity?: TranzmitIdentity): ConfigResponse | null {
  try {
    const storage = getStorage();
    if (!storage) return null;
    const raw = storage.getItem(storageKey(config, identity));
    if (!raw) return null;
    const cached = JSON.parse(raw) as { config: ConfigResponse; cachedAt: number };
    const ttlMs = Math.max(0, Number(cached.config.ttl || 0)) * 1000;
    if (ttlMs > 0 && Date.now() - cached.cachedAt > ttlMs) {
      storage.removeItem(storageKey(config, identity));
      return null;
    }
    return cached.config;
  } catch {
    return null;
  }
}

export function setCachedConfig(sdkConfig: TranzmitConfig, config: ConfigResponse, identity?: TranzmitIdentity): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(
      storageKey(sdkConfig, identity),
      JSON.stringify({ config, cachedAt: Date.now() })
    );
  } catch {
    // localStorage unavailable or full
  }
}

const FETCH_TIMEOUT_MS = 8000;

export async function fetchConfig(
  config: TranzmitConfig,
  identity = resolveIdentity(config)
): Promise<ConfigResponse> {
  if (typeof fetch !== "function") {
    throw new Error("Config fetch unavailable: fetch is not defined");
  }

  const base = resolveApiBaseUrl(config.apiBaseUrl);
  const url = `${base}/v1/config`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      signal: controller.signal,
      body: JSON.stringify({
        publicKey: config.publicKey,
        identity,
        traits: config.userTraits || {},
        privateTraits: config.privateTraits || {},
      }),
    });

    if (!response.ok) {
      throw new Error(`Config fetch failed: HTTP ${response.status}`);
    }

    return response.json() as Promise<ConfigResponse>;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("Config fetch timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
