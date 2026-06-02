import type { ProductSpec } from "@tranzmit/shared";
import { SpecRenderer } from "./renderer/SpecRenderer.js";
import { ModalPresenter } from "./presentation/ModalPresenter.js";
import { SheetPresenter } from "./presentation/SheetPresenter.js";
import type { ActivePaywall } from "./types.js";

export interface PaywallHostProps {
  activePaywalls: ActivePaywall[];
  onCTA: (active: ActivePaywall, product: ProductSpec) => void;
  onDismiss: (active: ActivePaywall) => void;
  onError: (active: ActivePaywall, error: Error) => void;
}

export function PaywallHost({ activePaywalls, onCTA, onDismiss, onError }: PaywallHostProps) {
  return (
    <>
      {activePaywalls.map((active) => {
        const content = (
          <SpecRenderer
            spec={active.placement.spec}
            onCTA={(product) => onCTA(active, product)}
            onDismiss={() => onDismiss(active)}
            onError={(error) => onError(active, error)}
            presentation={active.presentation}
          />
        );

        if (active.presentation === "inline") {
          return <SpecRenderer key={active.id} spec={active.placement.spec} onCTA={(product) => onCTA(active, product)} onDismiss={() => onDismiss(active)} onError={(error) => onError(active, error)} presentation="inline" />;
        }

        if (active.presentation === "modal") {
          return (
            <ModalPresenter key={active.id} visible onDismiss={() => onDismiss(active)}>
              {content}
            </ModalPresenter>
          );
        }

        if (active.presentation === "fullscreen") {
          return (
            <ModalPresenter key={active.id} visible onDismiss={() => onDismiss(active)} fullscreen>
              {content}
            </ModalPresenter>
          );
        }

        return (
          <SheetPresenter key={active.id} visible onDismiss={() => onDismiss(active)}>
            {content}
          </SheetPresenter>
        );
      })}
    </>
  );
}
