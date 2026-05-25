import { useEffect, useMemo, useRef } from "react";
import type { PaywallSpec, ProductSpec } from "@tranzmit/shared";
import { SpecRenderer } from "./renderer/SpecRenderer.js";
import { ModalPresenter } from "./presentation/ModalPresenter.js";
import { SheetPresenter } from "./presentation/SheetPresenter.js";
import { useTranzmit } from "./TranzmitContext.js";
import type { PresentationMode } from "./types.js";

export interface TranzmitPaywallProps {
  trigger?: string;
  spec?: PaywallSpec;
  variantId?: string;
  visible: boolean;
  presentation?: PresentationMode;
  onCTA?: (product: ProductSpec) => void;
  onDismiss?: () => void;
  onImpression?: () => void;
}

export function TranzmitPaywall({
  trigger,
  spec,
  variantId,
  visible,
  presentation = "sheet",
  onCTA,
  onDismiss,
  onImpression,
}: TranzmitPaywallProps) {
  const { getPlacement, track } = useTranzmit();
  const placement = trigger ? getPlacement(trigger) : null;
  const resolvedSpec = spec || placement?.spec;
  const resolvedTrigger = trigger || "dynamic_spec";
  const resolvedVariantId = spec ? variantId : placement?.variantId;
  const impressionKey = `${resolvedTrigger}:${resolvedVariantId || "none"}:${resolvedSpec?.cacheKey || resolvedSpec?.revision || "none"}`;
  const lastImpressionRef = useRef<string | null>(null);
  const shownAtRef = useRef<number>(Date.now());

  const handleDismiss = () => {
    track("dismissal", {
      trigger: resolvedTrigger,
      variantId: resolvedVariantId,
      time_on_screen_ms: Date.now() - shownAtRef.current,
    });
    onDismiss?.();
  };

  useEffect(() => {
    if (!visible || !resolvedSpec || lastImpressionRef.current === impressionKey) return;
    lastImpressionRef.current = impressionKey;
    shownAtRef.current = Date.now();
    track("impression", { trigger: resolvedTrigger, variantId: resolvedVariantId });
    onImpression?.();
  }, [impressionKey, onImpression, resolvedSpec, resolvedTrigger, resolvedVariantId, track, visible]);

  const content = useMemo(() => {
    if (!resolvedSpec) return null;
    return (
      <SpecRenderer
        spec={resolvedSpec}
        presentation={presentation}
        onCTA={(product) => {
          track("cta_click", {
            trigger: resolvedTrigger,
            variantId: resolvedVariantId,
            productId: product.id,
          });
          onCTA?.(product);
        }}
        onDismiss={() => {
          handleDismiss();
        }}
      />
    );
  }, [handleDismiss, onCTA, presentation, resolvedSpec, resolvedTrigger, resolvedVariantId, track]);

  if (!visible || !resolvedSpec || !content) return null;
  if (presentation === "inline") return content;
  if (presentation === "modal") {
    return (
      <ModalPresenter visible onDismiss={handleDismiss}>
        {content}
      </ModalPresenter>
    );
  }
  return (
    <SheetPresenter visible onDismiss={handleDismiss}>
      {content}
    </SheetPresenter>
  );
}
