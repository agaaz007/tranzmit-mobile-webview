import type { PaywallSpec, ProductSpec } from "@tranzmit/shared";

export interface RenderCallbacks {
  onCTA?: (product: ProductSpec) => void;
  onDismiss?: () => void;
  onImpression?: () => void;
}

export function renderPaywall(
  spec: PaywallSpec,
  container: HTMLElement,
  callbacks: RenderCallbacks
): { dismiss: () => void } {
  const isDark = spec.theme === "dark" || Boolean(spec.style?.gradientColors);
  const bg = spec.style?.backgroundColor || (isDark ? "#1f2937" : "#ffffff");
  const text = spec.style?.textColor || (isDark ? "#f9fafb" : "#111827");
  const muted = spec.style?.secondaryTextColor || (isDark ? "#9ca3af" : "#6b7280");
  const border = spec.style?.productCardStyle?.borderColor || (isDark ? "#374151" : "#e5e7eb");
  const accent = spec.style?.accentColor || "#2563eb";
  const headlineText = spec.header?.title || spec.headline || "";
  const subheadlineText = spec.header?.subtitle || spec.subheadline;
  const ctaText = typeof spec.cta === "string" ? spec.cta : spec.cta.text;
  const layout = spec.layout || "webview";

  const root = document.createElement("div");
  root.className = "tranzmit-paywall";
  root.setAttribute("data-layout", layout);
  root.setAttribute("data-theme", spec.theme || (isDark ? "dark" : "light"));
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: layout === "fullscreen" || layout === "hero" ? "0" : "16px",
    backdropFilter: "blur(4px)",
  });

  root.addEventListener("click", (e) => {
    if (e.target === root) callbacks.onDismiss?.();
  });

  const card = document.createElement("div");
  card.className = "tranzmit-paywall-card";
  Object.assign(card.style, {
    background: spec.style?.gradientColors
      ? `linear-gradient(135deg, ${spec.style.gradientColors[0]}, ${spec.style.gradientColors[1]})`
      : bg,
    color: text,
    borderRadius: `${spec.style?.cornerRadius ?? 16}px`,
    padding: "32px",
    maxWidth: "420px",
    width: "100%",
    position: "relative",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    maxHeight: "90vh",
    overflowY: "auto",
  });

  const closeBtn = document.createElement("button");
  if (spec.dismiss?.enabled !== false) {
    closeBtn.className = "tranzmit-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    Object.assign(closeBtn.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      background: "none",
      border: "none",
      fontSize: "24px",
      cursor: "pointer",
      color: muted,
      lineHeight: "1",
      padding: "4px 8px",
      borderRadius: "4px",
    });
    closeBtn.addEventListener("click", () => callbacks.onDismiss?.());
    closeBtn.addEventListener("mouseenter", () => { closeBtn.style.backgroundColor = isDark ? "#374151" : "#f3f4f6"; });
    closeBtn.addEventListener("mouseleave", () => { closeBtn.style.backgroundColor = "transparent"; });
    card.appendChild(closeBtn);
  }

  const content = document.createElement("div");
  content.className = "tranzmit-paywall-content";

  const headline = document.createElement("h2");
  headline.className = "tranzmit-headline";
  headline.textContent = headlineText;
  Object.assign(headline.style, {
    fontSize: "24px",
    fontWeight: "700",
    margin: "0 0 8px 0",
    lineHeight: "1.3",
    color: text,
  });
  content.appendChild(headline);

  if (subheadlineText) {
    const sub = document.createElement("p");
    sub.className = "tranzmit-subheadline";
    sub.textContent = subheadlineText;
    Object.assign(sub.style, {
      fontSize: "15px",
      color: muted,
      margin: "0 0 20px 0",
      lineHeight: "1.5",
    });
    content.appendChild(sub);
  }

  if (spec.features && spec.features.length > 0) {
    const list = document.createElement("ul");
    list.className = "tranzmit-features";
    Object.assign(list.style, {
      listStyle: "none",
      padding: "0",
      margin: "0 0 24px 0",
    });
    for (const feature of spec.features) {
      const li = document.createElement("li");
      const featureText = typeof feature === "string" ? feature : feature.text;
      const marker = typeof feature === "string" || feature.included ? "✓" : "×";
      li.textContent = `${marker}  ${featureText}`;
      Object.assign(li.style, {
        padding: "6px 0",
        fontSize: "14px",
        color: text,
        display: "flex",
        alignItems: "center",
        gap: "8px",
      });
      list.appendChild(li);
    }
    content.appendChild(list);
  }

  if (spec.products.length > 0) {
    const productsEl = document.createElement("div");
    productsEl.className = "tranzmit-products";
    Object.assign(productsEl.style, {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    });
    for (const product of spec.products) {
      productsEl.appendChild(renderProduct(product, spec, callbacks, { isDark, accent, text, muted, border, bg, ctaText }));
    }
    content.appendChild(productsEl);
  }

  if (spec.secondaryCta) {
    const secondary = document.createElement("button");
    secondary.className = "tranzmit-secondary-cta";
    secondary.textContent = spec.secondaryCta;
    Object.assign(secondary.style, {
      display: "block",
      width: "100%",
      marginTop: "12px",
      padding: "10px",
      background: "none",
      border: "none",
      color: muted,
      fontSize: "14px",
      cursor: "pointer",
      textDecoration: "underline",
    });
    secondary.addEventListener("click", () => callbacks.onDismiss?.());
    content.appendChild(secondary);
  }

  card.appendChild(content);
  root.appendChild(card);
  container.appendChild(root);

  callbacks.onImpression?.();

  function dismiss() {
    root.remove();
  }

  return { dismiss };
}

