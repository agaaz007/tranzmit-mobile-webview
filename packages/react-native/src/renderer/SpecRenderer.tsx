import { useMemo } from "react";
import { Linking, View } from "react-native";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import type { PaywallSpec, ProductSpec } from "@tranzmit/shared";
import type { PresentationMode } from "../types.js";

export interface SpecRendererProps {
  spec: PaywallSpec;
  presentation?: PresentationMode;
  onCTA: (product: ProductSpec) => void;
  onDismiss: () => void;
}

export function SpecRenderer({
  spec,
  presentation = "sheet",
  onCTA,
  onDismiss,
}: SpecRendererProps) {
  const html = useMemo(() => composeDocument(spec), [spec]);

  const handleMessage = (event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(message.type || message.action || "");
    if (!isAllowed(spec, type)) return;

    if (type === "cta" || type === "cta_click") {
      const product = productFromMessage(spec, message) || defaultProduct(spec);
      if (product) onCTA(product);
      return;
    }

    if (type === "dismiss") {
      onDismiss();
      return;
    }

    if (type === "open_url" && typeof message.url === "string") {
      void Linking.openURL(message.url);
    }
  };

  const shouldStart = (request: WebViewNavigation) => {
    const url = request.url || "";
    if (url.startsWith("about:") || url.startsWith("data:")) return true;
    handleMessage({ nativeEvent: { data: JSON.stringify({ type: "open_url", url }) } } as WebViewMessageEvent);
    return false;
  };

  return (
    <View style={{ width: "100%", height: heightForPresentation(presentation), overflow: "hidden", borderRadius: presentation === "inline" || presentation === "fullscreen" ? 0 : 28 }}>
      <WebView
        originWhitelist={["*"]}
        source={{ html, baseUrl: spec.document?.baseUrl }}
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={shouldStart}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        automaticallyAdjustContentInsets={false}
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

function heightForPresentation(presentation: PresentationMode) {
  if (presentation === "inline") return 560;
  if (presentation === "fullscreen") return "100%";
  if (presentation === "modal") return "86%";
  return "82%";
}

function defaultProduct(spec: PaywallSpec) {
  return spec.products.find((product) => product.isDefault || product.highlighted) || spec.products[0];
}

function productFromMessage(spec: PaywallSpec, message: Record<string, unknown>) {
  const productId = typeof message.productId === "string"
    ? message.productId
    : typeof message.product_id === "string"
      ? message.product_id
      : undefined;
  if (!productId) return undefined;
  return spec.products.find((product) => product.id === productId);
}

function isAllowed(spec: PaywallSpec, type: string) {
  if (type === "cta_click" || type === "ready") return true;
  const allowed = spec.bridge?.allowedActions;
  if (!allowed || allowed.length === 0) {
    return ["cta", "dismiss", "custom_action", "open_url"].includes(type);
  }
  return allowed.includes(type as any);
}

function composeDocument(spec: PaywallSpec) {
  const document = spec.document || legacyDocument(spec);
  const js = document.js ? `<script>${document.js}</script>` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<style>
  html, body { margin: 0; padding: 0; background: transparent; -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  button, a { touch-action: manipulation; }
  ${document.css || ""}
</style>
</head>
<body>
${document.html}
${js}
<script>
(function(){
  function post(message){
    try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } catch (_) {}
  }
  window.Tranzmit = {
    post: post,
    cta: function(productId){ post({ type: 'cta', productId: productId }); },
    dismiss: function(){ post({ type: 'dismiss' }); },
    customAction: function(name, payload){ post({ type: 'custom_action', name: name, payload: payload || {} }); }
  };
  document.addEventListener('click', function(event){
    var node = event.target;
    while (node && node !== document) {
      var action = node.getAttribute && node.getAttribute('data-tranzmit-action');
      if (action) {
        event.preventDefault();
        post({
          type: action === 'cta' ? 'cta' : action,
          productId: node.getAttribute('data-product-id') || undefined,
          name: node.getAttribute('data-action-name') || undefined,
          url: node.getAttribute('href') || undefined
        });
        return;
      }
      node = node.parentNode;
    }
  }, true);
  window.addEventListener('load', function(){ post({ type: 'ready' }); });
})();
</script>
</body>
</html>`;
}

function legacyDocument(spec: PaywallSpec) {
  const product = defaultProduct(spec);
  const title = spec.header?.title || spec.headline || "Upgrade";
  const subtitle = spec.header?.subtitle || spec.subheadline;
  const ctaText = typeof spec.cta === "string" ? spec.cta : spec.cta.text;
  const features = (spec.features || [])
    .map((feature) => `<li>${escapeHtml(featureText(feature))}</li>`)
    .join("");
  const productHtml = product
    ? `<div class="product">
        ${product.badge ? `<span class="badge">${escapeHtml(product.badge)}</span>` : ""}
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(priceText(product))}</span>
      </div>`
    : "";

  return {
    html: spec.customHtml || `<main class="tranzmit-paywall">
      <section class="card">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
        ${features ? `<ul>${features}</ul>` : ""}
        ${productHtml}
        <button data-tranzmit-action="cta" data-product-id="${escapeHtml(product?.id || "product")}">${escapeHtml(ctaText)}</button>
        ${spec.secondaryCta ? `<button class="secondary" data-tranzmit-action="dismiss">${escapeHtml(spec.secondaryCta)}</button>` : ""}
      </section>
    </main>`,
    css: spec.customCss || `
body { min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: rgba(15, 23, 42, 0.48); color: #111827; }
.tranzmit-paywall { width: 100%; padding: 24px; }
.card { background: #fff; border-radius: 28px; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28); padding: 28px; text-align: center; }
h1 { margin: 0; font-size: 32px; line-height: 1.05; letter-spacing: -0.04em; }
.subtitle { color: #6b7280; font-size: 16px; line-height: 1.45; }
ul { padding: 0; list-style: none; display: grid; gap: 10px; margin: 20px 0; text-align: left; }
li { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 14px; padding: 12px; }
.product { display: grid; gap: 6px; border: 1px solid #dbeafe; background: #eff6ff; border-radius: 18px; padding: 16px; margin: 18px 0; }
.badge { justify-self: center; background: #1d4ed8; color: white; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; }
button { width: 100%; border: 0; border-radius: 999px; background: #1d4ed8; color: white; padding: 16px; font-size: 16px; font-weight: 800; }
.secondary { margin-top: 10px; background: transparent; color: #64748b; }
`,
    js: undefined,
  };
}

function featureText(feature: unknown) {
  if (feature && typeof feature === "object") {
    const record = feature as Record<string, unknown>;
    const text = record.text || record.title || record.label;
    if (text != null) return String(text);
  }
  return String(feature).split("|")[0];
}

function priceText(product: ProductSpec) {
  const price = product.price;
  if (typeof price === "string") return price;
  const amount = typeof price.amount === "number" ? (price.amount / 100).toFixed(2) : "";
  const interval = price.interval ? ` / ${price.interval}` : "";
  return `${price.currency} ${amount}${interval}`.trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
