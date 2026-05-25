import type { PlatformAdapter, PlatformMetadata } from "./adapter.js";
import type { ConfigResponse, PlacementConfig } from "./config.js";
import type { TranzmitIdentity } from "./identity.js";
import { hashString, resolveIdentity, stableJson } from "./identity.js";

export const DEFAULT_API_BASE_URL = "https://tranzmit-api-production.up.railway.app";

const CONFIG_KEY_PREFIX = "tranzmit:config:";
const FETCH_TIMEOUT_MS = 8000;

export interface InitConfig {
  publicKey: string;
  userId?: string;
  identifiers?: Record<string, string>;
  userTraits?: Record<string, unknown>;
  privateTraits?: Record<string, unknown>;
  apiBaseUrl?: string;
  onError?: (error: TranzmitError) => void;
  debug?: boolean;
}

export interface TranzmitError extends Error {
  name: "TranzmitError";
  code: string;
  recoverable: boolean;
}

export interface SharedClient {
  init(config: InitConfig): Promise<void>;
  refreshConfig(): Promise<void>;
  getPlacement(trigger: string): PlacementConfig | null;
  track(event: string, properties?: Record<string, unknown>): void;
  reportConversion(data: Record<string, unknown>): void;
  flush(): Promise<void>;
  isReady(): boolean;
  getConfig(): ConfigResponse | null;
  getSessionId(): string;
  getIdentity(): TranzmitIdentity | null;
  reset(): void;
}

interface QueuedEvent {
  event: string;
  timestamp: number;
  properties?: Record<string, unknown>;
  attempts: number;
}