interface Theme {
  isDark: boolean;
  accent: string;
  text: string;
  muted: string;
  border: string;
  bg: string;
  ctaText: string;
}

function renderProduct(
  product: ProductSpec,
  spec: PaywallSpec,
  callbacks: RenderCallbacks,
  theme: Theme
): HTMLElement {
  const el = document.createElement("div");
  el.className = "tranzmit-product";
  if (product.highlighted || product.isDefault) el.classList.add("tranzmit-product-highlighted");

  const isHighlighted = !!(product.highlighted || product.isDefault);
  Object.assign(el.style, {
    border: isHighlighted ? `2px solid ${theme.accent}` : `1px solid ${theme.border}`,
    borderRadius: "12px",
    padding: "16px",
    position: "relative",
    cursor: "pointer",
    transition: "border-color 0.15s, box-shadow 0.15s",
    backgroundColor: isHighlighted ? (theme.isDark ? "#1e3a5f" : "#eff6ff") : "transparent",
  });

  el.addEventListener("mouseenter", () => {
    el.style.borderColor = theme.accent;
    el.style.boxShadow = `0 0 0 1px ${theme.accent}`;
  });
  el.addEventListener("mouseleave", () => {
    el.style.borderColor = isHighlighted ? theme.accent : theme.border;
    el.style.boxShadow = "none";
  });

  if (product.badge) {
    const badge = document.createElement("span");
    badge.className = "tranzmit-badge";
    badge.textContent = product.badge;
    Object.assign(badge.style, {
      position: "absolute",
      top: "-10px",
      right: "16px",
      backgroundColor: theme.accent,
      color: "#ffffff",
      fontSize: "11px",
      fontWeight: "600",
      padding: "3px 10px",
      borderRadius: "99px",
      letterSpacing: "0.02em",
    });
    el.appendChild(badge);
  }

  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  });

  const info = document.createElement("div");

  const name = document.createElement("h3");
  name.className = "tranzmit-product-name";
  name.textContent = product.name;
  Object.assign(name.style, {
    fontSize: "16px",
    fontWeight: "600",
    margin: "0 0 4px 0",
    color: theme.text,
  });
  info.appendChild(name);

  const price = document.createElement("p");
  price.className = "tranzmit-product-price";
  price.textContent = formatProductPrice(product);
  Object.assign(price.style, {
    fontSize: "14px",
    color: theme.muted,
    margin: "0",
  });
  info.appendChild(price);

  const cta = document.createElement("button");
  cta.className = "tranzmit-cta";
  cta.textContent = theme.ctaText;
  Object.assign(cta.style, {
    backgroundColor: isHighlighted ? theme.accent : "transparent",
    color: isHighlighted ? "#ffffff" : theme.accent,
    border: isHighlighted ? "none" : `1px solid ${theme.accent}`,
    padding: "8px 16px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "500",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "opacity 0.15s",
  });
  cta.addEventListener("mouseenter", () => { cta.style.opacity = "0.85"; });
  cta.addEventListener("mouseleave", () => { cta.style.opacity = "1"; });
  cta.addEventListener("click", (e) => {
    e.stopPropagation();
    callbacks.onCTA?.(product);
  });

  row.appendChild(info);
  row.appendChild(cta);
  el.appendChild(row);

  el.addEventListener("click", () => callbacks.onCTA?.(product));

  return el;
}

function formatProductPrice(product: ProductSpec): string {
  if (typeof product.price === "string") return product.price;
  const price = formatPrice(product.price.amount, product.price.currency);
  return product.price.interval ? `${price} / ${product.price.interval}` : price;
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
