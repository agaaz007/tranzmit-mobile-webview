import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderPaywall } from "../src/renderer.js";
import type { PaywallSpec } from "@tranzmit/shared";

const baseSpec: PaywallSpec = {
  layout: "hero_vertical",
  headline: "Unlock Premium",
  subheadline: "Get more done",
  cta: "Subscribe Now",
  theme: "light",
  features: ["Feature A", "Feature B"],
  products: [
    {
      id: "pro",
      name: "Pro Plan",
      price: { amount: 1999, currency: "USD", interval: "month" },
      highlighted: true,
      badge: "Popular",
    },
    {
      id: "basic",
      name: "Basic Plan",
      price: { amount: 499, currency: "USD", interval: "month" },
    },
  ],
};

describe("renderer", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("renders headline and subheadline", () => {
    renderPaywall(baseSpec, container, {});
    expect(container.querySelector(".tranzmit-headline")?.textContent).toBe("Unlock Premium");
    expect(container.querySelector(".tranzmit-subheadline")?.textContent).toBe("Get more done");
  });

  it("renders features list", () => {
    renderPaywall(baseSpec, container, {});
    const items = container.querySelectorAll(".tranzmit-features li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("✓  Feature A");
  });

  it("renders products with prices", () => {
    renderPaywall(baseSpec, container, {});
    const products = container.querySelectorAll(".tranzmit-product");
    expect(products).toHaveLength(2);
    expect(products[0].classList.contains("tranzmit-product-highlighted")).toBe(true);
  });

  it("renders badge when present", () => {
    renderPaywall(baseSpec, container, {});
    const badge = container.querySelector(".tranzmit-badge");
    expect(badge?.textContent).toBe("Popular");
  });

  it("calls onImpression on render", () => {
    const onImpression = vi.fn();
    renderPaywall(baseSpec, container, { onImpression });
    expect(onImpression).toHaveBeenCalledTimes(1);
  });

  it("calls onCTA when CTA button clicked", () => {
    const onCTA = vi.fn();
    renderPaywall(baseSpec, container, { onCTA });
    const buttons = container.querySelectorAll(".tranzmit-cta");
    (buttons[0] as HTMLElement).click();
    expect(onCTA).toHaveBeenCalledWith(baseSpec.products[0]);
  });

  it("calls onDismiss when close button clicked", () => {
    const onDismiss = vi.fn();
    renderPaywall(baseSpec, container, { onDismiss });
    const close = container.querySelector(".tranzmit-close") as HTMLElement;
    close.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismiss removes the paywall from DOM", () => {
    const { dismiss } = renderPaywall(baseSpec, container, {});
    expect(container.querySelector(".tranzmit-paywall")).not.toBeNull();
    dismiss();
    expect(container.querySelector(".tranzmit-paywall")).toBeNull();
  });

  it("sets layout and theme data attributes", () => {
    renderPaywall(baseSpec, container, {});
    const root = container.querySelector(".tranzmit-paywall") as HTMLElement;
    expect(root.getAttribute("data-layout")).toBe("hero_vertical");
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("renders secondaryCta as dismiss action", () => {
    const spec: PaywallSpec = { ...baseSpec, secondaryCta: "Maybe Later" };
    const onDismiss = vi.fn();
    renderPaywall(spec, container, { onDismiss });
    const secondary = container.querySelector(".tranzmit-secondary-cta") as HTMLElement;
    expect(secondary.textContent).toBe("Maybe Later");
    secondary.click();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("handles spec with no features", () => {
    const spec: PaywallSpec = { ...baseSpec, features: undefined };
    renderPaywall(spec, container, {});
    expect(container.querySelector(".tranzmit-features")).toBeNull();
  });

  it("handles spec with no subheadline", () => {
    const spec: PaywallSpec = { ...baseSpec, subheadline: undefined };
    renderPaywall(spec, container, {});
    expect(container.querySelector(".tranzmit-subheadline")).toBeNull();
  });
});