export function createTranzmitClient(
  adapter: PlatformAdapter,
  metadata: PlatformMetadata = {}
): SharedClient {
  let currentConfig: InitConfig | null = null;
  let currentIdentity: TranzmitIdentity | null = null;
  let configResponse: ConfigResponse | null = null;
  let initialized = false;
  let initPromise: Promise<void> | null = null;
  let currentInitKey: string | null = null;
  let sessionId = generateSessionId();
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeBackground: (() => void) | null = null;
  let unsubscribeForeground: (() => void) | null = null;

  async function init(config: InitConfig): Promise<void> {
    validatePublicKey(config.publicKey);

    const identity = await resolveIdentity(
      config.publicKey,
      { userId: config.userId, identifiers: config.identifiers },
      adapter.storage
    );
    const nextKey = initKey(config, identity);

    if (currentInitKey === nextKey && initPromise) return initPromise;
    if (currentInitKey === nextKey && initialized) return;

    clearLifecycle();
    clearFlushTimer();
    queue = [];
    currentConfig = config;
    currentIdentity = identity;
    currentInitKey = nextKey;
    configResponse = null;
    initialized = false;
    sessionId = generateSessionId();

    unsubscribeBackground = adapter.lifecycle.onBackground(() => {
      void flush();
    });
    unsubscribeForeground = adapter.lifecycle.onForeground(() => {
      sessionId = generateSessionId();
    });

    initPromise = initFromCacheThenNetwork(config, identity);
    return initPromise;
  }

  async function initFromCacheThenNetwork(
    config: InitConfig,
    identity: TranzmitIdentity
  ): Promise<void> {
    const cached = await getCachedConfig(adapter, config, identity);
    if (cached) {
      configResponse = cached;
      initialized = true;
      track("page_view");
      void refreshConfig(config, identity);
      return;
    }

    try {
      const fresh = await fetchConfig(config, identity);
      await hydratePaywallDocuments(fresh);
      configResponse = fresh;
      initialized = true;
      await setCachedConfig(adapter, config, identity, fresh);
      track("page_view");
    } catch (err: any) {
      const error = makeError("config_fetch_failed", err?.message || "Config fetch failed", true);
      config.onError?.(error);
      initPromise = null;
      currentInitKey = null;
      throw error;
    }
  }

  async function refreshConfig(config: InitConfig, identity: TranzmitIdentity): Promise<void> {
    try {
      const fresh = await fetchConfig(config, identity);
      await hydratePaywallDocuments(fresh);
      configResponse = fresh;
      await setCachedConfig(adapter, config, identity, fresh);
    } catch (err: any) {
      config.onError?.(
        makeError("config_refresh_failed", err?.message || "Config refresh failed", true)
      );
    }
  }

  async function refreshCurrentConfig(): Promise<void> {
    if (!currentConfig || !currentIdentity) return;
    try {
      const fresh = await fetchConfig(currentConfig, currentIdentity);
      await hydratePaywallDocuments(fresh);
      configResponse = fresh;
      initialized = true;
      await setCachedConfig(adapter, currentConfig, currentIdentity, fresh);
    } catch (err: any) {
      currentConfig.onError?.(
        makeError("config_refresh_failed", err?.message || "Config refresh failed", true)
      );
      throw err;
    }
  }

  function getPlacement(trigger: string): PlacementConfig | null {
    const placement = configResponse?.placements?.[trigger];
    if (!initialized || !placement || !placement.enabled) return null;
    return placement;
  }

  function track(event: string, properties?: Record<string, unknown>): void {
    if (!currentConfig) return;
    queue.push({
      event,
      timestamp: Date.now(),
      properties: addMetadata(properties),
      attempts: 0,
    });

    if (queue.length > 100) {
      queue = queue.slice(queue.length - 100);
    }

    if (queue.length >= 10) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => {
        void flush();
      }, 30_000);
    }
  }

  function reportConversion(data: Record<string, unknown>): void {
    const trigger = typeof data.trigger === "string" ? data.trigger : undefined;
    const placement = trigger ? configResponse?.placements?.[trigger] : null;
    track("conversion", placement ? { ...data, ...attribution(trigger!, placement) } : data);
    void flush();
  }

  async function flush(): Promise<void> {
    if (!currentConfig || queue.length === 0) return;

    clearFlushTimer();
    const batch = queue.splice(0, queue.length);

    if (typeof fetch !== "function") {
      requeue(batch);
      return;
    }

    try {
      const response = await fetch(`${resolveApiBaseUrl(currentConfig.apiBaseUrl)}/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: currentConfig.publicKey,
          userId: currentConfig.userId,
          identity: currentIdentity || undefined,
          traits: currentConfig.userTraits || {},
          privateTraits: currentConfig.privateTraits || {},
          sessionId,
          events: batch.map(({ attempts: _attempts, ...event }) => event),
        }),
      });

      if (!response.ok) {
        throw new Error(`Event flush failed: HTTP ${response.status}`);
      }
    } catch {
      requeue(batch);
    }
  }

  function reset(): void {
    clearLifecycle();
    clearFlushTimer();
    currentConfig = null;
    currentIdentity = null;
    configResponse = null;
    initialized = false;
    initPromise = null;
    currentInitKey = null;
    sessionId = generateSessionId();
    queue = [];
  }

  function addMetadata(properties?: Record<string, unknown>): Record<string, unknown> | undefined {
    const next = { ...(properties || {}) };
    if (metadata.platform) next.platform = metadata.platform;
    if (metadata.os) next.os = metadata.os;
    if (metadata.sdkVersion) next.sdk_version = metadata.sdkVersion;
    return Object.keys(next).length ? next : undefined;
  }

  function attribution(trigger: string, placement: PlacementConfig): Record<string, unknown> {
    const placementId = placement.placement_id || placement.placementId;
    const variantKey = placement.variant_key || placement.variantKey || placement.variantId;
    return {
      trigger,
      variantId: placement.variantId,
      variant_key: variantKey,
      ...(placementId ? { placement_id: placementId } : {}),
    };
  }

  function requeue(events: QueuedEvent[]): void {
    const retryable = events
      .map((event) => ({ ...event, attempts: event.attempts + 1 }))
      .filter((event) => event.attempts <= 3);
    queue = [...retryable, ...queue].slice(-100);
  }

  function clearLifecycle(): void {
    unsubscribeBackground?.();
    unsubscribeForeground?.();
    unsubscribeBackground = null;
    unsubscribeForeground = null;
  }

  function clearFlushTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    init,
    refreshConfig: refreshCurrentConfig,
    getPlacement,
    track,
    reportConversion,
    flush,
    isReady: () => initialized,
    getConfig: () => configResponse,
    getSessionId: () => sessionId,
    getIdentity: () => currentIdentity,
    reset,
  };
}

export function resolveApiBaseUrl(explicit?: string): string {
  if (explicit?.trim()) return explicit.replace(/\/$/, "");
  return DEFAULT_API_BASE_URL;
}

export function makeError(code: string, message: string, recoverable: boolean): TranzmitError {
  const err = new Error(message) as TranzmitError;
  err.name = "TranzmitError";
  err.code = code;
  err.recoverable = recoverable;
  return err;
}

export function validatePublicKey(key: string): void {
  if (!/^pk_(live|test)_[A-Za-z0-9_]+$/.test(key)) {
    throw makeError("init_invalid_key", "publicKey must match pk_live_xxx or pk_test_xxx", false);
  }
}

async function getCachedConfig(
  adapter: PlatformAdapter,
  config: InitConfig,
  identity: TranzmitIdentity
): Promise<ConfigResponse | null> {
  try {
    const raw = await adapter.storage.get(configStorageKey(config, identity));
    if (!raw) return null;
    const cached = JSON.parse(raw) as { config: ConfigResponse; cachedAt: number };
    // Stale configs are still valuable offline. init() always refreshes in the
    // background when cache exists, so TTL controls freshness, not availability.
    return cached.config;
  } catch {
    return null;
  }
}

async function setCachedConfig(
  adapter: PlatformAdapter,
  config: InitConfig,
  identity: TranzmitIdentity,
  response: ConfigResponse
): Promise<void> {
  try {
    await adapter.storage.set(
      configStorageKey(config, identity),
      JSON.stringify({ config: response, cachedAt: Date.now() })
    );
  } catch {
    // Best-effort cache.
  }
}

async function fetchConfig(
  config: InitConfig,
  identity: TranzmitIdentity
): Promise<ConfigResponse> {
  if (typeof fetch !== "function") {
    throw new Error("Config fetch unavailable: fetch is not defined");
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

  try {
    const response = await fetch(`${resolveApiBaseUrl(config.apiBaseUrl)}/v1/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller?.signal,
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
    if (err?.name === "AbortError") {
      throw new Error("Config fetch timed out");
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function hydratePaywallDocuments(config: ConfigResponse): Promise<void> {
  const placements = Object.values(config.placements || {});
  await Promise.all(placements.map(async (placement) => {
    if (!placement) return;
    const spec = placement.spec;
    const document = spec.document;
    if (!document?.url || document.html) return;

    const response = await fetch(document.url);
    if (!response.ok) {
      throw new Error(`Paywall document fetch failed: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json() as {
        html?: string;
        css?: string;
        js?: string;
        baseUrl?: string;
        integrity?: string;
      };
      if (!payload.html) throw new Error("Paywall document payload is missing html");
      spec.document = {
        ...document,
        html: payload.html,
        css: payload.css ?? document.css,
        js: payload.js ?? document.js,
        baseUrl: payload.baseUrl ?? document.baseUrl,
        integrity: payload.integrity ?? document.integrity,
      };
      return;
    }

    spec.document = {
      ...document,
      html: await response.text(),
    };
  }));
}

function configStorageKey(config: InitConfig, identity: TranzmitIdentity): string {
  return CONFIG_KEY_PREFIX + config.publicKey + ":" + configCacheKey(config, identity);
}

function initKey(config: InitConfig, identity: TranzmitIdentity): string {
  return stableJson({
    publicKey: config.publicKey,
    identity,
    apiBaseUrl: resolveApiBaseUrl(config.apiBaseUrl),
    userTraits: config.userTraits || {},
    privateTraits: config.privateTraits || {},
  });
}

function configCacheKey(config: InitConfig, identity: TranzmitIdentity): string {
  return hashString(stableJson({
    publicKey: config.publicKey,
    identity,
    userTraits: config.userTraits || {},
    privateTraits: config.privateTraits || {},
  }));
}

function generateSessionId(): string {
  return "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}
