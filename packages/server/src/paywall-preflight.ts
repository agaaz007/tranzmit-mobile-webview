import {
  extractLocalizationTokens,
  extractRelativeAssetReferences,
  validateLocalizationCoverage,
  type PaywallSpec,
} from "@tranzmit/shared";
import { validatePaywallSpec } from "./paywall-schema.js";
import { sha256Integrity } from "./webview-documents.js";

/**
 * Publish preflight: every check an operator would otherwise have to remember
 * to run by hand before a paywall reaches real users.
 *
 * The engine is deliberately pure — spec in, report out — so the same checks run
 * from the dashboard's "Submit" button, from the release endpoint, and from unit
 * tests. Device-rendering results cannot be produced without a browser, so the
 * dashboard measures them in a sandboxed iframe and submits them as
 * `viewports`; everything else is derived from the document bytes themselves.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  items?: string[];
}

/**
 * One render of the composed document at one locale and one device, audited in
 * the frame by the shared harness (`responsive.mjs`, vendored from the SDK
 * repo's `templates/preview`). The dashboard composes through the SDK's real
 * `renderDocument()` before measuring, so these describe the app's own layout,
 * not a raw browser's.
 */
export interface ViewportAudit {
  id: string;
  deviceId: string;
  label?: string;
  /** BCP-47 tag, or "default" when the spec has no localization block. */
  locale: string;
  width: number;
  height: number;
  passed: boolean;
  failures?: string[];
  /** The render never reported back, so nothing about it is known. */
  timedOut?: boolean;
}

export interface PreflightInput {
  /** The fully composed spec: content + environment products + checkout. */
  spec: unknown;
  environmentKind: "test" | "live";
  /**
   * Billing product IDs published in the sibling test environment. Used to fail
   * a live publish that still carries the test environment's checkout binding.
   */
  testEnvironmentProductIds?: string[];
  viewports?: ViewportAudit[];
}

export interface PreflightReport {
  status: CheckStatus;
  checks: PreflightCheck[];
  documentBytes: number;
  tokens: string[];
  locales: string[];
  productIds: string[];
  viewports: ViewportAudit[];
}

/**
 * The production regression matrix, from RESPONSIVE_LEARNINGS: "Test 320, 360,
 * 375, 390, 412, and 430 px phone widths. A 390 px pass does not prove narrow
 * phones." iPad is rendered too, but it is a visual check rather than a gate.
 *
 * Kept in step with RESPONSIVE_DEVICES in the vendored `responsive.mjs`;
 * tests/preview-harness-vendoring.test.ts fails if the two drift.
 */
export const REQUIRED_PROBE_WIDTHS = [320, 360, 375, 390, 412, 430];

/** Bridge actions the SDK knows how to route. Anything else is dead markup. */
const ALLOWED_BRIDGE_ACTIONS = new Set(["cta", "dismiss", "custom_action", "open_url"]);

const DOCUMENT_WARN_BYTES = 100_000;

const PLACEHOLDER_PRODUCT_ID = /^(?:.*\b)?(?:replace[_-]?me|your[_-]?product|todo|tbd|xxx+|changeme|placeholder|product[_-]?id)(?:\b.*)?$/i;
const TEST_LOOKING_PRODUCT_ID = /(?:^|[_\-.])(?:test|sandbox|dummy|staging|demo|mock)(?:[_\-.]|$)/i;

type JsonRecord = Record<string, any>;

export function runPaywallPreflight(input: PreflightInput): PreflightReport {
  const spec = isRecord(input.spec) ? (input.spec as JsonRecord) : {};
  const document = isRecord(spec.document) ? spec.document : {};
  const html = typeof document.html === "string" ? document.html : "";
  const css = typeof document.css === "string" ? document.css : undefined;
  const viewports = Array.isArray(input.viewports) ? input.viewports : [];
  const productIds = specProductIds(spec);
  const checks: PreflightCheck[] = [];

  checks.push(schemaCheck(spec));
  checks.push(documentCheck(html, document));
  checks.push(localizationCheck(spec, html));
  checks.push(assetCheck(html, css, document));
  checks.push(ctaBridgeCheck(html, productIds));
  checks.push(bridgeActionCheck(html, spec));
  checks.push(billingCheck(spec, html, productIds, input));
  checks.push(responsiveSourceCheck(html, css));
  checks.push(...viewportChecks(spec, viewports));

  const localization = isRecord(spec.localization) ? spec.localization : null;
  const translations = localization && isRecord(localization.translations)
    ? localization.translations
    : {};

  return {
    status: aggregate(checks),
    checks,
    documentBytes: documentBytes(document),
    tokens: extractLocalizationTokens(html),
    locales: Object.keys(translations).sort(),
    productIds,
    viewports,
  };
}

