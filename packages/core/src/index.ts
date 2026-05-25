import type { ConfigResponse, ProductSpec } from "@tranzmit/shared";
import type { TranzmitConfig, GateOptions, GateResult, TranzmitError } from "./types.js";
import { getCachedConfig, setCachedConfig, fetchConfig } from "./config.js";
import { initEvents, queueEvent, flush, setupPageUnloadFlush } from "./events.js";
import { preloadAssets } from "./assets.js";
import { renderPaywall } from "./renderer.js";
import { renderCustomHtml } from "./custom-renderer.js";
import { getCurrentUrl, getDocument, hasBrowserDOM, initKey, resolveIdentity } from "./runtime.js";

export type { TranzmitConfig, GateOptions, GateResult, TranzmitError } from "./types.js";
export type { ProductSpec } from "@tranzmit/shared";

let state: {
  config: TranzmitConfig | null;
  identity: import("@tranzmit/shared").TranzmitIdentity | null;
  configResponse: ConfigResponse | null;
  sessionId: string;
  initialized: boolean;
  initPromise: Promise<void> | null;
  initKey: string | null;
  activePaywalls: Map<string, { dismiss: () => void }>;
} = {
  config: null,
  identity: null,
  configResponse: null,
  sessionId: "",
  initialized: false,
  initPromise: null,
  initKey: null,
  activePaywalls: new Map(),
};

function generateSessionId(): string {
  return "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function makeError(code: string, message: string, recoverable: boolean): TranzmitError {
  const err = new Error(message) as TranzmitError;
  err.name = "TranzmitError";
  err.code = code;
  err.recoverable = recoverable;
  return err;
}

function validatePublicKey(key: string): void {
  if (!/^pk_(live|test)_[A-Za-z0-9_]+$/.test(key)) {
    throw makeError(
      "init_invalid_key",
      "publicKey must match pk_live_xxx or pk_test_xxx",
      false
    );
  }
}

export async function init(config: TranzmitConfig): Promise<void> {
  validatePublicKey(config.publicKey);

  const key = initKey(config);
  if (state.initKey === key && state.initPromise) {
    return state.initPromise;
  }
  if (state.initKey === key && state.initialized) {
    return;
  }

  for (const active of state.activePaywalls.values()) {
    active.dismiss();
  }

  state.config = config;
  state.identity = resolveIdentity(config);
  state.initKey = key;
  state.sessionId = generateSessionId();
  state.activePaywalls.clear();

  initEvents(config, state.sessionId, state.identity);
  setupPageUnloadFlush();

  if (!hasBrowserDOM()) {
    state.initialized = false;
    state.initPromise = Promise.resolve();
    return;
  }

  const cached = getCachedConfig(config, state.identity);

  if (cached) {
    state.configResponse = cached;
    state.initialized = true;

    fetchConfig(config, state.identity)
      .then((fresh) => {
        state.configResponse = fresh;
        setCachedConfig(config, fresh, state.identity || undefined);
        if (fresh.assets) preloadAssets(fresh.assets);
      })
      .catch((err) => {
        config.onError?.(
          makeError("config_refresh_failed", err.message, true)
        );
      });
    state.initPromise = Promise.resolve();

    if (cached.assets) {
      preloadAssets(cached.assets).catch(() => {});
    }
  } else {
    state.initPromise = fetchConfig(config, state.identity)
      .then((fresh) => {
        state.configResponse = fresh;
        state.initialized = true;
        setCachedConfig(config, fresh, state.identity || undefined);
        if (fresh.assets) return preloadAssets(fresh.assets);
      })
      .catch((err) => {
        const error = makeError("config_fetch_failed", err.message, true);
        config.onError?.(error);
        state.initPromise = null;
        state.initKey = null;
        throw error;
      });

    await state.initPromise;
  }

  queueEvent("page_view", { url: getCurrentUrl() });
}

export function gate(trigger: string, options: GateOptions = {}): GateResult {
  const noop = { shown: false, dismiss: () => {} };

  if (!state.initialized || !state.configResponse) {
    return noop;
  }

  const placement = state.configResponse.placements[trigger];
  if (!placement || !placement.enabled) {
    return noop;
  }

  if (state.activePaywalls.has(trigger)) {
    return {
      shown: true,
      variantId: placement.variantId,
      dismiss: () => state.activePaywalls.get(trigger)?.dismiss(),
    };
  }

  const doc = getDocument();
  const container = options.container || doc?.body;
  if (!container) {
    return noop;
  }

  const render = placement.spec.layout === "custom" && placement.spec.customHtml
    ? renderCustomHtml
    : renderPaywall;

  let dismissed = false;
  let dismissImpl = () => {};

  const dismissOnce = (trackDismissal: boolean) => {
    if (dismissed) return;
    dismissed = true;
    state.activePaywalls.delete(trigger);
    dismissImpl();
    if (trackDismissal) {
      queueEvent("dismissal", attribution(trigger, placement));
      options.onDismiss?.();
    }
  };

  try {
    const { dismiss } = render(placement.spec, container, {
      onCTA: (product: ProductSpec) => {
        queueEvent("cta_click", {
          ...attribution(trigger, placement),
          productId: product.id,
        });
        dismissOnce(false);
        options.onCTA?.(product);
      },
      onDismiss: () => {
        dismissOnce(true);
      },
      onImpression: () => {
        queueEvent("impression", attribution(trigger, placement));
        options.onImpression?.();
      },
    });
    dismissImpl = dismiss;
  } catch (err: any) {
    const error = makeError("render_failed", err?.message || "Paywall render failed", true);
    state.config?.onError?.(error);
    queueEvent("render_error", { ...attribution(trigger, placement), message: error.message });
    return noop;
  }

  state.activePaywalls.set(trigger, { dismiss: () => dismissOnce(true) });

  return {
    shown: true,
    variantId: placement.variantId,
    dismiss: () => {
      dismissOnce(true);
    },
  };
}

export function track(event: string, properties?: Record<string, unknown>): void {
  queueEvent(event, properties);
}

export function reportConversion(data: {
  trigger: string;
  revenue?: number;
  currency?: string;
}): void {
  const placement = state.configResponse?.placements?.[data.trigger];
  queueEvent("conversion", placement ? { ...data, ...attribution(data.trigger, placement) } : data);
}

export { flush } from "./events.js";

export function reset(): void {
  state = {
    config: null,
    identity: null,
    configResponse: null,
    sessionId: "",
    initialized: false,
    initPromise: null,
    initKey: null,
    activePaywalls: new Map(),
  };
}

function attribution(trigger: string, placement: NonNullable<ConfigResponse["placements"][string]>): Record<string, unknown> {
  const placementId = placement.placement_id || placement.placementId;
  const variantKey = placement.variant_key || placement.variantKey || placement.variantId;
  return {
    trigger,
    variantId: placement.variantId,
    variant_key: variantKey,
    ...(placementId ? { placement_id: placementId } : {}),
  };
}
