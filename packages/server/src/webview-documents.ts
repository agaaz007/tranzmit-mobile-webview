import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

type JsonRecord = Record<string, any>;

export interface WebViewDocumentContext {
  publicKey: string;
  placementId: string;
  variantKey: string;
  apiBaseUrl: string;
  includeInline?: boolean;
}

export interface WebViewDocumentPayload {
  html: string;
  css?: string;
  js?: string;
  baseUrl?: string;
  cacheKey: string;
  revision: string | number;
  integrity: string;
}

const DEFAULT_DOCUMENT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 365;

export function publicApiBaseUrl(req: IncomingMessage): string {
  const explicit = process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (explicit) return explicit;

  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "http";
  const normalizedHost = Array.isArray(host) ? host[0] : host;
  const normalizedProto = Array.isArray(proto) ? proto[0] : proto;
  return `${normalizedProto}://${normalizedHost}`.replace(/\/$/, "");
}

export function shouldInlineDocuments(): boolean {
  return process.env.PAYWALL_DOCUMENT_DELIVERY !== "hosted";
}

export function documentCacheTtlSeconds(): number {
  const raw = Number(process.env.PAYWALL_DOCUMENT_CACHE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DOCUMENT_CACHE_TTL_SECONDS;
}

export function configTtlSeconds(): number {
  const raw = Number(process.env.CONFIG_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60;
}

export function ensureWebViewSpec(spec: unknown, context?: WebViewDocumentContext): JsonRecord {
  const next = cloneRecord(spec);
  next.renderer = "webview";
  next.templateId = next.templateId || next.layout || "paywall";
  next.dismiss = next.dismiss || { enabled: true, delay_ms: 0 };
  next.bridge = next.bridge || { version: 1, allowedActions: ["cta", "dismiss", "open_url", "custom_action"] };

  const existingDocument = cloneRecord(next.document);
  const html = stringOrUndefined(existingDocument.html) || buildLegacyWebViewHtml(next);
  const css = stringOrUndefined(existingDocument.css) || stringOrUndefined(next.customCss) || buildLegacyWebViewCss(next);
  const js = stringOrUndefined(existingDocument.js);
  const baseUrl = stringOrUndefined(existingDocument.baseUrl);
  const contentHash = hashDocument({ html, css, js, baseUrl });
  const revision = next.revision || `doc-${contentHash.slice(0, 12)}`;
  const cacheKey = next.cacheKey || `${next.templateId}:${revision}`;
  const integrity = `sha256-${contentHash}`;
  const includeInline = context?.includeInline ?? true;

  next.revision = revision;
  next.cacheKey = cacheKey;
  next.document = {
    ...(includeInline ? { html, css, ...(js ? { js } : {}), ...(baseUrl ? { baseUrl } : {}) } : {}),
    ...(context ? {
      url: documentUrl(context.apiBaseUrl, context.publicKey, context.placementId, context.variantKey, cacheKey),
      integrity,
      cacheTtlSeconds: documentCacheTtlSeconds(),
    } : {}),
  };
  next.metadata = {
    ...(next.metadata || {}),
    documentDelivery: context ? (includeInline ? "hosted+inline" : "hosted") : "inline",
  };

  return next;
}

export function webViewDocumentPayload(spec: unknown): WebViewDocumentPayload {
  const normalized = ensureWebViewSpec(spec, { publicKey: "", placementId: "", variantKey: "", apiBaseUrl: "", includeInline: true });
  const document = normalized.document || {};
  return {
    html: document.html || "",
    css: document.css,
    js: document.js,
    baseUrl: document.baseUrl,
    cacheKey: normalized.cacheKey,
    revision: normalized.revision,
    integrity: document.integrity || `sha256-${hashDocument(document)}`,
  };
}

export function hashDocument(document: { html?: string; css?: string; js?: string; baseUrl?: string }): string {
  return createHash("sha256")
    .update(document.html || "")
    .update("\n---css---\n")
    .update(document.css || "")
    .update("\n---js---\n")
    .update(document.js || "")
    .update("\n---base---\n")
    .update(document.baseUrl || "")
    .digest("hex");
}

function documentUrl(apiBaseUrl: string, publicKey: string, placementId: string, variantKey: string, cacheKey: string): string {
  const path = [
    "v1",
    "paywall-documents",
    encodeURIComponent(placementId),
    encodeURIComponent(variantKey),
    `${encodeURIComponent(cacheKey)}.json`,
  ].join("/");
  return `${apiBaseUrl}/${path}?key=${encodeURIComponent(publicKey)}`;
}

function buildLegacyWebViewHtml(spec: JsonRecord): string {
  const product = Array.isArray(spec.products) ? spec.products[0] : undefined;
  const title = spec.header?.title || spec.headline || "Upgrade";
  const subtitle = spec.header?.subtitle || spec.subheadline || "";
  const cta = typeof spec.cta === "string" ? spec.cta : spec.cta?.text || "Continue";
  const features = Array.isArray(spec.features) ? spec.features : [];
  const featureHtml = features
    .map((feature: unknown) => `<li><span class="icon">✓</span><span>${escapeHtml(featureText(feature))}</span></li>`)
    .join("");
  const productHtml = product
    ? `<section class="offer">
        ${product.badge ? `<div class="badge">${escapeHtml(product.badge)}</div>` : ""}
        <strong>${escapeHtml(product.name || "")}</strong>
        <span>${escapeHtml(priceText(product))}</span>
        ${product.description ? `<p>${escapeHtml(product.description)}</p>` : ""}
      </section>`
    : "";

  return `<main class="tranzmit-paywall">
    <button class="close" data-tranzmit-action="dismiss" aria-label="Close">×</button>
    <section class="card">
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
      ${featureHtml ? `<ul>${featureHtml}</ul>` : ""}
      ${productHtml}
      <button class="cta" data-tranzmit-action="cta" data-product-id="${escapeHtml(product?.id || "product")}">${escapeHtml(cta)}</button>
      ${spec.secondaryCta ? `<button class="secondary" data-tranzmit-action="dismiss">${escapeHtml(spec.secondaryCta)}</button>` : ""}
      ${spec.legal ? `<p class="legal">${escapeHtml(spec.legal)}</p>` : ""}
    </section>
  </main>`;
}

function buildLegacyWebViewCss(spec: JsonRecord): string {
  const accent = spec.style?.accentColor || "#6537d9";
  const text = spec.style?.textColor || "#17172e";
  const secondary = spec.style?.secondaryTextColor || "#6f6878";
  const background = spec.style?.backgroundColor || "#fbfaff";

  return `body{min-height:100vh;margin:0;background:transparent;color:${text};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.tranzmit-paywall{min-height:100vh;background:${background};padding:24px;position:relative}.close{position:absolute;left:16px;top:16px;border:0;border-radius:999px;background:#fff;color:${secondary};width:38px;height:38px;font-size:28px}.card{background:#fff;border-radius:28px;box-shadow:0 24px 80px rgba(15,23,42,.16);padding:34px 24px;text-align:center}h1{font-size:36px;line-height:1.05;margin:0 0 10px;font-weight:900;letter-spacing:-.04em}.subtitle{color:${secondary};font-size:16px;line-height:1.45;margin:0 0 18px}ul{display:grid;gap:10px;list-style:none;margin:18px 0;padding:0;text-align:left}li{align-items:center;background:#f8f5ff;border:1px solid #ece4fb;border-radius:14px;display:flex;gap:10px;padding:12px;font-weight:700}.icon{color:${accent};font-weight:900}.offer{border:1.5px solid ${accent};border-radius:22px;display:grid;gap:6px;margin:18px 0;padding:18px}.offer strong{color:${accent};font-size:24px}.badge{justify-self:center;background:#e6b246;color:#fff;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:900}.cta,.secondary{width:100%;border:0;border-radius:999px;min-height:56px;font-size:17px;font-weight:900}.cta{background:${accent};color:#fff}.secondary{background:transparent;color:${secondary};margin-top:8px}.legal{color:${secondary};font-size:12px}`;
}

function cloneRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function featureText(feature: unknown): string {
  if (feature && typeof feature === "object") {
    const record = feature as JsonRecord;
    return String(record.text || record.title || record.label || "");
  }
  return String(feature || "").split("|")[0];
}

function priceText(product: JsonRecord): string {
  if (typeof product.price === "string") return product.price;
  if (product.price && typeof product.price === "object") {
    const amount = typeof product.price.amount === "number" ? (product.price.amount / 100).toFixed(2) : "";
    const interval = product.price.interval ? ` / ${product.price.interval}` : "";
    return `${product.price.currency || ""} ${amount}${interval}`.trim();
  }
  return "";
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}