export function aggregate(checks: PreflightCheck[]): CheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

// --- Individual checks -------------------------------------------------------

function schemaCheck(spec: JsonRecord): PreflightCheck {
  const validation = validatePaywallSpec(spec);
  if (validation.errors.length > 0) {
    return {
      id: "spec-schema",
      title: "Spec schema",
      status: "fail",
      detail: `${validation.errors.length} schema error${validation.errors.length === 1 ? "" : "s"}.`,
      items: validation.errors.map((error) => `${error.path}: ${error.message}`),
    };
  }
  if (validation.warnings.length > 0) {
    return {
      id: "spec-schema",
      title: "Spec schema",
      status: "warn",
      detail: "Valid, with warnings.",
      items: validation.warnings.map((warning) => `${warning.path}: ${warning.message}`),
    };
  }
  return { id: "spec-schema", title: "Spec schema", status: "pass", detail: "Valid against the paywall spec schema." };
}

function documentCheck(html: string, document: JsonRecord): PreflightCheck {
  const items: string[] = [];
  let status: CheckStatus = "pass";

  if (!html) {
    return {
      id: "document",
      title: "Document bytes",
      status: "fail",
      detail: "The release has no inline document HTML. V2 serves exact author bytes, so HTML is required.",
    };
  }

  if (typeof document.integrity === "string" && document.integrity !== sha256Integrity(html)) {
    status = "fail";
    items.push("document.integrity does not match the uploaded HTML. Re-import the file instead of editing the hash.");
  }

  const bytes = documentBytes(document);
  if (bytes > DOCUMENT_WARN_BYTES) {
    if (status !== "fail") status = "warn";
    items.push(
      `${formatBytes(bytes)} of html+css+js. Documents above ${formatBytes(DOCUMENT_WARN_BYTES)} load slowly on cellular; ` +
      "re-encode inlined images to WebP or host them as URLs."
    );
  }

  return {
    id: "document",
    title: "Document bytes",
    status,
    detail: status === "pass"
      ? `${formatBytes(bytes)}, integrity verified.`
      : `${formatBytes(bytes)}.`,
    ...(items.length ? { items } : {}),
  };
}

function localizationCheck(spec: JsonRecord, html: string): PreflightCheck {
  const coverage = validateLocalizationCoverage(spec as Pick<PaywallSpec, "document" | "localization">);
  const tokens = extractLocalizationTokens(html);
  if (coverage.issues.length > 0) {
    return {
      id: "localization",
      title: "Localization",
      status: "fail",
      detail: `${coverage.issues.length} localization problem${coverage.issues.length === 1 ? "" : "s"}.`,
      items: coverage.issues.map((issue) => `${issue.path}: ${issue.message}`),
    };
  }
  if (!tokens.length) {
    return {
      id: "localization",
      title: "Localization",
      status: "pass",
      detail: "The document has no localization tokens, so it ships as authored.",
    };
  }
  const localization = isRecord(spec.localization) ? spec.localization : null;
  const locales = localization && isRecord(localization.translations)
    ? Object.keys(localization.translations).sort()
    : [];
  return {
    id: "localization",
    title: "Localization",
    status: "pass",
    detail: `${tokens.length} token${tokens.length === 1 ? "" : "s"} resolved in every locale (${locales.join(", ")}).`,
  };
}

