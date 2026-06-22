import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTranzmitClient, type SharedClient } from "@tranzmit/shared";
import { reactNativeAdapter, reactNativeMetadata } from "./adapter.js";
import { PaywallHost } from "./PaywallHost.js";
import { TranzmitContext } from "./TranzmitContext.js";
import type {
  ActivePaywall,
  GateOptions,
  GateResult,
  ReportConversionData,
  TranzmitContextValue,
  TranzmitProviderProps,
} from "./types.js";

const noopResult: GateResult = { shown: false, dismiss: () => {} };

export function TranzmitProvider({
  publicKey,
  userId,
  identifiers,
  userTraits,
  privateTraits,
  apiBaseUrl,
  onError,
  debug,
  children,
}: TranzmitProviderProps) {
  const clientRef = useRef<SharedClient | null>(null);
  const activeRef = useRef<Map<string, ActivePaywall>>(new Map());
  const dynamicTraitsRef = useRef<Record<string, unknown>>({});
  const [isReady, setIsReady] = useState(false);
  const [activePaywalls, setActivePaywalls] = useState<ActivePaywall[]>([]);
  const [configVersion, setConfigVersion] = useState(0);

  if (!clientRef.current) {
    clientRef.current = createTranzmitClient(reactNativeAdapter, reactNativeMetadata);
  }

  const dismissPaywall = useCallback((id: string, trackDismissal: boolean) => {
    const active = activeRef.current.get(id);
    if (!active) return;

    activeRef.current.delete(id);
    setActivePaywalls((items) => items.filter((item) => item.id !== id));

    if (trackDismissal) {
      clientRef.current?.track("dismissal", {
        ...attribution(active.trigger, active.placement),
        time_on_screen_ms: Date.now() - active.shownAt,
      });
      active.options.onDismiss?.();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const client = clientRef.current!;
    setIsReady(false);
    activeRef.current.clear();
    setActivePaywalls([]);

    client
      .init({
        publicKey,
        userId,
        identifiers,
        userTraits: mergeTraits(userTraits, dynamicTraitsRef.current),
        privateTraits,
        apiBaseUrl,
        onError: onError as any,
        debug,
      })
      .then(() => {
        if (!cancelled) setIsReady(client.isReady());
      })
      .catch((err) => {
        onError?.(err);
        if (!cancelled) setIsReady(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, debug, identifiers, onError, privateTraits, publicKey, userId, userTraits]);

  const gate = useCallback((trigger: string, options: GateOptions = {}): GateResult => {
    const client = clientRef.current;
    if (!client?.isReady()) {
      options.onFallback?.({ trigger, reason: "not_ready" });
      return noopResult;
    }

    const placement = client.getPlacement(trigger);
    if (!placement) {
      options.onFallback?.({ trigger, reason: "placement_not_found" });
      return noopResult;
    }

    const existing = activeRef.current.get(trigger);
    if (existing) {
      return {
        shown: true,
        variantId: existing.placement.variantId,
        dismiss: () => dismissPaywall(existing.id, true),
      };
    }

    const active: ActivePaywall = {
      id: trigger,
      trigger,
      placement,
      presentation: options.presentation || presentationFromSpec(placement.spec),
      options,
      shownAt: Date.now(),
    };

    activeRef.current.set(trigger, active);
    setActivePaywalls((items) => [...items, active]);
    client.track("impression", attribution(trigger, placement));
    options.onImpression?.();

    return {
      shown: true,
      variantId: placement.variantId,
      dismiss: () => dismissPaywall(active.id, true),
    };
  }, [dismissPaywall]);

  const handlePaywallError = useCallback((active: ActivePaywall, error: Error) => {
    clientRef.current?.track("paywall_error", {
      ...attribution(active.trigger, active.placement),
      reason: "render_error",
      message: error.message,
    });
    dismissPaywall(active.id, false);
    active.options.onFallback?.({
      trigger: active.trigger,
      reason: "render_error",
      error,
      placement: active.placement,
      variantId: active.placement.variantId,
    });
  }, [dismissPaywall]);

  const track = useCallback((event: string, properties?: Record<string, unknown>) => {
    clientRef.current?.track(event, properties);
  }, []);

  const reportConversion = useCallback((data: ReportConversionData) => {
    clientRef.current?.reportConversion(data);
  }, []);

  const refreshConfig = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setIsReady(false);
    activeRef.current.clear();
    setActivePaywalls([]);
    await client.refreshConfig();
    setIsReady(client.isReady());
  }, []);

  const setTraits = useCallback(async (traits: Record<string, unknown>, options?: { merge?: boolean }) => {
    const client = clientRef.current;
    if (!client) return;

    dynamicTraitsRef.current = options?.merge === false
      ? { ...traits }
      : { ...dynamicTraitsRef.current, ...traits };

    await client.setTraits(traits, options);
    setIsReady(client.isReady());
    setConfigVersion((version) => version + 1);
  }, []);

  const value = useMemo<TranzmitContextValue>(() => ({
    isReady,
    ready: isReady,
    gate,
    track,
    reportConversion,
    refreshConfig,
    setTraits,
    flush: () => clientRef.current?.flush() || Promise.resolve(),
    getPlacement: (trigger) => clientRef.current?.getPlacement(trigger) || null,
  }), [configVersion, gate, isReady, refreshConfig, reportConversion, setTraits, track]);

  return (
    <TranzmitContext.Provider value={value}>
      {children}
      <PaywallHost
        activePaywalls={activePaywalls}
        onCTA={(active, product) => {
          clientRef.current?.track("cta_click", {
            ...attribution(active.trigger, active.placement),
            productId: product.id,
          });
          dismissPaywall(active.id, false);
          active.options.onCTA?.(product);
        }}
        onDismiss={(active) => dismissPaywall(active.id, true)}
        onError={handlePaywallError}
      />
    </TranzmitContext.Provider>
  );
}

function presentationFromSpec(spec: any) {
  const mode = spec?.presentation?.mode;
  return mode === "modal" || mode === "fullscreen" || mode === "inline" || mode === "sheet"
    ? mode
    : "sheet";
}

function attribution(trigger: string, placement: ActivePaywall["placement"]): Record<string, unknown> {
  const placementId = placement.placement_id || placement.placementId;
  const variantKey = placement.variant_key || placement.variantKey || placement.variantId;
  return {
    trigger,
    variantId: placement.variantId,
    variant_key: variantKey,
    ...(placementId ? { placement_id: placementId } : {}),
  };
}

function mergeTraits(
  base?: Record<string, unknown>,
  dynamic?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const merged = { ...(base || {}), ...(dynamic || {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
