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
  const [isReady, setIsReady] = useState(false);
  const [activePaywalls, setActivePaywalls] = useState<ActivePaywall[]>([]);

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
        userTraits,
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
    if (!client?.isReady()) return noopResult;

    const placement = client.getPlacement(trigger);
    if (!placement) return noopResult;

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
      presentation: options.presentation || "sheet",
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

  const value = useMemo<TranzmitContextValue>(() => ({
    isReady,
    ready: isReady,
    gate,
    track,
    reportConversion,
    refreshConfig,
    flush: () => clientRef.current?.flush() || Promise.resolve(),
    getPlacement: (trigger) => clientRef.current?.getPlacement(trigger) || null,
  }), [gate, isReady, refreshConfig, reportConversion, track]);

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
      />
    </TranzmitContext.Provider>
  );
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