function assetCheck(html: string, css: string | undefined, document: JsonRecord): PreflightCheck {
  const items: string[] = [];
  let status: CheckStatus = "pass";

  const unresolved = extractRelativeAssetReferences(html, css);
  if (unresolved.length > 0 && !document.baseUrl) {
    status = "fail";
    items.push(
      `${unresolved.length} relative asset reference${unresolved.length === 1 ? "" : "s"} with no baseUrl — ` +
      `these resolve to nothing on device: ${unresolved.slice(0, 8).join(", ")}`
    );
  }

  const remote = remoteAssetReferences(html, css);
  if (remote.length > 0) {
    if (status !== "fail") status = "warn";
    items.push(
      `${remote.length} asset${remote.length === 1 ? "" : "s"} load over the network at paywall-open time ` +
      `and will be blank on a slow or offline connection: ${remote.slice(0, 5).join(", ")}`
    );
  }

  const inlined = (html.match(/data:image\//g) || []).length;
  return {
    id: "assets",
    title: "Assets",
    status,
    detail: status === "pass"
      ? `${inlined} inlined image${inlined === 1 ? "" : "s"}, no unresolved references.`
      : `${inlined} inlined image${inlined === 1 ? "" : "s"}.`,
    ...(items.length ? { items } : {}),
  };
}

function ctaBridgeCheck(html: string, productIds: string[]): PreflightCheck {
  const ctaTags = matchActionTags(html, "cta");
  if (ctaTags.length === 0) {
    return {
      id: "cta-bridge",
      title: "CTA bridge",
      status: "fail",
      detail: 'No element carries data-tranzmit-action="cta". The purchase button would do nothing on device.',
    };
  }

  const items: string[] = [];
  let status: CheckStatus = "pass";
  const tagged = ctaTags.filter((tag) => extractTagAttribute(tag, "data-product-id"));
  if (tagged.length === 0) {
    status = "warn";
    items.push(
      `The CTA has no data-product-id, so the SDK falls back to the first product ` +
      `(${productIds[0] || "none configured"}). Tag it explicitly if this paywall sells a specific SKU.`
    );
  }
  if (ctaTags.length > 1) {
    status = "warn";
    items.push(`${ctaTags.length} elements are tagged as the CTA. Every one of them starts checkout.`);
  }

  return {
    id: "cta-bridge",
    title: "CTA bridge",
    status,
    detail: status === "pass"
      ? `CTA wired to ${tagged.length === ctaTags.length ? "an explicit product" : "the default product"}.`
      : "CTA is wired, with warnings.",
    ...(items.length ? { items } : {}),
  };
}

function billingCheck(
  spec: JsonRecord,
  html: string,
  productIds: string[],
  input: PreflightInput
): PreflightCheck {
  const items: string[] = [];
  let status: CheckStatus = "pass";

  const products = Array.isArray(spec.products) ? spec.products : [];
  if (products.length === 0) {
    return {
      id: "billing",
      title: "Billing product IDs",
      status: "fail",
      detail: "No products are configured, so the CTA has nothing to purchase.",
    };
  }

  for (const product of products) {
    if (!isRecord(product) || typeof product.id !== "string" || !product.id.trim()) {
      status = "fail";
      items.push("A product entry has no id. The id is the only value the host app uses to start billing.");
      continue;
    }
    if (PLACEHOLDER_PRODUCT_ID.test(product.id.trim())) {
      status = "fail";
      items.push(`"${product.id}" is a placeholder Billing Product ID, not a real one from the billing provider.`);
    }
  }

  const known = new Set(productIds);
  for (const referenced of documentProductIds(html)) {
    if (!known.has(referenced)) {
      status = "fail";
      items.push(
        `The document's CTA points at Billing Product ID "${referenced}", which is not in this environment's products. ` +
        "Checkout would start with an unknown SKU."
      );
    }
  }

  if (input.environmentKind === "live") {
    const testIds = new Set((input.testEnvironmentProductIds || []).filter(Boolean));
    for (const id of productIds) {
      if (testIds.has(id)) {
        status = "fail";
        items.push(
          `"${id}" is the test environment's Billing Product ID. Live traffic would be sent to a test SKU. ` +
          "Set the live product on this environment before publishing."
        );
      } else if (TEST_LOOKING_PRODUCT_ID.test(id)) {
        if (status !== "fail") status = "warn";
        items.push(`"${id}" looks like a test SKU but is configured on a live environment. Confirm it with the billing provider.`);
      }
    }
  }

  return {
    id: "billing",
    title: "Billing product IDs",
    status,
    detail: status === "pass"
      ? `${productIds.length} product${productIds.length === 1 ? "" : "s"} (${productIds.join(", ")}) match the document.`
      : `${productIds.length} product${productIds.length === 1 ? "" : "s"} configured.`,
    ...(items.length ? { items } : {}),
  };
}

/**
 * Static responsive rules taken from the paywall authoring contract. These are
 * warnings, not failures: the measured viewport probes are what actually gate a
 * publish. They exist to explain *why* a render broke.
 */
function responsiveSourceCheck(html: string, css: string | undefined): PreflightCheck {
  const source = `${html}\n${css || ""}`;
  const items: string[] = [];

  if (/<html[\s>]/i.test(html) && !/<meta[^>]+name=["']viewport["']/i.test(html)) {
    items.push('No <meta name="viewport"> — the WebView lays the document out at desktop width.');
  }
  if (/height\s*:\s*100vh/i.test(source)) {
    items.push("Uses height:100vh. On mobile that includes the browser chrome; use 100svh or var(--tz-vh).");
  }
  const fixedWidths = Array.from(source.matchAll(/(?:min-)?width\s*:\s*(\d{3,4})px/gi))
    .map((match) => Number(match[1]))
    .filter((width) => width > 430);
  if (fixedWidths.length > 0) {
    items.push(
      `Fixed widths wider than the narrowest supported phone (${Array.from(new Set(fixedWidths)).join("px, ")}px). ` +
      "These force horizontal scrolling at 320px."
    );
  }
  if (!/tz-scroll|tz-template|class=["'][^"']*\b(?:screen|paywall-screen|tranzmit-paywall)\b/i.test(source)) {
    items.push("No recognizable scroll region (.tz-scroll / .screen). Content taller than the phone may be unreachable.");
  }
  if (/position\s*:\s*fixed/i.test(source)) {
    items.push("Uses position:fixed. Fixed elements ignore the safe-area insets the SDK injects and can sit under the home indicator.");
  }

  return {
    id: "responsive-source",
    title: "Responsive authoring rules",
    status: items.length ? "warn" : "pass",
    detail: items.length
      ? `${items.length} rule${items.length === 1 ? "" : "s"} from the authoring contract are not followed.`
      : "Follows the viewport-locked authoring contract.",
    ...(items.length ? { items } : {}),
  };
}

/**
 * Coverage is per locale, not per device. A missing token renders as an empty
 * string and can change the layout, so a matrix that passes in English proves
 * nothing about Hinglish.
 */
function viewportChecks(spec: JsonRecord, audits: ViewportAudit[]): PreflightCheck[] {
  const expectedLocales = configuredLocales(spec);
  const gaps: string[] = [];
  for (const locale of expectedLocales) {
    const measured = new Set(
      audits.filter((audit) => audit.locale === locale).map((audit) => Math.round(audit.width))
    );
    const missing = REQUIRED_PROBE_WIDTHS.filter((width) => !measured.has(width));
    if (missing.length) gaps.push(`${locale}: not rendered at ${missing.join("px, ")}px`);
  }

  const coverage: PreflightCheck = gaps.length
    ? {
      id: "viewport-coverage",
      title: "Device rendering coverage",
      status: "fail",
      detail: audits.length
        ? "The rendering matrix is incomplete."
        : "The document was never rendered. Press Submit in the dashboard to measure it.",
      items: gaps,
    }
    : {
      id: "viewport-coverage",
      title: "Device rendering coverage",
      status: "pass",
      detail: `${audits.length} renders: ${expectedLocales.length} locale${expectedLocales.length === 1 ? "" : "s"} across ${REQUIRED_PROBE_WIDTHS.join("px, ")}px and up.`,
    };

  if (!audits.length) return [coverage];

  const items: string[] = [];
  let status: CheckStatus = "pass";
  for (const audit of audits) {
    if (audit.passed) continue;
    status = "fail";
    const where = `${audit.locale} · ${audit.label || audit.deviceId} (${audit.width}px)`;
    const failures = audit.failures && audit.failures.length
      ? audit.failures
      : [audit.timedOut ? "the render never reported back" : "failed without a reason"];
    for (const failure of failures) items.push(`${where}: ${failure}`);
  }

  const failedRenders = audits.filter((audit) => !audit.passed).length;
  const rendering: PreflightCheck = {
    id: "viewport-rendering",
    title: "Device rendering",
    status,
    detail: status === "pass"
      ? `All ${audits.length} renders passed the shared responsive audit.`
      : `${failedRenders} of ${audits.length} renders failed.`,
    ...(items.length ? { items: items.slice(0, 40) } : {}),
  };

  return [coverage, rendering];
}

function configuredLocales(spec: JsonRecord): string[] {
  const localization = isRecord(spec.localization) ? spec.localization : null;
  const translations = localization && isRecord(localization.translations) ? localization.translations : null;
  const locales = translations ? Object.keys(translations).sort() : [];
  return locales.length ? locales : ["default"];
}

/**
 * The SDK routes only four bridge actions. Anything else — a `back` control
 * reintroduced by a re-export, say — is markup the app will never wire up, so
 * it silently does nothing on device.
 */
function bridgeActionCheck(html: string, spec: JsonRecord): PreflightCheck {
  const items: string[] = [];
  const unknown = new Set<string>();
  for (const match of html.matchAll(/\sdata-tranzmit-action\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const action = (match[2] ?? match[3] ?? "").trim();
    if (action && !ALLOWED_BRIDGE_ACTIONS.has(action)) unknown.add(action);
  }
  for (const action of unknown) {
    items.push(
      `data-tranzmit-action="${action}" is not a bridge action the SDK routes ` +
      `(${Array.from(ALLOWED_BRIDGE_ACTIONS).join(", ")}). Tapping it does nothing.`
    );
  }

  const metadata = isRecord(spec.metadata) ? spec.metadata : {};
  if (String(metadata.forbidBackAction) === "true") {
    if (/data-tranzmit-action\s*=\s*["']back["']/i.test(html) || html.includes("{{back_aria}}")) {
      items.push("This paywall forbids a back control, and one is present again.");
    }
  }

  return {
    id: "bridge-actions",
    title: "Bridge actions",
    status: items.length ? "fail" : "pass",
    detail: items.length ? "The document wires actions the SDK cannot route." : "Every tagged action is one the SDK routes.",
    ...(items.length ? { items } : {}),
  };
}

// --- Helpers -----------------------------------------------------------------

export function specProductIds(spec: unknown): string[] {
  const products = isRecord(spec) && Array.isArray((spec as JsonRecord).products)
    ? (spec as JsonRecord).products
    : [];
  const ids: string[] = [];
  for (const product of products) {
    if (isRecord(product) && typeof product.id === "string" && product.id.trim()) {
      ids.push(product.id.trim());
    }
  }
  return ids;
}

/** Billing product IDs the document itself hardcodes on its bridge elements. */
export function documentProductIds(html: string): string[] {
  const found = new Set<string>();
  for (const tag of matchActionTags(html, "cta")) {
    const id = extractTagAttribute(tag, "data-product-id");
    if (id) found.add(id);
  }
  return Array.from(found);
}

function matchActionTags(html: string, action: string): string[] {
  const tags: string[] = [];
  for (const match of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = match[0];
    if (extractTagAttribute(tag, "data-tranzmit-action") === action) tags.push(tag);
  }
  return tags;
}

function extractTagAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = tag.match(pattern);
  if (!match) return null;
  const value = match[2] ?? match[3] ?? match[4] ?? "";
  return value.trim() || null;
}

function remoteAssetReferences(html: string, css: string | undefined): string[] {
  const found = new Set<string>();
  const source = `${html}\n${css || ""}`;
  for (const match of source.matchAll(/\s(?:src|href)=("|')(https?:\/\/[^"']+)\1/gi)) {
    found.add(match[2]);
  }
  for (const match of source.matchAll(/url\(\s*("|')?(https?:\/\/[^"')]+)\1?\s*\)/gi)) {
    found.add(match[2]);
  }
  return Array.from(found);
}

function documentBytes(document: JsonRecord): number {
  let total = 0;
  for (const key of ["html", "css", "js"]) {
    const value = document[key];
    if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes >= 102_400 ? 0 : 1)} KB`;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
