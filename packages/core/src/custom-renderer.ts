import type { PaywallSpec, ProductSpec } from "@tranzmit/shared";
import type { RenderCallbacks } from "./renderer.js";

export function renderCustomHtml(
  spec: PaywallSpec,
  container: HTMLElement,
  callbacks: RenderCallbacks
): { dismiss: () => void } {
  const html = spec.customHtml || "";
  const css = spec.customCss || "";
  const normalized = normalizeCustomHtml(interpolateTemplate(html, spec));

  const overlay = document.createElement("div");
  overlay.className = "tranzmit-paywall tranzmit-custom";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    backdropFilter: "blur(4px)",
    padding: "16px",
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) callbacks.onDismiss?.();
  });

  const host = document.createElement("div");
  host.className = "tranzmit-custom-host";
  const renderRoot = host.attachShadow
    ? host.attachShadow({ mode: "open" })
    : host;

  const scopedCss = [normalized.css, css].filter(Boolean).join("\n");
  if (scopedCss) {
    const style = document.createElement("style");
    style.textContent = scopedCss;
    renderRoot.appendChild(style);
  }

  const wrapper = document.createElement("div");
  wrapper.className = "tranzmit-custom-wrapper";
  wrapper.innerHTML = normalized.html;

  bindCtaElements(wrapper, spec, callbacks);
  bindDismissElements(wrapper, callbacks);

  renderRoot.appendChild(wrapper);
  overlay.appendChild(host);
  container.appendChild(overlay);

  callbacks.onImpression?.();

  function dismiss() {
    overlay.remove();
  }

  return { dismiss };
}

function normalizeCustomHtml(html: string): { html: string; css: string } {
  if (!/<\/?(html|head|body)(\s|>)/i.test(html)) {
    return { html, css: "" };
  }

  try {
    const doc = document.implementation.createHTMLDocument("tranzmit-custom-paywall");
    doc.documentElement.innerHTML = html;
    const css = Array.from(doc.querySelectorAll("style"))
      .map((style) => style.textContent || "")
      .join("\n");
    const body = doc.body?.innerHTML?.trim();
    return { html: body || html, css };
  } catch {
    return { html, css: "" };
  }
}

function interpolateTemplate(html: string, spec: PaywallSpec): string {
  let result = html;
  const headline = spec.header?.title || spec.headline || "";
  const subheadline = spec.header?.subtitle || spec.subheadline || "";
  const cta = typeof spec.cta === "string" ? spec.cta : spec.cta.text;

  result = result.replace(/\{\{headline\}\}/g, escapeHtml(headline));
  result = result.replace(/\{\{subheadline\}\}/g, escapeHtml(subheadline));
  result = result.replace(/\{\{cta\}\}/g, escapeHtml(cta));
  result = result.replace(/\{\{secondaryCta\}\}/g, escapeHtml(spec.secondaryCta || ""));

  if (spec.features) {
    const featuresHtml = spec.features
      .map((f) => `<li>${escapeHtml(typeof f === "string" ? f : f.text)}</li>`)
      .join("");
    result = result.replace(/\{\{features\}\}/g, featuresHtml);
  }

  const productsBlockRegex = /\{\{#products\}\}([\s\S]*?)\{\{\/products\}\}/g;
  result = result.replace(productsBlockRegex, (_match, template: string) => {
    return spec.products
      .map((product) => interpolateProduct(template, product))
      .join("");
  });

  if (spec.products.length > 0) {
    spec.products.forEach((product, i) => {
      const prefix = `product${i > 0 ? i : ""}`;
      result = result.replace(new RegExp(`\\{\\{${prefix}\\.id\\}\\}`, "g"), escapeHtml(product.id));
      result = result.replace(new RegExp(`\\{\\{${prefix}\\.name\\}\\}`, "g"), escapeHtml(product.name));
      result = result.replace(new RegExp(`\\{\\{${prefix}\\.price\\}\\}`, "g"), escapeHtml(formatProductPrice(product)));
      result = result.replace(new RegExp(`\\{\\{${prefix}\\.interval\\}\\}`, "g"), escapeHtml(productInterval(product)));
      result = result.replace(new RegExp(`\\{\\{${prefix}\\.badge\\}\\}`, "g"), escapeHtml(product.badge || ""));
    });
  }

  return result;
}

function interpolateProduct(template: string, product: ProductSpec): string {
  let result = template;
  result = result.replace(/\{\{id\}\}/g, escapeHtml(product.id));
  result = result.replace(/\{\{name\}\}/g, escapeHtml(product.name));
  result = result.replace(/\{\{price\}\}/g, escapeHtml(formatProductPrice(product)));
  result = result.replace(/\{\{interval\}\}/g, escapeHtml(productInterval(product)));
  result = result.replace(/\{\{badge\}\}/g, escapeHtml(product.badge || ""));
  result = result.replace(/\{\{highlighted\}\}/g, product.highlighted || product.isDefault ? "highlighted" : "");
  return result;
}

function bindCtaElements(
  wrapper: HTMLElement,
  spec: PaywallSpec,
  callbacks: RenderCallbacks
): void {
  let ctaElements = Array.from(wrapper.querySelectorAll("[data-tranzmit-cta]"));
  if (ctaElements.length === 0) {
    ctaElements = Array.from(
      wrapper.querySelectorAll("[data-tranzmit-primary], .primary-btn, button:not([data-tranzmit-dismiss])")
    ).slice(0, 1);
  }
  ctaElements.forEach((el) => {
    const productId = el.getAttribute("data-tranzmit-cta");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const product = spec.products.find((p) => p.id === productId) || spec.products[0];
      if (product) callbacks.onCTA?.(product);
    });
  });
}

function bindDismissElements(
  wrapper: HTMLElement,
  callbacks: RenderCallbacks
): void {
  let dismissElements = Array.from(wrapper.querySelectorAll("[data-tranzmit-dismiss]"));
  if (dismissElements.length === 0) {
    dismissElements = Array.from(
      wrapper.querySelectorAll("[data-tranzmit-secondary], .secondary-btn, .close, [aria-label='Close']")
    );
  }
  dismissElements.forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onDismiss?.();
    });
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatProductPrice(product: ProductSpec): string {
  if (typeof product.price === "string") return product.price;
  return formatPrice(product.price.amount, product.price.currency);
}

function productInterval(product: ProductSpec): string {
  return typeof product.price === "string" ? "" : product.price.interval || "";
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}
