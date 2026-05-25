import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderCustomHtml } from "../src/custom-renderer.js";
import type { PaywallSpec } from "@tranzmit/shared";

const customSpec: PaywallSpec = {
  layout: "custom",
  headline: "Go Premium",
  subheadline: "Unlock everything",
  cta: "Subscribe",
  theme: "light",
  products: [
    { id: "pro", name: "Pro Plan", price: { amount: 999, currency: "USD", interval: "month" }, highlighted: true, badge: "Best Value" },
    { id: "basic", name: "Basic", price: { amount: 499, currency: "USD", interval: "month" } },
  ],
  customHtml: `
    <div class="my-paywall">
      <h1>{{headline}}</h1>
      <p>{{subheadline}}</p>
      {{#products}}
        <div class="plan {{highlighted}}">
          <span class="badge">{{badge}}</span>
          <h3>{{name}}</h3>
          <p>{{price}} / {{interval}}</p>
          <button data-tranzmit-cta="{{id}}">Choose {{name}}</button>
        </div>
      {{/products}}
      <button data-tranzmit-dismiss>No thanks</button>
    </div>
  `,
  customCss: `.my-paywall { background: white; padding: 24px; border-radius: 12px; }`,
};

describe("custom-renderer", () => {
  let container: HTMLElement;

  function root(): ParentNode {
    const host = container.querySelector(".tranzmit-custom-host") as HTMLElement | null;
    return host?.shadowRoot || container;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("renders custom HTML with interpolated headline and subheadline", () => {
    renderCustomHtml(customSpec, container, {});
    expect(root().querySelector("h1")?.textContent).toBe("Go Premium");
    expect(root().querySelector("p")?.textContent).toBe("Unlock everything");
  });

  it("renders products via {{#products}} block", () => {
    renderCustomHtml(customSpec, container, {});
    const plans = root().querySelectorAll(".plan");
    expect(plans).toHaveLength(2);
    expect(plans[0].querySelector("h3")?.textContent).toBe("Pro Plan");
    expect(plans[1].querySelector("h3")?.textContent).toBe("Basic");
  });

  it("interpolates product price and interval", () => {
    renderCustomHtml(customSpec, container, {});
    const plan = root().querySelector(".plan");
    expect(plan?.querySelector("p")?.textContent).toContain("9.99");
    expect(plan?.querySelector("p")?.textContent).toContain("month");
  });

  it("adds highlighted class for highlighted products", () => {
    renderCustomHtml(customSpec, container, {});
    const plans = root().querySelectorAll(".plan");
    expect(plans[0].classList.contains("highlighted")).toBe(true);
    expect(plans[1].classList.contains("highlighted")).toBe(false);
  });

  it("binds data-tranzmit-cta to onCTA callback with correct product", () => {
    const onCTA = vi.fn();
    renderCustomHtml(customSpec, container, { onCTA });
    const buttons = root().querySelectorAll("[data-tranzmit-cta]");
    (buttons[0] as HTMLElement).click();
    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro" }));
    (buttons[1] as HTMLElement).click();
    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "basic" }));
  });

  it("binds data-tranzmit-dismiss to onDismiss callback", () => {
    const onDismiss = vi.fn();
    renderCustomHtml(customSpec, container, { onDismiss });
    const dismiss = root().querySelector("[data-tranzmit-dismiss]") as HTMLElement;
    dismiss.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onImpression when rendered", () => {
    const onImpression = vi.fn();
    renderCustomHtml(customSpec, container, { onImpression });
    expect(onImpression).toHaveBeenCalledTimes(1);
  });

  it("injects customCss as style tag", () => {
    renderCustomHtml(customSpec, container, {});
    const style = root().querySelector("style");
    expect(style?.textContent).toContain(".my-paywall");
  });

  it("dismiss removes the overlay", () => {
    const { dismiss } = renderCustomHtml(customSpec, container, {});
    expect(container.querySelector(".tranzmit-custom")).not.toBeNull();
    dismiss();
    expect(container.querySelector(".tranzmit-custom")).toBeNull();
  });

  it("renders badge text inside product", () => {
    renderCustomHtml(customSpec, container, {});
    const badge = root().querySelector(".badge");
    expect(badge?.textContent).toBe("Best Value");
  });

  it("escapes HTML in interpolated values", () => {
    const xssSpec: PaywallSpec = {
      ...customSpec,
      headline: '<script>alert("xss")</script>',
      customHtml: '<h1>{{headline}}</h1>',
    };
    renderCustomHtml(xssSpec, container, {});
    expect(root().querySelector("h1")?.textContent).toContain("<script>");
    expect(root().querySelector("h1")?.innerHTML).not.toContain("<script>alert");
  });

  it("extracts body content from full HTML documents", () => {
    renderCustomHtml({
      ...customSpec,
      customHtml: "<!doctype html><html><head><style>.modal{color:red}</style></head><body><div class='modal'><button class='primary-btn'>Continue</button><button class='secondary-btn'>No</button></div></body></html>",
      customCss: "",
    }, container, {});

    expect(root().querySelector(".modal")).not.toBeNull();
    expect(root().querySelector("style")?.textContent).toContain(".modal");
    expect(root().querySelector("html")).toBeNull();
  });

  it("auto-binds primary and secondary buttons when data attributes are missing", () => {
    const onCTA = vi.fn();
    const onDismiss = vi.fn();
    renderCustomHtml({
      ...customSpec,
      customHtml: "<div><button class='primary-btn'>Continue</button><button class='secondary-btn'>Not now</button></div>",
    }, container, { onCTA, onDismiss });

    (root().querySelector(".primary-btn") as HTMLElement).click();
    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro" }));
    (root().querySelector(".secondary-btn") as HTMLElement).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
