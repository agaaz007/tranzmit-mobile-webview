import type { PaywallLocalization, PaywallSpec } from "./spec.js";

export interface LocalizationIssue {
  path: string;
  message: string;
  keyword: "localization" | "assets";
}

export interface LocalizationValidationResult {
  tokens: string[];
  issues: LocalizationIssue[];
}

const TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;
const ASSET_ATTR_RE = /\s(?:src|href|data-tranzmit-src|data-tranzmit-fallback-src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const SRCSET_ATTR_RE = /\s(?:srcset|data-tranzmit-srcset)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi;

export function extractLocalizationTokens(html: string | undefined): string[] {
  const tokens = new Set<string>();
  if (!html) return [];

  for (const match of html.matchAll(TOKEN_RE)) {
    if (match[1]) tokens.add(match[1]);
  }

  return Array.from(tokens).sort();
}

export function resolveLocalizedStrings(
  localization: PaywallLocalization | undefined,
  locale: string | undefined
): Record<string, string> {
  if (!localization || !localization.translations) return {};

  const { defaultLocale, translations } = localization;
  const translationKeys = new Map<string, string>();
  for (const key of Object.keys(translations)) {
    translationKeys.set(key, key);
    const canonical = canonicalLocale(key);
    if (canonical && !translationKeys.has(canonical)) translationKeys.set(canonical, key);
  }
  const defaultKey = translationKeys.get(defaultLocale)
    || translationKeys.get(canonicalLocale(defaultLocale) || "");
  const base = defaultKey ? translations[defaultKey] || {} : {};

  for (const candidate of localeCandidates(locale)) {
    const key = translationKeys.get(candidate);
    if (key) {
      return { ...base, ...translations[key] };
    }
  }

  return base;
}

export function localizeHtml(html: string, strings: Record<string, string>): string {
  return html.replace(TOKEN_RE, (_match, key: string) => {
    const value = strings[key];
    return value == null ? "" : escapeHtml(String(value));
  });
}

export function validateLocalizationCoverage(spec: Pick<PaywallSpec, "document" | "localization">): LocalizationValidationResult {
  const html = spec.document?.html || "";
  const tokens = extractLocalizationTokens(html);
  const issues: LocalizationIssue[] = [];
  const localization = spec.localization;

  if (!localization) {
    if (!tokens.length) return { tokens, issues };
    issues.push({
      path: "/localization",
      message: "Document contains localization tokens but no localization block",
      keyword: "localization",
    });
    return { tokens, issues };
  }

  if (!localization.defaultLocale) {
    issues.push({
      path: "/localization/defaultLocale",
      message: "Missing defaultLocale",
      keyword: "localization",
    });
  }

  const translations = localization.translations || {};
  if (localization.defaultLocale && !translations[localization.defaultLocale]) {
    issues.push({
      path: `/localization/translations/${localization.defaultLocale}`,
      message: `Missing default locale translations for "${localization.defaultLocale}"`,
      keyword: "localization",
    });
  }

  if (!tokens.length) return { tokens, issues };

  for (const [locale, strings] of Object.entries(translations)) {
    for (const token of tokens) {
      if (strings[token] == null) {
        issues.push({
          path: `/localization/translations/${locale}/${token}`,
          message: `Missing token "${token}" in locale "${locale}"`,
          keyword: "localization",
        });
      }
    }
  }

  return { tokens, issues };
}

export function extractRelativeAssetReferences(...sources: Array<string | undefined>): string[] {
  const references = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(ASSET_ATTR_RE)) {
      addAssetReference(references, match[1] || match[2] || match[3]);
    }
    for (const match of source.matchAll(SRCSET_ATTR_RE)) {
      const value = (match[1] || match[2] || match[3] || "").trim();
      if (!value || /^data:/i.test(value)) continue;
      for (const candidate of value.split(",")) {
        addAssetReference(references, candidate.trim().split(/\s+/)[0]);
      }
    }
    for (const match of source.matchAll(CSS_URL_RE)) {
      addAssetReference(references, match[1] || match[2] || match[3]);
    }
  }

  return Array.from(references).sort();
}

function addAssetReference(references: Set<string>, raw: string | undefined): void {
  const value = raw?.trim();
  if (value && isRelativeAssetReference(value)) references.add(value);
}

function localeCandidates(locale: string | undefined): string[] {
  const raw = locale?.trim();
  if (!raw) return [];
  const canonical = canonicalLocale(raw);
  const candidates = new Set<string>([raw]);
  if (!canonical) return Array.from(candidates);

  const parts = canonical.split("-");
  while (parts.length > 0) {
    candidates.add(parts.join("-"));
    parts.pop();
  }
  return Array.from(candidates);
}

function canonicalLocale(locale: string): string | undefined {
  const normalized = locale.replace(/_/g, "-");
  try {
    if (typeof Intl !== "undefined" && typeof Intl.getCanonicalLocales === "function") {
      return Intl.getCanonicalLocales(normalized)[0];
    }
  } catch {}

  const parts = normalized.split("-");
  if (!/^[A-Za-z]{2,8}$/.test(parts[0] || "")
      || parts.some((part) => !/^[A-Za-z0-9]{1,8}$/.test(part))) return undefined;
  return parts.map((part, index) => {
    if (index === 0) return part.toLowerCase();
    if (/^[A-Za-z]{4}$/.test(part)) {
      return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
    }
    if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) return part.toUpperCase();
    return part.toLowerCase();
  }).join("-");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRelativeAssetReference(value: string): boolean {
  if (!value || value.startsWith("#") || value.startsWith("{{")) return false;
  if (/^(https?:|data:|about:|mailto:|tel:|blob:|\/\/)/i.test(value)) return false;
  return true;
}
